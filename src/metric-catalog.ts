import { Decimal } from "decimal.js";
import {
  type KnownMetricName,
  metricDefinitions,
  type RawUnit,
  usageQuantityPattern,
} from "./metric-definitions.js";

export type {
  HistoryBranchMetricName,
  HistoryProjectMetricName,
  KnownMetricName,
  RawUnit,
  SnapshotProjectMetricName,
} from "./metric-definitions.js";
export { branchConsumptionMetrics, projectConsumptionMetrics } from "./metric-definitions.js";

/** Recursively freeze so a consumer can't mutate process-global billing data. */
export function deepFreeze<T>(value: T): T {
  for (const nested of Object.values(value as Record<string, unknown>)) {
    if (nested && typeof nested === "object") deepFreeze(nested);
  }
  Object.freeze(value);
  return value;
}

export const metricCatalog = metricDefinitions;
// Null prototype so hostile metric names like "constructor" cannot resolve
// through the prototype chain and defeat unknown-metric detection.
export const rawUnits: Readonly<Record<string, RawUnit>> = Object.freeze(
  Object.assign(
    Object.create(null) as Record<string, RawUnit>,
    Object.fromEntries(
      Object.entries(metricDefinitions).map(([name, definition]) => [name, definition.rawUnit]),
    ),
  ),
);

const BillingDecimal = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export function deriveBillingValue(name: string, rawValue: string) {
  if (!Object.hasOwn(metricCatalog, name)) {
    throw new RangeError(`Unknown consumption metric: ${name}`);
  }
  if (typeof rawValue !== "string" || !usageQuantityPattern.test(rawValue)) {
    throw new RangeError(
      "Usage quantity must be a canonical non-negative integer of at most 128 digits",
    );
  }
  const definition = metricCatalog[name as KnownMetricName];
  const numerator = BigInt(rawValue);
  const divisor = greatestCommonDivisor(numerator, definition.denominator);
  const reducedNumerator = numerator / divisor;
  const reducedDenominator = definition.denominator / divisor;
  return {
    exact: {
      numerator: reducedNumerator.toString(),
      denominator: reducedDenominator.toString(),
    },
    decimalApproximation: new BillingDecimal(reducedNumerator.toString())
      .div(reducedDenominator.toString())
      .toString(),
    decimalPrecision: 40 as const,
    rounding: "half_up" as const,
    unit: definition.derivedUnit,
  };
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    [a, b] = [b, a % b];
  }
  return a;
}
