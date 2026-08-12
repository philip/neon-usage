import { describe, expect, it } from "vitest";
import { type CurrentSnapshotSource, createCurrentSnapshotService } from "../src/index.js";
import { NeonApiError } from "../src/neon-api-source.js";

describe("CurrentSnapshotService.organizationReport", () => {
  it.each([
    [{ concurrency: 0 }, "concurrency must be an integer between 1 and 100"],
    [{ maxProjects: Number.NaN }, "maxProjects must be an integer between 1 and 10000"],
  ] as const)("rejects invalid options", (options, message) => {
    const source = {} as CurrentSnapshotSource;
    expect(() => createCurrentSnapshotService(source, options)).toThrow(message);
  });

  it("returns a complete, explicitly non-historical report from Free-compatible APIs", async () => {
    const source: CurrentSnapshotSource = {
      listProjects: async () => ({ projectIds: ["project-1"], unavailableProjectIds: [] }),
      getProjectSnapshot: async () => ({
        projectId: "project-1",
        periodStart: "2026-08-01T00:00:00Z",
        periodEnd: "2026-09-01T00:00:00Z",
        activeTimeSeconds: "3600",
        computeTimeSeconds: "900",
        writtenDataBytes: "1000000000",
        dataTransferBytes: "500000000",
        dataStorageByteHours: "9007199254740993",
        metricEvidence,
      }),
      listBranchSizes: async () => ({
        branches: [
          {
            branchId: "branch-1",
            logicalSizeBytes: "400000000",
            evidence: factEvidence("/branches/0/logical_size"),
          },
          {
            branchId: "branch-2",
            logicalSizeBytes: "600000000",
            evidence: factEvidence("/branches/1/logical_size"),
          },
        ],
      }),
    };

    const report = await createCurrentSnapshotService(source, {
      now: () => new Date("2026-08-08T12:30:00Z"),
    }).organizationReport("org-1");

    expect(report).toEqual({
      schemaVersion: 1,
      kind: "current_period_snapshot",
      historical: false,
      generatedAt: "2026-08-08T12:30:00.000Z",
      organizationId: "org-1",
      coverage: { status: "complete", projectsRequested: 1, projectsReturned: 1, errors: [] },
      projects: [
        {
          projectId: "project-1",
          period: {
            start: "2026-08-01T00:00:00Z",
            end: "2026-09-01T00:00:00Z",
          },
          metrics: {
            activeTimeSeconds: "3600",
            computeTimeSeconds: "900",
            writtenDataBytes: "1000000000",
            dataTransferBytes: "500000000",
            dataStorageByteHours: "9007199254740993",
          },
          metricEvidence,
          branchStorage: {
            status: "available",
            totalLogicalSizeBytes: "1000000000",
            branches: [
              {
                branchId: "branch-1",
                logicalSizeBytes: "400000000",
                evidence: factEvidence("/branches/0/logical_size"),
              },
              {
                branchId: "branch-2",
                logicalSizeBytes: "600000000",
                evidence: factEvidence("/branches/1/logical_size"),
              },
            ],
          },
        },
      ],
    });
  });

  it("propagates inventory, project, and branch evidence into the snapshot report", async () => {
    const source: CurrentSnapshotSource = {
      listProjects: async () => ({
        projectIds: ["project-1"],
        unavailableProjectIds: [],
        evidence: [{ evidenceId: "inventory", payloadHash: "sha256:inventory" }],
      }),
      getProjectSnapshot: async () => ({
        projectId: "project-1",
        periodStart: "2026-08-01T00:00:00Z",
        periodEnd: "2026-09-01T00:00:00Z",
        activeTimeSeconds: "0",
        computeTimeSeconds: "0",
        writtenDataBytes: "0",
        dataTransferBytes: "0",
        dataStorageByteHours: "0",
        metricEvidence,
        evidence: { evidenceId: "project", payloadHash: "sha256:project" },
      }),
      listBranchSizes: async () => ({
        branches: [
          {
            branchId: "branch-1",
            logicalSizeBytes: "10",
            evidence: {
              evidenceId: "branches",
              payloadHash: "sha256:branches",
              sourcePath: "/branches/0/logical_size",
            },
          },
        ],
        evidence: [{ evidenceId: "branches", payloadHash: "sha256:branches" }],
      }),
    };

    const report = await createCurrentSnapshotService(source).organizationReport("org-1");

    expect(report.evidence).toEqual([
      { evidenceId: "branches", payloadHash: "sha256:branches" },
      { evidenceId: "inventory", payloadHash: "sha256:inventory" },
      { evidenceId: "project", payloadHash: "sha256:project" },
    ]);
    expect(report.projects[0]?.evidence).toEqual({
      evidenceId: "project",
      payloadHash: "sha256:project",
    });
    expect(report.projects[0]?.branchStorage.branches[0]?.evidence).toEqual({
      evidenceId: "branches",
      payloadHash: "sha256:branches",
      sourcePath: "/branches/0/logical_size",
    });
  });

  it("retains branch page evidence when the project has no branches", async () => {
    const source: CurrentSnapshotSource = {
      listProjects: async () => ({ projectIds: ["project-1"], unavailableProjectIds: [] }),
      getProjectSnapshot: async () => ({
        projectId: "project-1",
        periodStart: "2026-08-01T00:00:00Z",
        periodEnd: "2026-09-01T00:00:00Z",
        activeTimeSeconds: "0",
        computeTimeSeconds: "0",
        writtenDataBytes: "0",
        dataTransferBytes: "0",
        dataStorageByteHours: "0",
        metricEvidence,
      }),
      listBranchSizes: async () => ({
        branches: [],
        evidence: [{ evidenceId: "empty-branches", payloadHash: "sha256:empty" }],
      }),
    };

    const report = await createCurrentSnapshotService(source).organizationReport("org-1");

    expect(report.evidence).toContainEqual({
      evidenceId: "empty-branches",
      payloadHash: "sha256:empty",
    });
    expect(report.projects[0]?.branchStorage).toMatchObject({
      status: "available",
      branches: [],
      evidence: [{ evidenceId: "empty-branches", payloadHash: "sha256:empty" }],
    });
  });

  it("retains project counters and marks coverage partial when branch sizes fail", async () => {
    const source: CurrentSnapshotSource = {
      listProjects: async () => ({ projectIds: ["project-1"], unavailableProjectIds: [] }),
      getProjectSnapshot: async () => ({
        projectId: "project-1",
        periodStart: "2026-08-01T00:00:00Z",
        periodEnd: "2026-09-01T00:00:00Z",
        activeTimeSeconds: "3600",
        computeTimeSeconds: "900",
        writtenDataBytes: "0",
        dataTransferBytes: "0",
        dataStorageByteHours: "1000",
        metricEvidence,
      }),
      listBranchSizes: async () => {
        throw new NeonApiError(
          429,
          JSON.stringify({ code: "RATE_LIMITED", message: "branch endpoint unavailable" }),
          "request-branch",
          2,
          true,
          500,
        );
      },
    };

    const report = await createCurrentSnapshotService(source).organizationReport("org-1");

    expect(report.coverage).toEqual({
      status: "partial",
      projectsRequested: 1,
      projectsReturned: 1,
      errors: [
        {
          projectId: "project-1",
          source: "branch_sizes",
          message: "Neon API request failed with HTTP 429: branch endpoint unavailable",
          detail: {
            code: "RATE_LIMITED",
            message: "Neon API request failed with HTTP 429: branch endpoint unavailable",
            requestId: "request-branch",
            attempts: 2,
            retryable: true,
            retryAfterMs: 500,
            status: 429,
          },
        },
      ],
    });
    expect(report.projects[0]?.branchStorage).toEqual({
      status: "unavailable",
      totalLogicalSizeBytes: null,
      branches: [],
    });
  });

  it("retains successful projects when one project snapshot fails", async () => {
    const source: CurrentSnapshotSource = {
      listProjects: async () => ({
        projectIds: ["project-1", "project-2"],
        unavailableProjectIds: [],
      }),
      getProjectSnapshot: async (projectId) => {
        if (projectId === "project-2") {
          throw new NeonApiError(
            400,
            JSON.stringify({ code: "INVALID_PROJECT", message: "project unavailable" }),
            "request-project",
            1,
            false,
          );
        }
        return {
          projectId,
          periodStart: "2026-08-01T00:00:00Z",
          periodEnd: "2026-09-01T00:00:00Z",
          activeTimeSeconds: "0",
          computeTimeSeconds: "0",
          writtenDataBytes: "0",
          dataTransferBytes: "0",
          dataStorageByteHours: "0",
          metricEvidence,
        };
      },
      listBranchSizes: async () => ({ branches: [] }),
    };

    const report = await createCurrentSnapshotService(source).organizationReport("org-1");

    expect(report.projects.map((project) => project.projectId)).toEqual(["project-1"]);
    expect(report.coverage).toEqual({
      status: "partial",
      projectsRequested: 2,
      projectsReturned: 1,
      errors: [
        {
          projectId: "project-2",
          source: "project_snapshot",
          message: "Neon API request failed with HTTP 400: project unavailable",
          detail: {
            code: "INVALID_PROJECT",
            message: "Neon API request failed with HTTP 400: project unavailable",
            status: 400,
            requestId: "request-project",
            attempts: 1,
            retryable: false,
          },
        },
      ],
    });
  });

  it("marks projects omitted by inventory collection as partial", async () => {
    const source: CurrentSnapshotSource = {
      listProjects: async () => ({
        projectIds: ["project-1"],
        unavailableProjectIds: ["project-2"],
      }),
      getProjectSnapshot: async (projectId) => ({
        projectId,
        periodStart: "2026-08-01T00:00:00Z",
        periodEnd: "2026-09-01T00:00:00Z",
        activeTimeSeconds: "0",
        computeTimeSeconds: "0",
        writtenDataBytes: "0",
        dataTransferBytes: "0",
        dataStorageByteHours: "0",
        metricEvidence,
      }),
      listBranchSizes: async () => ({ branches: [] }),
    };

    const report = await createCurrentSnapshotService(source).organizationReport("org-1");

    expect(report.coverage).toEqual({
      status: "partial",
      projectsRequested: 2,
      projectsReturned: 1,
      errors: [
        {
          projectId: "project-2",
          source: "project_list",
          message: "Project details were unavailable during project inventory",
          detail: {
            code: "PROJECT_INVENTORY_UNAVAILABLE",
            message: "Project details were unavailable during project inventory",
          },
        },
      ],
    });
  });

  it("scopes the fan-out to requested projects and flags unknown requests", async () => {
    const snapshotted: string[] = [];
    const source: CurrentSnapshotSource = {
      listProjects: async () => ({
        projectIds: ["project-1", "project-2", "project-3"],
        unavailableProjectIds: [],
      }),
      getProjectSnapshot: async (projectId) => {
        snapshotted.push(projectId);
        return {
          projectId,
          periodStart: "2026-08-01T00:00:00Z",
          periodEnd: "2026-09-01T00:00:00Z",
          activeTimeSeconds: "0",
          computeTimeSeconds: "0",
          writtenDataBytes: "0",
          dataTransferBytes: "0",
          dataStorageByteHours: "0",
          metricEvidence,
        };
      },
      listBranchSizes: async () => ({ branches: [] }),
    };

    const report = await createCurrentSnapshotService(source).organizationReport(
      "org-1",
      undefined,
      { projectIds: ["project-2", "project-missing"] },
    );

    expect(snapshotted).toEqual(["project-2"]);
    expect(report.coverage).toEqual({
      status: "partial",
      projectsRequested: 2,
      projectsReturned: 1,
      errors: [
        {
          projectId: "project-missing",
          source: "project_list",
          message: "Requested project is not in the organization inventory",
          detail: {
            code: "PROJECT_NOT_IN_INVENTORY",
            message: "Requested project is not in the organization inventory",
          },
        },
      ],
    });
    expect(report.projects.map((project) => project.projectId)).toEqual(["project-2"]);
  });

  it("keeps the scoped fan-out under the project cap that the full walk exceeds", async () => {
    const source: CurrentSnapshotSource = {
      listProjects: async () => ({
        projectIds: Array.from({ length: 5 }, (_, index) => `project-${index}`),
        unavailableProjectIds: [],
      }),
      getProjectSnapshot: async (projectId) => ({
        projectId,
        periodStart: "2026-08-01T00:00:00Z",
        periodEnd: "2026-09-01T00:00:00Z",
        activeTimeSeconds: "0",
        computeTimeSeconds: "0",
        writtenDataBytes: "0",
        dataTransferBytes: "0",
        dataStorageByteHours: "0",
        metricEvidence,
      }),
      listBranchSizes: async () => ({ branches: [] }),
    };
    const service = createCurrentSnapshotService(source, { maxProjects: 2 });

    await expect(service.organizationReport("org-1")).rejects.toThrow(
      "found 5 projects; maximum is 2",
    );
    const scoped = await service.organizationReport("org-1", undefined, {
      projectIds: ["project-1", "project-3"],
    });
    expect(scoped.coverage).toEqual({
      status: "complete",
      projectsRequested: 2,
      projectsReturned: 2,
      errors: [],
    });
  });

  it("rejects an empty projectIds scope", async () => {
    const source = {} as CurrentSnapshotSource;
    await expect(
      createCurrentSnapshotService(source).organizationReport("org-1", undefined, {
        projectIds: [],
      }),
    ).rejects.toThrow("must name at least one project");
  });

  it("propagates cancellation instead of returning partial snapshots", async () => {
    const cancellation = Object.assign(new Error("cancelled"), { kind: "cancelled" });
    const source: CurrentSnapshotSource = {
      listProjects: async () => ({ projectIds: ["project-1"], unavailableProjectIds: [] }),
      getProjectSnapshot: async () => {
        throw cancellation;
      },
      listBranchSizes: async () => ({ branches: [] }),
    };

    await expect(createCurrentSnapshotService(source).organizationReport("org-1")).rejects.toBe(
      cancellation,
    );
  });

  it("does not downgrade a primitive operation abort reason", async () => {
    const controller = new AbortController();
    const source: CurrentSnapshotSource = {
      listProjects: async () => ({ projectIds: ["project-1"], unavailableProjectIds: [] }),
      getProjectSnapshot: async () => {
        controller.abort("stop");
        throw controller.signal.reason;
      },
      listBranchSizes: async () => ({ branches: [] }),
    };

    await expect(
      createCurrentSnapshotService(source).organizationReport("org-1", {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "OperationCancelledError", kind: "cancelled" });
  });

  it("rejects a snapshot attributed to a different project", async () => {
    const source: CurrentSnapshotSource = {
      listProjects: async () => ({ projectIds: ["project-1"], unavailableProjectIds: [] }),
      getProjectSnapshot: async () => ({
        projectId: "project-other",
        periodStart: "2026-08-01T00:00:00Z",
        periodEnd: "2026-09-01T00:00:00Z",
        activeTimeSeconds: "0",
        computeTimeSeconds: "0",
        writtenDataBytes: "0",
        dataTransferBytes: "0",
        dataStorageByteHours: "0",
        metricEvidence,
      }),
      listBranchSizes: async () => ({ branches: [] }),
    };

    await expect(
      createCurrentSnapshotService(source).organizationReport("org-1"),
    ).rejects.toMatchObject({ name: "ConsumptionSourceIntegrityError" });
  });

  it("bounds per-project API concurrency", async () => {
    let active = 0;
    let maximumActive = 0;
    const source: CurrentSnapshotSource = {
      listProjects: async () => ({
        projectIds: ["project-1", "project-2", "project-3", "project-4"],
        unavailableProjectIds: [],
      }),
      getProjectSnapshot: async (projectId) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return {
          projectId,
          periodStart: "2026-08-01T00:00:00Z",
          periodEnd: "2026-09-01T00:00:00Z",
          activeTimeSeconds: "0",
          computeTimeSeconds: "0",
          writtenDataBytes: "0",
          dataTransferBytes: "0",
          dataStorageByteHours: "0",
          metricEvidence,
        };
      },
      listBranchSizes: async () => ({ branches: [] }),
    };

    await createCurrentSnapshotService(source, { concurrency: 2 }).organizationReport("org-1");

    expect(maximumActive).toBe(2);
  });

  it("refuses an unexpectedly large snapshot fan-out before project detail calls", async () => {
    let detailCalls = 0;
    const source: CurrentSnapshotSource = {
      listProjects: async () => ({
        projectIds: Array.from({ length: 101 }, (_, index) => `project-${index}`),
        unavailableProjectIds: [],
      }),
      getProjectSnapshot: async () => {
        detailCalls += 1;
        throw new Error("not expected");
      },
      listBranchSizes: async () => ({ branches: [] }),
    };

    await expect(createCurrentSnapshotService(source).organizationReport("org-1")).rejects.toThrow(
      "Current snapshot report found 101 projects; maximum is 100",
    );
    expect(detailCalls).toBe(0);
  });
  it("keeps coverage complete when a branch size is an explicit unknown", async () => {
    const source: CurrentSnapshotSource = {
      listProjects: async () => ({ projectIds: ["project-1"], unavailableProjectIds: [] }),
      getProjectSnapshot: async () => ({
        projectId: "project-1",
        periodStart: "2026-08-01T00:00:00Z",
        periodEnd: "2026-09-01T00:00:00Z",
        activeTimeSeconds: "3600",
        computeTimeSeconds: "900",
        writtenDataBytes: "1000000000",
        dataTransferBytes: "500000000",
        dataStorageByteHours: "9007199254740993",
        metricEvidence,
      }),
      listBranchSizes: async () => ({
        branches: [
          {
            branchId: "branch-1",
            logicalSizeBytes: null,
            evidence: {
              payloadHash: `sha256:${"a".repeat(64)}`,
              sourcePath: "/branches/0",
            },
          },
        ],
      }),
    };

    const report = await createCurrentSnapshotService(source, {
      now: () => new Date("2026-08-08T12:30:00Z"),
    }).organizationReport("org-1");

    expect(report.coverage.status).toBe("complete");
    expect(report.projects[0]?.branchStorage).toMatchObject({
      status: "available",
      totalLogicalSizeBytes: null,
    });
  });
});

const factEvidence = (sourcePath: string) => ({ payloadHash: "sha256:test", sourcePath });

const metricEvidence = {
  activeTimeSeconds: factEvidence("/project/active_time_seconds"),
  computeTimeSeconds: factEvidence("/project/compute_time_seconds"),
  writtenDataBytes: factEvidence("/project/written_data_bytes"),
  dataTransferBytes: factEvidence("/project/data_transfer_bytes"),
  dataStorageByteHours: factEvidence("/project/data_storage_bytes_hour"),
};
