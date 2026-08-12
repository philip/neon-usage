import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
// Type-only: erased at compile, so importing this module never loads the
// native addon. The value is required lazily inside the factory below, so a
// missing or unbuildable better-sqlite3 only surfaces when a store is actually
// created — the CLI catches that and falls back to the in-memory store.
import type Database from "better-sqlite3";
import { compareCanonicalText } from "./canonical-order.js";
import { ConsumptionSourceIntegrityError } from "./errors.js";
import type {
  CanonicalConsumptionFact,
  CollectionPageWrite,
  CollectionRunCompletion,
  CollectionRunRecord,
  EvidenceFactStore,
} from "./evidence-fact-store.js";
import {
  evidenceWriteAction,
  finalRunRecord,
  parseUtcTimestamp,
  validateFact,
  validateResourceName,
  validateRunId,
  withEvidenceBody,
} from "./fact-store-support.js";
import type { CollectionRunId } from "./history-collection.js";
import type { NeonSourceEvidence } from "./neon-api-source.js";

type JsonRow = { json: string };

const SCHEMA_VERSION = 2;
const SCHEMA_TABLES = new Set([
  "evidence",
  "collection_runs",
  "collection_pages",
  "facts",
  "fact_occurrences",
  "resource_names",
]);

/** The better-sqlite3 native addon is not installed/built — a degradable
 * availability condition, distinct from an integrity/permission fault. */
export class SqliteModuleUnavailableError extends Error {
  readonly moduleUnavailable = true as const;
  constructor(detail: string) {
    super(`better-sqlite3 is unavailable: ${detail}`);
    this.name = "SqliteModuleUnavailableError";
  }
}

/**
 * Whether an error from loading/constructing better-sqlite3 is the native
 * binding failing to LOAD (missing, wrong arch, ABI/libc skew) — a degradable
 * availability condition — as opposed to a database-level fault, which must
 * fail closed. SQLite's own errors carry SQLITE_* codes and are never treated
 * as a load failure.
 */
export function isSqliteBindingLoadFailure(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === "string" && code.startsWith("SQLITE_")) return false;
  const message = error instanceof Error ? error.message : String(error);
  return /Could not locate the bindings file|was compiled against a different Node\.js version|NODE_MODULE_VERSION|invalid ELF header|not a valid Win32 application|self-register|Cannot find module '[^']*\.node'|incompatible architecture|GLIBC|libstdc\+\+|The specified module could not be found|No native build was found/.test(
    message,
  );
}

export function createSqliteEvidenceFactStore(path: string): EvidenceFactStore {
  if (!path.trim()) throw new TypeError("SQLite store path must not be empty");
  const resolved = resolve(path);
  const directory = dirname(resolved);
  // Load the native addon FIRST: when it is unavailable the caller degrades to
  // in-memory, and nothing (directory, stray zero-byte store file) should have
  // been created for that run.
  let DatabaseConstructor: typeof Database;
  try {
    DatabaseConstructor = createRequire(import.meta.url)("better-sqlite3") as typeof Database;
  } catch (error) {
    throw new SqliteModuleUnavailableError(error instanceof Error ? error.message : String(error));
  }
  // The native binding only actually loads at construction; probe it with an
  // in-memory database so an unloadable binding surfaces BEFORE any directory
  // or store file is created — a fallback-to-memory run must leave no trace.
  try {
    new DatabaseConstructor(":memory:").close();
  } catch (error) {
    if (isSqliteBindingLoadFailure(error)) {
      throw new SqliteModuleUnavailableError(
        error instanceof Error ? error.message : String(error),
      );
    }
    throw error;
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // The store's directory must be owner-controlled: a group/world-writable
  // directory lets another local account swap the database (or its WAL/SHM
  // sidecars) between our O_NOFOLLOW open and SQLite's own pathname open — a
  // race no after-the-fact identity check can fully close. statSync (not
  // lstat) so a symlinked directory is judged by its target; a sticky
  // world-writable directory (/tmp) is allowed because the sticky bit blocks
  // exactly the rename/unlink swap this defends against. POSIX only.
  if (typeof process.getuid === "function") {
    const dirStat = statSync(directory);
    if (dirStat.uid !== process.getuid()) {
      throw new TypeError(
        `${directory} is not owned by the current user; refusing to keep the store in a directory another account controls`,
      );
    }
    if ((dirStat.mode & 0o022) !== 0 && (dirStat.mode & 0o1000) === 0) {
      throw new TypeError(
        `${directory} is writable by other accounts (chmod go-w to fix); refusing to keep the store in a shared-writable directory`,
      );
    }
  }
  if (lstatSync(resolved, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new TypeError(`${resolved} is a symbolic link; refusing to use it as a store`);
  }
  // Open with O_NOFOLLOW so a symlink swapped in after the lstat above (TOCTOU)
  // is refused at open time, and fchmod the resulting descriptor rather than the
  // path so the tightening lands on the file we actually opened. Owner-only mode
  // is set on create and re-asserted for a pre-existing looser file.
  const fd = openSync(resolved, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  let identity: { dev: number; ino: number };
  try {
    fchmodSync(fd, 0o600);
    const stat = fstatSync(fd);
    identity = { dev: stat.dev, ino: stat.ino };
  } finally {
    closeSync(fd);
  }
  // The native binding can also fail at construction (the JS package installed
  // but its .node binary never built or unloadable — npm --ignore-scripts, an
  // arch/ABI/libc mismatch). Those are the same degradable condition as a
  // missing module; database-level faults must still fail closed.
  let database: Database.Database;
  try {
    database = new DatabaseConstructor(resolved);
  } catch (error) {
    if (isSqliteBindingLoadFailure(error)) {
      throw new SqliteModuleUnavailableError(
        error instanceof Error ? error.message : String(error),
      );
    }
    throw error;
  }
  try {
    // better-sqlite3 reopens by pathname, outside our O_NOFOLLOW descriptor, so
    // revalidate identity: if the path was swapped for a symlink or a different
    // file between our open and its open (TOCTOU), refuse rather than operate on
    // an attacker-substituted file. Matters for a custom --store/NEON_USAGE_STORE
    // path in a directory another local account can write.
    const reopened = lstatSync(resolved);
    if (
      reopened.isSymbolicLink() ||
      reopened.dev !== identity.dev ||
      reopened.ino !== identity.ino
    ) {
      throw new TypeError(`${resolved} changed identity while opening; refusing to use it`);
    }
    database.pragma("busy_timeout = 5000");
    database.pragma("journal_mode = WAL");
    database.pragma("foreign_keys = ON");
    prepareSchema(database, resolved);
  } catch (error) {
    database.close();
    throw error;
  }

  const getRun = (runId: CollectionRunId): CollectionRunRecord | undefined => {
    const row = database
      .prepare(
        "SELECT intent_json, status, completed_at, page_count, quality_flags_json FROM collection_runs WHERE run_id = ?",
      )
      .get(runId) as
      | {
          intent_json: string;
          status: CollectionRunRecord["status"];
          completed_at: string | null;
          page_count: number;
          quality_flags_json: string;
        }
      | undefined;
    if (!row) return undefined;
    return {
      runId,
      intent: JSON.parse(row.intent_json),
      status: row.status,
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
      pageCount: row.page_count,
      qualityFlags: JSON.parse(row.quality_flags_json),
    };
  };

  const appendTransaction = database.transaction((write: CollectionPageWrite) => {
    const run = getRun(write.runId);
    if (!run) {
      throw new ConsumptionSourceIntegrityError(`Collection run ${write.runId} was not begun`);
    }
    const existingPage = getJson<CollectionPageWrite>(
      database,
      "SELECT json FROM collection_pages WHERE run_id = ? AND page_number = ?",
      write.runId,
      write.pageNumber,
    );
    if (existingPage) {
      if (!isDeepStrictEqual(existingPage, write)) {
        throw new ConsumptionSourceIntegrityError(
          `Collection page ${write.runId}:${write.pageNumber} conflicts`,
        );
      }
      return { appendedFacts: 0, existingFacts: write.facts.length };
    }
    if (run.status !== "running") {
      throw new ConsumptionSourceIntegrityError(`Collection run ${write.runId} is already final`);
    }
    if (write.pageNumber !== run.pageCount + 1) {
      throw new ConsumptionSourceIntegrityError(
        `Collection page ${write.runId}:${write.pageNumber} is not the next page for its run`,
      );
    }
    validatePage(database, write);
    let appendedFacts = 0;
    let existingFacts = 0;
    const batch = new Map<string, CanonicalConsumptionFact>();
    for (const fact of write.facts) {
      const duplicate = batch.get(fact.observationId);
      if (duplicate && !isDeepStrictEqual(duplicate, fact)) {
        throw new ConsumptionSourceIntegrityError(
          `Observation ${fact.observationId} conflicts within the collection page`,
        );
      }
      if (duplicate) continue;
      batch.set(fact.observationId, fact);
      const existing = getFact(database, fact.observationId);
      if (existing && !isDeepStrictEqual(existing, fact)) {
        throw new ConsumptionSourceIntegrityError(
          `Observation ${fact.observationId} conflicts with an existing revision`,
        );
      }
      if (existing) existingFacts += 1;
      else appendedFacts += 1;
    }
    for (const fact of batch.values()) {
      database
        .prepare(
          "INSERT OR IGNORE INTO facts(observation_id, effective_fact_id, json) VALUES (?, ?, ?)",
        )
        .run(fact.observationId, fact.effectiveFactId, JSON.stringify(fact));
      database
        .prepare(
          "INSERT INTO fact_occurrences(effective_fact_id, observation_id, run_id, page_number) VALUES (?, ?, ?, ?)",
        )
        .run(fact.effectiveFactId, fact.observationId, write.runId, write.pageNumber);
    }
    database
      .prepare("INSERT INTO collection_pages(run_id, page_number, json) VALUES (?, ?, ?)")
      .run(write.runId, write.pageNumber, JSON.stringify(write));
    database
      .prepare("UPDATE collection_runs SET page_count = ? WHERE run_id = ?")
      .run(write.pageNumber, write.runId);
    return { appendedFacts, existingFacts };
  });

  const writeEvidenceTransaction = database.transaction((record: NeonSourceEvidence) => {
    const existing = getJson<NeonSourceEvidence>(
      database,
      "SELECT json FROM evidence WHERE evidence_id = ?",
      record.evidenceId,
    );
    const action = evidenceWriteAction(existing, record);
    if (action === "insert") {
      database
        .prepare("INSERT INTO evidence(evidence_id, json) VALUES (?, ?)")
        .run(record.evidenceId, JSON.stringify(record));
    } else if (action === "upgrade_body" && existing && record.response.bodyBase64) {
      database
        .prepare("UPDATE evidence SET json = ? WHERE evidence_id = ?")
        .run(
          JSON.stringify(withEvidenceBody(existing, record.response.bodyBase64)),
          record.evidenceId,
        );
    }
  });

  return {
    async writeEvidence(record, signal) {
      if (signal.aborted) throw signal.reason;
      writeEvidenceTransaction(record);
    },
    async beginCollectionRun({ runId, intent }) {
      validateRunId(runId);
      if (!intent.sourceAccount || !intent.sourceContract) {
        throw new TypeError("collection intent requires source account and source contract");
      }
      const existing = getRun(runId);
      if (existing && !isDeepStrictEqual(existing.intent, intent)) {
        throw new ConsumptionSourceIntegrityError(`Collection run ${runId} intent does not match`);
      }
      if (!existing) {
        database
          .prepare(
            "INSERT INTO collection_runs(run_id, intent_json, status, page_count, quality_flags_json) VALUES (?, ?, 'running', 0, '[]')",
          )
          .run(runId, JSON.stringify(intent));
      }
    },
    async appendCollectionPage(write) {
      return appendTransaction(structuredClone(write));
    },
    async recordCollectionRun(record) {
      finalizeRun(database, getRun, record);
    },
    async getEvidence(evidenceId) {
      return clone(
        getJson<NeonSourceEvidence>(
          database,
          "SELECT json FROM evidence WHERE evidence_id = ?",
          evidenceId,
        ),
      );
    },
    async getFactRevision(observationId) {
      return clone(getFact(database, observationId));
    },
    async getFactRevisions(effectiveFactId) {
      return (
        database
          .prepare("SELECT json FROM facts WHERE effective_fact_id = ? ORDER BY sequence")
          .all(effectiveFactId) as JsonRow[]
      ).map((row) => JSON.parse(row.json));
    },
    async getEffectiveFactRevision(effectiveFactId, query = {}) {
      const cutoff = query.asCollectedAt
        ? parseUtcTimestamp(query.asCollectedAt, "asCollectedAt")
        : undefined;
      const rows = database
        .prepare(
          `SELECT f.json, o.observation_id, o.run_id, o.page_number, r.completed_at
           FROM fact_occurrences o
           JOIN facts f ON f.observation_id = o.observation_id
           JOIN collection_runs r ON r.run_id = o.run_id
           WHERE o.effective_fact_id = ? AND r.status = 'complete'`,
        )
        .all(effectiveFactId) as Array<{
        json: string;
        observation_id: string;
        run_id: CollectionRunId;
        page_number: number;
        completed_at: string;
      }>;
      const selected = rows
        .filter(
          (row) =>
            cutoff === undefined ||
            parseUtcTimestamp(row.completed_at, "collection completion timestamp") <= cutoff,
        )
        .sort((left, right) => {
          const leftAt = parseUtcTimestamp(left.completed_at, "collection completion timestamp");
          const rightAt = parseUtcTimestamp(right.completed_at, "collection completion timestamp");
          return (
            (leftAt > rightAt ? -1 : leftAt < rightAt ? 1 : 0) ||
            compareCanonicalText(right.run_id, left.run_id) ||
            right.page_number - left.page_number ||
            compareCanonicalText(right.observation_id, left.observation_id)
          );
        })[0];
      return selected ? JSON.parse(selected.json) : undefined;
    },
    async recordResourceNames(observations) {
      const insert = database.prepare(
        "INSERT OR IGNORE INTO resource_names(kind, resource_id, name, observed_at) VALUES (?, ?, ?, ?)",
      );
      const write = database.transaction(() => {
        for (const observation of observations) {
          validateResourceName(observation);
          insert.run(
            observation.kind,
            observation.resourceId,
            observation.name,
            observation.observedAt,
          );
        }
      });
      write();
    },
    async getResourceNames(resourceIds) {
      const statement = database.prepare(
        "SELECT name, observed_at FROM resource_names WHERE resource_id = ?",
      );
      const latest = new Map<string, string>();
      for (const resourceId of new Set(resourceIds)) {
        const rows = statement.all(resourceId) as Array<{ name: string; observed_at: string }>;
        // Pick the latest chronologically (Date.parse), not by the DB's lexical
        // order — mirrors the in-memory store so a mix of ISO precisions can't
        // let a stale name win, and keeps the two stores at parity.
        let best: { name: string; at: number } | undefined;
        for (const row of rows) {
          const at = Date.parse(row.observed_at);
          if (!best || at >= best.at) best = { name: row.name, at };
        }
        if (best) latest.set(resourceId, best.name);
      }
      return latest;
    },
    async getRunPage(runId, pageNumber) {
      return clone(
        getJson<CollectionPageWrite>(
          database,
          "SELECT json FROM collection_pages WHERE run_id = ? AND page_number = ?",
          runId,
          pageNumber,
        ),
      );
    },
    async getCollectionRun(runId) {
      return clone(getRun(runId));
    },
    async listCollectionRuns(filter) {
      const rows = database.prepare("SELECT run_id FROM collection_runs").all() as Array<{
        run_id: CollectionRunId;
      }>;
      const matches: CollectionRunRecord[] = [];
      for (const row of rows) {
        const run = getRun(row.run_id);
        if (
          run &&
          run.intent.sourceAccount === filter.sourceAccount &&
          run.intent.sourceContract === filter.sourceContract
        ) {
          matches.push(run);
        }
      }
      return matches;
    },
    close() {
      if (database.open) database.close();
    },
  };
}

function prepareSchema(database: Database.Database, path: string): void {
  const version = Number(database.pragma("user_version", { simple: true }));
  if (version > SCHEMA_VERSION) {
    throw new Error(
      `${path} uses store schema version ${version}; this build supports up to ${SCHEMA_VERSION}`,
    );
  }
  // v1 -> v2 adds the append-only resource_names table; the shared CREATE
  // TABLE IF NOT EXISTS block below performs that migration.
  if (version === 0) {
    const tables = (
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    if (!tables.every((name) => SCHEMA_TABLES.has(name))) {
      throw new Error(`${path} is not a neon-usage store`);
    }
  }
  // Create tables and bump the version atomically: migrated or not, never half.
  const migrate = database.transaction(() => {
    database.exec(`
    CREATE TABLE IF NOT EXISTS evidence (
      evidence_id TEXT PRIMARY KEY,
      json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS collection_runs (
      run_id TEXT PRIMARY KEY,
      intent_json TEXT NOT NULL,
      status TEXT NOT NULL,
      completed_at TEXT,
      page_count INTEGER NOT NULL,
      quality_flags_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS collection_pages (
      run_id TEXT NOT NULL REFERENCES collection_runs(run_id),
      page_number INTEGER NOT NULL,
      json TEXT NOT NULL,
      PRIMARY KEY (run_id, page_number)
    );
    CREATE TABLE IF NOT EXISTS facts (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      observation_id TEXT NOT NULL UNIQUE,
      effective_fact_id TEXT NOT NULL,
      json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS facts_effective ON facts(effective_fact_id, sequence);
    CREATE TABLE IF NOT EXISTS fact_occurrences (
      effective_fact_id TEXT NOT NULL,
      observation_id TEXT NOT NULL REFERENCES facts(observation_id),
      run_id TEXT NOT NULL REFERENCES collection_runs(run_id),
      page_number INTEGER NOT NULL,
      PRIMARY KEY (effective_fact_id, observation_id, run_id, page_number)
    );
    CREATE TABLE IF NOT EXISTS resource_names (
      kind TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      name TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      PRIMARY KEY (kind, resource_id, name, observed_at)
    );
    CREATE INDEX IF NOT EXISTS resource_names_latest
      ON resource_names(resource_id, observed_at);
  `);
    database.pragma(`user_version = ${SCHEMA_VERSION}`);
  });
  migrate();
}

function finalizeRun(
  database: Database.Database,
  getRun: (runId: CollectionRunId) => CollectionRunRecord | undefined,
  record: CollectionRunCompletion,
): void {
  const completedAt = parseUtcTimestamp(record.completedAt, "collection completion timestamp");
  const run = getRun(record.runId);
  if (!run) {
    throw new ConsumptionSourceIntegrityError(
      `Collection run ${record.runId} does not match its committed pages`,
    );
  }
  const finalRecord = finalRunRecord(run, record);
  if (run.status !== "running") {
    if (!isDeepStrictEqual(run, finalRecord)) {
      throw new ConsumptionSourceIntegrityError(`Collection run ${record.runId} conflicts`);
    }
    return;
  }
  const pages = database
    .prepare("SELECT json FROM collection_pages WHERE run_id = ? ORDER BY page_number")
    .all(record.runId) as JsonRow[];
  const writes = pages.map((row) => JSON.parse(row.json) as CollectionPageWrite);
  if (
    record.sourceContract !== run.intent.sourceContract ||
    (record.status !== "failed" && writes.length !== record.pageCount) ||
    writes.some((write) =>
      write.facts.some((fact) => fact.sourceContract !== record.sourceContract),
    )
  ) {
    throw new ConsumptionSourceIntegrityError(
      `Collection run ${record.runId} does not match its committed pages`,
    );
  }
  for (const write of writes) {
    for (const reference of write.evidence) {
      const evidence = getJson<NeonSourceEvidence>(
        database,
        "SELECT json FROM evidence WHERE evidence_id = ?",
        reference.evidenceId,
      );
      if (
        !evidence ||
        evidence.sourceContract !== record.sourceContract ||
        parseUtcTimestamp(evidence.completedAt, "evidence completion timestamp") > completedAt
      ) {
        throw new ConsumptionSourceIntegrityError(
          `Collection run ${record.runId} does not match its committed pages`,
        );
      }
    }
  }
  database
    .prepare(
      "UPDATE collection_runs SET status = ?, completed_at = ?, quality_flags_json = ? WHERE run_id = ?",
    )
    .run(record.status, record.completedAt, JSON.stringify(record.qualityFlags), record.runId);
}

function validatePage(database: Database.Database, write: CollectionPageWrite): void {
  validateRunId(write.runId);
  if (!Number.isInteger(write.pageNumber) || write.pageNumber < 1) {
    throw new TypeError("page number must be a positive integer");
  }
  for (const reference of write.evidence) {
    const evidence = getJson<NeonSourceEvidence>(
      database,
      "SELECT json FROM evidence WHERE evidence_id = ?",
      reference.evidenceId,
    );
    if (!evidence || evidence.response.payloadHash !== reference.payloadHash) {
      throw new ConsumptionSourceIntegrityError(
        `Evidence ${reference.evidenceId} is missing or has a conflicting payload hash`,
      );
    }
    parseUtcTimestamp(evidence.completedAt, "evidence completion timestamp");
  }
  for (const fact of write.facts) {
    validateFact(fact);
    const reference = write.evidence.find(
      (candidate) => candidate.evidenceId === fact.provenance.evidenceId,
    );
    const evidence = reference
      ? getJson<NeonSourceEvidence>(
          database,
          "SELECT json FROM evidence WHERE evidence_id = ?",
          reference.evidenceId,
        )
      : undefined;
    if (
      !reference ||
      !evidence ||
      reference.payloadHash !== fact.provenance.payloadHash ||
      evidence.sourceContract !== fact.sourceContract
    ) {
      throw new ConsumptionSourceIntegrityError(
        `Observation ${fact.observationId} is not linked to page evidence`,
      );
    }
  }
}

function getFact(database: Database.Database, observationId: string) {
  return getJson<CanonicalConsumptionFact>(
    database,
    "SELECT json FROM facts WHERE observation_id = ?",
    observationId,
  );
}

function getJson<T>(
  database: Database.Database,
  sql: string,
  ...parameters: unknown[]
): T | undefined {
  const row = database.prepare(sql).get(...parameters) as JsonRow | undefined;
  return row ? JSON.parse(row.json) : undefined;
}

function clone<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}
