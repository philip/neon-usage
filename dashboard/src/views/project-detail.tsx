import { useEffect, useRef } from "react";
import { BranchUsageTable } from "@/components/branch-usage-table/branch-usage-table";
import { ConsumptionChart } from "@/components/consumption-chart/consumption-chart";
import { CollectingNotice, CoverageBanner } from "@/components/coverage-banner";
import type { ProjectReport, SnapshotReport } from "@/lib/api";
import {
  bucketLabel,
  bytesToGb,
  CHART_GROUPS,
  formatQuantity,
  metricInfo,
  secondsToHours,
  toDisplayValue,
} from "@/lib/metrics";

/**
 * One project's stats, opened by clicking its row: the scoped history window
 * as charts plus the current-period snapshot with per-branch storage. Both
 * come from single-project queries — a couple of requests, not a fleet walk.
 */
export function ProjectDetail({
  projectId,
  name,
  history,
  historyLoading,
  historyError,
  snapshot,
  snapshotLoading,
  snapshotError,
  granularity,
  onClose,
}: {
  projectId: string;
  name: string | null;
  history: ProjectReport | null;
  historyLoading: boolean;
  historyError: string | null;
  snapshot: SnapshotReport | null;
  snapshotLoading: boolean;
  snapshotError: string | null;
  granularity: "hourly" | "daily" | "monthly";
  onClose: () => void;
}) {
  // The panel opens below the (often tall) usage table; without this the
  // click appears to do nothing.
  const panel = useRef<HTMLElement | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: rescroll when the selected project changes
  useEffect(() => {
    panel.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [projectId]);

  const project = history?.projects.find((entry) => entry.projectId === projectId);
  const buckets = new Map<string, Record<string, number>>();
  const totals = new Map<string, number>();
  for (const period of project?.periods ?? []) {
    for (const bucket of period.buckets) {
      const values = buckets.get(bucket.start) ?? {};
      for (const metric of bucket.metrics) {
        if (metric.presence === "unknown" || metric.value === null) continue;
        const value = toDisplayValue(metric.name, metric.value);
        values[metric.name] = (values[metric.name] ?? 0) + value;
        totals.set(metric.name, (totals.get(metric.name) ?? 0) + value);
      }
      buckets.set(bucket.start, values);
    }
  }
  const orderedStarts = [...buckets.keys()].sort();
  const groups = CHART_GROUPS.filter((group) =>
    group.metrics.some((metric) => (totals.get(metric) ?? 0) > 0),
  );

  const snapshotProject = snapshot?.projects.find((entry) => entry.projectId === projectId);
  const branchRows = (snapshotProject?.branchStorage.branches ?? []).map((branch) => ({
    id: branch.branchId,
    name: branch.name ?? branch.branchId,
    metrics: { size: bytesToGb(branch.logicalSizeBytes ?? "0") },
    hint: branch.branchId,
  }));

  return (
    <section
      ref={panel}
      className="scroll-mt-4 space-y-3 rounded-lg border-2 border-[color:var(--primary)]/40 bg-[color:var(--card)] p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{name ?? projectId}</h2>
          <p className="font-mono text-xs text-[color:var(--muted-foreground)]">{projectId}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-[color:var(--border)] px-2 py-1 text-xs text-[color:var(--muted-foreground)] hover:text-[color:var(--foreground)]"
        >
          Close
        </button>
      </div>

      {history ? (
        <CoverageBanner
          coverage={history.coverage}
          generatedAt={history.generatedAt}
          asOf={history.asOf}
        />
      ) : null}
      {historyLoading ? <CollectingNotice label={`history for ${projectId}`} /> : null}
      {historyError ? (
        <p className="text-xs text-[color:var(--destructive)]">{historyError}</p>
      ) : null}

      {totals.size > 0 ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {[...totals.entries()]
            .filter(([, value]) => value > 0)
            .map(([metric, value]) => (
              <span key={metric}>
                <span className="text-[color:var(--muted-foreground)]">
                  {metricInfo(metric).label}:
                </span>{" "}
                <span className="font-medium tabular-nums">
                  {formatQuantity(value)} {metricInfo(metric).unit}
                </span>
              </span>
            ))}
        </div>
      ) : null}

      {groups.length > 0 ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {groups.map((group) => (
            <ConsumptionChart
              key={group.id}
              title={`${group.title} (${group.unit})`}
              data={orderedStarts.map((start) => ({
                label: bucketLabel(start, granularity),
                values: Object.fromEntries(
                  group.metrics.map((metric) => [metric, buckets.get(start)?.[metric] ?? 0]),
                ),
              }))}
              series={group.metrics.map((metric) => ({
                id: metric,
                label: metricInfo(metric).label,
                unit: group.unit,
              }))}
              variant={granularity === "hourly" ? "area" : "bar"}
              stacked
              isLoading={historyLoading}
              empty={<span>No consumption in this window.</span>}
            />
          ))}
        </div>
      ) : history && !historyLoading ? (
        <p className="text-xs text-[color:var(--muted-foreground)]">
          No consumption in this window.
        </p>
      ) : null}

      <div className="space-y-2">
        <h3 className="text-xs font-semibold">Current period</h3>
        {snapshotLoading ? <CollectingNotice label="the project snapshot" /> : null}
        {snapshotError ? (
          <p className="text-xs text-[color:var(--destructive)]">{snapshotError}</p>
        ) : null}
        {snapshotProject ? (
          <>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
              <span>
                <span className="text-[color:var(--muted-foreground)]">Period:</span>{" "}
                {snapshotProject.period.start.slice(0, 10)} –{" "}
                {snapshotProject.period.end.slice(0, 10)}
              </span>
              <span>
                <span className="text-[color:var(--muted-foreground)]">Compute:</span>{" "}
                <span className="tabular-nums">
                  {formatQuantity(secondsToHours(snapshotProject.metrics.computeTimeSeconds))} hrs
                </span>
              </span>
              <span>
                <span className="text-[color:var(--muted-foreground)]">Active:</span>{" "}
                <span className="tabular-nums">
                  {formatQuantity(secondsToHours(snapshotProject.metrics.activeTimeSeconds))} hrs
                </span>
              </span>
              <span>
                <span className="text-[color:var(--muted-foreground)]">Written:</span>{" "}
                <span className="tabular-nums">
                  {formatQuantity(bytesToGb(snapshotProject.metrics.writtenDataBytes))} GB
                </span>
              </span>
              <span>
                <span className="text-[color:var(--muted-foreground)]">Transfer:</span>{" "}
                <span className="tabular-nums">
                  {formatQuantity(bytesToGb(snapshotProject.metrics.dataTransferBytes))} GB
                </span>
              </span>
              <span>
                <span className="text-[color:var(--muted-foreground)]">Branch storage:</span>{" "}
                <span className="tabular-nums">
                  {snapshotProject.branchStorage.totalLogicalSizeBytes === null
                    ? snapshotProject.branchStorage.status === "unavailable"
                      ? "unavailable"
                      : "unknown"
                    : `${formatQuantity(
                        bytesToGb(snapshotProject.branchStorage.totalLogicalSizeBytes),
                      )} GB`}
                </span>
              </span>
            </div>
            {branchRows.length > 0 ? (
              <BranchUsageTable
                title="Branch storage"
                rows={branchRows}
                columns={[
                  {
                    id: "size",
                    label: "Logical size",
                    unit: "GB",
                    format: formatQuantity,
                  },
                ]}
                layout="list"
                topN={8}
                showTotals={false}
              />
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}
