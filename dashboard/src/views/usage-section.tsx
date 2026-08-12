import { BranchUsageTable } from "@/components/branch-usage-table/branch-usage-table";
import { CollectingNotice } from "@/components/coverage-banner";
import type { PricingEstimate, UsageOverview } from "@/lib/api";
import { formatQuantity, metricInfo } from "@/lib/metrics";
import { cn } from "@/lib/utils";

const CURRENCY = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

export type UsageFormat = "gb" | "price";

/**
 * Usage by project with the same gb/price toggle as `usage --format`.
 * Quantity mode reads the overview's display-converted values; price mode
 * reads estimated USD per project from the estimate lines.
 */
export type DerivedProjectUsage = {
  rows: Array<{ projectId: string; name: string | null; metrics: Record<string, number> }>;
  loading: boolean;
};

export function UsageSection({
  overview,
  overviewLoading,
  derived,
  estimate,
  estimateLoading,
  error,
  format,
  onFormatChange,
  projectNames,
  onSelectProject,
}: {
  overview: UsageOverview | null;
  overviewLoading: boolean;
  /** Live-scope rows derived from the scoped history report. */
  derived: DerivedProjectUsage | null;
  estimate: PricingEstimate | null;
  estimateLoading: boolean;
  error: string | null;
  format: UsageFormat;
  onFormatChange: (format: UsageFormat) => void;
  /** Directory names; rows fall back to bare IDs (with no duplicate hint). */
  projectNames?: Map<string, string>;
  /** Row click opens the project's detail panel. */
  onSelectProject?: (projectId: string) => void;
}) {
  const priceMode = format === "price";
  const isLoading = priceMode ? estimateLoading : (derived?.loading ?? overviewLoading);

  // Name resolution order: directory, then the overview's snapshot names.
  // A row without a name shows its ID once — never as both name and hint.
  const nameFor = (projectId: string): string | null =>
    projectNames?.get(projectId) ??
    overview?.activeProjects.find((project) => project.projectId === projectId)?.name ??
    null;
  const namedRow = (projectId: string, metrics: Record<string, number>) => {
    const name = nameFor(projectId);
    return {
      id: projectId,
      name: name ?? projectId,
      metrics,
      ...(name ? { hint: projectId } : {}),
    };
  };

  // Columns: metrics any project actually used this window (quantities), or
  // metrics any line actually billed (prices); compute always leads.
  let columns: Array<{ id: string; label: string; unit?: string; format?: (v: number) => string }>;
  let rows: Array<{ id: string; name: string; metrics: Record<string, number>; hint?: string }>;
  if (priceMode) {
    const perProject = new Map<string, Record<string, number>>();
    const billedMetrics = new Set<string>(["compute_unit_seconds"]);
    for (const line of estimate?.lines ?? []) {
      if (line.status !== "estimated" || !line.amount) continue;
      const amount = Number(line.amount.decimalApproximation);
      if (amount > 0) billedMetrics.add(line.metric);
      const metrics = perProject.get(line.projectId) ?? {};
      metrics[line.metric] = (metrics[line.metric] ?? 0) + amount;
      perProject.set(line.projectId, metrics);
    }
    columns = [...billedMetrics].slice(0, 6).map((name) => ({
      id: name,
      label: metricInfo(name).label,
      unit: "USD",
      format: (value: number) => CURRENCY.format(value),
    }));
    rows = [...perProject.entries()].map(([projectId, metrics]) => namedRow(projectId, metrics));
  } else if (derived) {
    const usedMetrics = new Set<string>(["compute_unit_seconds"]);
    for (const row of derived.rows) {
      for (const [name, value] of Object.entries(row.metrics)) {
        if (value > 0) usedMetrics.add(name);
      }
    }
    columns = [...usedMetrics].slice(0, 6).map((name) => ({
      id: name,
      label: metricInfo(name).label,
      unit: metricInfo(name).unit,
      format: formatQuantity,
    }));
    rows = derived.rows.map((row) => namedRow(row.projectId, row.metrics));
  } else {
    const usedMetrics = new Set<string>(["compute_unit_seconds"]);
    for (const project of overview?.activeProjects ?? []) {
      for (const metric of project.metrics) {
        if (Number(metric.displayValue) > 0) usedMetrics.add(metric.name);
      }
    }
    columns = [...usedMetrics].slice(0, 6).map((name) => ({
      id: name,
      label: metricInfo(name).label,
      unit: metricInfo(name).unit,
      format: formatQuantity,
    }));
    rows = (overview?.activeProjects ?? []).map((project) =>
      namedRow(
        project.projectId,
        Object.fromEntries(project.metrics.map((m) => [m.name, Number(m.displayValue)])),
      ),
    );
  }

  const toggle = (
    // biome-ignore lint/a11y/useSemanticElements: a labeled segmented control, not a form fieldset
    <div
      className="inline-flex rounded-md border border-[color:var(--border)] p-0.5 text-xs"
      role="group"
      aria-label="Units"
    >
      {(
        [
          { id: "gb" as const, label: "Quantities" },
          { id: "price" as const, label: "Est. price" },
        ] as const
      ).map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={format === option.id}
          onClick={() => onFormatChange(option.id)}
          className={cn(
            "rounded px-2 py-1",
            format === option.id
              ? "bg-[color:var(--secondary)] font-medium text-[color:var(--foreground)]"
              : "text-[color:var(--muted-foreground)] hover:text-[color:var(--foreground)]",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );

  return (
    <div className="space-y-2">
      <BranchUsageTable
        title={priceMode ? "Estimated price by project (not an invoice)" : "Usage by project"}
        entity={{ singular: "Project", plural: "projects" }}
        rows={rows}
        columns={columns}
        layout="table"
        topN={10}
        showTotals
        action={toggle}
        {...(onSelectProject
          ? { onSelectBranch: (row: { id: string }) => onSelectProject(row.id) }
          : {})}
        isLoading={isLoading}
        error={error}
        empty={
          priceMode && estimate && estimate.status !== "estimated" ? (
            <span>Estimate unavailable: {estimate.status.replaceAll("_", " ")}.</span>
          ) : (
            <span>No active projects in this window.</span>
          )
        }
        meteredThrough={
          overview
            ? `${overview.observedProjectCount} project(s) observed; window ${overview.effectiveRange.from} – ${overview.effectiveRange.to}.`
            : undefined
        }
      />
      {isLoading ? <CollectingNotice label="project usage" /> : null}
      {overview && overview.unavailableProjectIds.length > 0 ? (
        <p className="text-xs text-[color:var(--status-scaling)]">
          Unavailable projects: {overview.unavailableProjectIds.join(", ")}
        </p>
      ) : null}
    </div>
  );
}
