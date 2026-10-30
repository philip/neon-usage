import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCapabilityService } from "../src/capability-service.js";
import { runCli } from "../src/cli.js";
import { createNeonUsageClient } from "../src/client.js";
import { createCurrentSnapshotService } from "../src/current-snapshot-service.js";
import { createNeonDependencies } from "../src/default-dependencies.js";
import * as historyServices from "../src/history-report.js";
import { createOrganizationHistoryService } from "../src/history-report.js";
import * as stores from "../src/in-memory-fact-store.js";
import { createInMemoryEvidenceFactStore } from "../src/in-memory-fact-store.js";
import type {
  InternalReportDependencies,
  OrganizationHistoryResult,
} from "../src/internal-history.js";
import { type SerializedOutputTooLargeError, serializeMachineJson } from "../src/machine-json.js";
import {
  type MeasuredBillingUsage,
  parseMeasuredBillingUsage,
} from "../src/measured-usage-contract.js";
import { projectConsumptionMetrics } from "../src/metric-definitions.js";
import type { NeonSourceEvidence } from "../src/neon-api-source.js";
import { createNeonApiSource } from "../src/neon-api-source.js";
import * as sqliteStores from "../src/sqlite-fact-store.js";
import { branchComponentHistory } from "./fixtures/branch-component-history.js";

const now = () => new Date("2026-08-27T12:00:00.000Z");
const query = {
  from: "2026-08-26T00:00:00.000Z",
  to: "2026-08-27T00:00:00.000Z",
  granularity: "daily" as const,
};
const explicitMetrics = ["compute_unit_seconds", "extra_branches_month"] as const;
const historyFlags = ["--from", query.from, "--to", query.to, "--granularity", "daily"];

function historyPage(
  projectIds = ["project-1"],
  metrics: readonly string[] = explicitMetrics,
  cursor: string | null = null,
) {
  return {
    projects: projectIds.map((projectId) => ({
      project_id: projectId,
      periods: [
        {
          period_id: "period-1",
          period_plan: "launch",
          period_start: "2026-08-01T00:00:00.000Z",
          period_end: "2026-09-01T00:00:00.000Z",
          consumption: [
            {
              timeframe_start: query.from,
              timeframe_end: query.to,
              metrics: metrics.map((name) => ({
                metric_name: name,
                value: name === "extra_branches_month" ? "960" : "0",
              })),
            },
          ],
        },
      ],
    })),
    pagination: { cursor },
  };
}

function transport(page = historyPage(), missingSize = false, failedProject = false) {
  const payloads = new Map<string, string>();
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = new URL(String(input));
    let payload: unknown;
    let status = 200;
    if (url.pathname.endsWith("/organizations/org-1")) payload = { id: "org-1", plan: "launch" };
    else if (url.pathname.endsWith("/consumption_history/v2/projects")) payload = page;
    else if (url.pathname.endsWith("/projects"))
      payload = { projects: [{ id: "project-1", name: "One" }] };
    else if (url.pathname.endsWith("/branches"))
      payload = {
        branches: [
          { id: "branch-1", ...(missingSize ? {} : { logical_size: "9007199254740993" }) },
        ],
      };
    else if (url.pathname.endsWith("/projects/project-1") && failedProject) {
      status = 403;
      payload = { code: "PRIVATE_PROVIDER_CODE", message: "Raw provider diagnostics" };
    } else if (url.pathname.endsWith("/projects/project-1"))
      payload = {
        project: {
          id: "project-1",
          consumption_period_start: "2026-08-01T00:00:00Z",
          consumption_period_end: "2026-09-01T00:00:00Z",
          active_time_seconds: "3600",
          compute_time_seconds: "7200",
          written_data_bytes: "1",
          data_transfer_bytes: "9007199254740993",
          data_storage_bytes_hour: "0",
        },
      };
    else throw new Error(`Unexpected fixture URL: ${url.pathname}`);
    const body = JSON.stringify(payload);
    payloads.set(`sha256:${createHash("sha256").update(body).digest("hex")}`, body);
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  });
  return { fetch, payloads };
}

function cliDependencies(fixture: ReturnType<typeof transport>, maxPages = 1000) {
  const store = createInMemoryEvidenceFactStore();
  const source = createNeonApiSource({
    apiKey: "fixture-token",
    fetch: fixture.fetch,
    maxRetries: 0,
    maxResponseBytes: 100_000_000,
    evidenceClock: now,
    evidence: {
      sourceAccount: "cli-deployment",
      retention: "hash_only",
      write: (record, signal) => store.writeEvidence(record, signal),
    },
  });
  const history = createOrganizationHistoryService(source, {
    factStore: store,
    sourceAccount: "cli-deployment",
    now,
    maxPages,
    storeServing: { serve: false, tailBuckets: 0 },
    maxItems: 1_000_000,
    maxFacts: 1_000_000,
    maxBytes: 100_000_000,
  });
  const snapshots = createCurrentSnapshotService(source, { now });
  let collected: OrganizationHistoryResult | undefined;
  let stdout = "";
  const exitCodes: number[] = [];
  const deps: InternalReportDependencies & {
    write(value: string): void;
    setExitCode(value: number): void;
  } = {
    projectReport: (query, _control, context) => history.projectReport(query, context),
    branchReport: async () => {
      throw new Error("unused");
    },
    organizationSummary: async () => {
      throw new Error("export must use single-pass history");
    },
    organizationHistory: async (value, _control, context, origin) => {
      collected = await history.organizationHistory(value, context, origin);
      return collected;
    },
    capabilities: (id, context) => createCapabilityService(source).inspect(id, context),
    currentReport: (id, ids, context) =>
      snapshots.organizationReport(id, context, ids ? { projectIds: ids } : undefined),
    write: (value) => {
      stdout += value;
    },
    setExitCode: (value) => {
      exitCodes.push(value);
    },
  };
  return { deps, store, output: () => stdout, history: () => collected, exitCodes };
}

function captureEvidence() {
  const records = new Map<string, NeonSourceEvidence>();
  const createStore = stores.createInMemoryEvidenceFactStore;
  vi.spyOn(stores, "createInMemoryEvidenceFactStore").mockImplementation(() => {
    const store = createStore();
    return {
      ...store,
      writeEvidence: async (record, signal) => {
        await store.writeEvidence(record, signal);
        records.set(record.evidenceId, record);
      },
    };
  });
  return records;
}

async function assertReferences(
  value: MeasuredBillingUsage,
  fixture: ReturnType<typeof transport>,
  records: Map<string, NeonSourceEvidence>,
) {
  const references = value.evidence ?? [];
  expect(references.length).toBeGreaterThan(0);
  expect(new Set(references.map((reference) => reference.evidenceId)).size).toBe(references.length);
  for (const reference of references) {
    const payload = fixture.payloads.get(reference.payloadHash);
    expect(payload).toBeDefined();
    expect(
      `sha256:${createHash("sha256")
        .update(payload as string)
        .digest("hex")}`,
    ).toBe(reference.payloadHash);
    const record = records.get(reference.evidenceId);
    expect(record?.response.payloadHash).toBe(reference.payloadHash);
    expect(record?.evidenceId).toBe(reference.evidenceId);
  }
}

function semantic(value: MeasuredBillingUsage) {
  return {
    ...value,
    evidence: value.evidence
      ?.map(({ payloadHash }) => ({ evidenceId: `normalized:${payloadHash}`, payloadHash }))
      .sort((left, right) => left.payloadHash.localeCompare(right.payloadHash)),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("CLI and SDK measured usage parity", () => {
  it("rejects annual 10000-project branch output with the same collection limit and no CLI output", async () => {
    const annual = branchComponentHistory(10_000 * 12);
    expect(annual.projectReport.projects).toHaveLength(10_000);
    const fixture = transport();
    const cli = cliDependencies(fixture);
    const createHistory = historyServices.createOrganizationHistoryService;
    vi.spyOn(historyServices, "createOrganizationHistoryService").mockImplementation((...args) => ({
      ...createHistory(...args),
      organizationHistory: async () => annual,
    }));
    cli.deps.organizationHistory = async () => annual;
    const client = createNeonUsageClient({
      accessToken: "fixture-token",
      fetch: fixture.fetch,
      now,
      limits: { maxProjects: 10_000 },
    });
    try {
      const input = {
        organizationId: "org-1",
        source: "history" as const,
        query: {
          from: annual.summary.query.from,
          to: annual.summary.query.to,
          granularity: "monthly" as const,
          metrics: ["extra_branches_month"] as const,
        },
      };
      await expect(client.collectMeasuredUsage(input)).rejects.toMatchObject({
        name: "NeonUsageError",
        code: "COLLECTION_LIMIT_REACHED",
        message: "The operation reached a collection limit.",
      });
      await expect(
        runCli(
          [
            "export",
            "--source",
            "history",
            "--org-id",
            "org-1",
            "--from",
            input.query.from,
            "--to",
            input.query.to,
            "--granularity",
            "monthly",
            "--metrics",
            "extra_branches_month",
          ],
          cli.deps,
          { now, isTTY: false },
        ),
      ).rejects.toMatchObject({
        name: "NeonUsageError",
        code: "COLLECTION_LIMIT_REACHED",
        message: "The operation reached a collection limit.",
      });
      expect(cli.output()).toBe("");
      expect(cli.exitCodes).toEqual([]);
      expect(annual.projectReport.coverage.status).toBe("complete");
      expect(annual.projectReport.projects).toHaveLength(10_000);
      await expect(client.inspectCapability("org-1")).resolves.toBeDefined();
    } finally {
      client.close();
      cli.store.close();
    }
  }, 30_000);

  it.each([false, true])(
    "history shares values, pricing components, periods, coverage and hashes (partial=%s)",
    async (partial) => {
      const records = captureEvidence();
      const reports: OrganizationHistoryResult[] = [];
      const createHistory = historyServices.createOrganizationHistoryService;
      vi.spyOn(historyServices, "createOrganizationHistoryService").mockImplementation(
        (...args) => {
          const service = createHistory(...args);
          return {
            ...service,
            organizationHistory: async (...args) => {
              const result = await service.organizationHistory(...args);
              reports.push(result);
              return result;
            },
          };
        },
      );
      const page = historyPage(undefined, undefined, partial ? "next" : null);
      const fixture = transport(page);
      const cli = cliDependencies(fixture, partial ? 1 : 1000);
      const client = createNeonUsageClient({
        accessToken: "fixture-token",
        fetch: fixture.fetch,
        now,
        limits: { maxPages: partial ? 1 : 1000 },
      });
      try {
        const result = await client.collectMeasuredUsage({
          organizationId: "org-1",
          source: "history",
          query: { ...query, metrics: explicitMetrics },
        });
        await runCli(
          [
            "export",
            "--org-id",
            "org-1",
            "--source",
            "history",
            ...historyFlags,
            "--metrics",
            explicitMetrics.join(","),
          ],
          cli.deps,
          { now, isTTY: false },
        );
        const parsed = parseMeasuredBillingUsage(JSON.parse(cli.output()));
        expect(semantic(parsed)).toEqual(semantic(result.measuredUsage));
        expect(parsed.coverage.status).toBe(partial ? "partial" : "complete");
        expect(parsed.metrics === null).toBe(partial);
        expect(parsed.billableBranchMonthComponents.status).toBe(
          partial ? "unavailable" : "complete",
        );
        expect(result.estimate?.status).toBe(
          partial ? "unavailable_partial_coverage" : "estimated",
        );
        expect(cli.exitCodes).toEqual(partial ? [2] : []);
        await assertReferences(parsed, fixture, records);
        await assertReferences(result.measuredUsage, fixture, records);
        expect(reports).toHaveLength(2);
        const internalReports = reports.map(({ projectReport }) =>
          JSON.parse(
            JSON.stringify(projectReport, (key, value) =>
              key === "evidenceId" ? "normalized-evidence-id" : value,
            ),
          ),
        );
        // Internal comparison retains source paths, which the public contract does not expose.
        expect(internalReports[0]).toEqual(internalReports[1]);
        const report = cli.history()?.projectReport;
        expect(report).toBeDefined();
        for (const project of report?.projects ?? []) {
          for (const period of project.periods) {
            for (const bucket of period.buckets) {
              for (const metric of bucket.metrics) {
                expect(metric.evidence?.evidenceId).toBeDefined();
                expect(report?.evidence).toContainEqual({
                  evidenceId: metric.evidence?.evidenceId,
                  payloadHash: metric.evidence?.payloadHash,
                });
              }
            }
          }
        }
        expect(parsed.evidence?.[0]?.evidenceId).not.toBe(
          result.measuredUsage.evidence?.[0]?.evidenceId,
        );
        // One capability probe and one history fetch per surface; no pricing re-collection.
        expect(
          fixture.fetch.mock.calls.filter(([input]) =>
            String(input).includes("consumption_history"),
          ).length,
        ).toBe(4);
      } finally {
        client.close();
        cli.store.close();
      }
    },
  );

  it.each([
    ["complete", false, false],
    ["missing size", true, false],
    ["failed project", false, true],
  ] as const)(
    "production current export matches SDK scope, periods, coverage and evidence (%s)",
    async (_label, missingSize, failedProject) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now());
      const records = captureEvidence();
      const fixture = transport(undefined, missingSize, failedProject);
      vi.stubGlobal("fetch", fixture.fetch);
      const directory = mkdtempSync(join(tmpdir(), "neon-usage-parity-"));
      const store = createInMemoryEvidenceFactStore();
      vi.spyOn(sqliteStores, "createSqliteEvidenceFactStore").mockReturnValue(store);
      const openedStores: Array<typeof store> = [];
      const dependencies = createNeonDependencies({
        apiKey: "fixture-token",
        storePath: join(directory, "store.sqlite"),
        openedStores,
      });
      let stdout = "";
      const exitCodes: number[] = [];
      const cli = {
        deps: {
          ...dependencies,
          write: (value: string) => {
            stdout += value;
          },
          setExitCode: (value: number) => {
            exitCodes.push(value);
          },
        },
        output: () => stdout,
        exitCodes,
        store,
      };
      const client = createNeonUsageClient({
        accessToken: "fixture-token",
        fetch: fixture.fetch,
        now,
      });
      try {
        const result = await client.collectMeasuredUsage({
          organizationId: "org-1",
          source: "current",
          projectIds: ["project-1"],
        });
        await runCli(
          ["export", "--org-id", "org-1", "--source", "current", "--project-ids", "project-1"],
          cli.deps,
          { now, isTTY: false },
        );
        const parsed = parseMeasuredBillingUsage(JSON.parse(cli.output()));
        expect(semantic(parsed)).toEqual(semantic(result.measuredUsage));
        expect(parsed.pointInTimeStorage?.complete).toBe(!missingSize && !failedProject);
        expect(parsed.coverage.status).toBe(failedProject ? "partial" : "complete");
        if (failedProject)
          expect(JSON.stringify(parsed)).not.toMatch(
            /PRIVATE_PROVIDER_CODE|Raw provider diagnostics/,
          );
        expect(parsed.source.authoritative).toBe(false);
        expect(result.estimate).toBeNull();
        expect(cli.exitCodes).toEqual([2]);
        await assertReferences(parsed, fixture, records);
        await assertReferences(result.measuredUsage, fixture, records);
        expect(openedStores).toEqual([store]);
        const sourceAccounts = new Set(
          (parsed.evidence ?? []).map(
            (reference) => records.get(reference.evidenceId)?.sourceAccount,
          ),
        );
        expect([...sourceAccounts]).toEqual([
          `credential:sha256:${createHash("sha256").update("fixture-token").digest("hex")}`,
        ]);
      } finally {
        client.close();
        cli.store.close();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it.each([false, true])(
    "tracks omitted and explicitly supplied default metric lists separately (explicit=%s)",
    async (explicit) => {
      const fixture = transport(historyPage(undefined, projectConsumptionMetrics));
      const cli = cliDependencies(fixture);
      const client = createNeonUsageClient({
        accessToken: "fixture-token",
        fetch: fixture.fetch,
        now,
      });
      try {
        const result = await client.collectMeasuredUsage({
          organizationId: "org-1",
          source: "history",
          query: { ...query, ...(explicit ? { metrics: projectConsumptionMetrics } : {}) },
        });
        await runCli(
          [
            "export",
            "--org-id",
            "org-1",
            "--source",
            "history",
            ...historyFlags,
            ...(explicit ? ["--metrics", projectConsumptionMetrics.join(",")] : []),
          ],
          cli.deps,
          { now, isTTY: false },
        );
        const parsed = parseMeasuredBillingUsage(JSON.parse(cli.output()));
        expect(parsed.metricSelection.mode).toBe(explicit ? "explicit" : "default");
        expect(semantic(parsed)).toEqual(semantic(result.measuredUsage));
      } finally {
        client.close();
        cli.store.close();
      }
    },
  );

  it("delivers exactly 25,000,000 UTF-8 bytes and rejects one byte more while the SDK returns its bounded object", async () => {
    const metrics = projectConsumptionMetrics.filter((metric) => metric !== "extra_branches_month");
    async function sdk(ids: string[]) {
      const fixture = transport(historyPage(ids, metrics));
      const client = createNeonUsageClient({
        accessToken: "fixture-token",
        fetch: fixture.fetch,
        now,
        limits: { maxResponseBytes: 100_000_000, maxItems: 1_000_000, maxProjects: 10_000 },
      });
      try {
        return {
          fixture,
          measured: (
            await client.collectMeasuredUsage({
              organizationId: "org-1",
              source: "history",
              query: { ...query, metrics },
            })
          ).measuredUsage,
        };
      } finally {
        client.close();
      }
    }
    const first = await sdk(["project-00000"]);
    const second = await sdk(["project-00000", "project-00001"]);
    const firstBytes = Buffer.byteLength(serializeMachineJson(first.measured));
    const projectBytes = Buffer.byteLength(serializeMachineJson(second.measured)) - firstBytes;
    const count = 1 + Math.floor((25_000_000 - firstBytes) / projectBytes);
    expect(count).toBeLessThanOrEqual(10_000);
    const ids = Array.from(
      { length: count },
      (_, index) => `project-${String(index).padStart(5, "0")}`,
    );
    let padding = 25_000_000 - firstBytes - (count - 1) * projectBytes;
    for (let index = 0; padding > 0; index++) {
      const extra = Math.min(padding, 47);
      ids[index] += "x".repeat(extra);
      padding -= extra;
    }
    const boundary = await sdk(ids);
    expect(Buffer.byteLength(serializeMachineJson(boundary.measured))).toBe(25_000_000);
    const cli = cliDependencies(boundary.fixture);
    const flags = [
      "export",
      "--org-id",
      "org-1",
      "--source",
      "history",
      ...historyFlags,
      "--metrics",
      metrics.join(","),
    ];
    try {
      await runCli(flags, cli.deps, { now, isTTY: false });
      expect(Buffer.byteLength(cli.output())).toBe(25_000_000);
      expect(semantic(parseMeasuredBillingUsage(JSON.parse(cli.output())))).toEqual(
        semantic(boundary.measured),
      );
    } finally {
      cli.store.close();
    }
    ids[ids.length - 1] += "x";
    const above = await sdk(ids);
    expect(Buffer.byteLength(serializeMachineJson(above.measured))).toBe(25_000_001);
    const oversized = cliDependencies(above.fixture);
    try {
      await expect(runCli(flags, oversized.deps, { now, isTTY: false })).rejects.toMatchObject({
        name: "SerializedOutputTooLargeError",
        code: "SERIALIZED_OUTPUT_TOO_LARGE",
        actualBytes: 25_000_001,
        maxBytes: 25_000_000,
      } satisfies Partial<SerializedOutputTooLargeError>);
      expect(oversized.output()).toBe("");
    } finally {
      oversized.store.close();
    }
  }, 120_000);
});
