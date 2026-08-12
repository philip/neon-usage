import { CollectingNotice, CoverageBanner } from "@/components/coverage-banner";
import { Skeleton } from "@/components/ui/skeleton";
import type { SnapshotReport } from "@/lib/api";
import { bytesToGb, formatQuantity, secondsToHours } from "@/lib/metrics";

const HEADERS = [
  { key: "compute", label: "Compute time", unit: "hrs" },
  { key: "active", label: "Active time", unit: "hrs" },
  { key: "written", label: "Written data", unit: "GB" },
  { key: "transfer", label: "Data transfer", unit: "GB" },
  { key: "storage", label: "Branch storage", unit: "GB" },
] as const;

/** Current billing-period snapshot per project (the Free-compatible view). */
export function SnapshotSection({
  report,
  isLoading,
  error,
}: {
  report: SnapshotReport | null;
  isLoading: boolean;
  error: string | null;
}) {
  return (
    <section className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)] p-4">
      <h2 className="text-sm font-semibold">Current period snapshot</h2>
      <p className="mb-3 text-xs text-[color:var(--muted-foreground)]">
        Cumulative since each project's period start; not the history window above.
      </p>
      {error ? <p className="text-xs text-[color:var(--destructive)]">{error}</p> : null}
      {isLoading && !report ? (
        <div className="space-y-2">
          <CollectingNotice label="the current-period snapshot" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : null}
      {report ? (
        <div className="space-y-3">
          <CoverageBanner
            coverage={{
              status: report.coverage.status,
              errors: report.coverage.errors.map(
                (item) => `${item.projectId ?? "organization"}: ${item.message}`,
              ),
            }}
            generatedAt={report.generatedAt}
          />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-xs">
              <thead>
                <tr className="border-b border-[color:var(--border)] text-left text-[color:var(--muted-foreground)]">
                  <th className="py-1.5 pr-3 font-medium">Project</th>
                  {HEADERS.map((header) => (
                    <th key={header.key} className="py-1.5 pr-3 text-right font-medium">
                      {header.label}
                      <span className="ml-1 font-normal">({header.unit})</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.projects.map((project) => (
                  <tr key={project.projectId} className="border-b border-[color:var(--border)]/60">
                    <td className="py-1.5 pr-3 font-mono">{project.projectId}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">
                      {formatQuantity(secondsToHours(project.metrics.computeTimeSeconds))}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">
                      {formatQuantity(secondsToHours(project.metrics.activeTimeSeconds))}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">
                      {formatQuantity(bytesToGb(project.metrics.writtenDataBytes))}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">
                      {formatQuantity(bytesToGb(project.metrics.dataTransferBytes))}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">
                      {project.branchStorage.totalLogicalSizeBytes === null
                        ? project.branchStorage.status === "unavailable"
                          ? "unavailable"
                          : "unknown"
                        : formatQuantity(bytesToGb(project.branchStorage.totalLogicalSizeBytes))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </section>
  );
}
