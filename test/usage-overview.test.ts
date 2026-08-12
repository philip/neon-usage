import { describe, expect, it } from "vitest";
import {
  createUsageOverviewService,
  type OrganizationDirectorySource,
  type ProjectConsumptionSource,
} from "../src/index.js";

describe("UsageOverviewService", () => {
  it("enriches and filters projects while retaining exact organization totals", async () => {
    const source: ProjectConsumptionSource & OrganizationDirectorySource = {
      getProjectPage: async () => ({
        projects: [
          project("project-active", "3600"),
          project("project-storage-only", "0"),
          { projectId: "project-empty", periods: [] },
        ],
        nextCursor: null,
      }),
      listOrganizations: async () => [
        { id: "org-1", name: "Example", handle: "example", plan: "launch" },
      ],
      listProjectDirectory: async () => ({
        projects: [
          { id: "project-active", name: "Active Project" },
          { id: "project-storage-only", name: "Storage Project" },
          { id: "project-empty", name: "Empty Project" },
        ],
        unavailableProjectIds: [],
      }),
    };

    const overview = await createUsageOverviewService(source, {
      now: () => new Date("2026-08-09T12:00:00Z"),
    }).overview({
      organizationId: "org-1",
      from: "2026-08-08T00:00:00Z",
      to: "2026-08-09T00:00:00Z",
      granularity: "daily",
      metrics: ["compute_unit_seconds", "root_branch_bytes_month"],
    });

    expect(overview.organization).toEqual({ id: "org-1", name: "Example", plan: "launch" });
    expect(overview.observedProjectCount).toBe(3);
    expect(overview.enrichmentWarnings).toEqual([]);
    expect(overview.activeProjects).toEqual([
      {
        projectId: "project-active",
        name: "Active Project",
        metrics: [
          {
            name: "compute_unit_seconds",
            rawValue: "3600",
            rawUnit: "cu_second",
            displayValue: "1",
            displayUnit: "cu_hour",
          },
          {
            name: "root_branch_bytes_month",
            rawValue: "1000000000",
            rawUnit: "byte_month",
            displayValue: "1",
            displayUnit: "gb_month",
          },
        ],
      },
      {
        projectId: "project-storage-only",
        name: "Storage Project",
        metrics: [
          {
            name: "root_branch_bytes_month",
            rawValue: "1000000000",
            rawUnit: "byte_month",
            displayValue: "1",
            displayUnit: "gb_month",
          },
        ],
      },
    ]);
    expect(
      overview.totals?.find((metric) => metric.name === "compute_unit_seconds")?.raw.value,
    ).toBe("3600");
    expect(overview.activeProjects.flatMap((project) => project.metrics)).not.toContainEqual(
      expect.objectContaining({ name: "future_metric" }),
    );
  });

  it("retains accounting output when optional metadata enrichment fails", async () => {
    const source: ProjectConsumptionSource & OrganizationDirectorySource = {
      getProjectPage: async () => ({
        projects: [project("project-active", "3600")],
        nextCursor: null,
      }),
      listOrganizations: async () => {
        throw new Error("organization metadata unavailable");
      },
      listProjectDirectory: async () => {
        throw new Error("project names unavailable");
      },
    };

    const overview = await createUsageOverviewService(source, {
      now: () => new Date("2026-08-09T12:00:00Z"),
    }).overview({
      organizationId: "org-1",
      from: "2026-08-08T00:00:00Z",
      to: "2026-08-09T00:00:00Z",
      granularity: "daily",
      metrics: ["compute_unit_seconds"],
    });

    expect(overview.coverage.status).toBe("complete");
    expect(overview.activeProjects[0]?.name).toBeNull();
    expect(overview.enrichmentWarnings).toEqual([
      "PROJECT_NAMES_UNAVAILABLE",
      "ORGANIZATION_METADATA_UNAVAILABLE",
    ]);
  });

  it.each([
    Object.assign(new Error("cancelled"), { kind: "cancelled" }),
    Object.assign(new Error("evidence failed"), { integrityFailure: true }),
  ])("propagates non-optional enrichment failure: %s", async (failure) => {
    const source: ProjectConsumptionSource & OrganizationDirectorySource = {
      getProjectPage: async () => ({ projects: [], nextCursor: null }),
      listOrganizations: async () => [],
      listProjectDirectory: async () => {
        throw failure;
      },
    };

    await expect(
      createUsageOverviewService(source, {
        now: () => new Date("2026-08-09T12:00:00Z"),
      }).overview({
        organizationId: "org-1",
        from: "2026-08-08T00:00:00Z",
        to: "2026-08-09T00:00:00Z",
        granularity: "daily",
        metrics: ["compute_unit_seconds"],
      }),
    ).rejects.toBe(failure);
  });
});

function project(projectId: string, compute: string) {
  return {
    projectId,
    periods: [
      {
        id: "period-1",
        plan: "launch",
        start: "2026-08-01T00:00:00Z",
        buckets: [
          {
            start: "2026-08-08T00:00:00Z",
            end: "2026-08-09T00:00:00Z",
            metrics: [
              sourceMetric("compute_unit_seconds", compute),
              sourceMetric("root_branch_bytes_month", "1000000000"),
              sourceMetric("future_metric", "1000"),
            ],
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
