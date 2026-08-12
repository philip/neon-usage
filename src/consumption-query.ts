export type Granularity = "hourly" | "daily" | "monthly";

export type ProjectReportQuery = {
  organizationId: string;
  projectIds?: string[];
  from: string;
  to: string;
  granularity: Granularity;
  metrics: string[];
};

export type BranchReportQuery = ProjectReportQuery & {
  projectIds: string[];
  branchIds?: string[];
};

export type EffectiveRange = {
  from: string;
  to: string;
  granularity: Granularity;
};

export class ConsumptionQueryError extends Error {
  override readonly name = "ConsumptionQueryError";

  constructor(
    readonly code:
      | "INVALID_TIMESTAMP"
      | "INVALID_RANGE"
      | "INVALID_METRIC"
      | "DUPLICATE_METRIC"
      | "PROJECT_IDS_REQUIRED"
      | "INVALID_FILTER"
      | "INVALID_GRANULARITY"
      | "RANGE_OUTSIDE_GRANULARITY",
    message: string,
    readonly field?: "from" | "to",
  ) {
    super(message);
  }
}

/** The one home of the Neon resource-identifier shape. */
export const neonIdPattern = /^[a-z0-9-]{1,60}$/;

export function isNeonId(value: string): boolean {
  return neonIdPattern.test(value);
}

function parseTimestamp(value: string, field: "from" | "to"): Date {
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?([Zz]|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!parts) {
    throw new ConsumptionQueryError(
      "INVALID_TIMESTAMP",
      `${field} must be an RFC 3339 timestamp`,
      field,
    );
  }
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = [
    parts[1],
    parts[2],
    parts[3],
    parts[4],
    parts[5],
    parts[6],
    parts[9] ?? "0",
    parts[10] ?? "0",
  ].map(Number);
  const daysInMonth = new Date(Date.UTC(year ?? 0, month ?? 0, 0)).getUTCDate();
  if (
    month === undefined ||
    month < 1 ||
    month > 12 ||
    day === undefined ||
    day < 1 ||
    day > daysInMonth ||
    hour === undefined ||
    hour > 23 ||
    minute === undefined ||
    minute > 59 ||
    second === undefined ||
    second > 59 ||
    offsetHour === undefined ||
    offsetHour > 23 ||
    offsetMinute === undefined ||
    offsetMinute > 59
  ) {
    throw new ConsumptionQueryError(
      "INVALID_TIMESTAMP",
      `${field} must be a valid RFC 3339 timestamp`,
      field,
    );
  }
  return new Date(value.replace("t", "T").replace("z", "Z"));
}

function bucketStart(timestamp: Date, granularity: Granularity): Date {
  const result = new Date(timestamp);
  if (granularity === "hourly") {
    result.setUTCMinutes(0, 0, 0);
  } else if (granularity === "daily") {
    result.setUTCHours(0, 0, 0, 0);
  } else {
    result.setUTCDate(1);
    result.setUTCHours(0, 0, 0, 0);
  }
  return result;
}

/**
 * Validates a history query against the requested granularity's documented
 * lookback and returns the effective complete-bucket range. Buckets floor to
 * their granularity boundary, so an in-progress current bucket is never
 * queryable.
 */
export function validateHistoryQuery(
  query: ProjectReportQuery,
  now: Date,
  allowedMetrics: ReadonlySet<string>,
): EffectiveRange {
  if (!(["hourly", "daily", "monthly"] as unknown[]).includes(query.granularity)) {
    throw new ConsumptionQueryError(
      "INVALID_GRANULARITY",
      "granularity must be hourly, daily, or monthly",
    );
  }
  if (!isNeonId(query.organizationId)) {
    throw new ConsumptionQueryError("INVALID_FILTER", "organization ID is malformed");
  }
  if (query.metrics.length === 0 || query.metrics.some((metric) => !allowedMetrics.has(metric))) {
    throw new ConsumptionQueryError(
      "INVALID_METRIC",
      "metrics must contain one or more metrics supported by this consumption source",
    );
  }
  if (new Set(query.metrics).size !== query.metrics.length) {
    throw new ConsumptionQueryError("DUPLICATE_METRIC", "metrics must not contain duplicate names");
  }
  const from = parseTimestamp(query.from, "from");
  const to = parseTimestamp(query.to, "to");
  if (to.getTime() <= from.getTime()) {
    throw new ConsumptionQueryError("INVALID_RANGE", "to must be after from");
  }
  const effectiveFrom = bucketStart(from, query.granularity);
  const effectiveTo = bucketStart(to, query.granularity);
  const effectiveNow = bucketStart(now, query.granularity);
  if (effectiveTo.getTime() <= effectiveFrom.getTime()) {
    throw new ConsumptionQueryError(
      "INVALID_RANGE",
      "from and to must resolve to different consumption buckets",
    );
  }
  const oldest = new Date(effectiveNow);
  if (query.granularity === "hourly") {
    oldest.setTime(effectiveNow.getTime() - 168 * 60 * 60 * 1000);
  } else if (query.granularity === "daily") {
    oldest.setTime(effectiveNow.getTime() - 60 * 24 * 60 * 60 * 1000);
  } else {
    oldest.setUTCFullYear(oldest.getUTCFullYear() - 1);
  }
  if (
    effectiveFrom.getTime() < oldest.getTime() ||
    effectiveTo.getTime() > effectiveNow.getTime()
  ) {
    throw new ConsumptionQueryError(
      "RANGE_OUTSIDE_GRANULARITY",
      `${query.granularity} history is outside its supported lookback`,
    );
  }
  return {
    from: effectiveFrom.toISOString(),
    to: effectiveTo.toISOString(),
    granularity: query.granularity,
  };
}
