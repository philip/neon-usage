// Machinery shared by the delivery adapters (CLI and local dashboard HTTP):
// string-option parsing into report queries, default ranges, organization and
// project-ID resolution, partial-coverage detection, and the dependencies seam
// both adapters call through. Behavior here is the adapter contract — the
// parity tests hold CLI and HTTP to identical bodies for identical queries.

import type { BranchReportQuery, ProjectReportQuery } from "./consumption-query.js";
import type { NeonOrganization } from "./consumption-source.js";
import { projectConsumptionMetrics } from "./metric-catalog.js";
import type { OperationContext } from "./operation-context.js";
import { OperationCancelledError, throwIfAborted } from "./operation-context.js";
import type { PricingEstimate } from "./pricing-estimate.js";
import type { StoreServingOptions } from "./stored-history.js";
import type { UsageOverview } from "./usage-overview-service.js";

export type CollectionControl = {
  resumeRunId?: `run_${string}`;
  runId?: `run_${string}`;
  /** Serve-from-store policy; adapters default to serving with the standard tail. */
  storeServing?: StoreServingOptions;
};

export type ResolvedContextReport = {
  organizationId: string | null;
  projectId: string | null;
  branch: string | null;
  credential: "configured" | "missing" | "injected";
};

/**
 * The service surface a delivery adapter needs. The CLI extends it with
 * output concerns (write, exit codes); the dashboard HTTP layer serves it
 * as-is. Optional members reflect capabilities a configured adapter may
 * legitimately lack.
 */
export type ReportDependencies = {
  controls?(
    organizationId: string,
    projectIds: string[],
    context?: OperationContext,
  ): Promise<unknown>;
  quotaUtilization?(
    organizationId: string,
    projectIds: string[],
    context?: OperationContext,
  ): Promise<unknown>;
  projectReport(
    query: ProjectReportQuery,
    control?: CollectionControl,
    context?: OperationContext,
  ): Promise<unknown>;
  branchReport(
    query: BranchReportQuery,
    control?: CollectionControl,
    context?: OperationContext,
  ): Promise<unknown>;
  organizationSummary(
    query: ProjectReportQuery,
    control?: CollectionControl,
    context?: OperationContext,
  ): Promise<unknown>;
  capabilities(organizationId: string, context?: OperationContext): Promise<unknown>;
  /** Optional projectIds bound the per-project fan-out (one request each). */
  currentReport(
    organizationId: string,
    projectIds?: string[],
    context?: OperationContext,
  ): Promise<unknown>;
  organizations?(context?: OperationContext): Promise<NeonOrganization[]>;
  projects?(
    organizationId: string,
    context?: OperationContext,
  ): Promise<{
    projects: Array<{ id: string; name: string }>;
    unavailableProjectIds: string[];
  }>;
  usageOverview?(
    query: ProjectReportQuery,
    control?: CollectionControl,
    context?: OperationContext,
  ): Promise<UsageOverview>;
  storedProjectNames?(
    projectIds: string[],
    context?: OperationContext,
  ): Promise<Map<string, string>>;
  estimate?(
    query: ProjectReportQuery,
    control?: CollectionControl,
    context?: OperationContext,
  ): Promise<PricingEstimate>;
  defaultOrganizationId?: string;
  defaultProjectId?: string;
  context?: ResolvedContextReport;
};

export function historyQueryFromOptions(
  options: Record<string, string>,
  now: Date,
): ProjectReportQuery {
  const granularity = options.granularity as ProjectReportQuery["granularity"];
  if (options.month && (options.last || options.from || options.to)) {
    throw new Error("--month cannot be combined with --last, --from, or --to");
  }
  if (options.last && (options.from || options.to)) {
    throw new Error("--last cannot be combined with --from or --to");
  }
  if (Boolean(options.from) !== Boolean(options.to)) {
    throw new Error("Pass --from and --to together, or use --last");
  }
  const monthRange = options.month ? monthToRange(options.month, now) : undefined;
  const defaultRange = defaultHistoryRange(granularity, now, options.last);
  return {
    organizationId: options.orgId ?? "",
    from: monthRange?.from ?? options.from ?? defaultRange.from,
    to: monthRange?.to ?? options.to ?? defaultRange.to,
    granularity,
    metrics: commaSeparatedValues(options.metrics ?? projectConsumptionMetrics.join(",")),
  };
}

/**
 * Expands a `YYYY-MM` calendar month — or the keywords `current`/`previous` —
 * into a [from, to) range. The in-progress month clamps `to` to the last
 * complete day, so it means "this month to date"; a partial month is never
 * presented as if it were finished.
 */
function monthToRange(month: string, now: Date): { from: string; to: string } {
  const resolved = resolveMonthKeyword(month, now);
  const match = /^(\d{4})-(\d{2})$/.exec(resolved);
  const monthIndex = match ? Number(match[2]) - 1 : Number.NaN;
  if (!match || monthIndex < 0 || monthIndex > 11) {
    throw new Error("--month must be a calendar month (2026-07), or 'current' or 'previous'");
  }
  const year = Number(match[1]);
  const from = new Date(Date.UTC(year, monthIndex, 1));
  const nextMonth = new Date(Date.UTC(year, monthIndex + 1, 1));
  const todayFloor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const to = nextMonth.getTime() < todayFloor.getTime() ? nextMonth : todayFloor;
  if (to.getTime() <= from.getTime()) {
    throw new Error("--month current has no complete day yet; try --last 1d or --month previous");
  }
  return { from: from.toISOString(), to: to.toISOString() };
}

function resolveMonthKeyword(month: string, now: Date): string {
  const keyword = month.trim().toLowerCase();
  const asMonth = (offset: number) => {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  };
  if (keyword === "current") return asMonth(0);
  if (keyword === "previous" || keyword === "last") return asMonth(1);
  return month;
}

function defaultHistoryRange(
  granularity: ProjectReportQuery["granularity"],
  now: Date,
  duration?: string,
) {
  const to = new Date(now);
  if (granularity === "hourly") {
    to.setUTCMinutes(0, 0, 0);
    const from = new Date(to);
    from.setUTCHours(from.getUTCHours() - parseDuration(duration ?? "24h", ["h", "d", "w"]));
    return { from: from.toISOString(), to: to.toISOString() };
  }
  if (granularity === "monthly") {
    to.setUTCDate(1);
    to.setUTCHours(0, 0, 0, 0);
    const from = new Date(to);
    from.setUTCMonth(from.getUTCMonth() - parseDuration(duration ?? "6mo", ["mo"]));
    return { from: from.toISOString(), to: to.toISOString() };
  }
  to.setUTCHours(0, 0, 0, 0);
  // With no explicit window, the daily default is the current calendar month
  // to date — the billing-period view people expect (and what the dashboard
  // shows). On the 1st, when the month has no complete day yet, fall back to
  // the last 7 days so there is always something to report.
  if (duration === undefined) {
    const monthStart = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
    if (monthStart.getTime() < to.getTime()) {
      return { from: monthStart.toISOString(), to: to.toISOString() };
    }
  }
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - parseDuration(duration ?? "7d", ["d", "w"]));
  return { from: from.toISOString(), to: to.toISOString() };
}

function parseDuration(value: string, allowedUnits: string[]): number {
  const match = /^(\d+)(h|d|w|mo)$/.exec(value);
  if (!match?.[1] || !match[2] || !allowedUnits.includes(match[2])) {
    throw new Error(`Invalid --last value for this granularity: ${value}`);
  }
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount < 1) throw new Error("--last must be positive");
  const hourly = allowedUnits.includes("h");
  const units =
    match[2] === "w"
      ? amount * 7 * (hourly ? 24 : 1)
      : match[2] === "d"
        ? amount * (hourly ? 24 : 1)
        : amount;
  const lookback = hourly
    ? { limit: 168, label: "168 hours" }
    : allowedUnits.includes("mo")
      ? { limit: 12, label: "12 months" }
      : { limit: 60, label: "60 days" };
  if (units > lookback.limit) {
    throw new Error(`--last ${value} exceeds the ${lookback.label} lookback for this granularity`);
  }
  return units;
}

export function commaSeparatedValues(value: string): string[] {
  const values = value.split(",").map((item) => item.trim());
  if (values.some((item) => item.length === 0)) {
    throw new Error("comma-separated values must not contain empty entries");
  }
  return values;
}

export function hasPartialCoverage(value: unknown): boolean {
  if (typeof value !== "object" || value === null || !("coverage" in value)) {
    return false;
  }
  const coverage = value.coverage;
  return (
    typeof coverage === "object" &&
    coverage !== null &&
    "status" in coverage &&
    coverage.status === "partial"
  );
}

export async function resolveOrganizationId(
  value: string | undefined,
  dependencies: ReportDependencies,
  context?: OperationContext,
): Promise<string> {
  const organizationId = value?.trim() || dependencies.defaultOrganizationId;
  if (organizationId) return organizationId;
  const organizations = await dependencies.organizations?.(context);
  if (organizations?.length === 1 && organizations[0]) return organizations[0].id;
  if (organizations && organizations.length > 1) {
    throw new Error(
      "Multiple Neon organizations are available; run `neon-usage organizations`, then pass --org-id or run `neon link`",
    );
  }
  throw new Error(
    "Neon organization ID is required; pass --org-id, set NEON_ORG_ID, run `neon link`, or check `neon-usage organizations`",
  );
}

/**
 * The linked-project default shared by history commands: an explicit list wins;
 * otherwise the linked project applies only when the selected organization is
 * the linked one.
 */
export function defaultHistoryProjectIds(
  options: { projectIds?: string; orgId?: string },
  dependencies: ReportDependencies,
): string[] | undefined {
  return options.projectIds
    ? commaSeparatedValues(options.projectIds)
    : dependencies.defaultProjectId &&
        (!options.orgId || options.orgId === dependencies.defaultOrganizationId)
      ? [dependencies.defaultProjectId]
      : undefined;
}

export const historyScopes = ["organization", "live-projects"] as const;
export type HistoryScope = (typeof historyScopes)[number];

/**
 * The IDs of projects that exist right now. Scoping history to them skips
 * pagination over deleted projects — a large speedup for CI-heavy
 * organizations — but **undercounts versus the invoice**: projects deleted
 * during the window still bill for their consumption. Every surface that
 * shows a live-scoped report must say so.
 */
export async function liveProjectIds(
  organizationId: string,
  dependencies: ReportDependencies,
  context?: OperationContext,
): Promise<string[]> {
  if (!dependencies.projects) {
    throw new Error("Live-project scoping is unavailable in the configured adapter");
  }
  const directory = await dependencies.projects(organizationId, context);
  return directory.projects.map((project) => project.id);
}

/**
 * A single history query filters at most 100 projects (a source limit).
 * Callers that cannot chunk — a plain scoped project-report — reject a
 * larger live fleet with this message; the estimate path and the page
 * collect in chunks instead.
 */
export function assertWithinHistoryFilter(projectIds: string[]): string[] {
  if (projectIds.length > 100) {
    throw new Error(
      `${projectIds.length} live projects exceed the 100-project history filter; query explicit --project-ids chunks or use the organization scope`,
    );
  }
  return projectIds;
}

/**
 * The controls default: explicit IDs win; `all` (or no linked project) expands
 * to every project in the organization.
 */
export async function resolveControlsProjectIds(
  options: { projectIds?: string; orgId?: string },
  organizationId: string,
  dependencies: ReportDependencies,
  context?: OperationContext,
): Promise<string[]> {
  const linkedProject =
    dependencies.defaultProjectId &&
    (!options.orgId || options.orgId === dependencies.defaultOrganizationId)
      ? dependencies.defaultProjectId
      : undefined;
  return options.projectIds && options.projectIds !== "all"
    ? commaSeparatedValues(options.projectIds)
    : linkedProject && options.projectIds !== "all"
      ? [linkedProject]
      : ((await dependencies.projects?.(organizationId, context))?.projects.map(
          (project) => project.id,
        ) ?? []);
}

/**
 * Collection-backed calls write runs, facts, and observation revisions to one
 * durable store; interleaved runs against the same store conflict on
 * observation revisions (an integrity failure, by design). A concurrent
 * adapter — the dashboard page fires several reports at once — must run them
 * one at a time. Sequential collections over the same data are idempotent.
 */
/** The collection queue is at capacity; the request was refused, not queued. */
export class CollectionQueueFullError extends Error {
  override readonly name = "CollectionQueueFullError";
}

/** Live depth of the one-at-a-time collection queue. */
export type CollectionQueueState = {
  /** 1 while an operation holds the queue, else 0. */
  running: 0 | 1;
  /** Admitted operations waiting behind the running one. */
  queued: number;
};

export function serializeCollections(
  dependencies: ReportDependencies,
  options: {
    maxQueued?: number;
    /** Fired whenever the queue's depth changes; lets an adapter show an
     * honest "waiting in queue" instead of an endless "collecting". */
    onQueueChange?: (state: CollectionQueueState) => void;
  } = {},
): ReportDependencies {
  const maxQueued = options.maxQueued ?? 32;
  if (!Number.isSafeInteger(maxQueued) || maxQueued < 0) {
    throw new RangeError("maxQueued must be a non-negative safe integer");
  }
  type QueueItem = {
    operation: () => Promise<unknown>;
    context?: OperationContext;
    resolve(value: unknown): void;
    reject(reason: unknown): void;
    onAbort?: () => void;
  };
  let running: QueueItem | undefined;
  const queued: QueueItem[] = [];
  const emitQueueChange = () =>
    options.onQueueChange?.({
      running: running ? 1 : 0,
      queued: queued.length,
    });
  const startNext = (): void => {
    if (running) return;
    const item = queued.shift();
    if (!item) return;
    if (item.onAbort) item.context?.signal?.removeEventListener("abort", item.onAbort);
    try {
      throwIfAborted(item.context);
    } catch (error) {
      item.reject(error);
      emitQueueChange();
      startNext();
      return;
    }
    running = item;
    emitQueueChange();
    Promise.resolve()
      .then(item.operation)
      .then(item.resolve, item.reject)
      .finally(() => {
        running = undefined;
        if (queued.length > 0) startNext();
        else emitQueueChange();
      });
  };
  const enqueue = <T>(operation: () => Promise<T>, context?: OperationContext): Promise<T> => {
    try {
      throwIfAborted(context);
    } catch (error) {
      return Promise.reject(error);
    }
    if (running && queued.length >= maxQueued) {
      return Promise.reject(
        new CollectionQueueFullError(
          `too many collections are already queued (${maxQueued}); wait for them to finish and retry`,
        ),
      );
    }
    return new Promise<T>((resolve, reject) => {
      const item: QueueItem = {
        operation,
        ...(context ? { context } : {}),
        resolve: resolve as (value: unknown) => void,
        reject,
      };
      const signal = context?.signal;
      if (signal) {
        item.onAbort = () => {
          const index = queued.indexOf(item);
          if (index < 0) return;
          queued.splice(index, 1);
          reject(new OperationCancelledError(signal.reason));
          emitQueueChange();
        };
        signal.addEventListener("abort", item.onAbort, { once: true });
      }
      queued.push(item);
      startNext();
      if (queued.includes(item)) emitQueueChange();
    });
  };
  const { usageOverview, estimate, controls, quotaUtilization } = dependencies;
  return {
    ...dependencies,
    projectReport: (query, control, context) =>
      enqueue(() => dependencies.projectReport(query, control, context), context),
    branchReport: (query, control, context) =>
      enqueue(() => dependencies.branchReport(query, control, context), context),
    organizationSummary: (query, control, context) =>
      enqueue(() => dependencies.organizationSummary(query, control, context), context),
    currentReport: (organizationId, projectIds, context) =>
      enqueue(() => dependencies.currentReport(organizationId, projectIds, context), context),
    ...(usageOverview
      ? {
          usageOverview: (query, control, context) =>
            enqueue(() => usageOverview(query, control, context), context),
        }
      : {}),
    ...(estimate
      ? {
          estimate: (query, control, context) =>
            enqueue(() => estimate(query, control, context), context),
        }
      : {}),
    ...(controls
      ? {
          controls: (organizationId, projectIds, context) =>
            enqueue(() => controls(organizationId, projectIds, context), context),
        }
      : {}),
    ...(quotaUtilization
      ? {
          quotaUtilization: (organizationId, projectIds, context) =>
            enqueue(() => quotaUtilization(organizationId, projectIds, context), context),
        }
      : {}),
  };
}

/**
 * Short-TTL per-query memoization with single-flight semantics for the
 * expensive report calls: identical queries inside the window share one
 * in-flight or completed result instead of re-collecting (the gb→price
 * toggle and back-navigation are projections of the same collection).
 * Failures are evicted so a retry really retries. Reports carry their own
 * generatedAt, so a memoized response still tells the truth about its age.
 */
export function memoizeReports(
  dependencies: ReportDependencies,
  options: { ttlMs?: number; now?: () => number; maxEntries?: number } = {},
): ReportDependencies {
  const ttlMs = options.ttlMs ?? 5 * 60_000;
  const now = options.now ?? (() => Date.now());
  // Bound the memo: distinct queries would otherwise grow the map (and the
  // retained report payloads) without limit. Insertion-ordered eviction is
  // enough for a short-TTL cache.
  const maxEntries = options.maxEntries ?? 128;
  if (!Number.isFinite(ttlMs) || ttlMs < 0) {
    throw new RangeError("ttlMs must be a finite non-negative number");
  }
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new RangeError("maxEntries must be a positive safe integer");
  }
  if (ttlMs <= 0) return dependencies;
  type MemoEntry = {
    expires: number;
    settled: boolean;
    subscribers: number;
    controller: AbortController;
    result: Promise<unknown>;
  };
  const cache = new Map<string, MemoEntry>();
  const sweep = () => {
    const at = now();
    for (const [key, entry] of cache) {
      // Only settled entries expire: TTL-evicting a pending single-flight
      // promise would let an identical query start a duplicate collection —
      // the same hole the size-eviction guard below closes. Pending entries
      // always settle (the source enforces request deadlines), so this cannot
      // pin the map forever.
      if (entry.expires <= at && entry.settled) cache.delete(key);
    }
    // Size eviction skips in-flight entries: those retain single-flight
    // identity. Admission below refuses a NEW key when pending entries fill the
    // hard bound.
    if (cache.size > maxEntries) {
      for (const [key, entry] of cache) {
        if (cache.size <= maxEntries) break;
        if (entry.settled) cache.delete(key);
      }
    }
  };
  // The serve toggle is not part of a query's identity: a fresh=1 request
  // bypasses the cache read but REPLACES the shared entry, so a forced
  // re-collection is what subsequent plain requests see. tailBuckets, however,
  // changes what is collected, so it stays in the key (different --store-tail
  // values must not share a cached result).
  const isFreshRequest = (args: unknown[]) =>
    args.some(
      (argument) =>
        typeof argument === "object" &&
        argument !== null &&
        (argument as CollectionControl).storeServing?.serve === false,
    );
  const subscribe = <T>(entry: MemoEntry, context?: OperationContext): Promise<T> => {
    try {
      throwIfAborted(context);
    } catch (error) {
      return Promise.reject(error);
    }
    if (entry.settled) return entry.result as Promise<T>;
    entry.subscribers += 1;
    return new Promise<T>((resolve, reject) => {
      let active = true;
      const signal = context?.signal;
      const unsubscribe = (reason?: unknown) => {
        if (!active) return;
        active = false;
        signal?.removeEventListener("abort", onAbort);
        entry.subscribers -= 1;
        if (entry.subscribers === 0 && !entry.settled && !entry.controller.signal.aborted) {
          entry.controller.abort(reason);
        }
      };
      const onAbort = () => {
        unsubscribe(signal?.reason);
        reject(new OperationCancelledError(signal?.reason));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      entry.result.then(
        (value) => {
          if (!active) return;
          unsubscribe();
          resolve(value as T);
        },
        (error) => {
          if (!active) return;
          unsubscribe();
          reject(error);
        },
      );
    });
  };
  const memoize =
    <A extends unknown[], T>(
      name: string,
      operation: (args: A, context: OperationContext) => Promise<T>,
    ) =>
    (args: A, context?: OperationContext): Promise<T> => {
      try {
        throwIfAborted(context);
      } catch (error) {
        return Promise.reject(error);
      }
      sweep();
      // Key normalization: a fresh (serve=false) control collects the same
      // identity as the plain default (tailBuckets 0), so it must produce the
      // SAME key as a plain request — that is what makes "fresh REPLACES the
      // shared entry" true rather than parking the fresh result under a key no
      // plain request ever reads. Served requests keep tailBuckets in the key
      // (different --store-tail values must not share a result) and drop only
      // the `serve` toggle.
      const normalizedArgs = args.map((argument) => {
        if (typeof argument !== "object" || argument === null) return argument;
        const control = argument as CollectionControl;
        // Also drop an EXPLICIT {serve:true, tailBuckets:0}: it is exactly
        // the built-in default, so it must share the plain request's entry
        // rather than duplicating the collection under a second key.
        if (
          control.storeServing?.serve === false ||
          (control.storeServing?.serve === true && control.storeServing.tailBuckets === 0)
        ) {
          const { storeServing: _dropped, ...rest } = control;
          return Object.keys(rest).length === 0 ? undefined : rest;
        }
        return argument;
      });
      // Trailing empty controls are dropped so `f(query)` and
      // `f(query, freshControl)` normalize to the same arity, hence key.
      while (normalizedArgs.length > 0 && normalizedArgs[normalizedArgs.length - 1] === undefined) {
        normalizedArgs.pop();
      }
      const key = `${name}:${JSON.stringify(normalizedArgs, (property, value) =>
        property === "serve" ? undefined : value,
      )}`;
      let entry = cache.get(key);
      if (entry?.controller.signal.aborted && !entry.settled) {
        cache.delete(key);
        entry = undefined;
      }
      if (entry && !isFreshRequest(args)) return subscribe<T>(entry, context);
      if (!entry && cache.size >= maxEntries) {
        const settled = [...cache].find(([, entry]) => entry.settled);
        if (settled) cache.delete(settled[0]);
        else {
          return Promise.reject(
            new CollectionQueueFullError(
              `too many distinct reports are already pending (${maxEntries}); wait and retry`,
            ),
          );
        }
      }
      const controller = new AbortController();
      const result = Promise.resolve().then(() => operation(args, { signal: controller.signal }));
      entry = {
        expires: now() + ttlMs,
        settled: false,
        subscribers: 0,
        controller,
        result,
      };
      cache.set(key, entry);
      result.then(
        () => {
          if (entry) entry.settled = true;
        },
        () => {
          if (cache.get(key)?.result === result) cache.delete(key);
        },
      );
      return subscribe<T>(entry, context);
    };
  const { usageOverview, estimate, controls, quotaUtilization } = dependencies;
  const projectReport = memoize<[ProjectReportQuery, CollectionControl | undefined], unknown>(
    "projectReport",
    ([query, control], context) => dependencies.projectReport(query, control, context),
  );
  const branchReport = memoize<[BranchReportQuery, CollectionControl | undefined], unknown>(
    "branchReport",
    ([query, control], context) => dependencies.branchReport(query, control, context),
  );
  const organizationSummary = memoize<[ProjectReportQuery, CollectionControl | undefined], unknown>(
    "organizationSummary",
    ([query, control], context) => dependencies.organizationSummary(query, control, context),
  );
  const currentReport = memoize<[string, string[] | undefined], unknown>(
    "currentReport",
    ([organizationId, projectIds], context) =>
      dependencies.currentReport(organizationId, projectIds, context),
  );
  const memoizedUsage = usageOverview
    ? memoize<[ProjectReportQuery, CollectionControl | undefined], UsageOverview>(
        "usageOverview",
        ([query, control], context) => usageOverview(query, control, context),
      )
    : undefined;
  const memoizedEstimate = estimate
    ? memoize<[ProjectReportQuery, CollectionControl | undefined], PricingEstimate>(
        "estimate",
        ([query, control], context) => estimate(query, control, context),
      )
    : undefined;
  const memoizedControls = controls
    ? memoize<[string, string[]], unknown>("controls", ([organizationId, projectIds], context) =>
        controls(organizationId, projectIds, context),
      )
    : undefined;
  const memoizedUtilization = quotaUtilization
    ? memoize<[string, string[]], unknown>(
        "quotaUtilization",
        ([organizationId, projectIds], context) =>
          quotaUtilization(organizationId, projectIds, context),
      )
    : undefined;
  return {
    ...dependencies,
    projectReport: (query, control, context) => projectReport([query, control], context),
    branchReport: (query, control, context) => branchReport([query, control], context),
    organizationSummary: (query, control, context) =>
      organizationSummary([query, control], context),
    currentReport: (organizationId, projectIds, context) =>
      currentReport([organizationId, projectIds], context),
    ...(memoizedUsage
      ? { usageOverview: (query, control, context) => memoizedUsage([query, control], context) }
      : {}),
    ...(memoizedEstimate
      ? { estimate: (query, control, context) => memoizedEstimate([query, control], context) }
      : {}),
    ...(memoizedControls
      ? {
          controls: (organizationId, projectIds, context) =>
            memoizedControls([organizationId, projectIds], context),
        }
      : {}),
    ...(memoizedUtilization
      ? {
          quotaUtilization: (organizationId, projectIds, context) =>
            memoizedUtilization([organizationId, projectIds], context),
        }
      : {}),
  };
}

/**
 * Plan guidance shared by every adapter: when the consumption history API
 * refuses with its Launch-and-above 403, say what the plan CAN answer
 * instead of leaving a bare provider error. The report contract never
 * silently substitutes a different report kind — a usage consumer must not
 * receive a snapshot because the plan differed — so this is a better
 * refusal, not a fallback.
 */
export function withPlanHint(message: string, status?: number): string {
  if (status === 403 && /Launch plans and above/i.test(message)) {
    return `${message} This organization's plan has no consumption history API — use current-report for Free-compatible current-period counters, or capabilities to inspect the plan.`;
  }
  return message;
}

/** The context the configured dependencies resolve to, without exposing credentials. */
export function resolvedContext(dependencies: ReportDependencies): ResolvedContextReport {
  return (
    dependencies.context ?? {
      organizationId: dependencies.defaultOrganizationId ?? null,
      projectId: dependencies.defaultProjectId ?? null,
      branch: null,
      credential: "injected" as const,
    }
  );
}

/** The `context` report body, identical for every adapter over the same resolved context. */
export function contextReport(result: ResolvedContextReport): Record<string, unknown> {
  return {
    ...result,
    ...(result.organizationId ? {} : { organizationHint: "Set NEON_ORG_ID or run `neon link`" }),
    ...(result.credential !== "missing"
      ? {}
      : { credentialHint: "Set NEON_API_KEY, add .env.local, or run `neon auth`" }),
  };
}
