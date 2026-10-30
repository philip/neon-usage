import { createHash } from "node:crypto";
import { parse } from "lossless-json";
import { z } from "zod";
import type { BranchReportQuery, ProjectReportQuery } from "./consumption-query.js";
import type {
  BranchConsumptionSource,
  CurrentSnapshotSource,
  EvidenceRef,
  FactEvidenceRef,
  OrganizationDirectorySource,
  OrganizationSource,
  ProjectConsumptionPage,
  ProjectConsumptionSource,
  ProjectCurrentSnapshot,
  SourcePeriod,
} from "./consumption-source.js";
import type {
  ControlsSource,
  ProjectQuotaReading,
  ProjectRecordSource,
  SpendingNotificationReading,
} from "./controls-service.js";
import {
  ConsumptionSourceIntegrityError,
  markStructuredSourceError,
  sanitizeErrorText,
  toSourceErrorDetail,
} from "./errors.js";
import { historyContracts } from "./history-contracts.js";
import type { OperationContext } from "./operation-context.js";
import {
  OperationByteLimitError,
  OperationLimitError,
  raceAbort,
  throwIfAborted,
} from "./operation-context.js";
import type { RequestCoordinator } from "./request-coordinator.js";

const nonNegativeInteger = z
  .string()
  .regex(/^(0|[1-9]\d{0,39})$/, "must be a non-negative integer of at most 40 digits");
const neonId = z.string().regex(/^[a-z0-9-]{1,60}$/);
const projectHistoryContract = historyContracts.project;
const branchHistoryContract = historyContracts.branch;
const boundedString = (maxLength: number) => z.string().max(maxLength);
const periodSchema = z.object({
  period_id: boundedString(200),
  period_plan: boundedString(100),
  period_start: boundedString(100),
  period_end: boundedString(100).optional(),
  consumption: z.array(
    z.object({
      timeframe_start: boundedString(100),
      timeframe_end: boundedString(100),
      metrics: z.array(z.object({ metric_name: boundedString(200), value: nonNegativeInteger })),
    }),
  ),
});

const responseSchema = z.object({
  projects: z.array(
    z.object({
      project_id: neonId,
      periods: z.array(periodSchema),
    }),
  ),
  pagination: z
    .object({ cursor: boundedString(2000).nullable().optional() })
    .nullable()
    .optional(),
});

const branchResponseSchema = z.object({
  branches: z.array(
    z.object({
      project_id: neonId,
      branch_id: neonId,
      periods: z.array(periodSchema),
    }),
  ),
  pagination: z
    .object({ cursor: boundedString(2000).nullable().optional() })
    .nullable()
    .optional(),
});

const organizationSchema = z.object({ id: neonId, plan: boundedString(100) });
const organizationsSchema = z.object({
  organizations: z.array(
    z.object({
      id: neonId,
      name: boundedString(500),
      handle: boundedString(200),
      plan: boundedString(100),
    }),
  ),
  pagination: z.object({ cursor: boundedString(2000).nullable().optional() }).optional(),
});
const projectsSchema = z.object({
  projects: z.array(z.object({ id: neonId, name: boundedString(500) })),
  unavailable_project_ids: z.array(neonId).optional(),
  pagination: z.object({ cursor: boundedString(2000).nullable().optional() }).optional(),
});
const projectSnapshotSchema = z.object({
  project: z.object({
    id: neonId,
    consumption_period_start: boundedString(100),
    consumption_period_end: boundedString(100),
    active_time_seconds: nonNegativeInteger,
    compute_time_seconds: nonNegativeInteger,
    written_data_bytes: nonNegativeInteger,
    data_transfer_bytes: nonNegativeInteger,
    data_storage_bytes_hour: nonNegativeInteger,
  }),
});
const spendingLimitSchema = z.object({
  spending_limit_cents: z
    .string()
    .regex(/^(0|[1-9]\d{0,15})$/)
    .nullable()
    .optional(),
});
const quotaValue = z
  .string()
  .regex(/^(0|[1-9]\d{0,39})$/)
  .optional();
const projectQuotaSchema = z.object({
  project: z.object({
    id: neonId,
    consumption_period_end: boundedString(100).optional(),
    settings: z
      .object({
        quota: z
          .object({
            active_time_seconds: quotaValue,
            compute_time_seconds: quotaValue,
            written_data_bytes: quotaValue,
            data_transfer_bytes: quotaValue,
            logical_size_bytes: quotaValue,
          })
          .optional(),
      })
      .optional(),
  }),
});
const branchesSchema = z.object({
  branches: z.array(
    z.object({
      id: neonId,
      name: boundedString(500).optional(),
      logical_size: nonNegativeInteger.optional(),
    }),
  ),
  pagination: z.object({ next: boundedString(2000).nullable().optional() }).optional(),
});

export type NeonApiSourceOptions = {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  maxRetries?: number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  /** Cumulative transport/retry time; admission waits use the operation cancellation/deadline. */
  requestTimeoutMs?: number;
  maxRetryDelayMs?: number;
  maxResponseBytes?: number;
  shutdownSignal?: AbortSignal;
  now?: () => number;
  requestCoordinator?: RequestCoordinator;
  evidence?: {
    sourceAccount: string;
    retention: "hash_only" | "body";
    write(record: NeonSourceEvidence, signal: AbortSignal): Promise<void>;
  };
  evidenceClock?: () => Date;
};

export type NeonSourceEvidence = {
  evidenceId: string;
  sourceAccount: string;
  sourceContract: string;
  requestedAt: string;
  completedAt: string;
  request: {
    method: "GET";
    path: string;
    query: string;
    cursorIn: string | null;
    fingerprint: string;
  };
  response: {
    status: number;
    requestId?: string;
    cursorOut: string | null;
    payloadHash: string;
    bodyBase64?: string;
  };
  attempt: number;
};

export class NeonApiError extends Error {
  override readonly name = "NeonApiError";
  readonly code?: string;
  readonly requestId?: string;

  constructor(
    readonly status: number,
    body: string,
    requestId?: string,
    readonly attempts?: number,
    readonly retryable = false,
    readonly retryAfterMs?: number,
    accessToken?: string,
  ) {
    const details = parseApiError(body, accessToken);
    super(`Neon API request failed with HTTP ${status}: ${details.message}`);
    markStructuredSourceError(this);
    if (details.code) this.code = details.code;
    const boundedRequestId = requestId ? sanitizeErrorText(requestId, 200) : "";
    if (boundedRequestId) this.requestId = boundedRequestId;
  }
}

function parseApiError(body: string, accessToken?: string): { code?: string; message: string } {
  try {
    const value: unknown = JSON.parse(body);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const error = value as Record<string, unknown>;
      const code =
        typeof error.code === "string" &&
        error.code.trim() &&
        (!accessToken || !error.code.includes(accessToken))
          ? sanitizeErrorText(error.code, 100)
          : undefined;
      const message =
        typeof error.message === "string" &&
        error.message.trim() &&
        (!accessToken || !error.message.includes(accessToken))
          ? sanitizeErrorText(error.message, 500)
          : "unrecognized error response";
      return { ...(code ? { code } : {}), message };
    }
  } catch {
    // Fall through to a bounded generic message; arbitrary response bodies are discarded.
  }
  return { message: "unrecognized error response" };
}

function responseRequestId(response: Response, accessToken: string): string | undefined {
  const value =
    response.headers.get("x-neon-ret-request-id") ??
    response.headers.get("x-request-id") ??
    undefined;
  if (!value || value.includes(accessToken)) return undefined;
  const bounded = sanitizeErrorText(value, 200);
  return bounded || undefined;
}

export class NeonTransportError extends Error {
  override readonly name = "NeonTransportError";
  readonly retryable: boolean;

  constructor(
    readonly kind: "network" | "timeout" | "cancelled",
    readonly attempts: number,
    options?: ErrorOptions,
  ) {
    super(`Neon API ${kind} failure after ${attempts} attempt(s)`, options);
    markStructuredSourceError(this);
    this.retryable = kind !== "cancelled";
  }
}

export class NeonResponseError extends Error {
  override readonly name: string = "NeonResponseError";
  readonly retryable = false;
  status?: number;
  requestId?: string;
  attempts?: number;

  constructor(message: string, metadata?: NeonResponseMetadata, options?: ErrorOptions) {
    super(message, options);
    markStructuredSourceError(this);
    this.withMetadata(metadata);
  }

  withMetadata(metadata?: NeonResponseMetadata): this {
    if (!metadata) return this;
    this.status = metadata.status;
    this.attempts = metadata.attempts;
    if (metadata.requestId) this.requestId = metadata.requestId;
    return this;
  }
}

export class NeonResponseTooLargeError extends NeonResponseError {
  override readonly name = "NeonResponseTooLargeError";
}

export class NeonEvidenceError extends Error {
  override readonly name = "NeonEvidenceError";
  readonly retryable = false;
  readonly integrityFailure = true;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    markStructuredSourceError(this);
  }
}

function sourceContract(path: string): string {
  if (path === projectHistoryContract.endpoint) return projectHistoryContract.sourceContract;
  if (path === branchHistoryContract.endpoint) return branchHistoryContract.sourceContract;
  if (/^\/organizations\/[^/]+\/billing\/spending_limit$/.test(path)) return "spending-limit";
  if (/^\/organizations\/[^/]+$/.test(path)) return "organization-details";
  if (path === "/users/me/organizations") return "organization-list";
  if (path === "/projects") return "project-list";
  if (path.endsWith("/branches")) return "branch-list";
  return "project-details";
}

function responseCursor(path: string, value: unknown, accessToken: string): string | null {
  const schema =
    path === projectHistoryContract.endpoint
      ? responseSchema
      : path === branchHistoryContract.endpoint
        ? branchResponseSchema
        : path === "/users/me/organizations"
          ? organizationsSchema
          : path === "/projects"
            ? projectsSchema
            : /^\/projects\/[^/]+\/branches$/.test(path)
              ? branchesSchema
              : undefined;
  if (!schema) return null;
  const parsed = schema.safeParse(value);
  if (!parsed.success) return null;
  const pagination = parsed.data.pagination;
  const cursor =
    pagination &&
    ("cursor" in pagination ? pagination.cursor : "next" in pagination ? pagination.next : null);
  if (cursor?.includes(accessToken)) {
    throw new NeonResponseError("Neon API returned an unsafe pagination cursor");
  }
  return cursor ?? null;
}

async function readResponseBytes(
  response: Response,
  maxResponseBytes: number,
  signal: AbortSignal,
  onChunk: (bytes: number) => void,
): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxResponseBytes) {
    // Cancellation must not delay or replace the response limit error.
    void response.body?.cancel().catch(() => {});
    throw new NeonResponseTooLargeError(
      `Neon API response exceeds the ${maxResponseBytes}-byte limit`,
    );
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await raceAbort(reader.read(), signal);
      if (done) break;
      onChunk(value.byteLength);
      total += value.byteLength;
      if (total > maxResponseBytes) {
        throw new NeonResponseTooLargeError(
          `Neon API response exceeds the ${maxResponseBytes}-byte limit`,
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    // Reader cancellation itself may also be supplied by non-cooperative code.
    void reader.cancel(signal.reason).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

type NeonResponseMetadata = {
  status: number;
  requestId?: string;
  attempts: number;
};

function validateResponse<T>(
  schema: z.ZodType<T>,
  value: unknown,
  metadata?: NeonResponseMetadata,
): T {
  try {
    return schema.parse(value);
  } catch (error) {
    throw new NeonResponseError(
      "Neon API response did not match its published contract",
      metadata,
      { cause: error },
    );
  }
}

function mapSourcePeriods(
  periods: z.infer<typeof periodSchema>[],
  entityPath: string,
  provenance: { payloadHash: string; evidenceId?: string },
): SourcePeriod[] {
  return periods.map((period, periodIndex) => ({
    id: period.period_id,
    plan: period.period_plan,
    start: period.period_start,
    ...(period.period_end ? { end: period.period_end } : {}),
    buckets: period.consumption.map((bucket, bucketIndex) => ({
      start: bucket.timeframe_start,
      end: bucket.timeframe_end,
      metrics: bucket.metrics.map((metric, metricIndex) => {
        const metricEvidence: FactEvidenceRef = {
          ...provenance,
          sourcePath: `${entityPath}/periods/${periodIndex}/consumption/${bucketIndex}/metrics/${metricIndex}`,
        };
        return {
          name: metric.metric_name,
          value: metric.value,
          evidence: metricEvidence,
        };
      }),
    })),
  }));
}

function assertNeonId(value: string, label: string): void {
  if (!/^[a-z0-9-]{1,60}$/.test(value)) throw new TypeError(`${label} is malformed`);
}

function parseRetryAfter(retryAfter: string | null, now: number): number | undefined {
  if (retryAfter && /^\d+$/.test(retryAfter)) {
    const milliseconds = Number(retryAfter) * 1000;
    return Number.isFinite(milliseconds) ? Math.min(milliseconds, 86_400_000) : 86_400_000;
  }
  if (
    retryAfter &&
    (/^[A-Za-z]{3},/.test(retryAfter) ||
      /^[A-Za-z]+, \d{2}-[A-Za-z]{3}-\d{2}/.test(retryAfter) ||
      /^[A-Za-z]{3} [A-Za-z]{3}\s/.test(retryAfter))
  ) {
    const asctime = /^[A-Za-z]{3} [A-Za-z]{3}\s/.test(retryAfter);
    const date = Date.parse(asctime ? `${retryAfter} GMT` : retryAfter);
    if (Number.isFinite(date)) return Math.min(Math.max(0, date - now), 86_400_000);
  }
  return undefined;
}

/** A parsed `GET /projects/{id}` response — the shared input for the two readings below. */
type ProjectRecordResponse = {
  payload: unknown;
  payloadHash: string;
  metadata: NeonResponseMetadata;
  evidence?: EvidenceRef;
};

/** Current-period usage view of a project record (`GET /projects/{id}`). */
/** Guard against a misrouted/cached response attributing another project's data. */
function assertReturnedProject(
  returnedId: string,
  expectedId: string,
  metadata: NeonResponseMetadata,
): void {
  if (returnedId !== expectedId) {
    throw new NeonResponseError(
      `Neon returned project ${returnedId} for requested project ${expectedId}`,
      metadata,
    );
  }
}

function buildProjectSnapshotReading(
  response: ProjectRecordResponse,
  expectedProjectId: string,
): ProjectCurrentSnapshot {
  const { project } = validateResponse(projectSnapshotSchema, response.payload, response.metadata);
  assertReturnedProject(project.id, expectedProjectId, response.metadata);
  const factEvidence = (sourcePath: string): FactEvidenceRef => ({
    payloadHash: response.payloadHash,
    ...(response.evidence ? { evidenceId: response.evidence.evidenceId } : {}),
    sourcePath,
  });
  return {
    projectId: project.id,
    periodStart: project.consumption_period_start,
    periodEnd: project.consumption_period_end,
    activeTimeSeconds: project.active_time_seconds,
    computeTimeSeconds: project.compute_time_seconds,
    writtenDataBytes: project.written_data_bytes,
    dataTransferBytes: project.data_transfer_bytes,
    dataStorageByteHours: project.data_storage_bytes_hour,
    ...(response.evidence ? { evidence: response.evidence } : {}),
    metricEvidence: {
      activeTimeSeconds: factEvidence("/project/active_time_seconds"),
      computeTimeSeconds: factEvidence("/project/compute_time_seconds"),
      writtenDataBytes: factEvidence("/project/written_data_bytes"),
      dataTransferBytes: factEvidence("/project/data_transfer_bytes"),
      dataStorageByteHours: factEvidence("/project/data_storage_bytes_hour"),
    },
  };
}

/** Configured-quota view of the same project record. */
function buildProjectQuotaReading(
  response: ProjectRecordResponse,
  expectedProjectId: string,
): ProjectQuotaReading {
  const { project } = validateResponse(projectQuotaSchema, response.payload, response.metadata);
  assertReturnedProject(project.id, expectedProjectId, response.metadata);
  const quota = project.settings?.quota;
  // Zero and absent both mean unlimited per the update-project contract.
  const value = (raw: string | undefined) => (raw === undefined || raw === "0" ? null : raw);
  return {
    projectId: project.id,
    consumptionPeriodEnd: project.consumption_period_end ?? null,
    quota: {
      activeTimeSeconds: value(quota?.active_time_seconds),
      computeTimeSeconds: value(quota?.compute_time_seconds),
      writtenDataBytes: value(quota?.written_data_bytes),
      dataTransferBytes: value(quota?.data_transfer_bytes),
      logicalSizeBytes: value(quota?.logical_size_bytes),
    },
    enforcement: "suspend_computes_until_period_end",
    logicalSizeEnforcement: "suspend_affected_branch_persistent",
  };
}

type InventoryWalk = {
  requestContext(): OperationContext;
  countPage(items: number, bytes: number): void;
  nextCursor(requested: string | null, returned: string | null, items: number): string | null;
};

async function collectInventory<T>(
  context: OperationContext | undefined,
  maxPages: number,
  label: string,
  collect: (walk: InventoryWalk) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const deadline =
    context?.maxDurationMs === undefined ? undefined : performance.now() + context.maxDurationMs;
  const timer =
    context?.maxDurationMs === undefined
      ? undefined
      : setTimeout(
          () => controller.abort(new OperationLimitError("time_limit")),
          context.maxDurationMs,
        );
  const signal = context?.signal
    ? AbortSignal.any([context.signal, controller.signal])
    : controller.signal;
  const seenCursors = new Set<string>();
  let pages = 0;
  let items = 0;
  let bytes = 0;
  const checkDeadline = () => {
    throwIfAborted(context);
    if (deadline !== undefined && performance.now() >= deadline) {
      controller.abort(new OperationLimitError("time_limit"));
    }
    if (controller.signal.aborted) throw controller.signal.reason;
  };
  try {
    const result = await collect({
      requestContext() {
        checkDeadline();
        if (pages >= Math.min(maxPages, context?.maxPages ?? maxPages)) {
          throw new OperationLimitError("page_limit");
        }
        if (
          (context?.maxItems !== undefined && items >= context.maxItems) ||
          (context?.retainedItemBudget && context.retainedItemBudget.remaining <= 0)
        ) {
          throw new OperationLimitError("item_limit");
        }
        if (context?.maxResponseBytes !== undefined && bytes >= context.maxResponseBytes) {
          throw new OperationByteLimitError();
        }
        return {
          signal,
          ...(context?.retainedByteBudget
            ? { retainedByteBudget: context.retainedByteBudget }
            : {}),
          ...(context?.maxResponseBytes !== undefined
            ? { maxResponseBytes: context.maxResponseBytes - bytes }
            : {}),
        };
      },
      countPage(pageItems, pageBytes) {
        if (
          (context?.maxItems !== undefined && items + pageItems > context.maxItems) ||
          (context?.retainedItemBudget && pageItems > context.retainedItemBudget.remaining)
        ) {
          throw new OperationLimitError("item_limit");
        }
        if (context?.retainedItemBudget) context.retainedItemBudget.remaining -= pageItems;
        pages += 1;
        items += pageItems;
        bytes += pageBytes;
      },
      nextCursor(requested, returned, pageItems) {
        if (pageItems === 0) {
          // Live-validated Neon termination: an empty page echoes the requested cursor.
          if (returned === null || returned === requested) return null;
          throw new ConsumptionSourceIntegrityError(
            `Neon ${label} list returned an empty page with a continuation cursor`,
          );
        }
        if (returned !== null) {
          if (seenCursors.has(returned)) {
            throw new ConsumptionSourceIntegrityError(
              `Neon ${label} list returned a repeated cursor`,
            );
          }
          seenCursors.add(returned);
        }
        return returned;
      },
    });
    checkDeadline();
    return result;
  } catch (error) {
    if (signal.reason instanceof OperationLimitError) throw signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function createNeonApiSource(
  options: NeonApiSourceOptions,
): ProjectConsumptionSource &
  BranchConsumptionSource &
  OrganizationSource &
  OrganizationDirectorySource &
  CurrentSnapshotSource &
  ControlsSource &
  ProjectRecordSource {
  const fetch = options.fetch ?? globalThis.fetch;
  // A key with control characters (a stray newline from a copy-paste) makes
  // fetch throw an opaque "Invalid header value"; reject it up front with a
  // clear message instead — mirroring the other option validations below.
  const hasControlChar = (value: string) =>
    [...value].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);
  if (!options.apiKey || hasControlChar(options.apiKey)) {
    throw new TypeError("apiKey must be a non-empty string without control characters");
  }
  // Trim a trailing slash so `${baseUrl}${path}` never yields a `//` in the path.
  const baseUrl = (options.baseUrl ?? "https://console.neon.tech/api/v2").replace(/\/+$/, "");
  const baseOrigin = new URL(baseUrl);
  const loopback = baseOrigin.hostname === "localhost" || baseOrigin.hostname === "127.0.0.1";
  if (
    (baseOrigin.protocol !== "https:" && !(baseOrigin.protocol === "http:" && loopback)) ||
    baseOrigin.username ||
    baseOrigin.password ||
    baseOrigin.search ||
    baseOrigin.hash
  ) {
    throw new TypeError(
      "baseUrl must be a clean https origin (http is allowed only for loopback testing)",
    );
  }
  const maxRetries = options.maxRetries ?? 2;
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const maxRetryDelayMs = options.maxRetryDelayMs ?? 5_000;
  const maxResponseBytes = options.maxResponseBytes ?? 10_000_000;
  if (options.evidence && options.evidence.sourceAccount.trim().length === 0) {
    throw new TypeError("evidence.sourceAccount must not be empty");
  }
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) {
    throw new RangeError("maxRetries must be an integer between 0 and 10");
  }
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0 || requestTimeoutMs > 120_000) {
    throw new RangeError("requestTimeoutMs must be between 1 and 120000");
  }
  if (!Number.isFinite(maxRetryDelayMs) || maxRetryDelayMs < 0 || maxRetryDelayMs > 30_000) {
    throw new RangeError("maxRetryDelayMs must be between 0 and 30000");
  }
  if (
    !Number.isInteger(maxResponseBytes) ||
    maxResponseBytes < 1 ||
    maxResponseBytes > 100_000_000
  ) {
    throw new RangeError("maxResponseBytes must be an integer between 1 and 100000000");
  }
  const sleep =
    options.sleep ??
    ((milliseconds: number, signal?: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        const cancel = () => {
          clearTimeout(timer);
          reject(signal?.reason);
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", cancel);
          resolve();
        }, milliseconds);
        signal?.addEventListener("abort", cancel, { once: true });
      }));
  const random = options.random ?? Math.random;
  const retryClock = options.now ?? Date.now;

  async function request(
    path: string,
    searchParams?: URLSearchParams,
    context?: OperationContext,
  ): Promise<{
    payload: unknown;
    payloadHash: string;
    responseBytes: number;
    metadata: NeonResponseMetadata;
    evidence?: EvidenceRef;
  }> {
    const url = new URL(`${baseUrl}${path}`);
    if (searchParams) {
      url.search = searchParams.toString();
    }
    const controller = new AbortController();
    let remainingTimeoutMs = requestTimeoutMs;
    let deadline = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortKind: "cancelled" | "timeout" | undefined;
    const abort = (kind: "cancelled" | "timeout", reason?: unknown) => {
      if (controller.signal.aborted) return;
      abortKind = kind;
      controller.abort(reason);
    };
    const cancelOperation = () => abort("cancelled", context?.signal?.reason);
    const cancelShutdown = () => abort("cancelled", options.shutdownSignal?.reason);
    if (context?.signal?.aborted) cancelOperation();
    else context?.signal?.addEventListener("abort", cancelOperation, { once: true });
    if (options.shutdownSignal?.aborted) cancelShutdown();
    else options.shutdownSignal?.addEventListener("abort", cancelShutdown, { once: true });
    let fetchAttempts = 0;
    let operationResponseBytes = 0;
    try {
      if (controller.signal.aborted) {
        throw new NeonTransportError("cancelled", 0, { cause: controller.signal.reason });
      }
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        if (timer !== undefined) {
          clearTimeout(timer);
          remainingTimeoutMs = deadline - performance.now();
          if (remainingTimeoutMs <= 0) abort("timeout");
        }
        if (context?.retainedByteBudget && context.retainedByteBudget.remaining <= 0) {
          throw new OperationByteLimitError();
        }
        if (
          context?.maxResponseBytes !== undefined &&
          operationResponseBytes >= context.maxResponseBytes
        ) {
          throw new OperationByteLimitError();
        }
        try {
          if (options.requestCoordinator) {
            await raceAbort(
              options.requestCoordinator.acquire(controller.signal),
              controller.signal,
            );
          }
        } catch (error) {
          if (controller.signal.aborted) {
            throw new NeonTransportError(abortKind ?? "cancelled", fetchAttempts, {
              cause: error,
            });
          }
          throw error;
        }
        if (controller.signal.aborted) {
          throw new NeonTransportError(abortKind ?? "cancelled", fetchAttempts, {
            cause: controller.signal.reason,
          });
        }
        // Admission uses the operation deadline; transport and retry work share this budget.
        deadline = performance.now() + remainingTimeoutMs;
        timer = setTimeout(() => abort("timeout"), remainingTimeoutMs);
        let response: Response | undefined;
        try {
          fetchAttempts += 1;
          const requestedAt = (options.evidenceClock?.() ?? new Date()).toISOString();
          response = await raceAbort(
            fetch(url, {
              signal: controller.signal,
              redirect: "error",
              headers: {
                accept: "application/json",
                authorization: `Bearer ${options.apiKey}`,
              },
            }),
            controller.signal,
          );
          const effectiveResponseLimit = Math.min(
            maxResponseBytes,
            context?.retainedByteBudget?.remaining ?? maxResponseBytes,
            context?.maxResponseBytes === undefined
              ? maxResponseBytes
              : Math.max(0, context.maxResponseBytes - operationResponseBytes),
          );
          let bytes: Uint8Array;
          try {
            bytes = await readResponseBytes(
              response,
              effectiveResponseLimit,
              controller.signal,
              (chunkBytes) => {
                if (context?.retainedByteBudget) {
                  if (chunkBytes > context.retainedByteBudget.remaining) {
                    throw new OperationByteLimitError();
                  }
                  context.retainedByteBudget.remaining -= chunkBytes;
                }
                operationResponseBytes += chunkBytes;
              },
            );
          } catch (error) {
            if (
              error instanceof NeonResponseTooLargeError &&
              effectiveResponseLimit < maxResponseBytes
            ) {
              throw new OperationByteLimitError();
            }
            throw error;
          }
          const body = Buffer.from(bytes).toString("utf8");
          const payloadHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
          let parsedBody: unknown;
          try {
            parsedBody = parse(body, null, (value) => value);
          } catch {
            parsedBody = undefined;
          }
          const cursorOut = response.ok ? responseCursor(path, parsedBody, options.apiKey) : null;
          let evidenceRef: { evidenceId: string; payloadHash: string } | undefined;
          if (options.evidence) {
            const requestId = responseRequestId(response, options.apiKey);
            const canonicalUrl = new URL(url);
            canonicalUrl.searchParams.sort();
            const canonicalRequest = JSON.stringify({
              method: "GET",
              url: canonicalUrl.toString(),
            });
            const fingerprint = `sha256:${createHash("sha256").update(canonicalRequest).digest("hex")}`;
            const completedAt = (options.evidenceClock?.() ?? new Date()).toISOString();
            const contract = sourceContract(path);
            const evidenceId = `evidence:sha256:${createHash("sha256")
              .update(
                JSON.stringify({
                  sourceAccount: options.evidence.sourceAccount,
                  sourceContract: contract,
                  fingerprint,
                  cursorIn: url.searchParams.get("cursor"),
                  payloadHash,
                }),
              )
              .digest("hex")}`;
            try {
              await raceAbort(
                options.evidence.write(
                  {
                    evidenceId,
                    sourceAccount: options.evidence.sourceAccount,
                    sourceContract: contract,
                    requestedAt,
                    completedAt,
                    request: {
                      method: "GET",
                      path,
                      query: url.searchParams.toString(),
                      cursorIn: url.searchParams.get("cursor"),
                      fingerprint,
                    },
                    response: {
                      status: response.status,
                      ...(requestId ? { requestId } : {}),
                      cursorOut,
                      payloadHash,
                      ...(options.evidence.retention === "body"
                        ? { bodyBase64: Buffer.from(bytes).toString("base64") }
                        : {}),
                    },
                    attempt: fetchAttempts,
                  },
                  controller.signal,
                ),
                controller.signal,
              );
              evidenceRef = { evidenceId, payloadHash };
            } catch (error) {
              if (controller.signal.aborted) throw controller.signal.reason;
              throw new NeonEvidenceError("Failed to retain Neon API source evidence", {
                cause: error,
              });
            }
          }
          if (response.ok) {
            if (parsedBody === undefined) {
              throw new NeonResponseError("Neon API returned invalid JSON");
            }
            const requestId = responseRequestId(response, options.apiKey);
            return {
              payload: parsedBody,
              payloadHash,
              responseBytes: operationResponseBytes,
              metadata: {
                status: response.status,
                ...(requestId ? { requestId } : {}),
                attempts: fetchAttempts,
              },
              ...(evidenceRef ? { evidence: evidenceRef } : {}),
            };
          }
          // All traffic here is idempotent GETs, so transient 5xx gateway/server
          // errors are safe to retry alongside 423/429.
          const retryable = [423, 429, 500, 502, 503, 504].includes(response.status);
          const requestedDelay = parseRetryAfter(response.headers.get("retry-after"), retryClock());
          const delay =
            requestedDelay ?? Math.min(maxRetryDelayMs, Math.floor(250 * 2 ** attempt * random()));
          if (retryable && attempt < maxRetries && delay < deadline - performance.now()) {
            if (requestedDelay !== undefined && requestedDelay > maxRetryDelayMs) {
              throw new NeonApiError(
                response.status,
                body,
                responseRequestId(response, options.apiKey),
                fetchAttempts,
                true,
                requestedDelay,
                options.apiKey,
              );
            }
            await raceAbort(sleep(delay, controller.signal), controller.signal);
            continue;
          }
          throw new NeonApiError(
            response.status,
            body,
            responseRequestId(response, options.apiKey),
            fetchAttempts,
            retryable,
            requestedDelay,
            options.apiKey,
          );
        } catch (error) {
          if (controller.signal.aborted) {
            throw new NeonTransportError(abortKind ?? "cancelled", fetchAttempts, {
              cause: error,
            });
          }
          if (error instanceof NeonResponseError && response) {
            const requestId = responseRequestId(response, options.apiKey);
            error.withMetadata({
              status: response.status,
              ...(requestId ? { requestId } : {}),
              attempts: fetchAttempts,
            });
          }
          if (
            error instanceof NeonApiError ||
            error instanceof NeonResponseError ||
            error instanceof NeonEvidenceError ||
            error instanceof OperationByteLimitError
          )
            throw error;
          if (
            context?.maxResponseBytes !== undefined &&
            operationResponseBytes >= context.maxResponseBytes
          ) {
            throw new OperationByteLimitError();
          }
          if (attempt < maxRetries) {
            const delay = Math.min(maxRetryDelayMs, Math.floor(250 * 2 ** attempt * random()));
            if (delay < deadline - performance.now()) {
              try {
                await raceAbort(sleep(delay, controller.signal), controller.signal);
              } catch (waitError) {
                throw new NeonTransportError(abortKind ?? "cancelled", fetchAttempts, {
                  cause: waitError,
                });
              }
              continue;
            }
          }
          throw new NeonTransportError("network", fetchAttempts, { cause: error });
        }
      }
      throw new Error("unreachable retry state");
    } finally {
      clearTimeout(timer);
      context?.signal?.removeEventListener("abort", cancelOperation);
      options.shutdownSignal?.removeEventListener("abort", cancelShutdown);
    }
  }

  const source: ProjectConsumptionSource &
    BranchConsumptionSource &
    OrganizationSource &
    OrganizationDirectorySource &
    CurrentSnapshotSource &
    ControlsSource &
    ProjectRecordSource = {
    async getProjectPage(
      query: ProjectReportQuery,
      cursor: string | null,
      context?: OperationContext,
    ): Promise<ProjectConsumptionPage> {
      assertNeonId(query.organizationId, "organization ID");
      for (const projectId of query.projectIds ?? []) assertNeonId(projectId, "project ID");
      const searchParams = new URLSearchParams();
      searchParams.set("org_id", query.organizationId);
      if (query.projectIds) searchParams.set("project_ids", query.projectIds.join(","));
      searchParams.set("from", query.from);
      searchParams.set("to", query.to);
      searchParams.set("granularity", query.granularity);
      searchParams.set("metrics", query.metrics.join(","));
      searchParams.set("limit", projectHistoryContract.pageSize.toString());
      if (cursor !== null) {
        searchParams.set("cursor", cursor);
      }
      const response = await request(projectHistoryContract.endpoint, searchParams, context);
      const parsed = validateResponse(responseSchema, response.payload, response.metadata);
      return {
        projects: parsed.projects.map((project, projectIndex) => ({
          projectId: project.project_id,
          periods: mapSourcePeriods(project.periods, `/projects/${projectIndex}`, {
            payloadHash: response.payloadHash,
            ...(response.evidence ? { evidenceId: response.evidence.evidenceId } : {}),
          }),
        })),
        nextCursor: parsed.pagination?.cursor ?? null,
        responseBytes: response.responseBytes,
        ...(response.metadata.requestId ? { requestId: response.metadata.requestId } : {}),
        ...(response.evidence ? { evidence: response.evidence } : {}),
      };
    },

    async getBranchPage(
      query: BranchReportQuery,
      cursor: string | null,
      context?: OperationContext,
    ) {
      assertNeonId(query.organizationId, "organization ID");
      for (const projectId of query.projectIds) assertNeonId(projectId, "project ID");
      for (const branchId of query.branchIds ?? []) assertNeonId(branchId, "branch ID");
      const searchParams = new URLSearchParams();
      searchParams.set("org_id", query.organizationId);
      searchParams.set("project_ids", query.projectIds.join(","));
      if (query.branchIds && query.branchIds.length > 0) {
        searchParams.set("branch_ids", query.branchIds.join(","));
      }
      searchParams.set("from", query.from);
      searchParams.set("to", query.to);
      searchParams.set("granularity", query.granularity);
      searchParams.set("metrics", query.metrics.join(","));
      searchParams.set("limit", branchHistoryContract.pageSize.toString());
      if (cursor !== null) {
        searchParams.set("cursor", cursor);
      }
      const response = await request(branchHistoryContract.endpoint, searchParams, context);
      const parsed = validateResponse(branchResponseSchema, response.payload, response.metadata);
      return {
        branches: parsed.branches.map((branch, branchIndex) => ({
          projectId: branch.project_id,
          branchId: branch.branch_id,
          periods: mapSourcePeriods(branch.periods, `/branches/${branchIndex}`, {
            payloadHash: response.payloadHash,
            ...(response.evidence ? { evidenceId: response.evidence.evidenceId } : {}),
          }),
        })),
        nextCursor: parsed.pagination?.cursor ?? null,
        responseBytes: response.responseBytes,
        ...(response.metadata.requestId ? { requestId: response.metadata.requestId } : {}),
        ...(response.evidence ? { evidence: response.evidence } : {}),
      };
    },

    async getOrganization(organizationId, context) {
      assertNeonId(organizationId, "organization ID");
      const response = await request(
        `/organizations/${encodeURIComponent(organizationId)}`,
        undefined,
        context,
      );
      const organization = validateResponse(
        organizationSchema,
        response.payload,
        response.metadata,
      );
      if (organization.id !== organizationId) {
        throw new NeonResponseError(
          `Neon returned organization ${organization.id} for requested organization ${organizationId}`,
          response.metadata,
        );
      }
      return organization;
    },

    async listOrganizations(context) {
      return collectInventory(context, 100, "organization", async (walk) => {
        const directory: z.infer<typeof organizationsSchema>["organizations"] = [];
        let cursor: string | null = null;
        do {
          const response = await request(
            "/users/me/organizations",
            cursor === null ? undefined : new URLSearchParams({ cursor }),
            walk.requestContext(),
          );
          const page = validateResponse(organizationsSchema, response.payload, response.metadata);
          walk.countPage(page.organizations.length, response.responseBytes);
          cursor = walk.nextCursor(
            cursor,
            page.pagination?.cursor ?? null,
            page.organizations.length,
          );
          directory.push(...page.organizations);
        } while (cursor !== null);
        return directory;
      });
    },

    async probeProjectHistory(organizationId, context) {
      const to = new Date();
      to.setUTCHours(0, 0, 0, 0);
      const from = new Date(to);
      from.setUTCDate(from.getUTCDate() - 1);
      try {
        await source.getProjectPage(
          {
            organizationId,
            from: from.toISOString(),
            to: to.toISOString(),
            granularity: "daily",
            metrics: ["compute_unit_seconds"],
          },
          null,
          context,
        );
        return "available";
      } catch (error) {
        if (
          error instanceof NeonEvidenceError ||
          error instanceof NeonResponseTooLargeError ||
          error instanceof OperationByteLimitError ||
          error instanceof OperationLimitError ||
          (error instanceof NeonTransportError && error.kind === "cancelled")
        )
          throw error;
        // Live-validated 2026-08-10: a project-scoped key gets HTTP 404
        // ("not allowed to perform actions outside the project this key is
        // scoped to") from organization history, so authorization-shaped
        // statuses all classify as forbidden rather than transient.
        return error instanceof NeonApiError && [401, 403, 404].includes(error.status)
          ? "forbidden"
          : "temporarily_unavailable";
      }
    },

    async listProjectDirectory(organizationId, context) {
      assertNeonId(organizationId, "organization ID");
      return collectInventory(context, 100, "project", async (walk) => {
        const projects: Array<{ id: string; name: string }> = [];
        const unavailableProjectIds: string[] = [];
        const evidence: EvidenceRef[] = [];
        let cursor: string | null = null;
        do {
          const searchParams = new URLSearchParams({ org_id: organizationId, limit: "400" });
          if (cursor !== null) {
            searchParams.set("cursor", cursor);
          }
          const response = await request("/projects", searchParams, walk.requestContext());
          const page = validateResponse(projectsSchema, response.payload, response.metadata);
          const pageItems = page.projects.length + (page.unavailable_project_ids?.length ?? 0);
          walk.countPage(pageItems, response.responseBytes);
          cursor = walk.nextCursor(cursor, page.pagination?.cursor ?? null, pageItems);
          if (response.evidence) evidence.push(response.evidence);
          projects.push(...page.projects);
          unavailableProjectIds.push(...(page.unavailable_project_ids ?? []));
        } while (cursor !== null);
        const uniqueProjects = new Map(projects.map((project) => [project.id, project]));
        const available = new Set(uniqueProjects.keys());
        return {
          projects: [...uniqueProjects.values()],
          unavailableProjectIds: [...new Set(unavailableProjectIds)].filter(
            (projectId) => !available.has(projectId),
          ),
          ...(evidence.length > 0 ? { evidence } : {}),
        };
      });
    },

    async listProjects(organizationId, context) {
      const directory = await source.listProjectDirectory(organizationId, context);
      return {
        projectIds: directory.projects.map((project) => project.id),
        unavailableProjectIds: directory.unavailableProjectIds,
        ...(directory.qualityFlags ? { qualityFlags: directory.qualityFlags } : {}),
        ...(directory.evidence ? { evidence: directory.evidence } : {}),
      };
    },

    async getProjectSnapshot(projectId, context) {
      assertNeonId(projectId, "project ID");
      return buildProjectSnapshotReading(
        await request(`/projects/${encodeURIComponent(projectId)}`, undefined, context),
        projectId,
      );
    },

    /** Quota limits and current usage from a single project-record fetch. */
    async getProjectQuotaSnapshot(projectId, context) {
      assertNeonId(projectId, "project ID");
      const response = await request(
        `/projects/${encodeURIComponent(projectId)}`,
        undefined,
        context,
      );
      return {
        quota: buildProjectQuotaReading(response, projectId),
        snapshot: buildProjectSnapshotReading(response, projectId),
      };
    },

    async getSpendingNotification(organizationId, context): Promise<SpendingNotificationReading> {
      assertNeonId(organizationId, "organization ID");
      try {
        const response = await request(
          `/organizations/${encodeURIComponent(organizationId)}/billing/spending_limit`,
          undefined,
          context,
        );
        const parsed = validateResponse(spendingLimitSchema, response.payload, response.metadata);
        return parsed.spending_limit_cents == null
          ? { status: "not_configured", semantics: "alert_only" }
          : {
              status: "configured",
              spendingLimitCents: parsed.spending_limit_cents,
              semantics: "alert_only",
            };
      } catch (error) {
        if (
          error instanceof NeonEvidenceError ||
          error instanceof OperationByteLimitError ||
          error instanceof OperationLimitError ||
          (error instanceof NeonTransportError && error.kind === "cancelled")
        ) {
          throw error;
        }
        // Live-validated 2026-08-10: a genuinely unconfigured organization
        // returns 200 with spending_limit_cents null; 404 means the caller
        // cannot see the threshold (project-scoped key, plan) and must not be
        // reported as "not configured".
        return { status: "unavailable", detail: toSourceErrorDetail(error) };
      }
    },

    async getProjectQuota(projectId, context): Promise<ProjectQuotaReading> {
      assertNeonId(projectId, "project ID");
      return buildProjectQuotaReading(
        await request(`/projects/${encodeURIComponent(projectId)}`, undefined, context),
        projectId,
      );
    },

    async listBranchSizes(projectId, context) {
      assertNeonId(projectId, "project ID");
      return collectInventory(context, 1000, "branch", async (walk) => {
        const branchSizes = [];
        const evidence: EvidenceRef[] = [];
        const seenBranchIds = new Set<string>();
        let cursor: string | null = null;
        do {
          const searchParams = new URLSearchParams({
            limit: "100",
            sort_by: "created_at",
            sort_order: "asc",
          });
          if (cursor !== null) {
            searchParams.set("cursor", cursor);
          }
          const response = await request(
            `/projects/${encodeURIComponent(projectId)}/branches`,
            searchParams,
            walk.requestContext(),
          );
          const page = validateResponse(branchesSchema, response.payload, response.metadata);
          walk.countPage(page.branches.length, response.responseBytes);
          cursor = walk.nextCursor(cursor, page.pagination?.next ?? null, page.branches.length);
          if (response.evidence) evidence.push(response.evidence);
          for (const [branchIndex, branch] of page.branches.entries()) {
            if (seenBranchIds.has(branch.id)) {
              throw new NeonResponseError(
                `Neon branch list repeated branch ${branch.id}`,
                response.metadata,
              );
            }
            seenBranchIds.add(branch.id);
            // Live-validated 2026-08-09: Neon omits logical_size for branches
            // whose size has not been computed; report the absence explicitly.
            branchSizes.push({
              branchId: branch.id,
              ...(branch.name !== undefined ? { name: branch.name } : {}),
              logicalSizeBytes: branch.logical_size ?? null,
              evidence: {
                payloadHash: response.payloadHash,
                ...(response.evidence ? { evidenceId: response.evidence.evidenceId } : {}),
                sourcePath:
                  branch.logical_size === undefined
                    ? `/branches/${branchIndex}`
                    : `/branches/${branchIndex}/logical_size`,
              },
            });
          }
        } while (cursor !== null);
        return {
          branches: branchSizes,
          ...(evidence.length > 0 ? { evidence } : {}),
        };
      });
    },
  };

  return source;
}
