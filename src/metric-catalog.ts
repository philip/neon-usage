import { Decimal } from "decimal.js";

export type RawUnit = "cu_second" | "byte_month" | "byte" | "branch_hour" | "unknown";
type DerivedUnit = "cu_hour" | "gb_month" | "gb" | "branch_month_before_allowance";

type MetricDefinition = {
  rawUnit: Exclude<RawUnit, "unknown">;
  denominator: bigint;
  derivedUnit: DerivedUnit;
  branchSupported: boolean;
};

/** Recursively freeze so a consumer can't mutate process-global billing data. */
export function deepFreeze<T>(value: T): T {
  for (const nested of Object.values(value as Record<string, unknown>)) {
    if (nested && typeof nested === "object") deepFreeze(nested);
  }
  Object.freeze(value);
  return value;
}

export const metricCatalog = deepFreeze({
  compute_unit_seconds: {
    rawUnit: "cu_second",
    denominator: 3600n,
    derivedUnit: "cu_hour",
    branchSupported: true,
  },
  root_branch_bytes_month: {
    // Live-reconciled against a real invoice 2026-08-10: v2 *_bytes_month
    // values arrive already divided by 744 (byte-months, matching the metric
    // name), so GB-month conversion divides by 1e9 only; a /744/1e9
    // conversion would double-divide.
    rawUnit: "byte_month",
    denominator: 1_000_000_000n,
    derivedUnit: "gb_month",
    branchSupported: true,
  },
  child_branch_bytes_month: {
    // Live-reconciled against a real invoice 2026-08-10: v2 *_bytes_month
    // values arrive already divided by 744 (byte-months, matching the metric
    // name), so GB-month conversion divides by 1e9 only; a /744/1e9
    // conversion would double-divide.
    rawUnit: "byte_month",
    denominator: 1_000_000_000n,
    derivedUnit: "gb_month",
    branchSupported: true,
  },
  instant_restore_bytes_month: {
    // Live-reconciled against a real invoice 2026-08-10: v2 *_bytes_month
    // values arrive already divided by 744 (byte-months, matching the metric
    // name), so GB-month conversion divides by 1e9 only; a /744/1e9
    // conversion would double-divide.
    rawUnit: "byte_month",
    denominator: 1_000_000_000n,
    derivedUnit: "gb_month",
    branchSupported: true,
  },
  snapshot_storage_bytes_month: {
    // Live-reconciled against a real invoice 2026-08-10: v2 *_bytes_month
    // values arrive already divided by 744 (byte-months, matching the metric
    // name), so GB-month conversion divides by 1e9 only; a /744/1e9
    // conversion would double-divide.
    rawUnit: "byte_month",
    denominator: 1_000_000_000n,
    derivedUnit: "gb_month",
    branchSupported: false,
  },
  public_network_transfer_bytes: {
    rawUnit: "byte",
    denominator: 1_000_000_000n,
    derivedUnit: "gb",
    branchSupported: true,
  },
  private_network_transfer_bytes: {
    rawUnit: "byte",
    denominator: 1_000_000_000n,
    derivedUnit: "gb",
    branchSupported: true,
  },
  extra_branches_month: {
    rawUnit: "branch_hour",
    denominator: 744n,
    derivedUnit: "branch_month_before_allowance",
    branchSupported: false,
  },
} as const satisfies Record<string, MetricDefinition>);

export type KnownMetricName = keyof typeof metricCatalog;
export const projectConsumptionMetrics = Object.freeze(
  Object.keys(metricCatalog) as KnownMetricName[],
);
export const branchConsumptionMetrics = Object.freeze(
  projectConsumptionMetrics.filter((name) => metricCatalog[name].branchSupported),
);
// Null prototype so hostile metric names like "constructor" cannot resolve
// through the prototype chain and defeat unknown-metric detection.
export const rawUnits: Readonly<Record<string, RawUnit>> = Object.freeze(
  Object.assign(
    Object.create(null) as Record<string, RawUnit>,
    Object.fromEntries(
      projectConsumptionMetrics.map((name) => [name, metricCatalog[name].rawUnit]),
    ),
  ),
);

const BillingDecimal = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export function deriveBillingValue(name: string, rawValue: string) {
  if (!Object.hasOwn(metricCatalog, name)) {
    throw new RangeError(`Unknown consumption metric: ${name}`);
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
