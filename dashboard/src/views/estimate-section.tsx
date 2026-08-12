import {
  CostEstimateCard,
  type CostLine,
} from "@/components/cost-estimate-card/cost-estimate-card";
import { StorageBreakdown } from "@/components/storage-breakdown/storage-breakdown";
import type { PricingEstimate, UsageOverview } from "@/lib/api";
import { formatQuantity, metricInfo, toDisplayValue } from "@/lib/metrics";

const STORAGE_METRICS = [
  "root_branch_bytes_month",
  "child_branch_bytes_month",
  "instant_restore_bytes_month",
  "snapshot_storage_bytes_month",
];

/** Estimate lines aggregated per metric into the card's line shape. */
function costLines(estimate: PricingEstimate): CostLine[] {
  const byMetric = new Map<
    string,
    { used: number; billable: number; cost: number; included: number; rate: number }
  >();
  for (const line of estimate.lines) {
    if (line.status === "not_billed") continue;
    const info = metricInfo(line.metric);
    const entry = byMetric.get(line.metric) ?? {
      used: 0,
      billable: 0,
      cost: 0,
      included: 0,
      rate: 0,
    };
    entry.used += toDisplayValue(line.metric, line.raw.value);
    if (line.billable) entry.billable += Number(line.billable.value);
    if (line.amount) entry.cost += Number(line.amount.decimalApproximation);
    if (line.allowanceApplied) {
      entry.included += toDisplayValue(line.metric, line.allowanceApplied.rawQuantity);
    }
    if (line.ratePerUnit) entry.rate = Number(line.ratePerUnit);
    byMetric.set(line.metric, entry);
    void info;
  }
  return [...byMetric.entries()].map(([metric, entry]) => ({
    id: metric,
    label: metricInfo(metric).label,
    quantity: entry.billable,
    used: entry.used,
    unit: metricInfo(metric).unit,
    rate: entry.rate,
    cost: entry.cost,
    ...(entry.included > 0 ? { included: entry.included } : {}),
  }));
}

export function EstimateSection({
  estimate,
  overview,
  isLoading,
  error,
}: {
  estimate: PricingEstimate | null;
  overview: UsageOverview | null;
  isLoading: boolean;
  error: string | null;
}) {
  const unavailable =
    estimate && estimate.status !== "estimated"
      ? `Estimate unavailable: ${estimate.status.replaceAll("_", " ")}`
      : null;

  // Derive storage composition from the estimate's own lines (the same source
  // as the cost breakdown) rather than the usage overview, which is only
  // collected in organization scope — in live-projects scope it is null and the
  // composition would render empty despite the estimate having the data.
  const storageByMetric = new Map<string, { value: number; rate?: number }>();
  for (const line of estimate?.lines ?? []) {
    if (!STORAGE_METRICS.includes(line.metric)) continue;
    const entry = storageByMetric.get(line.metric) ?? { value: 0 };
    entry.value += toDisplayValue(line.metric, line.raw.value);
    if (line.ratePerUnit) entry.rate = Number(line.ratePerUnit);
    storageByMetric.set(line.metric, entry);
  }
  const storageSegments = STORAGE_METRICS.flatMap((metric) => {
    const entry = storageByMetric.get(metric);
    if (!entry || entry.value <= 0) return [];
    return [
      {
        id: metric,
        label: metricInfo(metric).label,
        value: entry.value,
        ...(entry.rate ? { rate: entry.rate } : {}),
      },
    ];
  });

  const period = estimate
    ? `${estimate.effectiveRange.from.slice(0, 10)} – ${estimate.effectiveRange.to.slice(0, 10)}`
    : undefined;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <CostEstimateCard
        title="Cost estimate"
        lines={estimate && !unavailable ? costLines(estimate) : []}
        plan={overview?.organization.plan ?? undefined}
        period={period}
        collapseZero
        isLoading={isLoading}
        error={error ?? unavailable}
        note={
          estimate ? (
            <>
              Estimate, not an invoice. Rate card {estimate.rateCard.revision}; excludes:{" "}
              {estimate.exclusions.join("; ") || "none listed"}.
              {estimate.lines.some((line) =>
                line.approximations?.includes("RATE_CARD_DATE_EXTRAPOLATION"),
              )
                ? " This window predates the rate card: today's documented rates were applied, and historical prices may have differed."
                : null}
              {estimate.lines.some((line) => line.approximations?.includes("PLAN_RATES_ASSUMED"))
                ? " This plan's rates are assumed defaults (documented as matching another plan); negotiated or custom terms may differ."
                : null}
              {estimate.lines.some((line) =>
                line.approximations?.includes("GRANULARITY_APPROXIMATION"),
              )
                ? " Branch allowances are netted per bucket; coarser-than-hourly buckets can smooth intra-bucket spikes."
                : null}
            </>
          ) : undefined
        }
      />
      <StorageBreakdown
        title="Storage composition"
        segments={storageSegments}
        unit="GB-mo"
        period={period}
        formatValue={formatQuantity}
        isLoading={isLoading && storageSegments.length === 0}
        error={error}
      />
    </div>
  );
}
