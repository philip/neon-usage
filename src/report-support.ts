import { compareCanonicalText } from "./canonical-order.js";
import type { EvidenceRef, SourcePeriod } from "./consumption-source.js";
import { ConsumptionSourceIntegrityError } from "./errors.js";

export function canonicalEvidenceReferences(references: EvidenceRef[]): EvidenceRef[] {
  const unique = new Map<string, EvidenceRef>();
  for (const reference of references) {
    const previous = unique.get(reference.evidenceId);
    if (previous && previous.payloadHash !== reference.payloadHash) {
      throw new ConsumptionSourceIntegrityError(
        `Evidence ${reference.evidenceId} was returned with conflicting payload hashes`,
      );
    }
    if (!previous) unique.set(reference.evidenceId, reference);
  }
  return [...unique.values()].sort(
    (left, right) =>
      compareCanonicalText(left.evidenceId, right.evidenceId) ||
      compareCanonicalText(left.payloadHash, right.payloadHash),
  );
}

export function assertMetricEvidenceLinkedToPage(
  periods: readonly SourcePeriod[],
  pageEvidence: readonly EvidenceRef[],
  scope: string,
): void {
  const byId = new Map<string, string>();
  for (const reference of pageEvidence) {
    if (!reference.evidenceId.trim() || !/^sha256:[a-f0-9]{64}$/.test(reference.payloadHash)) {
      throw new ConsumptionSourceIntegrityError(`${scope} returned malformed page evidence`);
    }
    const previous = byId.get(reference.evidenceId);
    if (previous !== undefined && previous !== reference.payloadHash) {
      throw new ConsumptionSourceIntegrityError(
        `${scope} returned conflicting page evidence ${reference.evidenceId}`,
      );
    }
    byId.set(reference.evidenceId, reference.payloadHash);
  }
  for (const period of periods) {
    for (const bucket of period.buckets) {
      for (const metric of bucket.metrics) {
        const evidence = metric.evidence;
        if (!evidence) {
          throw new ConsumptionSourceIntegrityError(
            `${scope} metric ${metric.name} returned without provenance`,
          );
        }
        const evidenceId = evidence.evidenceId;
        if (pageEvidence.length === 0) {
          if (evidenceId !== undefined) {
            throw new ConsumptionSourceIntegrityError(
              `${scope} metric ${metric.name} cites evidence absent from its page`,
            );
          }
          continue;
        }
        if (!evidenceId || byId.get(evidenceId) !== evidence.payloadHash) {
          throw new ConsumptionSourceIntegrityError(
            `${scope} metric ${metric.name} does not match its page evidence`,
          );
        }
      }
    }
  }
}

export function isIntegrityFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "integrityFailure" in error &&
    error.integrityFailure === true
  );
}

const UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/;

function utcMillis(value: string, scope: string, label: string): number {
  const parts = UTC_TIMESTAMP.exec(value);
  if (!parts) {
    throw new ConsumptionSourceIntegrityError(`${scope} returned a non-UTC ${label} "${value}"`);
  }
  const ms = Date.parse(value);
  const parsed = new Date(ms);
  // Component round-trip: Date.parse NORMALIZES impossible values (Feb 30,
  // 24:00) instead of rejecting them; a normalized instant is not the instant
  // the source claimed.
  if (
    Number.isNaN(ms) ||
    parsed.getUTCFullYear() !== Number(parts[1]) ||
    parsed.getUTCMonth() + 1 !== Number(parts[2]) ||
    parsed.getUTCDate() !== Number(parts[3]) ||
    parsed.getUTCHours() !== Number(parts[4]) ||
    parsed.getUTCMinutes() !== Number(parts[5]) ||
    parsed.getUTCSeconds() !== Number(parts[6])
  ) {
    throw new ConsumptionSourceIntegrityError(`${scope} returned an invalid ${label} "${value}"`);
  }
  return ms;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * A bucket must lie within a single granularity cell (one hour/day/month).
 * A bucket spanning a cell boundary (e.g. noon-to-noon under daily) would
 * double-count time against its neighbors and break stored replay, which
 * assumes canonical cell starts. Exact-duration is deliberately NOT required:
 * a plan-change boundary can legitimately split one cell into partial buckets
 * across two billing periods.
 */
function assertBucketShape(
  startMs: number,
  endMs: number,
  granularity: string,
  scope: string,
  bucket: { start: string; end: string },
): void {
  const lastMs = endMs - 1;
  let spansCells = false;
  if (granularity === "hourly") {
    spansCells = Math.floor(startMs / HOUR_MS) !== Math.floor(lastMs / HOUR_MS);
  } else if (granularity === "daily") {
    spansCells = Math.floor(startMs / DAY_MS) !== Math.floor(lastMs / DAY_MS);
  } else if (granularity === "monthly") {
    const start = new Date(startMs);
    const last = new Date(lastMs);
    spansCells =
      start.getUTCFullYear() !== last.getUTCFullYear() ||
      start.getUTCMonth() !== last.getUTCMonth();
  }
  if (spansCells) {
    throw new ConsumptionSourceIntegrityError(
      `${scope} returned bucket ${bucket.start}/${bucket.end} spanning a ${granularity} boundary`,
    );
  }
}

export function assertValidPeriodFacts(
  periods: SourcePeriod[],
  scope: string,
  range?: { from: string; to: string; granularity?: string },
): void {
  // Callers pass the bucket-aligned effectiveRange: buckets must be STRICTLY
  // contained in it, or out-of-window usage would inflate totals at full value.
  const rangeFromMs = range ? Date.parse(range.from) : Number.NEGATIVE_INFINITY;
  const rangeToMs = range ? Date.parse(range.to) : Number.POSITIVE_INFINITY;
  if (Number.isNaN(rangeFromMs) || Number.isNaN(rangeToMs)) {
    // A malformed range must fail loudly, not silently disable containment.
    throw new ConsumptionSourceIntegrityError("period validation received an unparseable window");
  }
  const periodIds = new Set<string>();
  const buckets = new Set<string>();
  // Bucket intervals accumulate across ALL of the entity's periods; overlap is
  // checked globally after the walk (see below).
  const ranges: Array<[number, number]> = [];
  for (const period of periods) {
    if (periodIds.has(period.id)) {
      throw new ConsumptionSourceIntegrityError(`${scope} returned duplicate period ${period.id}`);
    }
    periodIds.add(period.id);
    // Billing-period bounds must be well-formed UTC instants (they key pricing
    // and allowance grouping). Bucket-in-period containment is deliberately NOT
    // enforced: a plan-change boundary day may legitimately straddle periods.
    const periodStartMs = utcMillis(period.start, scope, "period start");
    if (period.end !== undefined && utcMillis(period.end, scope, "period end") <= periodStartMs) {
      throw new ConsumptionSourceIntegrityError(
        `${scope} returned period ${period.id} whose end is not after its start`,
      );
    }
    for (const bucket of period.buckets) {
      const identity = `${period.id}:${bucket.start}:${bucket.end}`;
      if (buckets.has(identity)) {
        throw new ConsumptionSourceIntegrityError(
          `${scope} returned duplicate bucket ${bucket.start}/${bucket.end}`,
        );
      }
      buckets.add(identity);
      const startMs = utcMillis(bucket.start, scope, "bucket start");
      const endMs = utcMillis(bucket.end, scope, "bucket end");
      if (endMs <= startMs) {
        throw new ConsumptionSourceIntegrityError(
          `${scope} returned a bucket whose end ${bucket.end} is not after its start ${bucket.start}`,
        );
      }
      // Strict containment: callers pass the bucket-aligned effectiveRange
      // (both ends floored to bucket boundaries), so a legitimate provider
      // bucket lies wholly inside it — a bucket even partially outside would
      // smuggle out-of-window usage into the totals at full value.
      if (startMs < rangeFromMs || endMs > rangeToMs) {
        throw new ConsumptionSourceIntegrityError(
          `${scope} returned bucket ${bucket.start}/${bucket.end} outside the requested window`,
        );
      }
      if (range?.granularity) {
        assertBucketShape(startMs, endMs, range.granularity, scope, bucket);
      }
      ranges.push([startMs, endMs]);
      if (new Set(bucket.metrics.map((metric) => metric.name)).size !== bucket.metrics.length) {
        throw new ConsumptionSourceIntegrityError(`${scope} returned duplicate metrics`);
      }
      for (const metric of bucket.metrics) {
        if (
          typeof metric.evidence?.payloadHash !== "string" ||
          !/^sha256:[a-f0-9]{64}$/.test(metric.evidence.payloadHash) ||
          typeof metric.evidence.sourcePath !== "string" ||
          !metric.evidence.sourcePath.startsWith("/")
        ) {
          throw new ConsumptionSourceIntegrityError(
            `${scope} returned metric ${metric.name} without valid source provenance`,
          );
        }
        // Values are carried as exact non-negative integer strings; downstream
        // aggregation does BigInt(value). Reject anything else here as a
        // structured integrity failure rather than a raw SyntaxError or a
        // negative that would understate a total.
        if (metric.value !== null && !/^\d+$/.test(metric.value)) {
          throw new ConsumptionSourceIntegrityError(
            `${scope} returned metric ${metric.name} with a non-negative-integer value`,
          );
        }
      }
    }
  }
  // Bucket intervals must be non-overlapping ACROSS the entity's periods, not
  // just within one: the same interval reported in two source periods would
  // double-count usage (and could double allowance windows). A plan-change
  // cell split into disjoint partial buckets across two periods stays legal.
  ranges.sort((left, right) => left[0] - right[0]);
  for (let index = 1; index < ranges.length; index += 1) {
    if ((ranges[index]?.[0] ?? 0) < (ranges[index - 1]?.[1] ?? 0)) {
      throw new ConsumptionSourceIntegrityError(
        `${scope} returned overlapping buckets across its periods`,
      );
    }
  }
}
