import { describe, expect, it } from "vitest";
import {
  createConsumptionService,
  type ProjectConsumptionSource,
  type ProjectReportQuery,
} from "../src/index.js";

describe("ConsumptionService.organizationSummary", () => {
  it("rejects project filters that would make the organization total incomplete", async () => {
    const source: ProjectConsumptionSource = {
      getProjectPage: async () => ({ projects: [], nextCursor: null }),
    };

    await expect(
      createConsumptionService(source, { now }).organizationSummary({
        ...query,
        projectIds: ["project-1"],
      }),
    ).rejects.toMatchObject({ code: "INVALID_FILTER" });
  });
  it("sums raw metrics exactly and converts each dimension to its billing unit", async () => {
    const source: ProjectConsumptionSource = {
      getProjectPage: async () => ({
        projects: [
          project("project-1", {
            compute_unit_seconds: "3600",
            root_branch_bytes_month: "2000000000",
            public_network_transfer_bytes: "1500000000",
            extra_branches_month: "744",
          }),
          project("project-2", {
            compute_unit_seconds: "7200",
            root_branch_bytes_month: "1000000000",
            public_network_transfer_bytes: "500000000",
            extra_branches_month: "372",
          }),
        ],
        nextCursor: null,
      }),
    };

    const summary = await createConsumptionService(source, { now }).organizationSummary(query);

    expect(summary).toMatchObject({
      schemaVersion: 1,
      scope: { kind: "organization_aggregate", organizationId: "org-1" },
      coverage: { status: "complete", pageCount: 1, qualityFlags: [] },
      query,
      effectiveRange: {
        from: "2026-08-07T00:00:00.000Z",
        to: "2026-08-08T00:00:00.000Z",
        granularity: "daily",
      },
      aggregation: "across_projects_periods_buckets_before_allowances",
      metrics: [
        {
          name: "compute_unit_seconds",
          raw: { value: "10800", unit: "cu_second" },
          derived: {
            exact: { numerator: "3", denominator: "1" },
            decimalApproximation: "3",
            decimalPrecision: 40,
            rounding: "half_up",
            unit: "cu_hour",
          },
        },
        {
          name: "root_branch_bytes_month",
          raw: { value: "3000000000", unit: "byte_month" },
          derived: {
            exact: { numerator: "3", denominator: "1" },
            decimalApproximation: "3",
            decimalPrecision: 40,
            rounding: "half_up",
            unit: "gb_month",
          },
        },
        {
          name: "public_network_transfer_bytes",
          raw: { value: "2000000000", unit: "byte" },
          derived: {
            exact: { numerator: "2", denominator: "1" },
            decimalApproximation: "2",
            decimalPrecision: 40,
            rounding: "half_up",
            unit: "gb",
          },
        },
        {
          name: "extra_branches_month",
          raw: { value: "1116", unit: "branch_hour" },
          derived: {
            exact: { numerator: "3", denominator: "2" },
            decimalApproximation: "1.5",
            decimalPrecision: 40,
            rounding: "half_up",
            unit: "branch_month_before_allowance",
          },
        },
      ],
      attribution: {
        projects: expect.arrayContaining([
          expect.objectContaining({ projectId: "project-1" }),
          expect.objectContaining({ projectId: "project-2" }),
        ]),
      },
    });
  });

  it("represents a non-terminating conversion as an exact rational", async () => {
    const source: ProjectConsumptionSource = {
      getProjectPage: async () => ({
        projects: [project("project-1", { compute_unit_seconds: "1" })],
        nextCursor: null,
      }),
    };

    const summary = await createConsumptionService(source, { now }).organizationSummary({
      ...query,
      metrics: ["compute_unit_seconds"],
    });

    expect(summary.metrics?.[0]?.derived).toEqual({
      exact: { numerator: "1", denominator: "3600" },
      decimalApproximation: "0.0002777777777777777777777777777777777777778",
      decimalPrecision: 40,
      rounding: "half_up",
      unit: "cu_hour",
    });
  });
});

const now = () => new Date("2026-08-08T12:30:00Z");

const query: ProjectReportQuery = {
  organizationId: "org-1",
  from: "2026-08-07T00:00:00Z",
  to: "2026-08-08T00:00:00Z",
  granularity: "daily",
  metrics: [
    "compute_unit_seconds",
    "root_branch_bytes_month",
    "public_network_transfer_bytes",
    "extra_branches_month",
  ],
};

function project(projectId: string, metrics: Record<string, string>) {
  return {
    projectId,
    periods: [
      {
        id: "period-1",
        plan: "scale",
        start: "2026-08-01T00:00:00Z",
        buckets: [
          {
            start: "2026-08-07T00:00:00Z",
            end: "2026-08-08T00:00:00Z",
            metrics: Object.entries(metrics).map(([name, value]) => sourceMetric(name, value)),
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
