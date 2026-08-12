import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CanonicalConsumptionFact, EvidenceFactStore } from "../src/evidence-fact-store.js";
import { effectiveFactIdentity, observationRevisionIdentity } from "../src/fact-identity.js";
import { createInMemoryEvidenceFactStore } from "../src/in-memory-fact-store.js";
import {
  createSqliteEvidenceFactStore,
  isSqliteBindingLoadFailure,
} from "../src/sqlite-fact-store.js";
import { requireSqlite, sqliteModule } from "./support/sqlite-availability.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

type StoreBackend = [
  string,
  () => { store: EvidenceFactStore; reopen: (() => EvidenceFactStore) | undefined },
];

const storeBackends: StoreBackend[] = [
  ["memory", () => ({ store: createInMemoryEvidenceFactStore(), reopen: undefined })],
  ...(sqliteModule
    ? [
        [
          "sqlite",
          () => {
            const directory = mkdtempSync(join(tmpdir(), "neon-usage-"));
            directories.push(directory);
            const path = join(directory, "store.sqlite");
            return {
              store: createSqliteEvidenceFactStore(path),
              reopen: () => createSqliteEvidenceFactStore(path),
            };
          },
        ] satisfies StoreBackend,
      ]
    : []),
];

describe.each(storeBackends)("%s evidence fact store", (_name, create) => {
  it("persists immutable intent and an atomic resumable page", async () => {
    const created = create();
    const intent = {
      sourceAccount: "account-1",
      sourceContract: "consumption-history-v2-projects",
      request: { organizationId: "org-1", metrics: ["compute_unit_seconds"] },
    } as const;
    await created.store.beginCollectionRun({ runId: "run_resume", intent });
    await created.store.appendCollectionPage({
      runId: "run_resume",
      pageNumber: 1,
      cursorIn: null,
      cursorOut: "next",
      nextCursor: "next",
      terminalState: "continue",
      page: { projects: [{ projectId: "project-1", periods: [] }], nextCursor: "next" },
      evidence: [],
      facts: [],
    });

    const reopened = created.reopen?.() ?? created.store;
    expect(await reopened.getCollectionRun("run_resume")).toEqual({
      runId: "run_resume",
      intent,
      status: "running",
      pageCount: 1,
      qualityFlags: [],
    });
    expect(await reopened.getRunPage("run_resume", 1)).toMatchObject({
      cursorIn: null,
      cursorOut: "next",
      nextCursor: "next",
      terminalState: "continue",
      page: { projects: [{ projectId: "project-1", periods: [] }], nextCursor: "next" },
    });
    reopened.close();
    if (reopened !== created.store) created.store.close();
  });

  it("keeps an exact retry idempotent and rejects a conflicting page without mutation", async () => {
    const { store } = create();
    await begin(store, "run_atomic");
    const write = {
      runId: "run_atomic" as const,
      pageNumber: 1,
      cursorIn: null,
      cursorOut: null,
      nextCursor: null,
      terminalState: "complete" as const,
      page: { projects: [], nextCursor: null },
      evidence: [],
      facts: [],
    };
    await expect(store.appendCollectionPage(write)).resolves.toEqual({
      appendedFacts: 0,
      existingFacts: 0,
    });
    await expect(store.appendCollectionPage(structuredClone(write))).resolves.toEqual({
      appendedFacts: 0,
      existingFacts: 0,
    });
    await expect(
      store.appendCollectionPage({ ...write, page: { projects: [], nextCursor: "different" } }),
    ).rejects.toThrow("conflicts");
    expect((await store.getRunPage("run_atomic", 1))?.page).toEqual({
      projects: [],
      nextCursor: null,
    });
    store.close();
  });

  it("reopens evidence, fact revisions, occurrences, and final run state", async () => {
    const created = create();
    const value = fact();
    await created.store.writeEvidence(evidence(), new AbortController().signal);
    await begin(created.store, "run_complete");
    await created.store.appendCollectionPage({
      runId: "run_complete",
      pageNumber: 1,
      cursorIn: null,
      cursorOut: null,
      nextCursor: null,
      terminalState: "complete",
      page: { projects: [{ projectId: "project-1", periods: [] }], nextCursor: null },
      evidence: [{ evidenceId: "evidence:a", payloadHash: `sha256:${"a".repeat(64)}` }],
      facts: [value],
    });
    await created.store.recordCollectionRun({
      runId: "run_complete",
      sourceContract: "consumption-history-v2-projects",
      status: "complete",
      completedAt: "2026-08-08T00:01:00Z",
      pageCount: 1,
      qualityFlags: [],
    });
    created.store.close();

    const reopened = created.reopen?.() ?? created.store;
    expect(await reopened.getEvidence("evidence:a")).toEqual(evidence());
    expect(await reopened.getFactRevisions(value.effectiveFactId)).toEqual([value]);
    expect(await reopened.getEffectiveFactRevision(value.effectiveFactId)).toEqual(value);
    expect((await reopened.getCollectionRun("run_complete"))?.status).toBe("complete");
    reopened.close();
  });

  it("treats exact duplicate finalization as idempotent and rejects conflicts", async () => {
    const { store } = create();
    await begin(store, "run_final");
    await store.appendCollectionPage({
      runId: "run_final",
      pageNumber: 1,
      cursorIn: null,
      cursorOut: null,
      nextCursor: null,
      terminalState: "complete",
      page: { projects: [], nextCursor: null },
      evidence: [],
      facts: [],
    });
    const completion = {
      runId: "run_final" as const,
      sourceContract: "consumption-history-v2-projects",
      status: "complete" as const,
      completedAt: "2026-08-08T00:01:00Z",
      pageCount: 1,
      qualityFlags: [],
    };
    await store.recordCollectionRun(completion);
    await expect(store.recordCollectionRun(structuredClone(completion))).resolves.toBeUndefined();
    expect(await store.getCollectionRun("run_final")).toEqual({
      runId: "run_final",
      intent: {
        sourceAccount: "account-1",
        sourceContract: "consumption-history-v2-projects",
        request: { organizationId: "org-1" },
      },
      status: "complete",
      completedAt: "2026-08-08T00:01:00Z",
      pageCount: 1,
      qualityFlags: [],
    });
    await expect(store.recordCollectionRun({ ...completion, status: "partial" })).rejects.toThrow(
      "conflicts",
    );
    store.close();
  });

  it("upgrades hash-only evidence in place when the exact body arrives", async () => {
    const { store } = create();
    const bytes = Buffer.from(JSON.stringify({ projects: [] }));
    const payloadHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const signal = new AbortController().signal;
    const hashOnly = evidence({ payloadHash });
    await store.writeEvidence(hashOnly, signal);
    await store.writeEvidence(
      evidence({ payloadHash, bodyBase64: bytes.toString("base64") }),
      signal,
    );
    expect((await store.getEvidence("evidence:a"))?.response.bodyBase64).toBe(
      bytes.toString("base64"),
    );
    await store.writeEvidence(structuredClone(hashOnly), signal);
    expect((await store.getEvidence("evidence:a"))?.response.bodyBase64).toBe(
      bytes.toString("base64"),
    );
    store.close();
  });

  it("rejects evidence whose body does not hash to its payload identity", async () => {
    const { store } = create();
    const signal = new AbortController().signal;
    await expect(
      store.writeEvidence(
        evidence({ bodyBase64: Buffer.from("something else").toString("base64") }),
        signal,
      ),
    ).rejects.toThrow("does not match its payload hash");
    store.close();
  });
});

const nameBackends: Array<[string, () => EvidenceFactStore]> = [
  ["memory", () => createInMemoryEvidenceFactStore()],
  ...(sqliteModule
    ? [
        [
          "sqlite",
          () => {
            const directory = mkdtempSync(join(tmpdir(), "neon-usage-"));
            directories.push(directory);
            return createSqliteEvidenceFactStore(join(directory, "names.sqlite"));
          },
        ] satisfies [string, () => EvidenceFactStore],
      ]
    : []),
];

describe.each(nameBackends)("%s resource names", (_name, create) => {
  it("records observations idempotently and returns the latest name", async () => {
    const store = create();
    await store.recordResourceNames([
      {
        kind: "project",
        resourceId: "project-1",
        name: "Old Name",
        observedAt: "2026-08-09T00:00:00Z",
      },
    ]);
    await store.recordResourceNames([
      {
        kind: "project",
        resourceId: "project-1",
        name: "New Name",
        observedAt: "2026-08-10T00:00:00Z",
      },
      {
        kind: "project",
        resourceId: "project-1",
        name: "New Name",
        observedAt: "2026-08-10T00:00:00Z",
      },
    ]);
    await expect(store.getResourceNames(["project-1", "project-missing"])).resolves.toEqual(
      new Map([["project-1", "New Name"]]),
    );
    await expect(
      store.recordResourceNames([
        {
          kind: "project",
          resourceId: "INVALID ID",
          name: "x",
          observedAt: "2026-08-10T00:00:00Z",
        },
      ]),
    ).rejects.toThrow("resource ID is malformed");
    store.close();
  });

  it("picks the latest name chronologically, not lexically, across ISO precisions", async () => {
    const store = create();
    // The fractional-second instant is 500ms LATER but sorts BEFORE the whole-
    // second string lexically ("." < "Z"), so a string ORDER BY would pick the
    // stale whole-second name. Both stores must agree on the chronological one.
    await store.recordResourceNames([
      { kind: "project", resourceId: "p-1", name: "stale", observedAt: "2026-08-01T00:00:00Z" },
      { kind: "project", resourceId: "p-1", name: "newer", observedAt: "2026-08-01T00:00:00.500Z" },
    ]);
    await expect(store.getResourceNames(["p-1"])).resolves.toEqual(new Map([["p-1", "newer"]]));
    store.close();
  });
});

describe.skipIf(!sqliteModule)("sqlite store schema version", () => {
  it("stamps new stores and refuses newer or foreign databases", () => {
    const directory = mkdtempSync(join(tmpdir(), "neon-usage-"));
    directories.push(directory);
    const path = join(directory, "versioned.sqlite");
    createSqliteEvidenceFactStore(path).close();

    const raw = new (requireSqlite())(path);
    expect(Number(raw.pragma("user_version", { simple: true }))).toBe(2);
    raw.pragma("user_version = 99");
    raw.close();
    expect(() => createSqliteEvidenceFactStore(path)).toThrow("schema version 99");

    const foreignPath = join(directory, "foreign.sqlite");
    const foreign = new (requireSqlite())(foreignPath);
    foreign.exec("CREATE TABLE users (id INTEGER PRIMARY KEY)");
    foreign.close();
    expect(() => createSqliteEvidenceFactStore(foreignPath)).toThrow("is not a neon-usage store");
  });

  it("migrates a v1 store to v2 preserving data and adding resource names", async () => {
    const directory = mkdtempSync(join(tmpdir(), "neon-usage-"));
    directories.push(directory);
    const path = join(directory, "v1.sqlite");
    const first = createSqliteEvidenceFactStore(path);
    await begin(first, "run_v1");
    first.close();
    const raw = new (requireSqlite())(path);
    raw.exec("DROP TABLE resource_names");
    raw.pragma("user_version = 1");
    raw.close();

    const migrated = createSqliteEvidenceFactStore(path);
    await expect(migrated.getCollectionRun("run_v1")).resolves.toMatchObject({
      status: "running",
    });
    await migrated.recordResourceNames([
      {
        kind: "project",
        resourceId: "project-1",
        name: "Migrated",
        observedAt: "2026-08-10T00:00:00Z",
      },
    ]);
    await expect(migrated.getResourceNames(["project-1"])).resolves.toEqual(
      new Map([["project-1", "Migrated"]]),
    );
    migrated.close();
  });
});

async function begin(store: EvidenceFactStore, runId: `run_${string}`) {
  await store.beginCollectionRun({
    runId,
    intent: {
      sourceAccount: "account-1",
      sourceContract: "consumption-history-v2-projects",
      request: { organizationId: "org-1" },
    },
  });
}

function fact(): CanonicalConsumptionFact {
  const identity = {
    sourceContract: "consumption-history-v2-projects",
    scope: { kind: "project" as const, organizationId: "org-1", projectId: "project-1" },
    periodId: "period-1",
    bucket: { start: "2026-08-07T00:00:00Z", end: "2026-08-08T00:00:00Z" },
    metricName: "compute_unit_seconds",
  };
  const payloadHash = `sha256:${"a".repeat(64)}`;
  return {
    observationId: observationRevisionIdentity({ ...identity, payloadHash }),
    effectiveFactId: effectiveFactIdentity(identity),
    sourceContract: identity.sourceContract,
    scope: identity.scope,
    billingPeriod: {
      sourcePeriodId: identity.periodId,
      plan: "launch",
      start: "2026-08-01T00:00:00Z",
    },
    bucket: identity.bucket,
    metric: { sourceName: identity.metricName },
    value: { decimalInteger: "1" },
    presence: "reported",
    provenance: {
      evidenceId: "evidence:a",
      payloadHash,
      sourcePath: "/projects/0/periods/0/consumption/0/metrics/0",
    },
  };
}

function evidence(overrides: { payloadHash?: string; bodyBase64?: string } = {}) {
  return {
    evidenceId: "evidence:a",
    sourceAccount: "account-1",
    sourceContract: "consumption-history-v2-projects",
    requestedAt: "2026-08-08T00:00:00Z",
    completedAt: "2026-08-08T00:00:01Z",
    request: {
      method: "GET" as const,
      path: "/consumption_history/v2/projects",
      query: "",
      cursorIn: null,
      fingerprint: "sha256:fingerprint",
    },
    response: {
      status: 200,
      cursorOut: null,
      payloadHash: overrides.payloadHash ?? `sha256:${"a".repeat(64)}`,
      ...(overrides.bodyBase64 ? { bodyBase64: overrides.bodyBase64 } : {}),
    },
    attempt: 1,
  };
}

describe.skipIf(!sqliteModule)("sqlite store directory safety", () => {
  it("refuses a store directory writable by other accounts", () => {
    if (typeof process.getuid !== "function") return; // POSIX-only check
    const directory = mkdtempSync(join(tmpdir(), "neon-usage-shared-"));
    directories.push(directory);
    chmodSync(directory, 0o777);
    expect(() => createSqliteEvidenceFactStore(join(directory, "store.sqlite"))).toThrow(
      /writable by other accounts/,
    );
  });
});

describe("binding-failure classification", () => {
  it("classifies loader failures as module-unavailable but never SQLITE_* faults", () => {
    const loadFailures = [
      "Could not locate the bindings file. Tried: ...",
      "Module did not self-register.",
      "The module was compiled against a different Node.js version using NODE_MODULE_VERSION 108.",
      "invalid ELF header",
      "%1 is not a valid Win32 application",
      "dlopen(...): tried: '...' (mach-o file, but is an incompatible architecture (have 'arm64', need 'x86_64'))",
      "/lib64/libstdc++.so.6: version `GLIBCXX_3.4.29' not found",
      "/lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.29' not found",
      "The specified module could not be found. \\\\?\\C:\\...\\better_sqlite3.node",
      "No native build was found for platform=linux arch=x64",
      "Cannot find module './build/Release/better_sqlite3.node'",
    ];
    for (const message of loadFailures) {
      expect(isSqliteBindingLoadFailure(new Error(message))).toBe(true);
    }

    const databaseFaults = [
      Object.assign(new Error("file is not a database"), { code: "SQLITE_NOTADB" }),
      Object.assign(new Error("unable to open database file"), { code: "SQLITE_CANTOPEN" }),
      Object.assign(new Error("database disk image is malformed"), { code: "SQLITE_CORRUPT" }),
      new Error("EACCES: permission denied, open '/x/store.sqlite'"),
    ];
    for (const fault of databaseFaults) {
      expect(isSqliteBindingLoadFailure(fault)).toBe(false);
    }

    // A GLIBC-looking message with an SQLITE_ code stays a database fault.
    expect(
      isSqliteBindingLoadFailure(
        Object.assign(new Error("GLIBC mention inside an sqlite error"), { code: "SQLITE_ERROR" }),
      ),
    ).toBe(false);
  });
});
