import { describe, expect, it } from "vitest";
import { createInMemoryEvidenceFactStore } from "../src/in-memory-fact-store.js";
import { type BranchConsumptionSource, createBranchConsumptionService } from "../src/index.js";
import { NeonApiError } from "../src/neon-api-source.js";

describe("BranchConsumptionService.branchReport", () => {
  it("retains branch attribution and marks omitted branch metrics as projected zero", async () => {
    const source: BranchConsumptionSource = {
      getBranchPage: async () => ({
        branches: [
          {
            projectId: "project-1",
            branchId: "branch-1",
            periods: [
              {
                id: "period-1",
                plan: "scale",
                start: "2026-08-01T00:00:00Z",
                buckets: [
                  {
                    start: "2026-08-07T00:00:00Z",
                    end: "2026-08-08T00:00:00Z",
                    metrics: [sourceMetric("compute_unit_seconds", "3600")],
                  },
                ],
              },
            ],
          },
        ],
        nextCursor: null,
      }),
    };

    const report = await createBranchConsumptionService(source, { now }).branchReport({
      organizationId: "org-1",
      projectIds: ["project-1"],
      from: "2026-08-07T00:00:00Z",
      to: "2026-08-08T00:00:00Z",
      granularity: "daily",
      metrics: ["compute_unit_seconds", "root_branch_bytes_month"],
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      source: { contract: "consumption-history-v2-branches", beta: true },
      coverage: {
        status: "complete",
        historicalCoverage: "unverified",
        pageCount: 1,
        qualityFlags: ["BETA_SOURCE", "BRANCH_HISTORY_COVERAGE_UNVERIFIED", "SOURCE_ZERO_OMITTED"],
      },
      branches: [
        {
          projectId: "project-1",
          branchId: "branch-1",
          periods: [
            {
              buckets: [
                {
                  metrics: [
                    {
                      name: "compute_unit_seconds",
                      value: "3600",
                      rawUnit: "cu_second",
                      presence: "reported",
                      evidence: sourceMetric("compute_unit_seconds", "").evidence,
                    },
                    {
                      name: "root_branch_bytes_month",
                      value: "0",
                      rawUnit: "byte_month",
                      presence: "projected_zero",
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it.each([
    undefined,
    { payloadHash: "sha256:short", sourcePath: "/metrics/compute_unit_seconds" },
    { payloadHash: `sha256:${"a".repeat(64)}`, sourcePath: "metrics/compute_unit_seconds" },
  ])("rejects missing or malformed branch metric provenance", async (evidence) => {
    const metric = sourceMetric("compute_unit_seconds", "3600");
    if (evidence) metric.evidence = evidence;
    else delete (metric as Partial<typeof metric>).evidence;
    const source: BranchConsumptionSource = {
      getBranchPage: async () => ({
        branches: [branchWithMetric(metric)],
        nextCursor: null,
      }),
    };

    await expect(
      createBranchConsumptionService(source, { now }).branchReport(branchQuery),
    ).rejects.toMatchObject({ name: "ConsumptionSourceIntegrityError" });
  });

  it("requires explicit unique project IDs", async () => {
    const source: BranchConsumptionSource = {
      getBranchPage: async () => ({ branches: [], nextCursor: null }),
    };

    await expect(
      createBranchConsumptionService(source, { now }).branchReport({
        organizationId: "org-1",
        projectIds: [],
        from: "2026-08-07T00:00:00Z",
        to: "2026-08-08T00:00:00Z",
        granularity: "daily",
        metrics: ["compute_unit_seconds"],
      }),
    ).rejects.toMatchObject({ code: "PROJECT_IDS_REQUIRED" });
  });

  it("rejects project-only metrics on the branch endpoint", async () => {
    const source: BranchConsumptionSource = {
      getBranchPage: async () => ({ branches: [], nextCursor: null }),
    };

    await expect(
      createBranchConsumptionService(source, { now }).branchReport({
        organizationId: "org-1",
        projectIds: ["project-1"],
        from: "2026-08-07T00:00:00Z",
        to: "2026-08-08T00:00:00Z",
        granularity: "daily",
        metrics: ["snapshot_storage_bytes_month"],
      }),
    ).rejects.toMatchObject({ code: "INVALID_METRIC" });
  });

  it("rejects duplicate branch filters", async () => {
    const source: BranchConsumptionSource = {
      getBranchPage: async () => ({ branches: [], nextCursor: null }),
    };

    await expect(
      createBranchConsumptionService(source, { now }).branchReport({
        organizationId: "org-1",
        projectIds: ["project-1"],
        branchIds: ["branch-1", "branch-1"],
        from: "2026-08-07T00:00:00Z",
        to: "2026-08-08T00:00:00Z",
        granularity: "daily",
        metrics: ["compute_unit_seconds"],
      }),
    ).rejects.toMatchObject({ code: "INVALID_FILTER" });
  });

  it("rejects malformed Neon resource IDs", async () => {
    const source: BranchConsumptionSource = {
      getBranchPage: async () => ({ branches: [], nextCursor: null }),
    };

    await expect(
      createBranchConsumptionService(source, { now }).branchReport({
        organizationId: "org-1",
        projectIds: ["INVALID PROJECT"],
        from: "2026-08-07T00:00:00Z",
        to: "2026-08-08T00:00:00Z",
        granularity: "daily",
        metrics: ["compute_unit_seconds"],
      }),
    ).rejects.toMatchObject({ code: "INVALID_FILTER" });
  });

  it("deduplicates branch entities while marking pagination partial", async () => {
    let calls = 0;
    const branch = {
      projectId: "project-1",
      branchId: "branch-1",
      periods: [],
    };
    const source: BranchConsumptionSource = {
      getBranchPage: async () => {
        calls += 1;
        return { branches: [branch], nextCursor: calls === 1 ? "next" : null };
      },
    };

    const report = await createBranchConsumptionService(source, { now }).branchReport({
      organizationId: "org-1",
      projectIds: ["project-1"],
      from: "2026-08-07T00:00:00Z",
      to: "2026-08-08T00:00:00Z",
      granularity: "daily",
      metrics: ["compute_unit_seconds"],
    });

    expect(report.coverage.status).toBe("partial");
    expect(report.coverage.qualityFlags).toContain("ENTITY_DUPLICATED");
    expect(report.branches).toHaveLength(1);
  });

  it("propagates cancellation after a collected page", async () => {
    let calls = 0;
    const cancellation = Object.assign(new Error("cancelled"), { kind: "cancelled" });
    const source: BranchConsumptionSource = {
      getBranchPage: async () => {
        calls += 1;
        if (calls === 2) throw cancellation;
        return {
          branches: [{ projectId: "project-1", branchId: "branch-1", periods: [] }],
          nextCursor: "next",
        };
      },
    };

    await expect(
      createBranchConsumptionService(source, { now }).branchReport({
        organizationId: "org-1",
        projectIds: ["project-1"],
        from: "2026-08-07T00:00:00Z",
        to: "2026-08-08T00:00:00Z",
        granularity: "daily",
        metrics: ["compute_unit_seconds"],
      }),
    ).rejects.toBe(cancellation);
  });

  it("requires an exact branch intent when resuming", async () => {
    const store = createInMemoryEvidenceFactStore();
    const controller = new AbortController();
    await expect(
      createBranchConsumptionService(
        {
          getBranchPage: async () => {
            controller.abort("interrupted");
            return {
              branches: [{ projectId: "project-1", branchId: "branch-1", periods: [] }],
              nextCursor: "next",
            };
          },
        },
        {
          now,
          createRunId: () => "run_branch-resume",
          factStore: store,
          sourceAccount: "account-test",
        },
      ).branchReport(branchQuery, { signal: controller.signal }),
    ).rejects.toMatchObject({ kind: "cancelled" });

    await expect(
      createBranchConsumptionService(
        { getBranchPage: async () => ({ branches: [], nextCursor: null }) },
        { now, factStore: store, sourceAccount: "account-test", resumeRunId: "run_branch-resume" },
      ).branchReport({ ...branchQuery, branchIds: ["branch-other"] }),
    ).rejects.toThrow("intent does not match");
    expect((await store.getCollectionRun("run_branch-resume"))?.status).toBe("running");
  });

  it("retains structured Neon details after a later page failure", async () => {
    let calls = 0;
    const source: BranchConsumptionSource = {
      getBranchPage: async () => {
        calls += 1;
        if (calls === 2) {
          throw new NeonApiError(503, "unavailable", "request-branch", 2, true);
        }
        return {
          branches: [{ projectId: "project-1", branchId: "branch-1", periods: [] }],
          nextCursor: "next",
        };
      },
    };

    const report = await createBranchConsumptionService(source, { now }).branchReport({
      organizationId: "org-1",
      projectIds: ["project-1"],
      from: "2026-08-07T00:00:00Z",
      to: "2026-08-08T00:00:00Z",
      granularity: "daily",
      metrics: ["compute_unit_seconds"],
    });

    expect(report.coverage.errorDetails).toEqual([
      {
        code: "NEON_API_ERROR",
        message: "Neon API request failed with HTTP 503: unrecognized error response",
        status: 503,
        requestId: "request-branch",
        attempts: 2,
        retryable: true,
      },
    ]);
  });
});

const now = () => new Date("2026-08-08T12:30:00Z");

const branchQuery = {
  organizationId: "org-1",
  projectIds: ["project-1"],
  from: "2026-08-07T00:00:00Z",
  to: "2026-08-08T00:00:00Z",
  granularity: "daily" as const,
  metrics: ["compute_unit_seconds"],
};

function branchWithMetric(metric: ReturnType<typeof sourceMetric>) {
  return {
    projectId: "project-1",
    branchId: "branch-1",
    periods: [
      {
        id: "period-1",
        plan: "scale",
        start: "2026-08-01T00:00:00Z",
        buckets: [
          {
            start: "2026-08-07T00:00:00Z",
            end: "2026-08-08T00:00:00Z",
            metrics: [metric],
          },
        ],
      },
    ],
  };
}

function sourceMetric(name: string, value: string) {
  return {
    name,
    value,
    evidence: { payloadHash: `sha256:${"a".repeat(64)}`, sourcePath: `/metrics/${name}` },
  };
}
