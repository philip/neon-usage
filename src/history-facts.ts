import type { SourcePeriod } from "./consumption-source.js";
import { ConsumptionSourceIntegrityError } from "./errors.js";
import type { CanonicalConsumptionFact } from "./evidence-fact-store.js";
import {
  effectiveFactIdentity,
  type ObservationScopeIdentity,
  observationRevisionIdentity,
} from "./fact-identity.js";

export function canonicalFactsFromPeriods(input: {
  sourceContract: string;
  scope: ObservationScopeIdentity;
  periods: SourcePeriod[];
}): CanonicalConsumptionFact[] {
  return input.periods.flatMap((period) =>
    period.buckets.flatMap((bucket) =>
      bucket.metrics.map((metric) => {
        if (!metric.evidence) {
          throw new ConsumptionSourceIntegrityError(
            `Reported metric ${metric.name} is missing source provenance`,
          );
        }
        const identity = {
          sourceContract: input.sourceContract,
          scope: input.scope,
          periodId: period.id,
          bucket: { start: bucket.start, end: bucket.end },
          metricName: metric.name,
        };
        return {
          observationId: observationRevisionIdentity({
            ...identity,
            payloadHash: metric.evidence.payloadHash,
          }),
          effectiveFactId: effectiveFactIdentity(identity),
          sourceContract: input.sourceContract,
          scope: input.scope,
          billingPeriod: {
            sourcePeriodId: period.id,
            plan: period.plan,
            start: period.start,
            ...(period.end ? { end: period.end } : {}),
          },
          bucket: identity.bucket,
          metric: { sourceName: metric.name },
          value: { decimalInteger: metric.value },
          presence: "reported" as const,
          provenance: metric.evidence,
        };
      }),
    ),
  );
}
