import type { OrganizationConsumptionSummary } from "../../src/history-report.js";
import { projectReportFromSummary } from "../../src/history-report.js";
import type { OrganizationHistoryResult } from "../../src/internal-history.js";
import { deriveBillingValue } from "../../src/metric-catalog.js";

/** Shared monthly buckets keep annual project-count regressions small. */
export function branchComponentHistory(componentCount: number): OrganizationHistoryResult {
  const from = "2025-08-01T00:00:00.000Z";
  const to = "2026-08-01T00:00:00.000Z";
  const buckets = Array.from({ length: 12 }, (_, month) => {
    const start = new Date(Date.UTC(2025, 7 + month, 1));
    const end = new Date(Date.UTC(2025, 8 + month, 1));
    // Launch includes nine child branches; leave exactly 744 billable hours.
    const raw = (9n * BigInt((end.getTime() - start.getTime()) / 3_600_000) + 744n).toString();
    return {
      start: start.toISOString(),
      end: end.toISOString(),
      metrics: [
        {
          name: "extra_branches_month",
          value: raw,
          rawUnit: "branch_hour" as const,
          presence: "reported" as const,
        },
      ],
    };
  });
  let totalRaw = 0n;
  const projects = Array.from({ length: Math.ceil(componentCount / 12) }, (_, index) => {
    const projectBuckets = buckets.slice(0, Math.min(12, componentCount - index * 12));
    for (const bucket of projectBuckets)
      for (const metric of bucket.metrics) totalRaw += BigInt(metric.value);
    return {
      projectId: `project-${index}`,
      periods: [
        { id: "annual-period", plan: "launch", start: from, end: to, buckets: projectBuckets },
      ],
    };
  });
  const raw = totalRaw.toString();
  const summary: OrganizationConsumptionSummary = {
    schemaVersion: 1,
    generatedAt: "2026-08-27T12:00:00.000Z",
    asOf: to,
    scope: { kind: "organization_aggregate", organizationId: "org-1" },
    coverage: {
      status: "complete",
      pageCount: Math.ceil(projects.length / 100),
      entityCount: projects.length,
      qualityFlags: [],
    },
    query: {
      organizationId: "org-1",
      from,
      to,
      granularity: "monthly",
      metrics: ["extra_branches_month"],
    },
    effectiveRange: { from, to, granularity: "monthly" },
    aggregation: "across_projects_periods_buckets_before_allowances",
    metrics: [
      {
        name: "extra_branches_month",
        raw: { value: raw, unit: "branch_hour" },
        derived: deriveBillingValue("extra_branches_month", raw),
      },
    ],
    attribution: { projects },
  };
  const projectReport = projectReportFromSummary(summary);
  if (!projectReport) throw new Error("Invalid fixture");
  return { summary, projectReport, metricSelectionMode: "explicit" };
}
