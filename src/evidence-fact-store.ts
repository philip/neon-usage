import type { FactEvidenceRef } from "./consumption-source.js";
import type { ObservationScopeIdentity } from "./fact-identity.js";
import type { CollectionRunId, HistoryCollectionQualityFlag } from "./history-collection.js";
import type { NeonSourceEvidence } from "./neon-api-source.js";

export type CanonicalConsumptionFact = {
  observationId: string;
  effectiveFactId: string;
  sourceContract: string;
  scope: ObservationScopeIdentity;
  billingPeriod: { sourcePeriodId: string; plan: string; start: string; end?: string };
  bucket: { start: string; end: string };
  metric: { sourceName: string };
  value: { decimalInteger: string };
  presence: "reported";
  provenance: FactEvidenceRef;
};

export type CollectionIntent = {
  sourceAccount: string;
  sourceContract: string;
  request: unknown;
};

export type CollectionTerminalState =
  | "continue"
  | "complete"
  | "empty_page_with_cursor"
  | "cursor_repeated"
  | "page_limit"
  | "time_limit"
  | "item_limit"
  | "fact_limit"
  | "byte_limit";

export type CollectionPageWrite<Page = unknown> = {
  runId: CollectionRunId;
  pageNumber: number;
  cursorIn: string | null;
  cursorOut: string | null;
  nextCursor: string | null;
  terminalState: CollectionTerminalState;
  page: Page;
  evidence: readonly { evidenceId: string; payloadHash: string }[];
  facts: readonly CanonicalConsumptionFact[];
};

export type AppendReceipt = { appendedFacts: number; existingFacts: number };
export type FactRevisionQuery = { asCollectedAt?: string };

export type CollectionRunRecord = {
  runId: CollectionRunId;
  intent: CollectionIntent;
  status: "running" | "complete" | "partial" | "failed";
  completedAt?: string;
  pageCount: number;
  qualityFlags: readonly HistoryCollectionQualityFlag[];
};

export type CollectionRunCompletion = {
  runId: CollectionRunId;
  sourceContract: string;
  status: "complete" | "partial" | "failed";
  completedAt: string;
  pageCount: number;
  qualityFlags: readonly HistoryCollectionQualityFlag[];
};

/**
 * Adapter-neutral store contract for evidence, runs, pages, and fact
 * revisions. Implementations MUST make each write method atomic and
 * serialized per key: the idempotency rules (exact retry accepted, conflict
 * rejected) are expressed as read-then-write sequences, so an implementation
 * with real I/O between read and write (a networked store) must wrap them in
 * a transaction or per-key lock. The embedded SQLite and in-memory stores
 * satisfy this by being synchronous end to end.
 */
export type ResourceNameObservation = {
  kind: "organization" | "project" | "branch";
  resourceId: string;
  name: string;
  /** RFC 3339 UTC instant the name was observed at the provider. */
  observedAt: string;
};

export interface EvidenceFactStore {
  writeEvidence(record: NeonSourceEvidence, signal: AbortSignal): Promise<void>;
  beginCollectionRun(input: { runId: CollectionRunId; intent: CollectionIntent }): Promise<void>;
  appendCollectionPage(write: CollectionPageWrite): Promise<AppendReceipt>;
  recordCollectionRun(record: CollectionRunCompletion): Promise<void>;
  getEvidence(evidenceId: string): Promise<NeonSourceEvidence | undefined>;
  getFactRevision(observationId: string): Promise<CanonicalConsumptionFact | undefined>;
  getFactRevisions(effectiveFactId: string): Promise<readonly CanonicalConsumptionFact[]>;
  getEffectiveFactRevision(
    effectiveFactId: string,
    query?: FactRevisionQuery,
  ): Promise<CanonicalConsumptionFact | undefined>;
  getRunPage(runId: CollectionRunId, pageNumber: number): Promise<CollectionPageWrite | undefined>;
  getCollectionRun(runId: CollectionRunId): Promise<CollectionRunRecord | undefined>;
  /**
   * Runs recorded for one credential and source contract, in no guaranteed
   * order; intents ride along so callers can match effective-query scope.
   * The read side of serve-from-store: a completed run certifies the range
   * its intent names.
   */
  listCollectionRuns(filter: {
    sourceAccount: string;
    sourceContract: string;
  }): Promise<readonly CollectionRunRecord[]>;
  /** Append-only name observations; exact duplicates are idempotent. */
  recordResourceNames(observations: readonly ResourceNameObservation[]): Promise<void>;
  /** Latest observed name per requested resource ID. */
  getResourceNames(resourceIds: readonly string[]): Promise<Map<string, string>>;
  close(): void;
}
