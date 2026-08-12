import type { CurrentPeriodSnapshotReport } from "./current-snapshot-service.js";
import type { ProjectConsumptionReport } from "./history-report.js";
import { deriveBillingValue, metricCatalog } from "./metric-catalog.js";

const metricHeaders: Record<string, string> = {
  compute_unit_seconds: "COMPUTE CU·h",
  root_branch_bytes_month: "ROOT GB·mo",
  child_branch_bytes_month: "CHILD GB·mo",
  instant_restore_bytes_month: "RESTORE GB·mo",
  snapshot_storage_bytes_month: "SNAP GB·mo",
  public_network_transfer_bytes: "PUB GB",
  private_network_transfer_bytes: "PRIV GB",
  extra_branches_month: "BRANCH·h",
};

function formatDisplay(value: string): string {
  const numeric = Number(value);
  if (numeric === 0) return "0";
  if (Math.abs(numeric) < 0.001) return "<0.001";
  if (Math.abs(numeric) >= 100) return numeric.toFixed(0);
  if (Math.abs(numeric) >= 10) return numeric.toFixed(1);
  return numeric.toFixed(3);
}

function table(headers: string[], values: string[][]): string[] {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...values.map((row) => row[index]?.length ?? 0)),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, index) =>
        index === 0 ? cell.padEnd(widths[index] ?? 0) : cell.padStart(widths[index] ?? 0),
      )
      .join("  ");
  return [line(headers), widths.map((width) => "-".repeat(width)).join("  "), ...values.map(line)];
}

/**
 * Time-series view: one row per bucket, metric columns summed across the
 * report's projects and converted to display units. The JSON report remains
 * the lossless contract; this is a human preview of chart-shaped data.
 */
export function renderHistoryTable(report: ProjectConsumptionReport): string {
  const metrics = report.query.metrics;
  const perBucket = new Map<string, Map<string, bigint>>();
  for (const project of report.projects) {
    for (const period of project.periods) {
      for (const bucket of period.buckets) {
        const totals = perBucket.get(bucket.start) ?? new Map<string, bigint>();
        for (const metric of bucket.metrics) {
          if (metric.value === null || !metrics.includes(metric.name)) continue;
          totals.set(metric.name, (totals.get(metric.name) ?? 0n) + BigInt(metric.value));
        }
        perBucket.set(bucket.start, totals);
      }
    }
  }
  const headers = ["BUCKET (UTC)", ...metrics.map((metric) => metricHeaders[metric] ?? metric)];
  const values = [...perBucket.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([start, totals]) => [
      start.replace(":00:00Z", "Z").replace("T00Z", "").slice(0, 16),
      ...metrics.map((metric) => {
        const raw = (totals.get(metric) ?? 0n).toString();
        return Object.hasOwn(metricCatalog, metric)
          ? formatDisplay(deriveBillingValue(metric, raw).decimalApproximation)
          : raw;
      }),
    ]);
  // Name the query's project scope: bucket rows are summed across projects,
  // so without this line there is no way to tell WHAT was summed — least of
  // all under the silent linked-project default.
  const requested = report.query.projectIds;
  const scopeLabel =
    requested === undefined
      ? `whole organization · ${report.projects.length} project(s) observed`
      : requested.length <= 3
        ? requested.join(", ")
        : `${requested.length} requested projects · ${report.projects.length} observed`;
  const output = [
    `Neon project history · ${report.query.organizationId} · ${scopeLabel}`,
    `Window: ${report.effectiveRange.from} -> ${report.effectiveRange.to} UTC · ${report.effectiveRange.granularity}`,
    `Coverage: ${report.coverage.status}`,
    // Freshness must be visible in the human view too: serve-from-store is
    // the default, so without this line a table could be 100% replay with
    // no hint that nothing was collected today.
    ...(report.servedFromStore
      ? [
          `Served from local store through ${report.servedFromStore.to.slice(0, 10)} (collected ${report.servedFromStore.collectedAt})`,
        ]
      : []),
    "",
    ...(values.length > 0 ? table(headers, values) : ["(no buckets in this window)"]),
  ];
  if (report.coverage.status !== "complete") {
    output.push("", "Warning: coverage is partial; rows may be incomplete");
  }
  return `${output.join("\n")}\n`;
}

export function renderSnapshotTable(report: CurrentPeriodSnapshotReport): string {
  const headers = [
    "PROJECT",
    "ACTIVE s",
    "COMPUTE s",
    "WRITTEN GB",
    "TRANSFER GB",
    "BRANCHES",
    "LOGICAL GB",
  ];
  const gigabytes = (value: string | null) =>
    value === null ? "unknown" : formatDisplay((Number(value) / 1e9).toString());
  const values = report.projects.map((project) => [
    project.projectId,
    project.metrics.activeTimeSeconds,
    project.metrics.computeTimeSeconds,
    gigabytes(project.metrics.writtenDataBytes),
    gigabytes(project.metrics.dataTransferBytes),
    String(project.branchStorage.branches.length),
    project.branchStorage.status === "available"
      ? gigabytes(project.branchStorage.totalLogicalSizeBytes)
      : "unavailable",
  ]);
  const period = report.projects[0]?.period;
  const output = [
    `Neon current-period snapshot · ${report.organizationId} · not historical`,
    ...(period ? [`Billing period: ${period.start} -> ${period.end}`] : []),
    `Coverage: ${report.coverage.status} · ${report.coverage.projectsReturned}/${report.coverage.projectsRequested} projects`,
    "",
    ...(values.length > 0 ? table(headers, values) : ["(no projects returned)"]),
  ];
  if (report.coverage.errors.length > 0) {
    output.push(
      "",
      `Warning: ${report.coverage.errors.length} coverage error(s); details in the JSON report`,
    );
  }
  return `${output.join("\n")}\n`;
}
