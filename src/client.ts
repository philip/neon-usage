import { randomUUID } from "node:crypto";
import { type CapabilityReport, createCapabilityService } from "./capability-service.js";
import { NeonUsageError } from "./client-errors.js";
import {
  ConsumptionQueryError,
  type Granularity,
  isNeonId,
  type ProjectReportQuery,
  validateHistoryQuery,
} from "./consumption-query.js";
import type { NeonOrganization } from "./consumption-source.js";
import { createCurrentSnapshotService } from "./current-snapshot-service.js";
import { ConsumptionSourceIntegrityError } from "./errors.js";
import { historyContracts } from "./history-contracts.js";
import { createOrganizationHistoryService } from "./history-report.js";
import { createInMemoryEvidenceFactStore } from "./in-memory-fact-store.js";
import { measuredSnapshotErrors } from "./measured-snapshot-errors.js";
import { MeasuredUsageContractError, measuredUsageLimits } from "./measured-usage-contract.js";
import { buildMeasuredUsageExport, type MeasuredBillingUsage } from "./measured-usage-export.js";
import { type HistoryProjectMetricName, projectConsumptionMetrics } from "./metric-catalog.js";
import {
  createNeonApiSource,
  NeonApiError,
  type NeonApiSourceOptions,
  NeonEvidenceError,
  NeonResponseError,
  NeonResponseTooLargeError,
  NeonTransportError,
} from "./neon-api-source.js";
import {
  OperationByteLimitError,
  OperationCancelledError,
  type OperationContext,
  OperationLimitError,
  raceAbort,
} from "./operation-context.js";
import { packageVersion as producerVersion } from "./package-version.js";
import { estimateProjectCosts, type PricingEstimate } from "./pricing-estimate.js";
import { neonDocumentationRateCard } from "./rate-card.js";
import {
  createSlidingWindowRequestCoordinator,
  type RequestCoordinator,
} from "./request-coordinator.js";

export type NeonUsageClientLimits = {
  maxPages: number;
  maxDurationMs: number;
  maxItems: number;
  maxFacts: number;
  maxBytes: number;
  maxProjects: number;
  concurrency: number;
  requestsPerMinute: number;
  maxResponseBytes: number;
};

export const DEFAULT_CLIENT_LIMITS: Readonly<NeonUsageClientLimits> = Object.freeze({
  maxPages: 1_000,
  maxDurationMs: 600_000,
  maxItems: 10_000,
  maxFacts: 1_000_000,
  maxBytes: 100_000_000,
  maxProjects: 1_000,
  concurrency: 5,
  requestsPerMinute: 180,
  maxResponseBytes: 10_000_000,
});

export const MAX_CLIENT_LIMITS: Readonly<NeonUsageClientLimits> = Object.freeze({
  maxPages: 10_000,
  maxDurationMs: 3_600_000,
  maxItems: 10_000_000,
  maxFacts: 100_000_000,
  maxBytes: 1_000_000_000,
  maxProjects: measuredUsageLimits.projects,
  concurrency: 100,
  requestsPerMinute: 600,
  maxResponseBytes: 100_000_000,
});

export type NeonUsageClientConfig = {
  accessToken: string;
  limits?: Partial<NeonUsageClientLimits>;
  requestCoordinator?: RequestCoordinator;
  fetch?: typeof fetch;
  now?: () => Date;
};

export type NeonUsageOperationOptions = { signal?: AbortSignal };

export type MeasuredUsageHistoryQuery = {
  from: string;
  to: string;
  granularity: Granularity;
  metrics?: readonly HistoryProjectMetricName[];
};

export type CollectMeasuredUsageInput =
  | { organizationId: string; source?: "auto"; query?: never; projectIds?: never }
  | {
      organizationId: string;
      source: "history";
      query?: MeasuredUsageHistoryQuery;
      projectIds?: never;
    }
  | {
      organizationId: string;
      source: "current";
      query?: never;
      projectIds?: string[];
    };

export type CollectedMeasuredUsage = {
  capability: CapabilityReport;
  measuredUsage: MeasuredBillingUsage;
  estimate: PricingEstimate | null;
};

export interface NeonUsageClient {
  listOrganizations(options?: NeonUsageOperationOptions): Promise<NeonOrganization[]>;
  listProjects(
    organizationId: string,
    options?: NeonUsageOperationOptions,
  ): Promise<{ projects: Array<{ id: string; name: string }>; unavailableProjectIds: string[] }>;
  inspectCapability(
    organizationId: string,
    options?: NeonUsageOperationOptions,
  ): Promise<CapabilityReport>;
  collectMeasuredUsage(
    input: CollectMeasuredUsageInput,
    options?: NeonUsageOperationOptions,
  ): Promise<CollectedMeasuredUsage>;
  close(): void;
}

const historyMetricNames = new Set<string>(historyContracts.project.supportedMetrics);
type ClientOperationContext = OperationContext & {
  startedAt: number;
  cancellationSignal: AbortSignal;
  deadlineSignal: AbortSignal;
};

export function createNeonUsageClient(config: NeonUsageClientConfig): NeonUsageClient {
  let validated: ReturnType<typeof validateConfig>;
  try {
    validated = validateConfig(config);
  } catch {
    throw new NeonUsageError("INVALID_INPUT");
  }
  const {
    accessToken,
    limits,
    fetch: fetchImpl,
    now,
    requestCoordinator: hostCoordinator,
  } = validated;
  const requestCoordinator = createSlidingWindowRequestCoordinator({
    limit: limits.requestsPerMinute,
    intervalMs: 60_000,
    ...(hostCoordinator ? { upstream: hostCoordinator } : {}),
  });
  let closed = false;
  let active: AbortController | undefined;

  const createSource = (evidence?: NeonApiSourceOptions["evidence"]) =>
    createNeonApiSource({
      apiKey: accessToken,
      fetch: fetchImpl,
      requestCoordinator,
      // Queued admission uses the operation deadline; transport and retries get two minutes.
      requestTimeoutMs: 120_000,
      maxResponseBytes: limits.maxResponseBytes,
      now: () => now().getTime(),
      evidenceClock: now,
      ...(evidence ? { evidence } : {}),
    });

  async function operate<T>(
    options: NeonUsageOperationOptions | undefined,
    operation: (context: ClientOperationContext) => Promise<T>,
    acceptDeadlinePartial?: (result: T) => boolean,
  ): Promise<T> {
    if (closed) throw new NeonUsageError("CLIENT_CLOSED");
    if (active) throw new NeonUsageError("CLIENT_BUSY");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let deadlineController: AbortController | undefined;
    let callerSignal: AbortSignal | undefined;
    const cancel = () => controller?.abort();
    try {
      if (options !== undefined) {
        assertRecord(options, ["signal"]);
        if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) invalid();
      }
      callerSignal = options?.signal;
      controller = new AbortController();
      active = controller;
      if (callerSignal?.aborted) controller.abort();
      else callerSignal?.addEventListener("abort", cancel, { once: true });
      const startedAt = performance.now();
      const deadline = startedAt + limits.maxDurationMs;
      deadlineController = new AbortController();
      const signal = AbortSignal.any([controller.signal, deadlineController.signal]);
      timer = setTimeout(
        () => deadlineController?.abort(new OperationLimitError("time_limit")),
        limits.maxDurationMs,
      );
      if (controller.signal.aborted) throw new OperationCancelledError(undefined);
      const result = await raceAbort(
        operation({
          signal,
          cancellationSignal: controller.signal,
          deadlineSignal: deadlineController.signal,
          startedAt,
          maxDurationMs: limits.maxDurationMs,
          maxPages: limits.maxPages,
          maxItems: limits.maxItems,
          // Inventory uses the retained-byte budget across pages; the source
          // independently caps each response at maxResponseBytes.
          maxResponseBytes: limits.maxBytes,
        }),
        acceptDeadlinePartial ? controller.signal : signal,
      );
      if (
        (deadlineController.signal.aborted || performance.now() >= deadline) &&
        !acceptDeadlinePartial?.(result)
      )
        throw new OperationLimitError("time_limit");
      return result;
    } catch (error) {
      if (controller?.signal.aborted) {
        throw new NeonUsageError("CANCELLED");
      }
      if (deadlineController?.signal.aborted) throw new NeonUsageError("COLLECTION_LIMIT_REACHED");
      throw publicError(error, accessToken);
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", cancel);
      if (active === controller) active = undefined;
    }
  }

  return {
    listOrganizations: (options) =>
      operate(options, (context) => createSource().listOrganizations(context)),
    listProjects: (organizationId, options) =>
      operate(options, async (context) => {
        validateId(organizationId);
        const directory = await createSource().listProjectDirectory(organizationId, {
          ...context,
          maxItems: Math.min(limits.maxItems, limits.maxProjects),
        });
        return {
          projects: directory.projects,
          unavailableProjectIds: directory.unavailableProjectIds,
        };
      }),
    inspectCapability: (organizationId, options) =>
      operate(options, (context) => {
        validateId(organizationId);
        return createCapabilityService(createSource()).inspect(organizationId, context);
      }),
    collectMeasuredUsage: (input, options) =>
      operate(
        options,
        async (context) => {
          const validatedInput = validateInput(input, now(), limits.maxProjects);
          const store = createInMemoryEvidenceFactStore();
          try {
            const sourceAccount = randomUUID();
            const source = createSource({
              sourceAccount,
              retention: "hash_only",
              write: (record, signal) => store.writeEvidence(record, signal),
            });
            const capability = await raceAbort(
              createCapabilityService(source).inspect(validatedInput.organizationId, context, {
                probeProjectHistory: validatedInput.source !== "current",
              }),
              context.signal,
            );
            const selected = selectSource(validatedInput.source ?? "auto", capability);
            if (selected === "current") {
              const snapshotContext = {
                ...context,
                retainedByteBudget: { remaining: limits.maxBytes },
              };
              const snapshot = await raceAbort(
                createCurrentSnapshotService(source, {
                  concurrency: limits.concurrency,
                  maxProjects: limits.maxProjects,
                  now,
                }).organizationReport(
                  validatedInput.organizationId,
                  snapshotContext,
                  validatedInput.source === "current" && validatedInput.projectIds
                    ? { projectIds: validatedInput.projectIds }
                    : undefined,
                ),
                context.signal,
              );
              // Partial snapshot diagnostics cross the same sanitized boundary as failures.
              snapshot.coverage.errors = measuredSnapshotErrors(
                snapshot.coverage.errors,
                (requestId) => !requestId.includes(accessToken),
              );
              return {
                capability,
                measuredUsage: buildMeasuredUsageExport({ producerVersion, snapshot, now }),
                estimate: null,
              };
            }
            const query = historyQuery(validatedInput, now());
            const history = await createOrganizationHistoryService(source, {
              maxPages: limits.maxPages,
              maxDurationMs: limits.maxDurationMs,
              maxItems: Math.min(limits.maxItems, limits.maxProjects),
              maxFacts: limits.maxFacts,
              maxBytes: limits.maxBytes,
              budget: {
                maxPages: limits.maxPages,
                maxDurationMs: limits.maxDurationMs,
                maxItems: Math.min(limits.maxItems, limits.maxProjects),
                maxFacts: limits.maxFacts,
                maxBytes: limits.maxBytes,
                startedAt: context.startedAt,
                pages: 0,
                items: 0,
                facts: 0,
                bytes: 0,
              },
              factStore: store,
              sourceAccount,
              storeServing: { serve: false, tailBuckets: 0 },
              now,
            }).organizationHistory(
              query,
              { ...context, signal: context.cancellationSignal },
              validatedInput.source === "history" && validatedInput.query?.metrics !== undefined
                ? "explicit"
                : "default",
            );
            if (
              history.projectReport.coverage.pageCount === 0 &&
              history.projectReport.coverage.qualityFlags.includes("TIME_LIMIT_REACHED")
            )
              throw new OperationLimitError("time_limit");
            const collectedEstimate = estimateProjectCosts(
              history.projectReport,
              neonDocumentationRateCard,
              {
                extrapolateRateCardDates: true,
                now,
              },
            );
            const estimate = {
              ...collectedEstimate,
              ...(collectedEstimate.requestIds
                ? {
                    requestIds: collectedEstimate.requestIds.filter(
                      (requestId) => !requestId.includes(accessToken),
                    ),
                  }
                : {}),
            };
            return {
              capability,
              measuredUsage: buildMeasuredUsageExport({
                producerVersion,
                history: history.summary,
                metricSelectionMode: history.metricSelectionMode,
                estimate,
                now,
              }),
              estimate,
            };
          } finally {
            store.close();
          }
        },
        (result) =>
          result.measuredUsage.coverage.status === "partial" &&
          result.measuredUsage.coverage.qualityFlags.includes("TIME_LIMIT_REACHED"),
      ),
    close() {
      closed = true;
      active?.abort();
    },
  };
}

function invalid(): never {
  throw new NeonUsageError("INVALID_INPUT");
}

function assertRecord(
  value: unknown,
  keys: readonly string[],
): asserts value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    invalid();
}

function validateId(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length > 60 || !isNeonId(value)) invalid();
}

function validateConfig(config: NeonUsageClientConfig) {
  assertRecord(config, ["accessToken", "limits", "requestCoordinator", "fetch", "now"]);
  if (
    typeof config.accessToken !== "string" ||
    !config.accessToken.trim() ||
    !/^[\x21-\x7e]+$/.test(config.accessToken)
  )
    invalid();
  const limits = { ...DEFAULT_CLIENT_LIMITS };
  if (config.limits !== undefined) {
    assertRecord(config.limits, Object.keys(limits));
    for (const key of Object.keys(limits) as Array<keyof NeonUsageClientLimits>) {
      const value = config.limits[key];
      if (value === undefined) continue;
      if (!Number.isInteger(value) || value < 1 || value > MAX_CLIENT_LIMITS[key]) invalid();
      limits[key] = value;
    }
  }
  const fetchImpl = config.fetch === undefined ? globalThis.fetch : config.fetch;
  const now = config.now === undefined ? () => new Date() : config.now;
  if (typeof fetchImpl !== "function" || typeof now !== "function") invalid();
  const date = now();
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) invalid();
  const coordinator = config.requestCoordinator;
  if (
    coordinator !== undefined &&
    (typeof coordinator !== "object" ||
      coordinator === null ||
      typeof coordinator.acquire !== "function")
  )
    invalid();
  return {
    accessToken: config.accessToken,
    limits: Object.freeze(limits),
    fetch: fetchImpl,
    now,
    requestCoordinator: coordinator,
  };
}

function validateInput(
  input: CollectMeasuredUsageInput,
  now: Date,
  maxProjects: number,
): CollectMeasuredUsageInput {
  assertRecord(input, ["organizationId", "source", "query", "projectIds"]);
  validateId(input.organizationId);
  const source = input.source === undefined ? "auto" : input.source;
  if (!["auto", "history", "current"].includes(source)) invalid();
  if (source !== "history" && "query" in input) invalid();
  if (source !== "current" && "projectIds" in input) invalid();
  if (source === "current") {
    const ids = input.projectIds;
    if (ids !== undefined && (!Array.isArray(ids) || ids.length === 0 || ids.length > maxProjects))
      invalid();
    const projectIds = ids ? [...ids] : undefined;
    if (
      projectIds &&
      (projectIds.some(
        (id) => typeof id !== "string" || id.length > 60 || !isNeonId(id) || id === "all",
      ) ||
        new Set(projectIds).size !== projectIds.length)
    )
      invalid();
    return {
      organizationId: input.organizationId,
      source,
      ...(projectIds ? { projectIds } : {}),
    };
  }
  if (source === "history" && input.query !== undefined) {
    assertRecord(input.query, ["from", "to", "granularity", "metrics"]);
    const query = input.query;
    if (
      typeof query.from !== "string" ||
      typeof query.to !== "string" ||
      query.from.length > measuredUsageLimits.timestampLength ||
      query.to.length > measuredUsageLimits.timestampLength ||
      (query.metrics !== undefined &&
        (!Array.isArray(query.metrics) || query.metrics.length > historyMetricNames.size))
    )
      invalid();
    if (query.metrics?.some((name) => typeof name !== "string" || name.length > 256)) invalid();
    const copied = {
      from: query.from,
      to: query.to,
      granularity: query.granularity,
      ...(query.metrics ? { metrics: [...query.metrics] } : {}),
    };
    validateHistoryQuery(
      {
        ...copied,
        organizationId: input.organizationId,
        metrics: [...(copied.metrics ?? projectConsumptionMetrics)],
      },
      now,
      historyMetricNames,
    );
    return { organizationId: input.organizationId, source, query: copied };
  }
  return { organizationId: input.organizationId, source };
}

function historyQuery(input: CollectMeasuredUsageInput, now: Date): ProjectReportQuery {
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  if (from.getTime() >= to.getTime()) from.setUTCDate(from.getUTCDate() - 7);
  const query = input.source === "history" ? input.query : undefined;
  return {
    organizationId: input.organizationId,
    from: query?.from ?? from.toISOString(),
    to: query?.to ?? to.toISOString(),
    granularity: query?.granularity ?? "daily",
    metrics: [...(query?.metrics ?? projectConsumptionMetrics)],
  };
}

function selectSource(
  requested: "auto" | "history" | "current",
  capability: CapabilityReport,
): "history" | "current" {
  if (requested === "current") return "current";
  if (capability.capabilities.projectHistory === "unsupported_by_plan") {
    if (requested === "history") throw new NeonUsageError("UNSUPPORTED_CAPABILITY");
    return "current";
  }
  if (capability.observedAvailability.projectHistory === "available") return "history";
  throw new NeonUsageError(
    capability.observedAvailability.projectHistory === "forbidden"
      ? "AUTHORIZATION_FAILED"
      : "PROVIDER_UNAVAILABLE",
  );
}

function publicErrorDetail(
  detail: { status?: number; requestId?: string } | undefined,
  accessToken: string,
): NeonUsageError {
  return new NeonUsageError(
    detail?.status === 401
      ? "AUTHENTICATION_FAILED"
      : detail?.status === 403
        ? "AUTHORIZATION_FAILED"
        : "PROVIDER_UNAVAILABLE",
    {
      ...(detail?.status !== undefined ? { providerStatus: detail.status } : {}),
      ...(detail?.requestId && !detail.requestId.includes(accessToken)
        ? { requestId: detail.requestId }
        : {}),
    },
  );
}

function publicError(error: unknown, accessToken: string): NeonUsageError {
  try {
    if (error instanceof NeonUsageError)
      return new NeonUsageError(error.code, {
        ...(error.providerStatus !== undefined ? { providerStatus: error.providerStatus } : {}),
        ...(error.requestId && !error.requestId.includes(accessToken)
          ? { requestId: error.requestId }
          : {}),
      });
    if (error instanceof ConsumptionQueryError) return new NeonUsageError("INVALID_INPUT");
    if (
      error instanceof OperationLimitError ||
      error instanceof OperationByteLimitError ||
      error instanceof NeonResponseTooLargeError
    )
      return new NeonUsageError("COLLECTION_LIMIT_REACHED");
    if (
      error instanceof OperationCancelledError ||
      (error instanceof NeonTransportError && error.kind === "cancelled")
    )
      return new NeonUsageError("CANCELLED");
    if (error instanceof NeonApiError) return publicErrorDetail(error, accessToken);
    if (
      error instanceof ConsumptionSourceIntegrityError ||
      error instanceof NeonResponseError ||
      error instanceof NeonEvidenceError ||
      error instanceof MeasuredUsageContractError
    )
      return new NeonUsageError("INTEGRITY_FAILURE");
    return new NeonUsageError("PROVIDER_UNAVAILABLE");
  } catch {
    // Injected rejection values can throw when their properties are inspected.
    return new NeonUsageError("PROVIDER_UNAVAILABLE");
  }
}
