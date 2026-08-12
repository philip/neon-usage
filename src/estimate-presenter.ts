import { sanitizeErrorText } from "./errors.js";
import type { MoneyAmount, PricingEstimate } from "./pricing-estimate.js";

const metricLabels: Record<string, string> = {
  compute_unit_seconds: "Compute",
  root_branch_bytes_month: "Root storage",
  child_branch_bytes_month: "Child storage",
  instant_restore_bytes_month: "Instant restore",
  snapshot_storage_bytes_month: "Snapshot storage",
  public_network_transfer_bytes: "Public egress",
  private_network_transfer_bytes: "Private egress",
  extra_branches_month: "Extra branches",
};

/**
 * Format money from the exact bigint fraction (half-up), identical to the
 * per-project price table — the two must never disagree by a rounding cent.
 */
function usd(amount: MoneyAmount): string {
  return usdFromFraction({
    numerator: BigInt(amount.exact.numerator),
    denominator: BigInt(amount.exact.denominator),
  });
}

export function renderEstimateTable(estimate: PricingEstimate): string {
  const output: string[] = [
    `Neon cost estimate · ${estimate.query.organizationId} · not an invoice`,
    `Window: ${estimate.effectiveRange.from} -> ${estimate.effectiveRange.to} UTC · ${estimate.effectiveRange.granularity}`,
    `Rate card: ${sanitizeErrorText(estimate.rateCard.revision, 100)} (${estimate.rateCard.provenance}, retrieved ${estimate.rateCard.retrievedAt})`,
  ];
  if (estimate.status !== "estimated" || !estimate.totalsByMetric || !estimate.totalAmount) {
    output.push(
      "",
      `Estimate unavailable: ${estimate.status.replace("unavailable_", "").replace(/_/g, " ")}`,
    );
    const reasons = [
      ...new Set(
        estimate.lines
          .filter((line) => line.status === "unavailable")
          .map((line) => `${line.metric}: ${line.unavailableReason ?? "unavailable"}`),
      ),
    ];
    if (reasons.length > 0) output.push(...reasons.map((reason) => `  ${reason}`));
    return `${output.join("\n")}\n`;
  }
  const rows = estimate.totalsByMetric.map((total) => ({
    label: metricLabels[total.metric] ?? total.metric,
    amount: usd(total.amount),
  }));
  const labelWidth = Math.max("TOTAL".length, ...rows.map((row) => row.label.length));
  const amountWidth = Math.max(
    usd(estimate.totalAmount).length,
    ...rows.map((row) => row.amount.length),
  );
  output.push("");
  for (const row of rows) {
    output.push(`${row.label.padEnd(labelWidth)}  ${row.amount.padStart(amountWidth)}`);
  }
  output.push(
    `${"-".repeat(labelWidth)}  ${"-".repeat(amountWidth)}`,
    `${"TOTAL".padEnd(labelWidth)}  ${usd(estimate.totalAmount).padStart(amountWidth)}`,
  );
  const approximations = [...new Set(estimate.lines.flatMap((line) => line.approximations))];
  if (approximations.length > 0) {
    output.push("", `Approximations: ${approximations.join(", ")}`);
  }
  output.push("", `Excludes: ${estimate.exclusions.join(", ").replace(/_/g, " ")}`);
  return `${output.join("\n")}\n`;
}

const priceColumns: Array<{ header: string; metrics: string[] }> = [
  { header: "COMPUTE", metrics: ["compute_unit_seconds"] },
  {
    header: "STORAGE",
    metrics: [
      "root_branch_bytes_month",
      "child_branch_bytes_month",
      "instant_restore_bytes_month",
      "snapshot_storage_bytes_month",
    ],
  },
  {
    header: "EGRESS",
    metrics: ["public_network_transfer_bytes", "private_network_transfer_bytes"],
  },
  { header: "BRANCHES", metrics: ["extra_branches_month"] },
];

type Fraction = { numerator: bigint; denominator: bigint };
const zeroFraction: Fraction = { numerator: 0n, denominator: 1n };

function addFraction(left: Fraction, right: Fraction): Fraction {
  return {
    numerator: left.numerator * right.denominator + right.numerator * left.denominator,
    denominator: left.denominator * right.denominator,
  };
}

function compareFraction(left: Fraction, right: Fraction): number {
  const difference = left.numerator * right.denominator - right.numerator * left.denominator;
  return difference > 0n ? 1 : difference < 0n ? -1 : 0;
}

/** Formats an exact non-negative dollar fraction as cents, half-up. */
function usdFromFraction(fraction: Fraction): string {
  if (fraction.numerator === 0n) return "$0.00";
  const cents = (fraction.numerator * 200n + fraction.denominator) / (fraction.denominator * 2n);
  if (cents === 0n) return "<$0.01";
  return `$${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/**
 * The usage table's price twin: the same per-project rows with dollars in
 * place of quantities, from the same single collection. Every printed dollar
 * derives from the same exact fractions as the JSON output.
 */
export function renderPriceTable(
  estimate: PricingEstimate,
  projectNames?: ReadonlyMap<string, string>,
): string {
  if (estimate.status !== "estimated" || !estimate.totalAmount) {
    return renderEstimateTable(estimate);
  }
  const byProject = new Map<string, Map<string, Fraction>>();
  for (const line of estimate.lines) {
    if (!line.amount) continue;
    const perMetric = byProject.get(line.projectId) ?? new Map<string, Fraction>();
    const amount: Fraction = {
      numerator: BigInt(line.amount.exact.numerator),
      denominator: BigInt(line.amount.exact.denominator),
    };
    perMetric.set(line.metric, addFraction(perMetric.get(line.metric) ?? zeroFraction, amount));
    byProject.set(line.projectId, perMetric);
  }
  const rows = [...byProject.entries()]
    .map(([projectId, perMetric]) => {
      const cells = priceColumns.map((column) =>
        column.metrics.reduce(
          (sum, metric) => addFraction(sum, perMetric.get(metric) ?? zeroFraction),
          zeroFraction,
        ),
      );
      return {
        projectId,
        cells,
        total: cells.reduce((sum, cell) => addFraction(sum, cell), zeroFraction),
      };
    })
    .filter((row) => row.total.numerator > 0n)
    .sort((left, right) => compareFraction(right.total, left.total));
  const headers = ["PROJECT", "ID", ...priceColumns.map((column) => column.header), "TOTAL"];
  const totalRow = [
    "TOTAL",
    "",
    ...priceColumns.map((_column, index) =>
      usdFromFraction(
        rows.reduce((sum, row) => addFraction(sum, row.cells[index] ?? zeroFraction), zeroFraction),
      ),
    ),
    usdFromFraction({
      numerator: BigInt(estimate.totalAmount.exact.numerator),
      denominator: BigInt(estimate.totalAmount.exact.denominator),
    }),
  ];
  const values = rows.map((row) => [
    sanitizeErrorText(projectNames?.get(row.projectId) ?? "(unknown)", 200),
    row.projectId,
    ...row.cells.map((cell) => usdFromFraction(cell)),
    usdFromFraction(row.total),
  ]);
  const widths = headers.map((header, index) =>
    Math.max(
      header.length,
      totalRow[index]?.length ?? 0,
      ...values.map((row) => row[index]?.length ?? 0),
    ),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, index) =>
        index < 2 ? cell.padEnd(widths[index] ?? 0) : cell.padStart(widths[index] ?? 0),
      )
      .join("  ");
  const output = [
    `Neon cost estimate · ${estimate.query.organizationId} · not an invoice`,
    `Window: ${estimate.effectiveRange.from} -> ${estimate.effectiveRange.to} UTC · ${estimate.effectiveRange.granularity}`,
    `Rate card: ${sanitizeErrorText(estimate.rateCard.revision, 100)} (${estimate.rateCard.provenance}, retrieved ${estimate.rateCard.retrievedAt})`,
    "",
    line(headers),
    widths.map((width) => "-".repeat(width)).join("  "),
    ...(values.length > 0 ? values.map(line) : ["(no billable usage in this window)"]),
    widths.map((width) => "-".repeat(width)).join("  "),
    line(totalRow),
    "",
    `Excludes: ${estimate.exclusions.join(", ").replace(/_/g, " ")}`,
  ];
  return `${output.join("\n")}\n`;
}
