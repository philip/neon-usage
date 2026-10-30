import type { MeasuredBillingUsage } from "neon-usage/contracts";
import {
  deriveBillingValue,
  MEASURED_USAGE_KIND,
  MEASURED_USAGE_SCHEMA_VERSION,
  MeasuredUsageContractError,
  metricDefinitions,
  parseMeasuredBillingUsage,
} from "neon-usage/contracts";

const exact = deriveBillingValue("compute_unit_seconds", "3600").exact;
if (exact.numerator !== "1" || exact.denominator !== "1")
  throw new Error("Browser exact arithmetic failed");
let rejected = false;
try {
  parseMeasuredBillingUsage({});
} catch (error) {
  rejected = error instanceof MeasuredUsageContractError;
}
if (
  !rejected ||
  MEASURED_USAGE_KIND !== "measured_billing_usage" ||
  MEASURED_USAGE_SCHEMA_VERSION !== 2 ||
  !metricDefinitions.compute_unit_seconds
)
  throw new Error("Browser contracts fixture failed");
export const parse: (input: unknown) => MeasuredBillingUsage = parseMeasuredBillingUsage;
