import { sanitizeErrorText } from "./errors.js";
import type { UsageOverview } from "./usage-overview-service.js";

// Provider-controlled text (names, plans) is untrusted and reaches a TTY;
// strip control and bidi characters before rendering.
function displayText(value: string): string {
  return sanitizeErrorText(value, 200);
}

export function renderUsageTable(overview: UsageOverview): string {
  const rows = overview.activeProjects
    .map((project) => ({
      // A project with usage in the window but no resolvable name is absent
      // from the live directory — almost always deleted during the window
      // (it still bills, so it stays in the invoice-aligned total).
      project: displayText(project.name ?? "(deleted?)"),
      id: project.projectId,
      compute: displayMetric(project.metrics, "compute_unit_seconds", "CU·h"),
      root: displayMetric(project.metrics, "root_branch_bytes_month", "GB·mo"),
      child: displayMetric(project.metrics, "child_branch_bytes_month", "GB·mo"),
      egress: displayMetric(project.metrics, "public_network_transfer_bytes", "GB"),
      computeRaw: BigInt(
        project.metrics.find((metric) => metric.name === "compute_unit_seconds")?.rawValue ?? "0",
      ),
    }))
    .sort((left, right) =>
      left.computeRaw === right.computeRaw ? 0 : left.computeRaw > right.computeRaw ? -1 : 1,
    );
  const headers = ["PROJECT", "ID", "COMPUTE", "ROOT STORAGE", "CHILD STORAGE", "PUBLIC EGRESS"];
  const values = rows.map((row) => [
    row.project,
    row.id,
    row.compute,
    row.root,
    row.child,
    row.egress,
  ]);
  const total = [
    "TOTAL",
    "",
    displayTotal(overview, "compute_unit_seconds", "CU·h"),
    displayTotal(overview, "root_branch_bytes_month", "GB·mo"),
    displayTotal(overview, "child_branch_bytes_month", "GB·mo"),
    displayTotal(overview, "public_network_transfer_bytes", "GB"),
  ];
  const widths = headers.map((header, index) =>
    Math.max(
      header.length,
      total[index]?.length ?? 0,
      ...values.map((row) => row[index]?.length ?? 0),
    ),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, index) =>
        index < 2 ? cell.padEnd(widths[index] ?? 0) : cell.padStart(widths[index] ?? 0),
      )
      .join("  ");
  const organization = overview.organization.name
    ? `${displayText(overview.organization.name)} (${overview.organization.id})`
    : overview.organization.id;
  const output = [
    `Neon usage · ${organization} · ${displayText(overview.organization.plan ?? "unknown plan")}`,
    `Window: ${overview.effectiveRange.from} -> ${overview.effectiveRange.to} UTC · ${overview.effectiveRange.granularity}`,
    `Coverage: ${overview.coverage.status} · ${rows.length} active of ${overview.observedProjectCount} observed projects`,
    ...(overview.servedFromStore
      ? [
          `Served from local store through ${overview.servedFromStore.to.slice(0, 10)} (collected ${overview.servedFromStore.collectedAt})`,
        ]
      : []),
    "",
    "Primary dimensions by project",
    line(headers),
    widths.map((width) => "-".repeat(width)).join("  "),
    ...values.map(line),
    widths.map((width) => "-".repeat(width)).join("  "),
    line(total),
    "",
    "Additional organization totals",
    `  Instant restore: ${displayTotal(overview, "instant_restore_bytes_month", "GB·mo")}`,
    `  Snapshot storage: ${displayTotal(overview, "snapshot_storage_bytes_month", "GB·mo")}`,
    `  Private egress: ${displayTotal(overview, "private_network_transfer_bytes", "GB")}`,
    `  Extra branches before allowance: ${displayTotal(overview, "extra_branches_month", "branch·mo")}`,
  ];
  if (overview.totals === null) {
    output.push("", "Warning: coverage is partial; organization totals are unavailable");
  }
  if (overview.unavailableProjectIds.length > 0) {
    output.push("", `Warning: ${overview.unavailableProjectIds.length} project(s) unavailable`);
  }
  if (overview.enrichmentWarnings.length > 0) {
    output.push(
      "",
      `Warning: metadata enrichment incomplete (${overview.enrichmentWarnings.join(", ")})`,
    );
  }
  return `${output.join("\n")}\n`;
}

function displayTotal(overview: UsageOverview, name: string, unit: string): string {
  if (overview.totals === null) return "n/a";
  const metric = overview.totals.find((item) => item.name === name);
  return metric ? `${formatDecimal(metric.derived.decimalApproximation)} ${unit}` : "n/a";
}

function displayMetric(
  metrics: UsageOverview["activeProjects"][number]["metrics"],
  name: string,
  unit: string,
): string {
  const metric = metrics.find((item) => item.name === name);
  return `${formatDecimal(metric?.displayValue ?? "0")} ${unit}`;
}

function formatDecimal(value: string): string {
  const number = Number(value);
  if (number === 0) return "0";
  if (Math.abs(number) < 0.001) return "<0.001";
  if (Math.abs(number) >= 100) return number.toFixed(0);
  if (Math.abs(number) >= 10) return number.toFixed(1);
  return number.toFixed(2);
}
