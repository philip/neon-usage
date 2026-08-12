import { type ReactNode, useMemo, useState } from "react";
import { CollectingNotice, CoverageBanner } from "@/components/coverage-banner";
import type {
  ContextReport,
  Organization,
  PricingEstimate,
  ProjectDirectory,
  ProjectReport,
  SnapshotReport,
  UsageOverview,
  UtilizationReport,
} from "@/lib/api";
import { formatQuantity, metricInfo, toDisplayValue } from "@/lib/metrics";
import { setTheme, storedTheme, type Theme } from "@/lib/theme";
import { useChunkedHistory } from "@/lib/use-chunked-history";
import { useReport } from "@/lib/use-report";
import { EstimateSection } from "@/views/estimate-section";
import { HistoryCharts } from "@/views/history-charts";
import { ProjectDetail } from "@/views/project-detail";
import { SnapshotSection } from "@/views/snapshot-section";
import { type UsageFormat, UsageSection } from "@/views/usage-section";
import { UtilizationSection } from "@/views/utilization-section";

type Granularity = "hourly" | "daily" | "monthly";
type Scope = "organization" | "live-projects";

const SCOPE_KEY = "neon-usage-scope";

/** Fast is the default; the invoice-aligned whole-org view is one click away. */
function storedScope(): Scope {
  // Storage-denied browsers still get the default; preferences never throw.
  try {
    return localStorage.getItem(SCOPE_KEY) === "organization" ? "organization" : "live-projects";
  } catch {
    return "live-projects";
  }
}

export type PeriodOption = {
  id: string;
  label: string;
  granularity: Granularity;
  /** Relative window (mutually exclusive with from/to). */
  last?: string;
  from?: string;
  to?: string;
};

const MONTH_LABEL = new Intl.DateTimeFormat("en-US", {
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/**
 * Billing-shaped periods plus the relative windows. Months inside the
 * 60-day daily lookback query daily buckets (a chartable shape); older
 * months fall back to their single monthly bucket, per the API's lookback
 * rules. The in-progress month is always "(to date)" through the last
 * complete day — a partial month labeled as a month would be a lie, and an
 * in-progress bucket is unqueryable by design.
 */
function periodOptions(now: Date): PeriodOption[] {
  const monthStart = (offset: number) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
  const todayFloor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const oldestDaily = new Date(todayFloor);
  oldestDaily.setUTCDate(oldestDaily.getUTCDate() - 60);
  const months: PeriodOption[] = [];
  if (todayFloor.getTime() > monthStart(0).getTime()) {
    months.push({
      id: "month-0",
      label: `${MONTH_LABEL.format(monthStart(0))} (to date)`,
      granularity: "daily",
      from: monthStart(0).toISOString(),
      to: todayFloor.toISOString(),
    });
  }
  for (let offset = 1; offset < 12; offset += 1) {
    const start = monthStart(offset);
    months.push({
      id: `month-${offset}`,
      label: MONTH_LABEL.format(start),
      granularity: start.getTime() >= oldestDaily.getTime() ? "daily" : "monthly",
      from: start.toISOString(),
      to: monthStart(offset - 1).toISOString(),
    });
  }
  return [
    { id: "last-7d", label: "Last 7 days", granularity: "daily", last: "7d" },
    { id: "last-24h", label: "Last 24 hours", granularity: "hourly", last: "24h" },
    ...months,
  ];
}

function periodRangeQuery(option: PeriodOption): string {
  return option.last
    ? `granularity=${option.granularity}&last=${option.last}`
    : `granularity=${option.granularity}&from=${encodeURIComponent(option.from ?? "")}&to=${encodeURIComponent(option.to ?? "")}`;
}

type HeavySection = "history" | "estimate";

/**
 * A section whose report is expensive to collect renders as an explicit
 * offer until asked. Fast-first: the page never queues several collections
 * behind each other on load — each is one CLI command's worth of work,
 * started when the reader wants that answer.
 */
function OnDemandSection({
  title,
  cost,
  loaded,
  actions,
  children,
}: {
  title: string;
  cost: string;
  loaded: boolean;
  /** First action is the recommended (cheapest) one. */
  actions: Array<{ label: string; run: () => void }>;
  children: ReactNode;
}) {
  if (loaded) return <>{children}</>;
  return (
    <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed border-[color:var(--border)] bg-[color:var(--card)] p-4">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="text-xs text-[color:var(--muted-foreground)]">{cost}</p>
      </div>
      <div className="flex gap-2">
        {actions.map((action, index) => (
          <button
            key={action.label}
            type="button"
            onClick={action.run}
            className={
              index === 0
                ? "rounded-md border border-[color:var(--border)] bg-[color:var(--secondary)] px-3 py-1.5 text-xs font-medium hover:bg-[color:var(--accent)]"
                : "rounded-md border border-[color:var(--border)] px-3 py-1.5 text-xs text-[color:var(--muted-foreground)] hover:text-[color:var(--foreground)]"
            }
          >
            {action.label}
          </button>
        ))}
      </div>
    </section>
  );
}

export default function App({ authorized = true }: { authorized?: boolean }) {
  const context = useReport<ContextReport>(authorized ? "/api/context" : null);
  const organizations = useReport<Organization[]>(authorized ? "/api/organizations" : null);
  const [selectedOrg, setSelectedOrg] = useState<string | null>(null);
  const [periods] = useState(() => periodOptions(new Date()));
  const [periodId, setPeriodId] = useState<string>(
    () => periodOptions(new Date()).find((option) => option.id === "month-0")?.id ?? "last-7d",
  );
  const period = periods.find((option) => option.id === periodId) ?? periods[0];
  const granularity = period?.granularity ?? "daily";
  const [format, setFormat] = useState<UsageFormat>("gb");
  const [scope, setScope] = useState<Scope>(storedScope);
  const chooseScope = (value: Scope) => {
    setScope(value);
    try {
      localStorage.setItem(SCOPE_KEY, value);
    } catch {
      // Storage denied: the choice lasts for this page's lifetime only.
    }
  };
  const [theme, setThemeState] = useState<Theme>(storedTheme);
  const chooseTheme = (value: Theme) => {
    setThemeState(value);
    setTheme(value);
  };
  const [requested, setRequested] = useState<Record<HeavySection, boolean>>({
    history: false,
    estimate: false,
  });
  const request = (section: HeavySection) =>
    setRequested((previous) => ({ ...previous, [section]: true }));
  // Per-project sections cost one request per project, so they default to
  // the active set; "all projects" is the explicit expensive choice.
  const [snapshotScope, setSnapshotScope] = useState<"active" | "all" | null>(null);
  const [utilizationScope, setUtilizationScope] = useState<"active" | "all" | null>(null);

  const orgId = selectedOrg ?? context.data?.organizationId ?? null;
  // Routes resolve a lone credential organization themselves; only a chosen
  // org must be pinned so every section stays on the same one.
  const orgQuery = orgId ? `orgId=${encodeURIComponent(orgId)}&` : "";
  const live = scope === "live-projects";
  const scopeQuery = live ? "&scope=live-projects" : "";
  const range = period ? periodRangeQuery(period) : "granularity=daily&last=7d";
  const ready = context.data !== null || context.error !== null;

  // Free organizations have no history API (Launch and above), so the page
  // never asks for what the plan cannot answer: history, usage, and
  // estimates stay off, and the current-period snapshot — the
  // Free-compatible view — loads instead.
  const selectedPlan =
    organizations.data?.find((organization) => organization.id === orgId)?.plan ?? null;
  const planFamily = selectedPlan?.toLowerCase() ?? null;
  const freePlan = planFamily === "free";
  // Fail closed: history starts only after discovery identifies a known
  // history-capable plan. An error or unknown plan must not be guessed paid.
  const historyCapable =
    planFamily !== null &&
    ["launch", "scale", "agent", "business", "enterprise"].includes(planFamily);

  // Instant on load: context, organizations, and the project directory (a
  // page or two, no history collection). In the default live scope one
  // scoped project-report then powers tiles, table, and charts together.
  // The whole-org overview — the invoice-aligned number — collects only in
  // organization scope, because an organization summary cannot be filtered.
  const projects = useReport<ProjectDirectory>(ready ? `/api/projects?${orgQuery}` : null);
  const usage = useReport<UsageOverview>(
    ready && historyCapable && !live ? `/api/usage?${orgQuery}${range}` : null,
  );
  const wantEstimate = !freePlan && (requested.estimate || format === "price");
  // Live-scope estimates chunk server-side past the 100-ID filter and
  // estimate the merged report once, so the scope always applies.
  const estimate = useReport<PricingEstimate>(
    ready && historyCapable && wantEstimate
      ? `/api/usage?${orgQuery}${range}&format=price${scopeQuery}`
      : null,
  );
  // Live scope collects per-project history in ≤100-ID chunks (the filter's
  // limit); organization scope is one whole-org collection.
  const wantHistory = !freePlan && (live || requested.history);
  const liveIds =
    ready && historyCapable && live && projects.data
      ? projects.data.projects.map((entry) => entry.id)
      : null;
  const chunked = useChunkedHistory(
    liveIds,
    `${orgQuery}${range}`,
    (chunk) => `/api/project-report?${orgQuery}${range}&projectIds=${chunk.join(",")}`,
  );
  const orgHistory = useReport<ProjectReport>(
    // scope=organization explicitly: without it the server would fall back
    // to the linked project while this section is labeled "All projects".
    ready && historyCapable && !live && requested.history
      ? `/api/project-report?${orgQuery}${range}&scope=organization`
      : null,
  );
  const history = live
    ? { data: chunked.data, error: chunked.error, loading: chunked.loading }
    : orgHistory;
  // Live scope: per-project and per-metric totals derived from the scoped
  // history report (display approximations; the JSON stays exact).
  const derivedRows = useMemo(() => {
    if (!live || !history.data) return null;
    const names = new Map((projects.data?.projects ?? []).map((entry) => [entry.id, entry.name]));
    return history.data.projects
      .map((project) => {
        const metrics: Record<string, number> = {};
        for (const period of project.periods) {
          for (const bucket of period.buckets) {
            for (const metric of bucket.metrics) {
              if (metric.presence === "unknown" || metric.value === null) continue;
              metrics[metric.name] =
                (metrics[metric.name] ?? 0) + toDisplayValue(metric.name, metric.value);
            }
          }
        }
        return {
          projectId: project.projectId,
          name: names.get(project.projectId) ?? null,
          metrics,
        };
      })
      .filter((row) => Object.values(row.metrics).some((value) => value > 0));
  }, [live, history.data, projects.data]);

  // Active projects — the set the per-project sections scope to by default.
  const activeProjectIds = useMemo(
    () =>
      live
        ? (derivedRows ?? []).map((row) => row.projectId)
        : (usage.data?.activeProjects ?? []).map((project) => project.projectId),
    [live, derivedRows, usage.data],
  );
  const perProjectIds = (scope: "active" | "all") =>
    scope === "active" && activeProjectIds.length > 0 ? activeProjectIds.join(",") : "all";
  const effectiveSnapshotScope = snapshotScope ?? (freePlan ? "all" : null);
  const snapshot = useReport<SnapshotReport>(
    ready && effectiveSnapshotScope
      ? `/api/current-report?${orgQuery}projectIds=${perProjectIds(effectiveSnapshotScope)}`
      : null,
  );
  const utilization = useReport<UtilizationReport>(
    ready && utilizationScope
      ? `/api/utilization?${orgQuery}projectIds=${perProjectIds(utilizationScope)}`
      : null,
  );

  // Clicking a project opens its detail: one scoped history query and one
  // scoped snapshot — a couple of requests each, memoized server-side.
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const detailHistory = useReport<ProjectReport>(
    selectedProject && historyCapable
      ? `/api/project-report?${orgQuery}${range}&projectIds=${encodeURIComponent(selectedProject)}`
      : null,
  );
  const detailSnapshot = useReport<SnapshotReport>(
    selectedProject && orgId
      ? `/api/current-report?${orgQuery}projectIds=${encodeURIComponent(selectedProject)}`
      : null,
  );

  const statTiles = useMemo(() => {
    if (freePlan) {
      if (!snapshot.data) return [];
      let compute = 0;
      let active = 0;
      let written = 0;
      let storage = 0;
      for (const project of snapshot.data.projects) {
        compute += Number(project.metrics.computeTimeSeconds) / 3600;
        active += Number(project.metrics.activeTimeSeconds) / 3600;
        written += Number(project.metrics.writtenDataBytes) / 1e9;
        storage += Number(project.branchStorage.totalLogicalSizeBytes ?? "0") / 1e9;
      }
      return [
        { name: "compute", label: "Compute (period)", unit: "hrs", value: formatQuantity(compute) },
        { name: "active", label: "Active (period)", unit: "hrs", value: formatQuantity(active) },
        { name: "written", label: "Written (period)", unit: "GB", value: formatQuantity(written) },
        { name: "storage", label: "Branch storage", unit: "GB", value: formatQuantity(storage) },
      ];
    }
    if (live) {
      if (!derivedRows) return [];
      const totals = new Map<string, number>();
      for (const row of derivedRows) {
        for (const [name, value] of Object.entries(row.metrics)) {
          totals.set(name, (totals.get(name) ?? 0) + value);
        }
      }
      return [...totals.entries()]
        .filter(([, value]) => value > 0)
        .slice(0, 4)
        .map(([name, value]) => ({
          name,
          label: metricInfo(name).label,
          unit: metricInfo(name).unit,
          value: formatQuantity(value),
        }));
    }
    if (!usage.data) return [];
    // Partial coverage suppresses authoritative totals (null); render no tiles
    // rather than crashing on `.filter`.
    return (usage.data.totals ?? [])
      .filter((total) => total.derived && Number(total.derived.decimalApproximation) > 0)
      .slice(0, 4)
      .map((total) => ({
        name: total.name,
        label: metricInfo(total.name).label,
        unit: metricInfo(total.name).unit,
        value: formatQuantity(Number(total.derived?.decimalApproximation ?? "0")),
      }));
  }, [freePlan, snapshot.data, live, derivedRows, usage.data]);

  return (
    <main className="mx-auto max-w-6xl space-y-5 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Neon usage</h1>
          <p className="text-xs text-[color:var(--muted-foreground)]">
            Read-only local dashboard. Live-project usage loads by default; the invoice-aligned
            whole-org reports collect on demand. Nothing in Neon is ever changed.
          </p>
        </div>
        {/* Persistent controls (Organization, Theme) are anchored right so they
            hold position when the plan-specific Period/Scope controls drop out. */}
        <div className="ml-auto flex flex-wrap items-center justify-end gap-3">
          {freePlan ? null : (
            <label className="flex items-center gap-2 text-xs">
              <span className="text-[color:var(--muted-foreground)]">Period</span>
              <select
                className="rounded-md border border-[color:var(--border)] bg-[color:var(--card)] px-2 py-1.5"
                value={periodId}
                onChange={(event) => setPeriodId(event.target.value)}
              >
                {periods.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {freePlan ? null : (
            // biome-ignore lint/a11y/useSemanticElements: a labeled segmented control, not a form fieldset
            <div
              className="inline-flex rounded-md border border-[color:var(--border)] p-0.5 text-xs"
              role="group"
              aria-label="History scope"
            >
              {(
                [
                  { id: "organization" as const, label: "All projects" },
                  { id: "live-projects" as const, label: "Live only (fast)" },
                ] as const
              ).map((option) => (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={scope === option.id}
                  onClick={() => chooseScope(option.id)}
                  className={
                    scope === option.id
                      ? "rounded bg-[color:var(--secondary)] px-2 py-1 font-medium text-[color:var(--foreground)]"
                      : "rounded px-2 py-1 text-[color:var(--muted-foreground)] hover:text-[color:var(--foreground)]"
                  }
                >
                  {option.label}
                </button>
              ))}
            </div>
          )}
          <label className="flex items-center gap-2 text-xs">
            <span className="text-[color:var(--muted-foreground)]">Organization</span>
            <select
              className="rounded-md border border-[color:var(--border)] bg-[color:var(--card)] px-2 py-1.5"
              value={orgId ?? ""}
              onChange={(event) => {
                setSelectedOrg(event.target.value || null);
                setSelectedProject(null);
                setSnapshotScope(null);
                setUtilizationScope(null);
                setRequested({ history: false, estimate: false });
                setFormat("gb");
              }}
            >
              {orgId === null ? <option value="">select…</option> : null}
              {(organizations.data ?? (orgId ? [{ id: orgId, name: null }] : [])).map(
                (organization) => (
                  <option key={organization.id} value={organization.id}>
                    {organization.name ?? organization.id}
                  </option>
                ),
              )}
            </select>
          </label>
          <button
            type="button"
            onClick={() => chooseTheme(theme === "dark" ? "light" : "dark")}
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            className="rounded-md border border-[color:var(--border)] p-1.5 text-[color:var(--muted-foreground)] hover:text-[color:var(--foreground)]"
          >
            {theme === "dark" ? (
              // Sun: click to go light
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
              </svg>
            ) : (
              // Moon: click to go dark
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            )}
          </button>
        </div>
      </header>

      {freePlan ? (
        <p className="rounded-md border border-[color:var(--border)] bg-[color:var(--muted)]/40 px-3 py-2 text-xs">
          Free plan: Neon's consumption history API is available on Launch and above, so this
          organization shows its live current-period counters instead — cumulative since the period
          started. Free organizations are not billed; limits suspend service instead.
        </p>
      ) : null}
      {!freePlan && scope === "live-projects" ? (
        <p className="rounded-md border border-[color:var(--status-scaling)]/40 bg-[color:var(--status-scaling)]/10 px-3 py-2 text-xs">
          Live-projects scope: skips projects deleted during the window, so totals can undercount
          the invoice. Switch to "All projects" for invoice-aligned numbers.
        </p>
      ) : null}

      {!authorized ? (
        <p className="rounded-md border border-[color:var(--destructive)]/40 bg-[color:var(--destructive)]/10 p-3 text-sm">
          This page was opened without its launch URL, so the API will refuse it. Rerun `neon-usage
          dashboard` and use the URL it opens or prints.
        </p>
      ) : null}
      {context.data?.credential === "demo" ? (
        <p className="rounded-md border border-[color:var(--border)] bg-[color:var(--muted)]/40 px-3 py-2 text-xs text-[color:var(--muted-foreground)]">
          Demo data — every value on this page is synthetic; no Neon account is involved.
        </p>
      ) : null}
      {context.data?.credential === "missing" ? (
        <p className="rounded-md border border-[color:var(--destructive)]/40 bg-[color:var(--destructive)]/10 p-3 text-sm">
          No Neon credential found. Set NEON_API_KEY, add .env.local, or run `neon auth`, then
          restart the dashboard.
        </p>
      ) : null}
      {organizations.error ? (
        <p className="text-xs text-[color:var(--destructive)]">
          Organizations unavailable: {organizations.error}
        </p>
      ) : null}

      {freePlan ? null : live ? (
        <>
          {history.data && !history.loading ? (
            // Only after every chunk lands: an intermediate prefix would show
            // "Complete coverage" for totals that cover only the chunks so far.
            <CoverageBanner
              coverage={history.data.coverage}
              generatedAt={history.data.generatedAt}
              asOf={history.data.asOf}
              servedFromStore={history.data.servedFromStore}
            />
          ) : null}
          {history.loading ? (
            <CollectingNotice
              label={`live-project history${chunked.progress ? ` (chunk ${chunked.progress})` : ""}`}
            />
          ) : null}
        </>
      ) : usage.data ? (
        <CoverageBanner
          coverage={usage.data.coverage}
          generatedAt={usage.data.generatedAt}
          asOf={usage.data.asOf}
          servedFromStore={usage.data.servedFromStore}
          extra={usage.data.enrichmentWarnings}
        />
      ) : usage.loading ? (
        <CollectingNotice label="the usage overview" />
      ) : null}

      {projects.data ? (
        <p className="text-xs text-[color:var(--muted-foreground)]">
          {projects.data.projects.length} live project(s)
          {projects.data.unavailableProjectIds.length > 0
            ? `; ${projects.data.unavailableProjectIds.length} unavailable`
            : ""}
        </p>
      ) : null}

      {statTiles.length > 0 ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {statTiles.map((tile) => (
            <div
              key={tile.name}
              className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)] p-3"
            >
              <p className="text-xs text-[color:var(--muted-foreground)]">{tile.label}</p>
              <p className="text-xl font-semibold tabular-nums">
                {tile.value}{" "}
                <span className="text-xs font-normal text-[color:var(--muted-foreground)]">
                  {tile.unit}
                </span>
              </p>
            </div>
          ))}
        </div>
      ) : null}

      {freePlan ? null : (
        <UsageSection
          overview={usage.data}
          overviewLoading={usage.loading}
          derived={live ? { rows: derivedRows ?? [], loading: history.loading } : null}
          estimate={estimate.data}
          estimateLoading={estimate.loading}
          error={format === "price" ? estimate.error : live ? history.error : usage.error}
          format={format}
          onFormatChange={setFormat}
          projectNames={
            new Map((projects.data?.projects ?? []).map((project) => [project.id, project.name]))
          }
          onSelectProject={(projectId) =>
            setSelectedProject((previous) => (previous === projectId ? null : projectId))
          }
        />
      )}

      {selectedProject && !freePlan ? (
        <ProjectDetail
          projectId={selectedProject}
          name={projects.data?.projects.find((entry) => entry.id === selectedProject)?.name ?? null}
          history={detailHistory.data}
          historyLoading={detailHistory.loading}
          historyError={detailHistory.error}
          snapshot={detailSnapshot.data}
          snapshotLoading={detailSnapshot.loading}
          snapshotError={detailSnapshot.error}
          granularity={granularity}
          onClose={() => setSelectedProject(null)}
        />
      ) : null}

      {freePlan ? null : (
        <OnDemandSection
          title="History charts"
          cost="Collects the bucketed time-series for the selected window (one project-report collection)."
          loaded={wantHistory}
          actions={[{ label: "Collect now", run: () => request("history") }]}
        >
          <HistoryCharts
            report={history.data}
            isLoading={history.loading}
            error={history.error}
            granularity={granularity}
          />
        </OnDemandSection>
      )}

      {freePlan ? null : (
        <OnDemandSection
          title="Cost estimate & storage composition"
          cost="Collects history and projects it through the published rate card (never an invoice)."
          loaded={wantEstimate}
          actions={[{ label: "Collect now", run: () => request("estimate") }]}
        >
          <EstimateSection
            estimate={estimate.data}
            overview={usage.data}
            isLoading={estimate.loading}
            error={estimate.error}
          />
        </OnDemandSection>
      )}

      <OnDemandSection
        title="Current period snapshot"
        cost="A project-record request plus a branch listing per project — active projects is the cheap answer; all projects walks the fleet."
        loaded={effectiveSnapshotScope !== null}
        actions={[
          ...(activeProjectIds.length > 0
            ? [
                {
                  label: `Active projects (${activeProjectIds.length})`,
                  run: () => setSnapshotScope("active"),
                },
              ]
            : []),
          {
            label: `All projects${projects.data ? ` (${projects.data.projects.length})` : ""}`,
            run: () => setSnapshotScope("all"),
          },
        ]}
      >
        <SnapshotSection
          report={snapshot.data}
          isLoading={snapshot.loading}
          error={snapshot.error}
        />
      </OnDemandSection>

      <OnDemandSection
        title="Controls & quota utilization"
        cost="Reads quotas and current usage per project — active projects is the cheap answer."
        loaded={utilizationScope !== null}
        actions={[
          ...(activeProjectIds.length > 0
            ? [
                {
                  label: `Active projects (${activeProjectIds.length})`,
                  run: () => setUtilizationScope("active"),
                },
              ]
            : []),
          {
            label: `All projects${projects.data ? ` (${projects.data.projects.length})` : ""}`,
            run: () => setUtilizationScope("all"),
          },
        ]}
      >
        <UtilizationSection
          report={utilization.data}
          isLoading={utilization.loading}
          error={utilization.error}
          projectNames={
            new Map((projects.data?.projects ?? []).map((project) => [project.id, project.name]))
          }
        />
      </OnDemandSection>

      <footer className="border-t border-[color:var(--border)] pt-3 text-xs text-[color:var(--muted-foreground)]">
        Served from 127.0.0.1 by `neon-usage dashboard`; your API key never reaches this page.
        Identical queries are served from a 5-minute local memo; the report's generatedAt always
        states when it was collected.
      </footer>
    </main>
  );
}
