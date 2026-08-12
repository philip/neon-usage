import { useEffect, useState } from "react";
import type { ProjectReport } from "./api";
import { authHeaders } from "./auth";

const CHUNK = 100;

export type ChunkedHistoryState = {
  data: ProjectReport | null;
  error: string | null;
  loading: boolean;
  /** "2/3" while collecting; null when idle or done. */
  progress: string | null;
};

/**
 * The history filter accepts at most 100 project IDs per query, so a
 * live-projects fleet larger than that collects in chunks — one valid query
 * each, serialized by the server, merged here. Partial results render as
 * they land; coverage is the honest merge (partial if any chunk is partial,
 * counts and quality flags accumulated). Deliberately thinner than the
 * server-side mergeProjectConsumptionReports: requestIds, errors,
 * errorDetails, and evidence are dropped because this merge feeds display
 * only — the exact JSON remains one scoped request away.
 */
export function useChunkedHistory(
  projectIds: string[] | null,
  /** Everything the query depends on besides the project IDs (org, range,
   * scope). Reruns the collection when it changes; probing one path can't,
   * because two different queries may share a first-chunk URL. */
  queryKey: string,
  buildPath: (chunk: string[]) => string,
): ChunkedHistoryState {
  const [state, setState] = useState<ChunkedHistoryState>({
    data: null,
    error: null,
    loading: false,
    progress: null,
  });
  const identity = projectIds?.join(",") ?? null;

  // queryKey is the stable change-token capturing buildPath's inputs; buildPath
  // itself is a fresh closure every render and deliberately not a dependency.
  // biome-ignore lint/correctness/useExhaustiveDependencies: queryKey proxies buildPath's inputs
  useEffect(() => {
    if (identity === null) {
      setState({ data: null, error: null, loading: false, progress: null });
      return;
    }
    const ids = identity === "" ? [] : identity.split(",");
    const chunks: string[][] = [];
    for (let index = 0; index < ids.length; index += CHUNK) {
      chunks.push(ids.slice(index, index + CHUNK));
    }
    let cancelled = false;
    const controller = new AbortController();
    (async () => {
      setState({ data: null, error: null, loading: true, progress: `0/${chunks.length}` });
      try {
        const merged: ProjectReport = {
          generatedAt: "",
          asOf: "",
          coverage: { status: "complete", pageCount: 0, entityCount: 0, qualityFlags: [] },
          effectiveRange: { from: "", to: "", granularity: "" },
          projects: [],
        };
        for (const [index, chunk] of chunks.entries()) {
          const response = await fetch(pathFor(chunk), {
            headers: { accept: "application/json", ...authHeaders() },
            signal: controller.signal,
          });
          const body: unknown = await response.json();
          if (cancelled) return;
          if (!response.ok) {
            const detail =
              typeof body === "object" && body !== null && "error" in body
                ? (body.error as { code?: string; message?: string })
                : {};
            setState({
              data: null,
              error: `${detail.code ?? response.status}: ${detail.message ?? "request failed"}`,
              loading: false,
              progress: null,
            });
            return;
          }
          const report = body as ProjectReport;
          merged.projects = [...merged.projects, ...report.projects];
          merged.coverage = {
            status: report.coverage.status === "partial" ? "partial" : merged.coverage.status,
            pageCount: (merged.coverage.pageCount ?? 0) + (report.coverage.pageCount ?? 0),
            entityCount: (merged.coverage.entityCount ?? 0) + (report.coverage.entityCount ?? 0),
            qualityFlags: [
              ...new Set([
                ...(merged.coverage.qualityFlags ?? []),
                ...(report.coverage.qualityFlags ?? []),
              ]),
            ],
          };
          merged.generatedAt = report.generatedAt;
          merged.asOf = report.asOf;
          merged.effectiveRange = report.effectiveRange;
          // Disclose store serving whenever ANY chunk was served: absence reads
          // as "freshly collected", which a half-stale merge must not claim.
          // The label keeps the widest served range and the OLDEST collection
          // instant (over-disclosing staleness is the conservative direction).
          if (report.servedFromStore) {
            const previous = merged.servedFromStore;
            merged.servedFromStore = previous
              ? {
                  from:
                    report.servedFromStore.from < previous.from
                      ? report.servedFromStore.from
                      : previous.from,
                  to:
                    report.servedFromStore.to > previous.to
                      ? report.servedFromStore.to
                      : previous.to,
                  collectedAt:
                    report.servedFromStore.collectedAt < previous.collectedAt
                      ? report.servedFromStore.collectedAt
                      : previous.collectedAt,
                }
              : report.servedFromStore;
          }
          const done = index + 1 === chunks.length;
          setState({
            // Until every chunk lands, the merged prefix is honest only as a
            // partial view — a consumer must never read it as complete.
            data: {
              ...merged,
              coverage: done ? merged.coverage : { ...merged.coverage, status: "partial" },
            },
            error: null,
            loading: !done,
            progress: done ? null : `${index + 1}/${chunks.length}`,
          });
        }
        if (chunks.length === 0) {
          // No live projects: publish no report rather than one with synthetic
          // empty-string metadata (generatedAt/asOf/effectiveRange) that the
          // banner and "metered through" copy would render as garbage.
          setState({ data: null, error: null, loading: false, progress: null });
        }
      } catch (error) {
        if (cancelled || controller.signal.aborted) return;
        setState({
          data: null,
          error: error instanceof Error ? error.message : String(error),
          loading: false,
          progress: null,
        });
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };

    function pathFor(chunk: string[]): string {
      return buildPath(chunk);
    }
  }, [identity, queryKey]);

  return state;
}
