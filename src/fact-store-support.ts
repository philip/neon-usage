import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ConsumptionSourceIntegrityError } from "./errors.js";
import type {
  CanonicalConsumptionFact,
  CollectionRunCompletion,
  CollectionRunRecord,
  ResourceNameObservation,
} from "./evidence-fact-store.js";
import { effectiveFactIdentity, observationRevisionIdentity } from "./fact-identity.js";
import type { CollectionRunId } from "./history-collection.js";
import type { NeonSourceEvidence } from "./neon-api-source.js";

export function validateRunId(runId: CollectionRunId): void {
  if (!/^run_[A-Za-z0-9-]{1,100}$/.test(runId)) {
    throw new TypeError("collection run ID is malformed");
  }
}

export function parseUtcTimestamp(value: string, label: string): bigint {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
  const timestamp = parts ? Date.parse(value) : Number.NaN;
  const parsed = new Date(timestamp);
  if (
    !parts ||
    !Number.isFinite(timestamp) ||
    parsed.getUTCFullYear() !== Number(parts[1]) ||
    parsed.getUTCMonth() + 1 !== Number(parts[2]) ||
    parsed.getUTCDate() !== Number(parts[3]) ||
    parsed.getUTCHours() !== Number(parts[4]) ||
    parsed.getUTCMinutes() !== Number(parts[5]) ||
    parsed.getUTCSeconds() !== Number(parts[6])
  ) {
    throw new TypeError(`${label} must be an RFC 3339 UTC timestamp`);
  }
  return (
    BigInt(Math.floor(timestamp / 1000)) * 1_000_000_000n + BigInt((parts[7] ?? "").padEnd(9, "0"))
  );
}

export function validateFact(fact: CanonicalConsumptionFact): void {
  if (fact.presence !== "reported") {
    throw new ConsumptionSourceIntegrityError("Only reported source facts may be stored");
  }
  if (
    typeof fact.provenance?.payloadHash !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(fact.provenance.payloadHash) ||
    typeof fact.provenance.sourcePath !== "string" ||
    !fact.provenance.sourcePath.startsWith("/")
  ) {
    throw new ConsumptionSourceIntegrityError("Stored facts require payload hash and source path");
  }
  if (!/^(0|[1-9]\d*)$/.test(fact.value.decimalInteger)) {
    throw new ConsumptionSourceIntegrityError("Stored fact values must be non-negative integers");
  }
  const identity = {
    sourceContract: fact.sourceContract,
    scope: fact.scope,
    periodId: fact.billingPeriod.sourcePeriodId,
    bucket: fact.bucket,
    metricName: fact.metric.sourceName,
  };
  if (effectiveFactIdentity(identity) !== fact.effectiveFactId) {
    throw new ConsumptionSourceIntegrityError("Stored fact effective identity is invalid");
  }
  if (
    observationRevisionIdentity({ ...identity, payloadHash: fact.provenance.payloadHash }) !==
    fact.observationId
  ) {
    throw new ConsumptionSourceIntegrityError("Stored fact observation identity is invalid");
  }
}

export type EvidenceWriteAction = "insert" | "keep" | "upgrade_body";

/**
 * Decides how an idempotent evidence write applies to what is already stored.
 * Records with the same identity may differ only in body retention: a stored
 * hash-only record is upgraded in place when the incoming record carries the
 * exact bytes its payload hash already pins.
 */
export function evidenceWriteAction(
  existing: NeonSourceEvidence | undefined,
  record: NeonSourceEvidence,
): EvidenceWriteAction {
  assertEvidenceBodyIntegrity(record);
  if (!existing) return "insert";
  if (!sameEvidenceIdentity(existing, record)) {
    throw new ConsumptionSourceIntegrityError(
      `Evidence ${record.evidenceId} conflicts with an existing record`,
    );
  }
  return existing.response.bodyBase64 === undefined && record.response.bodyBase64 !== undefined
    ? "upgrade_body"
    : "keep";
}

export function withEvidenceBody(
  existing: NeonSourceEvidence,
  bodyBase64: string,
): NeonSourceEvidence {
  return { ...existing, response: { ...existing.response, bodyBase64 } };
}

function assertEvidenceBodyIntegrity(record: NeonSourceEvidence): void {
  const body = record.response.bodyBase64;
  if (body === undefined) return;
  const hash = `sha256:${createHash("sha256").update(Buffer.from(body, "base64")).digest("hex")}`;
  if (hash !== record.response.payloadHash) {
    throw new ConsumptionSourceIntegrityError(
      `Evidence ${record.evidenceId} body does not match its payload hash`,
    );
  }
}

function sameEvidenceIdentity(left: NeonSourceEvidence, right: NeonSourceEvidence): boolean {
  const identity = (record: NeonSourceEvidence) => ({
    evidenceId: record.evidenceId,
    sourceAccount: record.sourceAccount,
    sourceContract: record.sourceContract,
    request: record.request,
    response: {
      status: record.response.status,
      cursorOut: record.response.cursorOut,
      payloadHash: record.response.payloadHash,
    },
  });
  if (!isDeepStrictEqual(identity(left), identity(right))) return false;
  const leftBody = left.response.bodyBase64;
  const rightBody = right.response.bodyBase64;
  return leftBody === undefined || rightBody === undefined || leftBody === rightBody;
}

/**
 * Merges a completion into a stored run record. The completion's
 * sourceContract is validation input, never part of the stored record, so
 * exact duplicate finalization stays idempotent in every store.
 */
export function finalRunRecord(
  run: CollectionRunRecord,
  record: CollectionRunCompletion,
): CollectionRunRecord {
  return {
    runId: run.runId,
    intent: run.intent,
    status: record.status,
    completedAt: record.completedAt,
    pageCount: record.pageCount,
    qualityFlags: record.qualityFlags,
  };
}

export function validateResourceName(observation: ResourceNameObservation): void {
  if (!["organization", "project", "branch"].includes(observation.kind)) {
    throw new TypeError("resource name observation kind is invalid");
  }
  if (!/^[a-z0-9-]{1,60}$/.test(observation.resourceId)) {
    throw new TypeError("resource ID is malformed");
  }
  if (observation.name.length === 0 || observation.name.length > 500) {
    throw new TypeError("resource name must contain between 1 and 500 characters");
  }
  parseUtcTimestamp(observation.observedAt, "resource name observation time");
}
