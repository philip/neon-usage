// Serve-from-store: the read side of the evidence store. A completed
// collection run certifies the effective range its intent names, and a
// complete bucket is immutable by identity — so a report can serve
// already-collected buckets from the store and collect only what is
// missing, plus a configurable re-observation tail for metering lag.
// Everything served is labeled (servedFromStore with the original
// collection time); run IDs never reach report JSON.

import type { Granularity, ProjectReportQuery } from "./consumption-query.js";
import type { EvidenceRef, SourcePeriod } from "./consumption-source.js";
import type { EvidenceFactStore } from "./evidence-fact-store.js";
import type { CollectionRunId, HistoryBudget } from "./history-collection.js";
import type { HistoryQualityFlag } from "./history-report.js";
import type { OperationContext } from "./operation-context.js";
import { throwIfAborted } from "./operation-context.js";

/**
 * Trailing buckets re-collected from the API even when stored — the only
 * window where a closed bucket's number could still move (metering lag).
 * Defaults to 0: closed buckets are final in Neon's metering, and any
 * nonzero tail costs a full fleet walk on large organizations because
 * history pages scale with project count, not bucket count. Adjustable
 * per query (--store-tail / storeTail) if that position needs revisiting.
 */
export const DEFAULT_STORE_TAIL_BUCKETS = 0;

export type StoreServingOptions = {
  /** Serve covered buckets from the store; false collects everything fresh. */
  serve: boolean;
  /** Trailing buckets always re-collected; 0 trusts the store completely. */
  tailBuckets: number;
};

export type StoredServingPlan = {
  /** Bucket starts to serve from the store, each with its owning run. */
  served: Array<{ bucketStart: string; runId: CollectionRunId; collectedAt: string }>;
  /** Contiguous remainder to collect live; null when fully served. */
  collectRange: { from: string; to: string } | null;
};

/** UTC bucket boundaries of [from, to) for a granularity. */
export function bucketStarts(range: {
  from: string;
  to: string;
  granularity: Granularity;
}): string[] {
  const starts: string[] = [];
  const cursor = new Date(range.from);
  const end = new Date(range.to).getTime();
  while (cursor.getTime() < end) {
    starts.push(cursor.toISOString());
    if (range.granularity === "hourly") cursor.setUTCHours(cursor.getUTCHours() + 1);
    else if (range.granularity === "daily") cursor.setUTCDate(cursor.getUTCDate() + 1);
    else cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return starts;
}

function sameStringSet(left: readonly string[] | undefined, right: readonly string[] | undefined) {
  if (left === undefined || right === undefined) return left === right;
  // True SET equality: a duplicate-bearing list must not pass a length
  // comparison and thereby "cover" a member the other side lacks.
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
}

/**
 * Whether a stored run's effective query certifies the requested scope
 * (everything but the time range). Organization, granularity, and metric set
 * must match exactly. The project set must COVER the request: equal, a
 * strict superset, or a whole-organization walk (undefined) — a run that
 * paginated the whole org (or an explicit superset) observed every requested
 * project's buckets, so its facts serve the subset. The reverse never holds:
 * a run filtered to [A] cannot certify anything about B, and an org-wide
 * request (undefined) is covered only by an org-wide run — serving it from
 * an explicit ID list would silently drop projects outside that list.
 */
export function storedScopeCovers(
  stored: ProjectReportQuery,
  requested: ProjectReportQuery,
): boolean {
  if (stored.organizationId !== requested.organizationId) return false;
  if (stored.granularity !== requested.granularity) return false;
  if (!sameStringSet(stored.metrics, requested.metrics)) return false;
  if (stored.projectIds === undefined) return true;
  if (requested.projectIds === undefined) return false;
  const storedSet = new Set(stored.projectIds);
  return requested.projectIds.every((projectId) => storedSet.has(projectId));
}

/**
 * Plans which leading buckets can be served from completed runs and what
 * remains to collect. Serving is a covered prefix only: history grows at
 * the end, so a gap in the middle simply collects from the gap onward.
 * The final `tailBuckets` buckets are never served.
 */
export function planStoredServing(input: {
  collectionQuery: ProjectReportQuery;
  runs: ReadonlyArray<{
    runId: CollectionRunId;
    status: string;
    completedAt?: string;
    request: ProjectReportQuery;
  }>;
  tailBuckets: number;
}): StoredServingPlan {
  const starts = bucketStarts({
    from: input.collectionQuery.from,
    to: input.collectionQuery.to,
    granularity: input.collectionQuery.granularity,
  });
  const candidates = input.runs
    .filter(
      (run) =>
        run.status === "complete" &&
        run.completedAt !== undefined &&
        storedScopeCovers(run.request, input.collectionQuery),
    )
    .sort((left, right) => (left.completedAt ?? "").localeCompare(right.completedAt ?? ""));
  const servableCount = Math.max(0, starts.length - Math.max(0, input.tailBuckets));
  const served: StoredServingPlan["served"] = [];
  for (const [index, bucketStart] of starts.entries()) {
    if (index >= servableCount) break;
    const bucketTime = new Date(bucketStart).getTime();
    const nextStart = starts[index + 1] ?? input.collectionQuery.to;
    const bucketEnd = new Date(nextStart).getTime();
    // Newest run covering the whole bucket owns it.
    const owner = [...candidates]
      .reverse()
      .find(
        (run) =>
          new Date(run.request.from).getTime() <= bucketTime &&
          new Date(run.request.to).getTime() >= bucketEnd,
      );
    if (!owner) break;
    served.push({
      bucketStart,
      runId: owner.runId,
      collectedAt: owner.completedAt ?? "",
    });
  }
  const collectFrom = starts[served.length];
  return {
    served,
    collectRange:
      collectFrom === undefined ? null : { from: collectFrom, to: input.collectionQuery.to },
  };
}

export type ReplayedProjects = {
  /** Source periods per project, clipped to the served buckets. */
  projects: Map<string, SourcePeriod[]>;
  evidence: EvidenceRef[];
  pageCount: number;
  qualityFlags: HistoryQualityFlag[];
  /** Newest original collection time among the served runs. */
  collectedAt: string;
};

type StoredProjectPage = {
  projects?: Array<{ projectId: string; periods: SourcePeriod[] }>;
};

/**
 * Replays the served runs' stored pages and clips every project's buckets
 * to the bucket set each run owns, so overlapping runs cannot double-count.
 * When the requested query names project IDs, only those projects are
 * replayed: an owning run may have a wider scope (a whole-organization or
 * superset walk), and its other projects must not leak into this report.
 */
export async function replayStoredProjects(
  store: EvidenceFactStore,
  plan: StoredServingPlan,
  getRun: (
    runId: CollectionRunId,
  ) => Promise<{ pageCount: number; qualityFlags: readonly HistoryQualityFlag[] } | undefined>,
  requestedProjectIds?: readonly string[],
  options: {
    maxDurationMs?: number;
    maxItems?: number;
    maxFacts?: number;
    maxBytes?: number;
    budget?: HistoryBudget;
    context?: OperationContext;
    /** Runs the collect path's shape/integrity validation on each stored
     * page BEFORE it is trusted: the store is a plain user-writable file,
     * and a corrupt or edited page must surface as a structured integrity
     * failure, never as silently wrong totals or a raw SyntaxError. */
    validatePage?(
      page: { projects?: Array<{ projectId: string; periods: SourcePeriod[] }> },
      pageEvidence: readonly EvidenceRef[],
    ): void;
  } = {},
): Promise<ReplayedProjects> {
  const requested = requestedProjectIds ? new Set(requestedProjectIds) : null;
  const ownedBuckets = new Map<CollectionRunId, Set<string>>();
  for (const entry of plan.served) {
    const owned = ownedBuckets.get(entry.runId) ?? new Set<string>();
    owned.add(entry.bucketStart);
    ownedBuckets.set(entry.runId, owned);
  }
  const projects = new Map<string, SourcePeriod[]>();
  const evidence: EvidenceRef[] = [];
  const qualityFlags = new Set<HistoryQualityFlag>();
  let pageCount = 0;
  const budget = options.budget ?? {
    ...(options.maxDurationMs ? { maxDurationMs: options.maxDurationMs } : {}),
    ...(options.maxItems ? { maxItems: options.maxItems } : {}),
    ...(options.maxFacts ? { maxFacts: options.maxFacts } : {}),
    ...(options.maxBytes ? { maxBytes: options.maxBytes } : {}),
    startedAt: performance.now(),
    items: 0,
    facts: 0,
    bytes: 0,
    pages: 0,
  };
  let collectedAt = "";
  for (const [runId, owned] of ownedBuckets) {
    throwIfAborted(options.context);
    const run = await getRun(runId);
    if (!run) {
      throw new Error(`Stored collection run ${runId} disappeared while serving`);
    }
    for (const flag of run.qualityFlags) qualityFlags.add(flag);
    const runCollectedAt = plan.served.find((entry) => entry.runId === runId)?.collectedAt ?? "";
    if (runCollectedAt > collectedAt) collectedAt = runCollectedAt;
    for (let pageNumber = 1; pageNumber <= run.pageCount; pageNumber += 1) {
      throwIfAborted(options.context);
      if (
        budget.maxDurationMs !== undefined &&
        performance.now() - budget.startedAt >= budget.maxDurationMs
      ) {
        qualityFlags.add("TIME_LIMIT_REACHED");
        return { projects, evidence, pageCount, qualityFlags: [...qualityFlags], collectedAt };
      }
      const page = await store.getRunPage(runId, pageNumber);
      if (!page) {
        throw new Error(`Stored page ${pageNumber} of run ${runId} disappeared while serving`);
      }
      const stored = page.page as StoredProjectPage;
      options.validatePage?.(stored, page.evidence);
      if (budget.maxPages !== undefined && budget.pages + 1 > budget.maxPages) {
        qualityFlags.add("PAGE_LIMIT_REACHED");
        return { projects, evidence, pageCount, qualityFlags: [...qualityFlags], collectedAt };
      }
      const pageBytes = Buffer.byteLength(JSON.stringify(page.page));
      const candidates = (stored.projects ?? []).flatMap((project) => {
        if (requested && !requested.has(project.projectId)) return [];
        const periods = project.periods
          .map((period) => ({
            ...period,
            buckets: period.buckets.filter((bucket) =>
              owned.has(new Date(bucket.start).toISOString()),
            ),
          }))
          .filter((period) => period.buckets.length > 0);
        return periods.length > 0 ? [{ projectId: project.projectId, periods }] : [];
      });
      const pageFacts = candidates.reduce(
        (total, project) =>
          total +
          project.periods.reduce(
            (periodTotal, period) =>
              periodTotal +
              period.buckets.reduce(
                (bucketTotal, bucket) => bucketTotal + bucket.metrics.length,
                0,
              ),
            0,
          ),
        0,
      );
      if (budget.maxItems !== undefined && budget.items + candidates.length > budget.maxItems) {
        qualityFlags.add("ITEM_LIMIT_REACHED");
        return { projects, evidence, pageCount, qualityFlags: [...qualityFlags], collectedAt };
      }
      if (budget.maxFacts !== undefined && budget.facts + pageFacts > budget.maxFacts) {
        qualityFlags.add("FACT_LIMIT_REACHED");
        return { projects, evidence, pageCount, qualityFlags: [...qualityFlags], collectedAt };
      }
      if (budget.maxBytes !== undefined && budget.bytes + pageBytes > budget.maxBytes) {
        qualityFlags.add("BYTE_LIMIT_REACHED");
        return { projects, evidence, pageCount, qualityFlags: [...qualityFlags], collectedAt };
      }
      budget.items += candidates.length;
      budget.facts += pageFacts;
      budget.bytes += pageBytes;
      budget.pages += 1;
      pageCount += 1;
      evidence.push(...page.evidence);
      for (const project of candidates) {
        const existing = projects.get(project.projectId) ?? [];
        projects.set(project.projectId, mergePeriods(existing, project.periods));
      }
    }
  }
  return { projects, evidence, pageCount, qualityFlags: [...qualityFlags], collectedAt };
}

/** Merges source periods by period ID, concatenating disjoint buckets in
 * start order. */
export function mergePeriods(left: SourcePeriod[], right: SourcePeriod[]): SourcePeriod[] {
  const byId = new Map<string, SourcePeriod>();
  for (const period of left) byId.set(period.id, period);
  for (const period of right) {
    const existing = byId.get(period.id);
    if (!existing) {
      byId.set(period.id, period);
      continue;
    }
    const seen = new Set(existing.buckets.map((bucket) => bucket.start));
    byId.set(period.id, {
      ...existing,
      buckets: [
        ...existing.buckets,
        ...period.buckets.filter((bucket) => !seen.has(bucket.start)),
      ].sort((a, b) => a.start.localeCompare(b.start)),
    });
  }
  return [...byId.values()].sort((a, b) => a.start.localeCompare(b.start));
}
