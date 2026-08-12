import { compareCanonicalText } from "./canonical-order.js";
import type { FactEvidenceRef, SourcePeriod } from "./consumption-source.js";
import { rawUnits } from "./metric-catalog.js";

export type ProjectedHistoryMetric = {
  name: string;
  value: string | null;
  rawUnit: string;
  presence: "reported" | "projected_zero" | "unknown";
  evidence?: FactEvidenceRef;
};

export type ProjectedHistoryPeriod = {
  id: string;
  plan: string;
  start: string;
  end?: string;
  buckets: Array<{
    start: string;
    end: string;
    metrics: ProjectedHistoryMetric[];
  }>;
};

export function projectHistoryPeriods(
  periods: SourcePeriod[],
  requestedMetrics: string[],
): {
  periods: ProjectedHistoryPeriod[];
  projectedZero: boolean;
  unknownMetric: boolean;
} {
  let projectedZero = false;
  let unknownMetric = false;
  const projectedPeriods = [...periods]
    .sort(
      (left, right) =>
        compareCanonicalText(left.start, right.start) ||
        compareCanonicalText(left.end ?? "", right.end ?? "") ||
        compareCanonicalText(left.id, right.id),
    )
    .map((period) => ({
      id: period.id,
      plan: period.plan,
      start: period.start,
      ...(period.end ? { end: period.end } : {}),
      buckets: [...period.buckets]
        .sort(
          (left, right) =>
            compareCanonicalText(left.start, right.start) ||
            compareCanonicalText(left.end, right.end),
        )
        .map((bucket) => {
          const reported = new Map(bucket.metrics.map((metric) => [metric.name, metric]));
          return {
            start: bucket.start,
            end: bucket.end,
            metrics: [
              ...requestedMetrics.map((name): ProjectedHistoryMetric => {
                const metric = reported.get(name);
                if (rawUnits[name] === undefined) {
                  unknownMetric = true;
                  return {
                    name,
                    value: metric?.value ?? null,
                    rawUnit: "unknown",
                    presence: metric === undefined ? "unknown" : "reported",
                    ...(metric?.evidence ? { evidence: metric.evidence } : {}),
                  };
                }
                if (metric === undefined) projectedZero = true;
                return {
                  name,
                  value: metric?.value ?? "0",
                  rawUnit: rawUnits[name] ?? "unknown",
                  presence: metric === undefined ? "projected_zero" : "reported",
                  ...(metric?.evidence ? { evidence: metric.evidence } : {}),
                };
              }),
              ...bucket.metrics
                .filter((metric) => !requestedMetrics.includes(metric.name))
                .sort(
                  (left, right) =>
                    compareCanonicalText(left.name, right.name) ||
                    compareCanonicalText(
                      left.evidence?.sourcePath ?? "",
                      right.evidence?.sourcePath ?? "",
                    ) ||
                    compareCanonicalText(left.value, right.value),
                )
                .map((metric): ProjectedHistoryMetric => {
                  if (rawUnits[metric.name] === undefined) unknownMetric = true;
                  return {
                    name: metric.name,
                    value: metric.value,
                    rawUnit: rawUnits[metric.name] ?? "unknown",
                    presence: "reported",
                    ...(metric.evidence ? { evidence: metric.evidence } : {}),
                  };
                }),
            ],
          };
        }),
    }));
  return { periods: projectedPeriods, projectedZero, unknownMetric };
}
