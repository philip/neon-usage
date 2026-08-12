import { describe, expect, it } from "vitest";
import { renderControlsTable, renderUtilizationTable } from "../src/controls-presenter.js";
import {
  type ControlsSource,
  createControlsService,
  createQuotaUtilizationService,
} from "../src/controls-service.js";
import { createNeonApiSource } from "../src/neon-api-source.js";

const now = () => new Date("2026-08-10T12:00:00Z");
const metricEvidence = Object.fromEntries(
  [
    "activeTimeSeconds",
    "computeTimeSeconds",
    "writtenDataBytes",
    "dataTransferBytes",
    "dataStorageByteHours",
  ].map((name) => [name, { payloadHash: `sha256:${"a".repeat(64)}`, sourcePath: `/${name}` }]),
) as never;

describe("controls inspection", () => {
  it("bounds and deduplicates project fan-out before provider calls", async () => {
    let calls = 0;
    const source: ControlsSource = {
      getSpendingNotification: async () => ({ status: "not_configured", semantics: "alert_only" }),
      getProjectQuota: async (projectId) => {
        calls += 1;
        return {
          projectId,
          consumptionPeriodEnd: null,
          quota: {
            activeTimeSeconds: null,
            computeTimeSeconds: null,
            writtenDataBytes: null,
            dataTransferBytes: null,
            logicalSizeBytes: null,
          },
          enforcement: "suspend_computes_until_period_end",
          logicalSizeEnforcement: "suspend_affected_branch_persistent",
        };
      },
    };
    const service = createControlsService(source, { maxProjects: 2 });
    await service.organizationControls("org-1", ["p-1", "p-1", "p-2"]);
    expect(calls).toBe(2);
    await expect(service.organizationControls("org-1", ["p-1", "p-2", "p-3"])).rejects.toThrow(
      /at most 2/,
    );
    // An empty organization is a report, not a request error.
    const empty = await service.organizationControls("org-1", []);
    expect(empty.projects).toEqual([]);
    expect(empty.coverage).toMatchObject({ projectsRequested: 0, projectsReturned: 0 });
  });
  it("keeps spending notifications and quotas separate and read-only", async () => {
    const source: ControlsSource = {
      getSpendingNotification: async () => ({
        status: "configured",
        spendingLimitCents: "500",
        semantics: "alert_only",
      }),
      getProjectQuota: async (projectId) => ({
        projectId,
        consumptionPeriodEnd: "2026-09-01T00:00:00Z",
        quota: {
          activeTimeSeconds: "3600",
          computeTimeSeconds: null,
          writtenDataBytes: null,
          dataTransferBytes: null,
          logicalSizeBytes: null,
        },
        enforcement: "suspend_computes_until_period_end",
        logicalSizeEnforcement: "suspend_affected_branch_persistent",
      }),
    };

    const report = await createControlsService(source, { now }).organizationControls("org-1", [
      "project-1",
    ]);

    expect(report).toMatchObject({
      kind: "controls_inspection",
      readOnly: true,
      spendingNotification: { status: "configured", semantics: "alert_only" },
      coverage: { status: "complete", projectsReturned: 1 },
    });
    expect(report.projects[0]?.quota.activeTimeSeconds).toBe("3600");
  });

  it("reports per-project quota failures as partial coverage", async () => {
    const source: ControlsSource = {
      getSpendingNotification: async () => ({ status: "not_configured", semantics: "alert_only" }),
      getProjectQuota: async () => {
        throw new Error("boom");
      },
    };

    const report = await createControlsService(source, { now }).organizationControls("org-1", [
      "project-1",
    ]);
    expect(report.coverage).toMatchObject({ status: "partial", projectsReturned: 0 });
    expect(report.coverage.errors[0]?.projectId).toBe("project-1");
  });

  it("maps the wire spending limit and reports 404 as unavailable, not unconfigured", async () => {
    const source = createNeonApiSource({
      apiKey: "secret",
      fetch: async (input) =>
        String(input).includes("spending_limit")
          ? Response.json({ spending_limit_cents: 500 })
          : Response.json({}, { status: 500 }),
    });
    await expect(source.getSpendingNotification("org-1")).resolves.toEqual({
      status: "configured",
      spendingLimitCents: "500",
      semantics: "alert_only",
    });

    const unconfigured = createNeonApiSource({
      apiKey: "secret",
      fetch: async () => Response.json({ spending_limit_cents: null }),
    });
    await expect(unconfigured.getSpendingNotification("org-1")).resolves.toEqual({
      status: "not_configured",
      semantics: "alert_only",
    });

    const denied = createNeonApiSource({
      apiKey: "project-scoped",
      maxRetries: 0,
      fetch: async () => Response.json({ message: "not allowed" }, { status: 404 }),
    });
    await expect(denied.getSpendingNotification("org-1")).resolves.toMatchObject({
      status: "unavailable",
      detail: { status: 404 },
    });
  });

  it("makes controls coverage partial when the spending notification fails, but not on a Free 422", async () => {
    const okQuota = async (projectId: string) => ({
      projectId,
      consumptionPeriodEnd: null,
      quota: {
        activeTimeSeconds: null,
        computeTimeSeconds: null,
        writtenDataBytes: null,
        dataTransferBytes: null,
        logicalSizeBytes: null,
      },
      enforcement: "suspend_computes_until_period_end" as const,
      logicalSizeEnforcement: "suspend_affected_branch_persistent" as const,
    });

    const failing: ControlsSource = {
      getSpendingNotification: async () => ({
        status: "unavailable",
        detail: { code: "NEON_API_ERROR", message: "boom", status: 500 },
      }),
      getProjectQuota: okQuota,
    };
    const failed = await createControlsService(failing).organizationControls("org-1", ["p-1"]);
    expect(failed.coverage.status).toBe("partial");

    const free: ControlsSource = {
      getSpendingNotification: async () => ({
        status: "unavailable",
        detail: { code: "NEON_API_ERROR", message: "not available on this plan", status: 422 },
      }),
      getProjectQuota: okQuota,
    };
    const freeReport = await createControlsService(free).organizationControls("org-1", ["p-1"]);
    expect(freeReport.coverage.status).toBe("complete");
  });

  it("treats zero and absent quota values as unlimited", async () => {
    const source = createNeonApiSource({
      apiKey: "secret",
      fetch: async () =>
        Response.json({
          project: {
            id: "project-1",
            consumption_period_end: "2026-09-01T00:00:00Z",
            settings: { quota: { active_time_seconds: 3600, compute_time_seconds: 0 } },
          },
        }),
    });
    await expect(source.getProjectQuota("project-1")).resolves.toMatchObject({
      quota: {
        activeTimeSeconds: "3600",
        computeTimeSeconds: null,
        writtenDataBytes: null,
      },
    });
  });

  it("renders a read-only controls table with alert-only framing", async () => {
    const source: ControlsSource = {
      getSpendingNotification: async () => ({
        status: "configured",
        spendingLimitCents: "500",
        semantics: "alert_only",
      }),
      getProjectQuota: async (projectId) => ({
        projectId,
        consumptionPeriodEnd: "2026-09-01T00:00:00Z",
        quota: {
          activeTimeSeconds: "3600",
          computeTimeSeconds: null,
          writtenDataBytes: null,
          dataTransferBytes: null,
          logicalSizeBytes: null,
        },
        enforcement: "suspend_computes_until_period_end",
        logicalSizeEnforcement: "suspend_affected_branch_persistent",
      }),
    };
    const table = renderControlsTable(
      await createControlsService(source, { now }).organizationControls("org-1", ["project-1"]),
    );
    expect(table).toContain("$5.00/month (alert only; spending continues)");
    expect(table).toMatch(/project-1\s+3600\s+unlimited/);
    expect(table).toContain("suspend project computes");
    expect(table).toContain("persistent per-branch size ceiling");
  });

  it("joins quota limits with current-period usage as percentages", async () => {
    const source = {
      getSpendingNotification: async () => ({
        status: "not_configured" as const,
        semantics: "alert_only" as const,
      }),
      getProjectQuotaSnapshot: async (projectId: string) => ({
        quota: {
          projectId,
          consumptionPeriodEnd: "2026-09-01T00:00:00Z",
          quota: {
            activeTimeSeconds: null,
            computeTimeSeconds: "36000",
            writtenDataBytes: null,
            dataTransferBytes: "1000000000",
            logicalSizeBytes: "100000000",
          },
          enforcement: "suspend_computes_until_period_end" as const,
          logicalSizeEnforcement: "suspend_affected_branch_persistent" as const,
        },
        snapshot: {
          projectId,
          periodStart: "2026-08-01T00:00:00Z",
          periodEnd: "2026-09-01T00:00:00Z",
          activeTimeSeconds: "89064",
          computeTimeSeconds: "22657",
          writtenDataBytes: "0",
          dataTransferBytes: "250000000",
          dataStorageByteHours: "0",
          metricEvidence,
        },
      }),
      listBranchSizes: async () => ({
        branches: [
          {
            branchId: "branch-1",
            logicalSizeBytes: "50970624",
            evidence: { payloadHash: `sha256:${"a".repeat(64)}`, sourcePath: "/branches/0" },
          },
        ],
      }),
    };

    const report = await createQuotaUtilizationService(source, {
      now,
    }).organizationUtilization("org-1", ["project-1"]);

    expect(report.projects[0]?.metrics).toMatchObject({
      activeTimeSeconds: { used: "89064", limit: null, percentUsed: null },
      computeTimeSeconds: { used: "22657", limit: "36000", percentUsed: "62.93" },
      dataTransferBytes: { used: "250000000", limit: "1000000000", percentUsed: "25.00" },
      largestBranchLogicalSizeBytes: { used: "50970624", limit: "100000000", percentUsed: "50.97" },
    });
    expect(report.coverage.status).toBe("complete");
  });
});

describe("unknown branch sizes are lower bounds", () => {
  const sourceWith = (branches: Array<{ branchId: string; logicalSizeBytes: string | null }>) => ({
    getSpendingNotification: async () => ({
      status: "not_configured" as const,
      semantics: "alert_only" as const,
    }),
    getProjectQuotaSnapshot: async (projectId: string) => ({
      quota: {
        projectId,
        consumptionPeriodEnd: null,
        quota: {
          activeTimeSeconds: null,
          computeTimeSeconds: null,
          writtenDataBytes: null,
          dataTransferBytes: null,
          logicalSizeBytes: "100000000",
        },
        enforcement: "suspend_computes_until_period_end" as const,
        logicalSizeEnforcement: "suspend_affected_branch_persistent" as const,
      },
      snapshot: {
        projectId,
        periodStart: "2026-08-01T00:00:00Z",
        periodEnd: "2026-09-01T00:00:00Z",
        activeTimeSeconds: "0",
        computeTimeSeconds: "0",
        writtenDataBytes: "0",
        dataTransferBytes: "0",
        dataStorageByteHours: "0",
        metricEvidence,
      },
    }),
    listBranchSizes: async () => ({
      branches: branches.map((branch) => ({
        ...branch,
        evidence: { payloadHash: `sha256:${"a".repeat(64)}`, sourcePath: "/branches/0" },
      })),
    }),
  });

  it("flags mixed known/unknown and empty branch lists; renders >= in the table", async () => {
    const mixed = await createQuotaUtilizationService(
      sourceWith([
        { branchId: "b1", logicalSizeBytes: "50000000" },
        { branchId: "b2", logicalSizeBytes: null },
      ]),
      { now },
    ).organizationUtilization("org-1", ["p-1"]);
    const metric = mixed.projects[0]?.metrics.largestBranchLogicalSizeBytes;
    expect(metric).toMatchObject({ percentUsed: "50.00", usedIsLowerBound: true });
    expect(renderUtilizationTable(mixed)).toContain(">=50.00%");

    const empty = await createQuotaUtilizationService(sourceWith([]), {
      now,
    }).organizationUtilization("org-1", ["p-1"]);
    expect(empty.projects[0]?.metrics.largestBranchLogicalSizeBytes.usedIsLowerBound).toBe(true);

    const known = await createQuotaUtilizationService(
      sourceWith([{ branchId: "b1", logicalSizeBytes: "50000000" }]),
      { now },
    ).organizationUtilization("org-1", ["p-1"]);
    expect(
      known.projects[0]?.metrics.largestBranchLogicalSizeBytes.usedIsLowerBound,
    ).toBeUndefined();
  });

  it("bounds and deduplicates utilization project fan-out", async () => {
    let calls = 0;
    const source = sourceWith([]);
    const service = createQuotaUtilizationService(
      {
        ...source,
        getProjectQuotaSnapshot: async (projectId) => {
          calls += 1;
          return source.getProjectQuotaSnapshot(projectId);
        },
      },
      { maxProjects: 2 },
    );
    await service.organizationUtilization("org-1", ["p-1", "p-1", "p-2"]);
    expect(calls).toBe(2);
    await expect(service.organizationUtilization("org-1", ["p-1", "p-2", "p-3"])).rejects.toThrow(
      /at most 2/,
    );
    const empty = await service.organizationUtilization("org-1", []);
    expect(empty.projects).toEqual([]);
    expect(empty.coverage).toMatchObject({ projectsRequested: 0, projectsReturned: 0 });
  });
});
