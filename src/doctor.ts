// The `doctor` command: an OFFLINE diagnosis of local setup — credential
// source and OAuth-expiry state, resolved context, store path and health,
// the effective request budget, and the bundled rate-card revision. It makes
// no Neon API requests, creates nothing (the store is opened read-only and
// only if it already exists), and never includes credential values.

import { lstatSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
// Type-only: erased at compile, so importing this module never loads the
// optional native dependency.
import type Database from "better-sqlite3";
import { defaultStorePath } from "./default-dependencies.js";
import { diagnoseNeonCliContext, type NeonCliDiagnosis } from "./neon-cli-context.js";
import { neonDocumentationRateCard } from "./rate-card.js";

export type DoctorStoreFile =
  | { exists: false }
  | {
      exists: true;
      sizeBytes: number;
      completeRuns: number;
      lastCompleteCollectionAt: string | null;
    }
  | { exists: true; sizeBytes?: number; error: string };

export type DoctorReport = {
  disposition: "doctor";
  generatedAt: string;
  /** Always true: doctor never calls the Neon API. */
  offline: true;
  /** Standing caveat, present in JSON as well as the table view. */
  sensitivity: "output includes local paths and account context; review before sharing";
  credential: NeonCliDiagnosis["credential"];
  context: NeonCliDiagnosis["context"];
  store: {
    path: string;
    pathSource: "flag" | "env" | "default";
    /** Whether the optional better-sqlite3 native module loads here. */
    persistence: "available" | "unavailable";
    persistenceDetail?: string;
    file: DoctorStoreFile;
  };
  requestBudget: { limit: number; intervalMs: number; source: "flag" | "built-in default" };
  collectionBudget: {
    maxDurationMs: number;
    maxItems: number;
    maxFacts: number;
    maxBytes: number;
    source: "flags" | "built-in default";
  };
  rateCard: { revision: string; retrievedAt: string };
};

export type DoctorInputs = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  now: Date;
  /** The CLI's global options; the same names resolveDefaultContext consumes. */
  options: {
    apiKey?: string;
    profile?: string;
    contextFile?: string;
    configDir?: string;
    store?: string;
  };
  /** Pre-parsed --request-budget, when the flag was passed. */
  requestBudget?: { limit: number; intervalMs: number };
  /** Pre-parsed collection-budget dials, when any were passed. */
  collectionBudget?: {
    maxDurationMs?: number;
    maxItems?: number;
    maxFacts?: number;
    maxBytes?: number;
  };
};

export function createDoctorReport(inputs: DoctorInputs): DoctorReport {
  const { cwd, env, now, options } = inputs;
  const diagnosis = diagnoseNeonCliContext({
    cwd,
    env,
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    ...(options.profile ? { profile: options.profile } : {}),
    ...(options.contextFile ? { contextFile: options.contextFile } : {}),
    ...(options.configDir ? { configDir: options.configDir } : {}),
  });
  const storePath = options.store ?? defaultStorePath(env);
  const pathSource = options.store ? "flag" : env.NEON_USAGE_STORE?.trim() ? "env" : "default";
  const module = loadSqlite();
  return {
    disposition: "doctor",
    generatedAt: now.toISOString(),
    offline: true,
    sensitivity: "output includes local paths and account context; review before sharing",
    credential: diagnosis.credential,
    context: diagnosis.context,
    store: {
      path: resolve(storePath),
      pathSource,
      persistence: "Database" in module ? "available" : "unavailable",
      ...("error" in module ? { persistenceDetail: module.error } : {}),
      file: inspectStoreFile(resolve(storePath), "Database" in module ? module.Database : null),
    },
    requestBudget: inputs.requestBudget
      ? { ...inputs.requestBudget, source: "flag" }
      : { limit: 45, intervalMs: 60_000, source: "built-in default" },
    collectionBudget: {
      maxDurationMs: inputs.collectionBudget?.maxDurationMs ?? 10 * 60_000,
      maxItems: inputs.collectionBudget?.maxItems ?? 10_000,
      maxFacts: inputs.collectionBudget?.maxFacts ?? 1_000_000,
      maxBytes: inputs.collectionBudget?.maxBytes ?? 100_000_000,
      source: inputs.collectionBudget ? "flags" : "built-in default",
    },
    rateCard: {
      revision: neonDocumentationRateCard.revision,
      retrievedAt: neonDocumentationRateCard.retrievedAt,
    },
  };
}

type SqliteConstructor = new (
  path: string,
  options?: { readonly?: boolean; fileMustExist?: boolean },
) => Database.Database;

function loadSqlite(): { Database: SqliteConstructor } | { error: string } {
  // Mirrors the store's own probe (load, then construct :memory:) without
  // touching disk; any failure means this run would degrade to in-memory.
  try {
    const DatabaseConstructor = createRequire(import.meta.url)(
      "better-sqlite3",
    ) as SqliteConstructor;
    new DatabaseConstructor(":memory:").close();
    return { Database: DatabaseConstructor };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // First line only, minus a dangling "Tried:" whose list lived on the
    // following lines — a truncated clause reads worse than none.
    const firstLine = (message.split("\n")[0] ?? "unavailable").replace(/[.,]?\s*Tried:\s*$/, "");
    return { error: firstLine };
  }
}

function inspectStoreFile(path: string, Sqlite: SqliteConstructor | null): DoctorStoreFile {
  const linkStat = lstatSync(path, { throwIfNoEntry: false });
  if (!linkStat) return { exists: false };
  if (linkStat.isSymbolicLink()) {
    // Same posture as the store itself: a symlinked store path is refused.
    return { exists: true, error: "the store path is a symbolic link; the store refuses symlinks" };
  }
  const sizeBytes = statSync(path).size;
  if (!Sqlite) {
    return { exists: true, sizeBytes, error: "cannot inspect: better-sqlite3 is unavailable" };
  }
  try {
    // Read-only with fileMustExist: inspection must never create or migrate.
    const database = new Sqlite(path, { readonly: true, fileMustExist: true });
    try {
      const row = database
        .prepare(
          "SELECT count(*) AS runs, max(completed_at) AS last FROM collection_runs WHERE status = 'complete'",
        )
        .get() as { runs: number; last: string | null };
      return {
        exists: true,
        sizeBytes,
        completeRuns: row.runs,
        lastCompleteCollectionAt: row.last ?? null,
      };
    } finally {
      database.close();
    }
  } catch (error) {
    return {
      exists: true,
      sizeBytes,
      error: `cannot inspect: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

const MINUTE_MS = 60_000;

function relativeTime(iso: string, now: Date): string {
  const delta = Date.parse(iso) - now.getTime();
  const magnitude = Math.abs(delta);
  const unit =
    magnitude >= 36 * 60 * MINUTE_MS
      ? `${Math.round(magnitude / (24 * 60 * MINUTE_MS))}d`
      : magnitude >= 90 * MINUTE_MS
        ? `${Math.round(magnitude / (60 * MINUTE_MS))}h`
        : `${Math.max(1, Math.round(magnitude / MINUTE_MS))}m`;
  return delta >= 0 ? `in ~${unit}` : `~${unit} ago`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} kB`;
  return `${bytes} B`;
}

/** Human preview; the JSON output is the machine contract. */
export function renderDoctorReport(report: DoctorReport): string {
  const lines: string[] = [
    "neon-usage doctor · local diagnosis (no Neon API requests)",
    "Output includes local paths and account context — review before sharing.",
    "",
  ];
  const now = new Date(report.generatedAt);

  const credential = report.credential;
  if (credential.state === "resolved") {
    const label =
      credential.source === "profile"
        ? `profile ${credential.profile} (${credential.kind === "oauth" ? "Neon CLI login" : "API key"})`
        : credential.source === "flag"
          ? "--api-key flag"
          : credential.source === "env"
            ? "NEON_API_KEY (environment)"
            : "NEON_API_KEY (.env.local)";
    lines.push(`Credential   ${label}`);
    if (credential.oauthExpiresAt) {
      lines.push(
        `             expires ${credential.oauthExpiresAt} (${relativeTime(credential.oauthExpiresAt, now)}); the Neon CLI refreshes it, this tool does not`,
      );
    }
    if (credential.credentialsPath) lines.push(`             ${credential.credentialsPath}`);
  } else {
    lines.push(`Credential   ${credential.state.toUpperCase()}: ${credential.detail}`);
  }

  if ("error" in report.context) {
    lines.push(`Context      ERROR: ${report.context.error}`);
  } else {
    const parts = [
      `org ${report.context.organizationId ?? "(unset)"}`,
      `project ${report.context.projectId ?? "(unset)"}`,
      `branch ${report.context.branch ?? "(unset)"}`,
    ];
    lines.push(`Context      ${parts.join(" · ")}`);
    if (report.context.path) lines.push(`             from ${report.context.path}`);
  }

  const store = report.store;
  const sourceNote =
    store.pathSource === "flag"
      ? "--store"
      : store.pathSource === "env"
        ? "NEON_USAGE_STORE"
        : "default";
  lines.push(`Store        ${store.path} (${sourceNote})`);
  // Say which backend a run would actually use, in both states: SQLite
  // persistence, or the degraded in-memory fallback and why.
  if (store.persistence === "unavailable") {
    lines.push(
      `             SQLite persistence UNAVAILABLE — runs use an in-memory store, nothing persists: ${store.persistenceDetail ?? "better-sqlite3 did not load"}`,
    );
  } else {
    lines.push(
      "             SQLite persistence available (collections persist and serve from the store)",
    );
  }
  if (!store.file.exists) {
    lines.push("             not created yet (first collection creates it)");
  } else if ("error" in store.file) {
    lines.push(
      `             ${store.file.sizeBytes !== undefined ? `${formatBytes(store.file.sizeBytes)} · ` : ""}${store.file.error}`,
    );
  } else {
    const last = store.file.lastCompleteCollectionAt;
    lines.push(
      `             ${formatBytes(store.file.sizeBytes)} · ${store.file.completeRuns} complete collection run(s)` +
        (last ? ` · last ${last} (${relativeTime(last, now)})` : ""),
    );
  }

  lines.push(
    `Budget       ${report.requestBudget.limit} requests/${Math.round(report.requestBudget.intervalMs / MINUTE_MS)}min (${report.requestBudget.source})`,
  );
  const collection = report.collectionBudget;
  lines.push(
    `             per collection: ${Math.round(collection.maxDurationMs / MINUTE_MS)}min · ` +
      `${collection.maxItems.toLocaleString("en-US")} items · ` +
      `${collection.maxFacts.toLocaleString("en-US")} facts · ` +
      `${formatBytes(collection.maxBytes)} (${collection.source})`,
  );
  lines.push(`Rate card    ${report.rateCard.revision} (retrieved ${report.rateCard.retrievedAt})`);
  return `${lines.join("\n")}\n`;
}
