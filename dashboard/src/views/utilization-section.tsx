import { CollectingNotice, CoverageBanner } from "@/components/coverage-banner";
import { Skeleton } from "@/components/ui/skeleton";
import type { UtilizationMetric, UtilizationReport } from "@/lib/api";
import { bytesToGb, formatQuantity, secondsToHours } from "@/lib/metrics";
import { cn } from "@/lib/utils";

function Cell({ metric, convert }: { metric: UtilizationMetric; convert: (v: string) => number }) {
  // "≥" marks a lower bound: an unknown contributing value (e.g. a branch
  // without a computed size) means real usage could be higher than shown.
  const bound = metric.usedIsLowerBound ? "≥" : "";
  if (metric.limit === null) {
    return (
      <td className="py-1.5 pr-3 text-right tabular-nums text-[color:var(--muted-foreground)]">
        {bound}
        {formatQuantity(convert(metric.used))} / ∞
      </td>
    );
  }
  const percent = Number(metric.percentUsed ?? "0");
  return (
    <td
      className={cn(
        "py-1.5 pr-3 text-right tabular-nums",
        percent >= 90 || (metric.usedIsLowerBound && percent >= 70)
          ? "font-semibold text-[color:var(--destructive)]"
          : percent >= 70 || metric.usedIsLowerBound
            ? "font-medium text-[color:var(--status-scaling)]"
            : undefined,
      )}
    >
      {bound}
      {formatQuantity(convert(metric.used))} / {formatQuantity(convert(metric.limit))}{" "}
      <span className="text-[color:var(--muted-foreground)]">
        ({bound}
        {metric.percentUsed}%)
      </span>
    </td>
  );
}

/** Native controls joined with current-period usage: quota headroom per project. */
export function UtilizationSection({
  report,
  isLoading,
  error,
  projectNames,
}: {
  report: UtilizationReport | null;
  isLoading: boolean;
  error: string | null;
  projectNames?: Map<string, string | null>;
}) {
  const spending = report?.spendingNotification;
  return (
    <section className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)] p-4">
      <h2 className="text-sm font-semibold">Controls &amp; quota utilization</h2>
      <p className="mb-3 text-xs text-[color:var(--muted-foreground)]">
        Read-only inspection of Neon's native controls. The cumulative quotas (compute, active,
        written, transfer) suspend the project's computes until the period ends; the largest-branch
        size quota is a persistent per-branch ceiling that suspends only that branch and does not
        reset monthly. The spending notification is alert-only.
      </p>
      {error ? <p className="text-xs text-[color:var(--destructive)]">{error}</p> : null}
      {isLoading && !report ? (
        <div className="space-y-2">
          <CollectingNotice label="quotas and current usage" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : null}
      {report ? (
        <div className="space-y-3">
          <CoverageBanner
            coverage={{
              status: report.coverage.status,
              errors: report.coverage.errors.map((item) => `${item.projectId}: ${item.message}`),
            }}
            generatedAt={report.generatedAt}
          />
          <p className="text-xs">
            Spending notification:{" "}
            {spending?.status === "configured" ? (
              <span>
                alert at ${(Number(spending.spendingLimitCents) / 100).toFixed(2)} (alert-only, does
                not cap spend)
              </span>
            ) : spending?.status === "not_configured" ? (
              <span className="text-[color:var(--muted-foreground)]">not configured</span>
            ) : spending?.status === "unavailable" && spending.detail.status === 422 ? (
              // Neon returns 422 when the plan has no spending limits (Free); that
              // is a plan fact, not an error, so present it plainly.
              <span className="text-[color:var(--muted-foreground)]">
                not available on this plan — spending limits are a Launch/Scale feature (Free
                organizations aren't billed; plan limits suspend service instead)
              </span>
            ) : (
              <span className="text-[color:var(--status-scaling)]">
                unavailable{spending ? `: ${spending.detail.message}` : ""}
              </span>
            )}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-xs">
              <thead>
                <tr className="border-b border-[color:var(--border)] text-left text-[color:var(--muted-foreground)]">
                  <th className="py-1.5 pr-3 font-medium">Project</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Compute (hrs)</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Active (hrs)</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Written (GB)</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Transfer (GB)</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Largest branch (GB)</th>
                </tr>
              </thead>
              <tbody>
                {report.projects.map((project) => {
                  const name = projectNames?.get(project.projectId) ?? null;
                  return (
                    <tr
                      key={project.projectId}
                      className="border-b border-[color:var(--border)]/60"
                    >
                      <td className="py-1.5 pr-3">
                        {name ? (
                          <>
                            <div>{name}</div>
                            {name !== project.projectId ? (
                              <div className="font-mono text-[10px] text-[color:var(--muted-foreground)]">
                                {project.projectId}
                              </div>
                            ) : null}
                          </>
                        ) : (
                          <span className="font-mono">{project.projectId}</span>
                        )}
                      </td>
                      <Cell metric={project.metrics.computeTimeSeconds} convert={secondsToHours} />
                      <Cell metric={project.metrics.activeTimeSeconds} convert={secondsToHours} />
                      <Cell metric={project.metrics.writtenDataBytes} convert={bytesToGb} />
                      <Cell metric={project.metrics.dataTransferBytes} convert={bytesToGb} />
                      <Cell
                        metric={project.metrics.largestBranchLogicalSizeBytes}
                        convert={bytesToGb}
                      />
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-[color:var(--muted-foreground)]">
            Used / limit in display units; ∞ means no quota set. Highlights at 70% and 90%.
          </p>
        </div>
      ) : null}
    </section>
  );
}
