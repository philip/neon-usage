import { ConsumptionChart } from "@/components/consumption-chart/consumption-chart";
import type { ProjectReport } from "@/lib/api";
import {
  bucketLabel,
  CHART_GROUPS,
  formatQuantity,
  metricInfo,
  toDisplayValue,
} from "@/lib/metrics";

/**
 * One chart per unit family (compute CU-hrs, storage GB-mo, transfer GB):
 * a single axis each, stacking only within a unit. Buckets aggregate across
 * projects; the per-project split lives in the usage table.
 */
export function HistoryCharts({
  report,
  isLoading,
  error,
  granularity,
}: {
  report: ProjectReport | null;
  isLoading: boolean;
  error: string | null;
  granularity: "hourly" | "daily" | "monthly";
}) {
  const buckets = new Map<string, Record<string, number>>();
  if (report) {
    for (const project of report.projects) {
      for (const period of project.periods) {
        for (const bucket of period.buckets) {
          const values = buckets.get(bucket.start) ?? {};
          for (const metric of bucket.metrics) {
            if (metric.presence === "unknown" || metric.value === null) continue;
            values[metric.name] =
              (values[metric.name] ?? 0) + toDisplayValue(metric.name, metric.value);
          }
          buckets.set(bucket.start, values);
        }
      }
    }
  }
  const orderedStarts = [...buckets.keys()].sort();
  const meteredThrough = report
    ? `Metered through ${report.asOf} (last complete ${granularity} bucket).`
    : undefined;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {CHART_GROUPS.map((group, index) => {
        const data = orderedStarts.map((start) => ({
          label: bucketLabel(start, granularity),
          values: Object.fromEntries(
            group.metrics.map((name) => [name, buckets.get(start)?.[name] ?? 0]),
          ),
        }));
        const series = group.metrics.map((name) => ({
          id: name,
          label: metricInfo(name).label,
          unit: group.unit,
        }));
        return (
          <ConsumptionChart
            key={group.id}
            className={index === 0 ? "lg:col-span-2" : undefined}
            title={`${group.title} (${group.unit})`}
            data={data}
            series={series}
            variant={granularity === "hourly" ? "area" : "bar"}
            stacked
            formatValue={formatQuantity}
            isLoading={isLoading}
            error={error}
            meteredThrough={index === CHART_GROUPS.length - 1 ? meteredThrough : undefined}
            empty={<span>No consumption in this window.</span>}
          />
        );
      })}
    </div>
  );
}
