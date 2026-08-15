import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { createDoctorReport, type DoctorReport, renderDoctorReport } from "../src/doctor.js";
import { createSqliteEvidenceFactStore } from "../src/index.js";
import { diagnoseNeonCliContext } from "../src/neon-cli-context.js";
import { sqliteModule } from "./support/sqlite-availability.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "neon-usage-doctor-"));
  temporaryDirectories.push(directory);
  return directory;
}

/** A config home holding one profile credential file. */
function configHome(credential: Record<string, unknown>): string {
  const home = temporaryDirectory();
  const neonDir = join(home, "neon");
  mkdirSync(neonDir, { recursive: true });
  writeFileSync(join(neonDir, "credentials.json"), JSON.stringify(credential), { mode: 0o600 });
  return home;
}

describe("diagnoseNeonCliContext", () => {
  it("reports a profile OAuth login with its expiry, never the token", () => {
    const home = configHome({
      type: "oauth",
      access_token: "secret-token",
      expires_at: "2027-01-01T00:00:00Z",
    });
    const cwd = temporaryDirectory();
    const diagnosis = diagnoseNeonCliContext({
      cwd,
      env: { XDG_CONFIG_HOME: home, HOME: home },
    });
    expect(diagnosis.credential).toMatchObject({
      state: "resolved",
      source: "profile",
      profile: "DEFAULT",
      kind: "oauth",
      oauthExpiresAt: "2027-01-01T00:00:00.000Z",
    });
    expect(JSON.stringify(diagnosis)).not.toContain("secret-token");
  });

  it("reports an expired login as an error with the refresh hint, not a crash", () => {
    const home = configHome({
      type: "oauth",
      access_token: "secret-token",
      expires_at: "2020-01-01T00:00:00Z",
    });
    const diagnosis = diagnoseNeonCliContext({
      cwd: temporaryDirectory(),
      env: { XDG_CONFIG_HOME: home, HOME: home },
    });
    expect(diagnosis.credential.state).toBe("error");
    expect(diagnosis.credential.detail).toContain("expired at 2020-01-01");
    expect(diagnosis.credential.detail).toContain("neon auth");
    expect(JSON.stringify(diagnosis)).not.toContain("secret-token");
  });

  it("distinguishes flag, environment, and .env.local key sources", () => {
    const cwd = temporaryDirectory();
    writeFileSync(join(cwd, ".env.local"), "NEON_API_KEY=local-secret\n", { mode: 0o600 });
    const empty = temporaryDirectory();

    expect(
      diagnoseNeonCliContext({ cwd: empty, env: {}, apiKey: "flag-secret" }).credential,
    ).toMatchObject({ state: "resolved", source: "flag" });
    expect(
      diagnoseNeonCliContext({ cwd: empty, env: { NEON_API_KEY: "env-secret", HOME: empty } })
        .credential,
    ).toMatchObject({ state: "resolved", source: "env" });
    expect(diagnoseNeonCliContext({ cwd, env: { HOME: cwd } }).credential).toMatchObject({
      state: "resolved",
      source: "env-local",
    });
  });

  it("reports missing credentials with the fix hint and resolves .neon context anyway", () => {
    const cwd = temporaryDirectory();
    writeFileSync(
      join(cwd, ".neon"),
      JSON.stringify({ orgId: "org-1", projectId: "project-1", branch: "main" }),
    );
    const diagnosis = diagnoseNeonCliContext({
      cwd,
      env: { HOME: cwd, XDG_CONFIG_HOME: join(cwd, "nowhere") },
    });
    expect(diagnosis.credential).toMatchObject({ state: "missing", profile: "DEFAULT" });
    expect(diagnosis.credential.detail).toContain("neon auth");
    expect(diagnosis.context).toMatchObject({
      organizationId: "org-1",
      projectId: "project-1",
      branch: "main",
      path: join(cwd, ".neon"),
    });
  });

  it("reports a malformed .neon as a context error without failing the credential half", () => {
    const cwd = temporaryDirectory();
    writeFileSync(join(cwd, ".neon"), "not json");
    const diagnosis = diagnoseNeonCliContext({
      cwd,
      env: { HOME: cwd, XDG_CONFIG_HOME: join(cwd, "nowhere"), NEON_API_KEY: "env-secret" },
    });
    expect(diagnosis.credential).toMatchObject({ state: "resolved", source: "env" });
    expect("error" in diagnosis.context && diagnosis.context.error).toContain(".neon");
  });
});

describe("createDoctorReport", () => {
  const now = new Date("2026-08-12T12:00:00Z");

  it("reports an absent store without creating it", () => {
    const cwd = temporaryDirectory();
    const storePath = join(cwd, "nested", "store.sqlite");
    const report = createDoctorReport({
      cwd,
      env: { HOME: cwd, XDG_CONFIG_HOME: join(cwd, "nowhere"), NEON_USAGE_STORE: storePath },
      now,
      options: {},
    });
    expect(report).toMatchObject({
      disposition: "doctor",
      offline: true,
      generatedAt: "2026-08-12T12:00:00.000Z",
      store: {
        pathSource: "env",
        persistence: sqliteModule ? "available" : "unavailable",
        file: { exists: false },
      },
      requestBudget: { limit: 180, intervalMs: 60_000 },
    });
    expect(report.rateCard.revision).toMatch(/^neon-docs-/);
    expect(report.requestBudget).toEqual({
      limit: 180,
      intervalMs: 60_000,
      source: "built-in default",
    });
    // A dialed budget is reported with its source.
    expect(
      createDoctorReport({
        cwd,
        env: { HOME: cwd, NEON_USAGE_STORE: storePath },
        now,
        options: {},
        requestBudget: { limit: 120, intervalMs: 60_000 },
      }).requestBudget,
    ).toEqual({ limit: 120, intervalMs: 60_000, source: "flag" });
    expect(report.collectionBudget).toEqual({
      maxDurationMs: 600_000,
      maxItems: 10_000,
      maxFacts: 1_000_000,
      maxBytes: 100_000_000,
      source: "built-in default",
    });
    expect(
      createDoctorReport({
        cwd,
        env: { HOME: cwd, NEON_USAGE_STORE: storePath },
        now,
        options: {},
        collectionBudget: { maxDurationMs: 300_000 },
      }).collectionBudget,
    ).toMatchObject({ maxDurationMs: 300_000, maxItems: 10_000, source: "flags" });
    // Inspection is read-only: the store file and its directory stay absent.
    expect(
      createDoctorReport({
        cwd,
        env: { HOME: cwd, NEON_USAGE_STORE: storePath },
        now,
        options: {},
      }).store.file,
    ).toEqual({ exists: false });
  });

  it.skipIf(!sqliteModule)(
    "inspects an existing store read-only: size and complete-run recency",
    async () => {
      const cwd = temporaryDirectory();
      const storePath = join(cwd, "store.sqlite");
      const store = createSqliteEvidenceFactStore(storePath);
      await store.beginCollectionRun({
        runId: "run_doctor",
        intent: { sourceAccount: "account-1", sourceContract: "test-pages", request: {} },
      });
      await store.appendCollectionPage({
        runId: "run_doctor",
        pageNumber: 1,
        cursorIn: null,
        cursorOut: null,
        nextCursor: null,
        terminalState: "complete",
        page: { items: [] },
        evidence: [],
        facts: [],
      });
      await store.recordCollectionRun({
        runId: "run_doctor",
        sourceContract: "test-pages",
        status: "complete",
        completedAt: "2026-08-12T11:00:00Z",
        pageCount: 1,
        qualityFlags: [],
      });
      store.close();

      const report = createDoctorReport({
        cwd,
        env: { HOME: cwd },
        now,
        options: { store: storePath },
      });
      expect(report.store.pathSource).toBe("flag");
      const file = report.store.file;
      if (!file.exists || "error" in file)
        throw new Error(`unexpected file state ${JSON.stringify(file)}`);
      expect(file.sizeBytes).toBeGreaterThan(0);
      expect(file.completeRuns).toBe(1);
      expect(file.lastCompleteCollectionAt).toBeTruthy();
    },
  );

  it("refuses to inspect a symlinked store path, like the store itself", () => {
    const cwd = temporaryDirectory();
    writeFileSync(join(cwd, "elsewhere"), "x");
    symlinkSync(join(cwd, "elsewhere"), join(cwd, "linked.sqlite"));
    const report = createDoctorReport({
      cwd,
      env: { HOME: cwd },
      now,
      options: { store: join(cwd, "linked.sqlite") },
    });
    expect(report.store.file).toMatchObject({
      exists: true,
      error: expect.stringContaining("symbolic link"),
    });
  });
});

describe("doctor rendering and CLI wiring", () => {
  it("renders the states a user must act on", () => {
    const report: DoctorReport = {
      disposition: "doctor",
      generatedAt: "2026-08-12T12:00:00.000Z",
      offline: true,
      sensitivity: "output includes local paths and account context; review before sharing",
      credential: {
        state: "resolved",
        source: "profile",
        profile: "DEFAULT",
        kind: "oauth",
        credentialsPath: "/home/x/.config/neon/credentials.json",
        oauthExpiresAt: "2026-08-12T12:42:00.000Z",
      },
      context: { organizationId: "org-1", projectId: null, branch: null, path: null },
      store: {
        path: "/tmp/store.sqlite",
        pathSource: "default",
        persistence: "unavailable",
        persistenceDetail: "Cannot find module 'better-sqlite3'",
        file: { exists: false },
      },
      requestBudget: { limit: 45, intervalMs: 60_000, source: "built-in default" },
      collectionBudget: {
        maxDurationMs: 600_000,
        maxItems: 10_000,
        maxFacts: 1_000_000,
        maxBytes: 100_000_000,
        source: "built-in default",
      },
      rateCard: { revision: "neon-docs-2026-08-08", retrievedAt: "2026-08-08" },
    };
    const text = renderDoctorReport(report);
    expect(text).toContain("no Neon API requests");
    expect(text).toContain("profile DEFAULT (Neon CLI login)");
    expect(text).toContain("expires 2026-08-12T12:42:00.000Z (in ~42m)");
    expect(text).toContain("SQLite persistence UNAVAILABLE");
    expect(text).toContain("project (unset)");
    expect(text).toContain("45 requests/1min");
    expect(text).toContain("review before sharing");

    const { persistenceDetail: _omitted, ...rest } = report.store;
    const available = renderDoctorReport({
      ...report,
      store: { ...rest, persistence: "available" },
    });
    expect(available).toContain("SQLite persistence available");
  });

  it("emits machine JSON through the CLI without touching the Neon API", async () => {
    let stdout = "";
    await runCli(
      ["doctor", "--output", "json"],
      {
        projectReport: async () => {
          throw new Error("doctor must not run reports");
        },
        branchReport: async () => ({ unused: true }),
        organizationSummary: async () => ({ unused: true }),
        capabilities: async () => ({ unused: true }),
        currentReport: async () => ({ unused: true }),
        write: (value) => {
          stdout += value;
        },
      },
      { now: () => new Date("2026-08-12T12:00:00Z"), isTTY: false },
    );
    const report = JSON.parse(stdout) as DoctorReport;
    expect(report.disposition).toBe("doctor");
    expect(report.offline).toBe(true);
    expect(Object.keys(report).sort()).toEqual([
      "collectionBudget",
      "context",
      "credential",
      "disposition",
      "generatedAt",
      "offline",
      "rateCard",
      "requestBudget",
      "sensitivity",
      "store",
    ]);
    // Never a secret in the output: shapes only, values from this machine.
    expect(stdout).not.toContain('api_key":');
  });
});
