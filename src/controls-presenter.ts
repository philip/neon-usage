import type {
  ControlsInspection,
  ProjectQuotaReading,
  QuotaUtilizationMetric,
  QuotaUtilizationReport,
} from "./controls-service.js";

const quotaColumns: Array<{ header: string; read(quota: ProjectQuotaReading["quota"]): string }> = [
  { header: "ACTIVE s", read: (quota) => quota.activeTimeSeconds ?? "unlimited" },
  { header: "COMPUTE s", read: (quota) => quota.computeTimeSeconds ?? "unlimited" },
  { header: "WRITTEN B", read: (quota) => quota.writtenDataBytes ?? "unlimited" },
  { header: "TRANSFER B", read: (quota) => quota.dataTransferBytes ?? "unlimited" },
  { header: "LOGICAL B", read: (quota) => quota.logicalSizeBytes ?? "unlimited" },
];

export function renderControlsTable(inspection: ControlsInspection): string {
  const notification = inspection.spendingNotification;
  const notificationLine =
    notification.status === "configured"
      ? `$${(Number(notification.spendingLimitCents) / 100).toFixed(2)}/month (alert only; spending continues)`
      : notification.status === "not_configured"
        ? "not configured"
        : `unavailable (${notification.detail.code})`;
  const headers = ["PROJECT", ...quotaColumns.map((column) => column.header)];
  const values = inspection.projects.map((project) => [
    project.projectId,
    ...quotaColumns.map((column) => column.read(project.quota)),
  ]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...values.map((row) => row[index]?.length ?? 0)),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, index) =>
        index === 0 ? cell.padEnd(widths[index] ?? 0) : cell.padStart(widths[index] ?? 0),
      )
      .join("  ");
  const output = [
    `Neon controls · ${inspection.organizationId} · read-only`,
    `Spending notification: ${notificationLine}`,
    "",
    // Per Neon docs: active/compute/written/transfer are cumulative-per-period
    // quotas that suspend the project's computes and reset each period; LOGICAL B
    // is a persistent per-branch logical-size ceiling that suspends only that
    // branch and does not reset. https://neon.com/docs/guides/consumption-limits#corresponding-quotas
    "Quotas: active/compute/written/transfer are cumulative per period (suspend project computes); LOGICAL B is a persistent per-branch size ceiling (suspends that branch, no reset)",
    line(headers),
    widths.map((width) => "-".repeat(width)).join("  "),
    ...(values.length > 0 ? values.map(line) : ["(no projects inspected)"]),
  ];
  if (inspection.coverage.errors.length > 0) {
    output.push(
      "",
      `Warning: ${inspection.coverage.errors.length} project(s) could not be inspected`,
    );
  }
  return `${output.join("\n")}\n`;
}

function utilizationCell(metric: QuotaUtilizationMetric): string {
  // A lower bound (some contributing value was unknown) must never read as
  // exact safe headroom; ">=" says the true usage could be higher.
  const bound = metric.usedIsLowerBound ? ">=" : "";
  return metric.percentUsed === null
    ? `${bound}${metric.used} / unlimited`
    : `${bound}${metric.percentUsed}%`;
}

export function renderUtilizationTable(report: QuotaUtilizationReport): string {
  const headers = ["PROJECT", "ACTIVE", "COMPUTE", "WRITTEN", "TRANSFER", "MAX BRANCH", "RESETS"];
  const values = report.projects.map((project) => [
    project.projectId,
    utilizationCell(project.metrics.activeTimeSeconds),
    utilizationCell(project.metrics.computeTimeSeconds),
    utilizationCell(project.metrics.writtenDataBytes),
    utilizationCell(project.metrics.dataTransferBytes),
    utilizationCell(project.metrics.largestBranchLogicalSizeBytes),
    project.periodEnd ? project.periodEnd.slice(0, 10) : "unknown",
  ]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...values.map((row) => row[index]?.length ?? 0)),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, index) =>
        index === 0 ? cell.padEnd(widths[index] ?? 0) : cell.padStart(widths[index] ?? 0),
      )
      .join("  ");
  const notification = report.spendingNotification;
  const output = [
    `Neon quota utilization · ${report.organizationId} · read-only`,
    `Spending notification: ${
      notification.status === "configured"
        ? `$${(Number(notification.spendingLimitCents) / 100).toFixed(2)}/month (alert only)`
        : notification.status
    }`,
    "",
    "Percent of quota used this period; MAX BRANCH is a persistent per-branch logical-size ceiling (not cumulative, no monthly reset); raw usage when unlimited",
    line(headers),
    widths.map((width) => "-".repeat(width)).join("  "),
    ...(values.length > 0 ? values.map(line) : ["(no projects inspected)"]),
  ];
  if (report.coverage.errors.length > 0) {
    output.push("", `Warning: ${report.coverage.errors.length} project(s) could not be inspected`);
  }
  return `${output.join("\n")}\n`;
}
