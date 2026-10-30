import type { PricingEstimate } from "./api.js";
import { metricInfo, toDisplayValue } from "./metrics.js";

function toBillingUnit(metric: string, rawValue: string): number {
  const displayed = toDisplayValue(metric, rawValue);
  return metric === "functions_invocations" ? displayed / 1_000_000 : displayed;
}

/** Estimate lines projected into the cost card's billing units. */
export function costLines(estimate: PricingEstimate) {
  const byMetric = new Map<
    string,
    { used: number; billable: number; cost: number; included: number; rate: number }
  >();
  for (const line of estimate.lines) {
    if (line.status === "not_billed") continue;
    const entry = byMetric.get(line.metric) ?? {
      used: 0,
      billable: 0,
      cost: 0,
      included: 0,
      rate: 0,
    };
    entry.used += toBillingUnit(line.metric, line.raw.value);
    if (line.billable) entry.billable += Number(line.billable.value);
    if (line.amount) entry.cost += Number(line.amount.decimalApproximation);
    if (line.allowanceApplied) {
      entry.included += toBillingUnit(line.metric, line.allowanceApplied.rawQuantity);
    }
    if (line.ratePerUnit) entry.rate = Number(line.ratePerUnit);
    byMetric.set(line.metric, entry);
  }
  return [...byMetric.entries()].map(([metric, entry]) => ({
    id: metric,
    label: metricInfo(metric).label,
    quantity: entry.billable,
    used: entry.used,
    unit: metric === "functions_invocations" ? "M invocations" : metricInfo(metric).unit,
    rate: entry.rate,
    cost: entry.cost,
    ...(entry.included > 0 ? { included: entry.included } : {}),
  }));
}
