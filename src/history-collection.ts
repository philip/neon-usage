import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  ConsumptionSourceIntegrityError,
  type SourceErrorDetail,
  toSourceErrorDetail,
} from "./errors.js";
import type {
  CollectionIntent,
  CollectionPageWrite,
  EvidenceFactStore,
} from "./evidence-fact-store.js";
import type { OperationContext } from "./operation-context.js";
import { isCancellationFailure, throwIfAborted } from "./operation-context.js";

export type HistoryCollectionQualityFlag =
  | "CURSOR_REPEATED"
  | "EMPTY_PAGE_WITH_CURSOR"
  | "SOURCE_REQUEST_FAILED"
  | "PAGE_LIMIT_REACHED"
  | "TIME_LIMIT_REACHED"
  | "ITEM_LIMIT_REACHED"
  | "FACT_LIMIT_REACHED"
  | "BYTE_LIMIT_REACHED"
  | "ENTITY_DUPLICATED";

export type CollectionRunId = `run_${string}`;
export type CollectionRunIdFactory = () => CollectionRunId;
export type CollectionRunStatus = "complete" | "partial" | "failed";
export type CollectionRunSummary = {
  runId: CollectionRunId;
  status: CollectionRunStatus;
  completedAt: string;
  pageCount: number;
  qualityFlags: readonly HistoryCollectionQualityFlag[];
};

export type CollectionRunResult<Page, Item> = {
  runId: CollectionRunId;
  pages: Page[];
  items: Item[];
  status: "complete" | "partial";
  qualityFlags: HistoryCollectionQualityFlag[];
  errors: string[];
  errorDetails: SourceErrorDetail[];
};

export type CollectionCheckpoint = {
  runId: CollectionRunId;
  pageNumber: number;
  cursorIn: string | null;
  cursorOut: string | null;
  nextCursor: string | null;
  complete: boolean;
  terminalState: CollectionPageWrite["terminalState"];
};

export type HistoryBudget = {
  maxPages?: number;
  maxDurationMs?: number;
  maxItems?: number;
  maxFacts?: number;
  maxBytes?: number;
  startedAt: number;
  items: number;
  facts: number;
  bytes: number;
  pages: number;
};

type CollectHistoryPagesOptions<Page, Item> = {
  maxPages: number;
  maxDurationMs?: number;
  maxItems?: number;
  maxFacts?: number;
  maxBytes?: number;
  budget?: HistoryBudget;
  createRunId?: CollectionRunIdFactory;
  now?: () => Date;
  context?: OperationContext;
  intent?: CollectionIntent;
  store?: EvidenceFactStore;
  resumeRunId?: CollectionRunId;
  getPage(cursor: string | null, context?: OperationContext): Promise<Page>;
  validatePage?(page: Page): void;
  getItems(page: Page): readonly Item[];
  getFactCount?(item: Item): number;
  getByteCount?(page: Page): number;
  getItemKey?(item: Item): string;
  validateItem?(item: Item): void;
  getNextCursor(page: Page): string | null;
  pageWrite?(
    page: Page,
    checkpoint: CollectionCheckpoint,
  ): Pick<CollectionPageWrite<Page>, "evidence" | "facts">;
  onPage?(page: Page, checkpoint: CollectionCheckpoint, context?: OperationContext): Promise<void>;
  onRunFinished?(summary: CollectionRunSummary): Promise<void>;
};

function isFatalCollectionFailure(error: unknown): boolean {
  return (
    (typeof error === "object" &&
      error !== null &&
      (("integrityFailure" in error && error.integrityFailure === true) ||
        isCancellationFailure(error))) ||
    false
  );
}

export async function collectHistoryPages<Page, Item = unknown>(
  options: CollectHistoryPagesOptions<Page, Item>,
): Promise<CollectionRunResult<Page, Item>> {
  if (Boolean(options.store) !== Boolean(options.intent) || (options.store && !options.pageWrite)) {
    throw new TypeError("collection persistence requires a store, intent, and pageWrite mapper");
  }
  const runId = options.resumeRunId ?? options.createRunId?.() ?? `run_${randomUUID()}`;
  if (!/^run_[A-Za-z0-9-]{1,100}$/.test(runId)) {
    throw new TypeError("collection run ID is malformed");
  }
  const pages: Page[] = [];
  const items: Item[] = [];
  const seenItemKeys = new Set<string>();
  const seenCursors = new Set<string>();
  const qualityFlags: HistoryCollectionQualityFlag[] = [];
  const errors: string[] = [];
  const errorDetails: SourceErrorDetail[] = [];
  let entityDuplicated = false;
  let cursor: string | null = null;
  let collectionFinished = false;
  let lifecycleStarted = !options.store;
  const budget = options.budget ?? {
    ...(options.maxDurationMs ? { maxDurationMs: options.maxDurationMs } : {}),
    ...(options.maxItems ? { maxItems: options.maxItems } : {}),
    ...(options.maxFacts ? { maxFacts: options.maxFacts } : {}),
    ...(options.maxBytes ? { maxBytes: options.maxBytes } : {}),
    maxPages: options.maxPages,
    startedAt: performance.now(),
    items: 0,
    facts: 0,
    bytes: 0,
    pages: 0,
  };
  const remainingDuration = budget.maxDurationMs
    ? Math.max(1, Math.ceil(budget.maxDurationMs - (performance.now() - budget.startedAt)))
    : undefined;
  const deadline = remainingDuration ? AbortSignal.timeout(remainingDuration) : undefined;
  const signal =
    deadline && options.context?.signal
      ? AbortSignal.any([options.context.signal, deadline])
      : (deadline ?? options.context?.signal);
  const requestContext = () => ({
    ...(signal ? { signal } : {}),
    ...(budget.maxBytes !== undefined
      ? { maxResponseBytes: Math.max(0, budget.maxBytes - budget.bytes) }
      : {}),
  });
  const countPage = (page: Page) => {
    const pageItems = options.getItems(page);
    return {
      items: pageItems.length,
      facts: pageItems.reduce((total, item) => total + (options.getFactCount?.(item) ?? 0), 0),
      bytes: options.getByteCount?.(page) ?? 0,
    };
  };

  try {
    if (options.store && options.intent) {
      const prior = await options.store.getCollectionRun(runId);
      if (options.resumeRunId && !prior) {
        throw new Error(`Collection run ${runId} was not found`);
      }
      if (prior && !options.resumeRunId) {
        // Without this, an explicit run ID that matched a stored terminal run
        // would silently replay the stored result instead of collecting.
        throw new ConsumptionSourceIntegrityError(
          `Collection run ${runId} already exists; resume it or choose a new run ID`,
        );
      }
      if (prior && !isDeepStrictEqual(prior.intent, options.intent)) {
        throw new ConsumptionSourceIntegrityError(`Collection run ${runId} intent does not match`);
      }
      await options.store.beginCollectionRun({ runId, intent: options.intent });
      lifecycleStarted = true;
      const run = await options.store.getCollectionRun(runId);
      if (!run) throw new Error(`Collection run ${runId} could not be loaded`);
      for (let pageNumber = 1; pageNumber <= run.pageCount; pageNumber += 1) {
        const committed = await options.store.getRunPage(runId, pageNumber);
        if (!committed) throw new Error(`Collection run ${runId} is missing page ${pageNumber}`);
        const page = committed.page as Page;
        options.validatePage?.(page);
        const counts = countPage(page);
        budget.items += counts.items;
        budget.facts += counts.facts;
        budget.bytes += counts.bytes;
        budget.pages += 1;
        if (budget.maxPages !== undefined && budget.pages > budget.maxPages) {
          qualityFlags.push("PAGE_LIMIT_REACHED");
          break;
        }
        if (budget.maxItems !== undefined && budget.items > budget.maxItems) {
          qualityFlags.push("ITEM_LIMIT_REACHED");
          break;
        }
        if (budget.maxFacts !== undefined && budget.facts > budget.maxFacts) {
          qualityFlags.push("FACT_LIMIT_REACHED");
          break;
        }
        if (budget.maxBytes !== undefined && budget.bytes > budget.maxBytes) {
          qualityFlags.push("BYTE_LIMIT_REACHED");
          break;
        }
        pages.push(page);
        restoreItems(page, options, items, seenItemKeys, () => {
          entityDuplicated = true;
        });
        if (committed.nextCursor !== null) seenCursors.add(committed.nextCursor);
        cursor = committed.nextCursor;
      }
      qualityFlags.push(...run.qualityFlags);
      const restoredBudgetLimit = qualityFlags.some((flag) =>
        [
          "PAGE_LIMIT_REACHED",
          "ITEM_LIMIT_REACHED",
          "FACT_LIMIT_REACHED",
          "BYTE_LIMIT_REACHED",
        ].includes(flag),
      );
      if (restoredBudgetLimit) {
        const status = "partial" as const;
        if (run.status === "running") {
          await finishRun(options, {
            runId,
            status,
            completedAt: (options.now?.() ?? new Date()).toISOString(),
            pageCount: run.pageCount,
            qualityFlags,
          });
        }
        return { runId, pages, items, status, qualityFlags, errors, errorDetails };
      }
      const last =
        run.pageCount > 0 ? await options.store.getRunPage(runId, run.pageCount) : undefined;
      if (run.status === "failed") {
        throw new Error(`Collection run ${runId} is terminal and failed`);
      }
      if (run.status !== "running" || (last && last.terminalState !== "continue")) {
        const terminalFlag =
          last?.terminalState === "empty_page_with_cursor"
            ? "EMPTY_PAGE_WITH_CURSOR"
            : last?.terminalState === "cursor_repeated"
              ? "CURSOR_REPEATED"
              : last?.terminalState === "page_limit"
                ? "PAGE_LIMIT_REACHED"
                : last?.terminalState === "time_limit"
                  ? "TIME_LIMIT_REACHED"
                  : last?.terminalState === "item_limit"
                    ? "ITEM_LIMIT_REACHED"
                    : last?.terminalState === "fact_limit"
                      ? "FACT_LIMIT_REACHED"
                      : last?.terminalState === "byte_limit"
                        ? "BYTE_LIMIT_REACHED"
                        : undefined;
        if (terminalFlag && !qualityFlags.includes(terminalFlag)) qualityFlags.push(terminalFlag);
        if (entityDuplicated && !qualityFlags.includes("ENTITY_DUPLICATED")) {
          qualityFlags.push("ENTITY_DUPLICATED");
        }
        const status = qualityFlags.some((flag) =>
          [
            "TIME_LIMIT_REACHED",
            "PAGE_LIMIT_REACHED",
            "ITEM_LIMIT_REACHED",
            "FACT_LIMIT_REACHED",
            "BYTE_LIMIT_REACHED",
          ].includes(flag),
        )
          ? "partial"
          : run.status === "running"
            ? last?.terminalState === "complete"
              ? "complete"
              : "partial"
            : run.status === "complete"
              ? "complete"
              : "partial";
        if (run.status === "running") {
          await finishRun(options, {
            runId,
            status,
            completedAt: (options.now?.() ?? new Date()).toISOString(),
            pageCount: pages.length,
            qualityFlags,
          });
        }
        return { runId, pages, items, status, qualityFlags, errors, errorDetails };
      }
    }
    do {
      throwIfAborted(options.context);
      let page: Page;
      try {
        if (budget.maxPages !== undefined && budget.pages >= budget.maxPages) {
          qualityFlags.push("PAGE_LIMIT_REACHED");
          break;
        }
        if (budget.maxBytes !== undefined && budget.bytes >= budget.maxBytes) {
          qualityFlags.push("BYTE_LIMIT_REACHED");
          break;
        }
        page = await options.getPage(cursor, requestContext());
        options.validatePage?.(page);
        if (deadline?.aborted) {
          qualityFlags.push("TIME_LIMIT_REACHED");
          break;
        }
      } catch (error) {
        throwIfAborted(options.context);
        if (
          typeof error === "object" &&
          error !== null &&
          "kind" in error &&
          error.kind === "byte_limit"
        ) {
          qualityFlags.push("BYTE_LIMIT_REACHED");
          break;
        }
        if (deadline?.aborted) {
          qualityFlags.push("TIME_LIMIT_REACHED");
          break;
        }
        if (pages.length === 0 || isFatalCollectionFailure(error)) throw error;
        const detail = toSourceErrorDetail(error);
        qualityFlags.push("SOURCE_REQUEST_FAILED");
        errors.push(detail.message);
        errorDetails.push(detail);
        break;
      }

      const pageItems = options.getItems(page);
      const counts = countPage(page);
      if (budget.maxItems !== undefined && budget.items + counts.items > budget.maxItems) {
        qualityFlags.push("ITEM_LIMIT_REACHED");
        break;
      }
      if (budget.maxFacts !== undefined && budget.facts + counts.facts > budget.maxFacts) {
        qualityFlags.push("FACT_LIMIT_REACHED");
        break;
      }
      if (budget.maxBytes !== undefined && budget.bytes + counts.bytes > budget.maxBytes) {
        qualityFlags.push("BYTE_LIMIT_REACHED");
        break;
      }
      budget.items += counts.items;
      budget.facts += counts.facts;
      budget.bytes += counts.bytes;
      budget.pages += 1;
      pages.push(page);
      restoreItems(page, options, items, seenItemKeys, () => {
        entityDuplicated = true;
      });
      const nextCursor = options.getNextCursor(page);
      let continuationIssue: HistoryCollectionQualityFlag | undefined;
      if (pageItems.length === 0 && nextCursor !== null) {
        continuationIssue = "EMPTY_PAGE_WITH_CURSOR";
      } else if (nextCursor !== null && seenCursors.has(nextCursor)) {
        continuationIssue = "CURSOR_REPEATED";
      } else if (budget.pages >= options.maxPages && nextCursor !== null) {
        continuationIssue = "PAGE_LIMIT_REACHED";
      } else if (
        (deadline?.aborted ||
          (budget.maxDurationMs !== undefined &&
            performance.now() - budget.startedAt >= budget.maxDurationMs)) &&
        nextCursor !== null
      ) {
        continuationIssue = "TIME_LIMIT_REACHED";
      } else if (
        budget.maxItems !== undefined &&
        budget.items >= budget.maxItems &&
        nextCursor !== null
      ) {
        continuationIssue = "ITEM_LIMIT_REACHED";
      } else if (
        budget.maxFacts !== undefined &&
        budget.facts >= budget.maxFacts &&
        nextCursor !== null
      ) {
        continuationIssue = "FACT_LIMIT_REACHED";
      } else if (
        budget.maxBytes !== undefined &&
        budget.bytes >= budget.maxBytes &&
        nextCursor !== null
      ) {
        continuationIssue = "BYTE_LIMIT_REACHED";
      }
      const checkpointCursor =
        continuationIssue === "EMPTY_PAGE_WITH_CURSOR" || continuationIssue === "CURSOR_REPEATED"
          ? null
          : nextCursor;
      const terminalState =
        continuationIssue === "EMPTY_PAGE_WITH_CURSOR"
          ? "empty_page_with_cursor"
          : continuationIssue === "CURSOR_REPEATED"
            ? "cursor_repeated"
            : continuationIssue === "PAGE_LIMIT_REACHED"
              ? "page_limit"
              : continuationIssue === "TIME_LIMIT_REACHED"
                ? "time_limit"
                : continuationIssue === "ITEM_LIMIT_REACHED"
                  ? "item_limit"
                  : continuationIssue === "FACT_LIMIT_REACHED"
                    ? "fact_limit"
                    : continuationIssue === "BYTE_LIMIT_REACHED"
                      ? "byte_limit"
                      : nextCursor === null
                        ? "complete"
                        : "continue";
      const checkpoint: CollectionCheckpoint = {
        runId,
        pageNumber: pages.length,
        cursorIn: cursor,
        cursorOut: nextCursor,
        nextCursor: checkpointCursor,
        complete: nextCursor === null,
        terminalState,
      };
      if (options.store && options.pageWrite) {
        await options.store.appendCollectionPage({
          ...checkpoint,
          page,
          ...options.pageWrite(page, checkpoint),
        });
      }
      await options.onPage?.(page, checkpoint, requestContext());
      throwIfAborted(options.context);
      if (deadline?.aborted) {
        qualityFlags.push("TIME_LIMIT_REACHED");
        break;
      }
      if (continuationIssue) {
        qualityFlags.push(continuationIssue);
        break;
      }
      if (nextCursor !== null) {
        seenCursors.add(nextCursor);
      }
      cursor = nextCursor;
    } while (cursor !== null);

    if (entityDuplicated) qualityFlags.push("ENTITY_DUPLICATED");

    const status = qualityFlags.length === 0 ? "complete" : "partial";
    const result = { runId, pages, items, status, qualityFlags, errors, errorDetails } as const;
    collectionFinished = true;
    await finishRun(options, {
      runId,
      status,
      completedAt: (options.now?.() ?? new Date()).toISOString(),
      pageCount: pages.length,
      qualityFlags,
    });
    return result;
  } catch (error) {
    if (
      lifecycleStarted &&
      !collectionFinished &&
      !(isCancellationFailure(error) && pages.length > 0)
    ) {
      try {
        await finishRun(options, {
          runId,
          status: "failed",
          completedAt: (options.now?.() ?? new Date()).toISOString(),
          pageCount: pages.length,
          qualityFlags,
        });
      } catch (finalizeError) {
        // The collection failure is the primary diagnosis; the failed
        // finalization rides along instead of replacing it.
        if (error instanceof Error && !("suppressed" in error)) {
          Object.defineProperty(error, "suppressed", {
            value: finalizeError,
            enumerable: false,
          });
        }
      }
    }
    throw error;
  }
}

function restoreItems<Page, Item>(
  page: Page,
  options: CollectHistoryPagesOptions<Page, Item>,
  items: Item[],
  seenItemKeys: Set<string>,
  duplicate: () => void,
): void {
  for (const item of options.getItems(page)) {
    options.validateItem?.(item);
    const key = options.getItemKey?.(item);
    if (key !== undefined && seenItemKeys.has(key)) {
      duplicate();
      continue;
    }
    if (key !== undefined) seenItemKeys.add(key);
    items.push(item);
  }
}

async function finishRun<Page, Item>(
  options: CollectHistoryPagesOptions<Page, Item>,
  summary: CollectionRunSummary,
): Promise<void> {
  if (options.store && options.intent) {
    await options.store.recordCollectionRun({
      ...summary,
      sourceContract: options.intent.sourceContract,
    });
  }
  await options.onRunFinished?.(summary);
}
