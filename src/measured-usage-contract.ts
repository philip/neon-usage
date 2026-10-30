import { Decimal } from "decimal.js";
import { z } from "zod";
import { deriveBillingValue } from "./metric-catalog.js";
import {
  baseMetricFormulas,
  type HistoryProjectMetricName,
  type KnownMetricName,
  metricDefinitions,
  type SnapshotProjectMetricName,
  usageQuantityPattern,
} from "./metric-definitions.js";

export const MEASURED_USAGE_KIND = "measured_billing_usage" as const;
export const MEASURED_USAGE_SCHEMA_VERSION = 2 as const;

// Shared with SDK limits; collection entries also cover pricing identities and evidence.
export const measuredUsageLimits = Object.freeze({
  projects: 10_000,
  metrics: Object.keys(metricDefinitions).length,
  collectionEntries: 100_000,
  metadataEntries: 1000,
  timestampLength: 64,
});
const maxDocumentEntries =
  2 *
  (measuredUsageLimits.projects * (measuredUsageLimits.metrics + 1) +
    measuredUsageLimits.metrics +
    3 * measuredUsageLimits.collectionEntries);

export type MeasuredUsageContractErrorCode =
  | "INVALID_SHAPE"
  | "UNSUPPORTED_KIND"
  | "UNSUPPORTED_VERSION"
  | "INCONSISTENT_VALUE";

export class MeasuredUsageContractError extends Error {
  constructor(
    public readonly code: MeasuredUsageContractErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MeasuredUsageContractError";
  }
}

const identifier = z.string().min(1).max(256);
const text = z.string().min(1).max(4096);
const integer = z.string().max(128).regex(usageQuantityPattern);
const positiveInteger = integer.refine((value) => value !== "0");
const timestamp = z.iso
  .datetime({ offset: true })
  .max(measuredUsageLimits.timestampLength)
  .refine((value) => !/\.\d{4}/.test(value), {
    error: "Timestamps support at most millisecond precision",
  });
const decimal = z
  .string()
  .max(256)
  .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d{1,3})?$/i)
  .refine((value) => Math.abs(Number(value.split(/e/i)[1] ?? 0)) <= 256);
const rational = z.object({ numerator: integer, denominator: positiveInteger });
const period = z.object({
  from: timestamp,
  to: timestamp,
  granularity: z.enum(["hourly", "daily", "monthly"]).optional(),
});
const window = z.object({ start: timestamp, end: timestamp });
const ids = z.array(identifier).max(measuredUsageLimits.projects);
const metric = z.object({
  name: identifier,
  raw: z.object({ value: integer, unit: identifier }),
  derived: z
    .object({ exact: rational, decimalApproximation: decimal, unit: identifier })
    .optional(),
  presence: z.enum(["reported", "projected_zero"]),
});
const baseCoverage = z.object({
  status: z.enum(["complete", "partial"]),
  authoritative: z.boolean(),
  qualityFlags: z.array(identifier).max(measuredUsageLimits.metadataEntries),
  omittedMetrics: z.array(identifier).max(measuredUsageLimits.metadataEntries),
});
const snapshotError = z.object({
  projectId: identifier.nullable(),
  source: z.enum(["project_list", "project_snapshot", "branch_sizes"]),
  message: text,
  detail: z
    .object({
      code: identifier,
      message: text,
      status: z.number().int().min(100).max(599).optional(),
      requestId: identifier.optional(),
      attempts: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
      retryable: z.boolean().optional(),
      retryAfterMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    })
    .optional(),
});
const snapshotCoverage = baseCoverage.extend({
  requestedProjectIds: ids,
  returnedProjectIds: ids,
  missingProjectIds: ids,
  errors: z.array(snapshotError).max(measuredUsageLimits.projects),
});
const componentIdentity = z.object({
  projectId: identifier,
  sourcePeriodId: identifier,
  allowanceWindow: window,
});
const component = z.object({
  projectId: identifier,
  billingPeriod: z.object({
    sourcePeriodId: identifier,
    plan: identifier,
    start: timestamp,
    end: timestamp.optional(),
  }),
  allowanceWindow: window,
  raw: z.object({ value: integer, unit: z.literal("branch_hour") }),
  allowanceApplied: z.object({
    exact: rational,
    unit: z.literal("branch_hour"),
    scope: z.literal("per_project"),
  }),
  billable: z.object({ exact: rational, unit: z.literal("branch_month") }),
  rateCardRevision: identifier,
  approximations: z.array(identifier).max(measuredUsageLimits.metadataEntries),
  certainty: z.enum(["exact", "approximate"]),
});
const components = z.object({
  status: z.enum(["complete", "partial", "unavailable"]),
  reasons: z.array(text).max(measuredUsageLimits.metadataEntries),
  expectedIdentities: z.array(componentIdentity).max(measuredUsageLimits.collectionEntries),
  items: z.array(component).max(measuredUsageLimits.collectionEntries),
});
const storage = z.object({
  totalLogicalSizeBytes: integer.nullable(),
  complete: z.boolean(),
  projects: z
    .array(z.object({ projectId: identifier, totalLogicalSizeBytes: integer.nullable() }))
    .max(measuredUsageLimits.projects),
});
const scope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("organization_aggregate"), organizationId: identifier }),
  z.object({ kind: z.literal("projects"), organizationId: identifier, projectIds: ids }),
]);
const source = z.discriminatedUnion("contract", [
  z.object({ contract: z.literal("consumption-history-v2"), authoritative: z.literal(true) }),
  z.object({ contract: z.literal("current-period-snapshot"), authoritative: z.literal(false) }),
]);
const unresolved = z.object({ field: z.enum(["peakCu", "avgCu", "activeHours"]), reason: text });
const schema = z
  .object({
    kind: z.literal(MEASURED_USAGE_KIND),
    schemaVersion: z.literal(MEASURED_USAGE_SCHEMA_VERSION),
    producerVersion: identifier,
    generatedAt: timestamp,
    asOf: timestamp,
    period,
    scope,
    source,
    metricSelection: z.object({
      mode: z.enum(["default", "explicit", "snapshot"]),
      requested: z.array(identifier).max(measuredUsageLimits.metrics),
    }),
    coverage: z.union([snapshotCoverage, baseCoverage]),
    metrics: z.array(metric).max(measuredUsageLimits.metrics).nullable(),
    projects: z
      .array(
        z.object({
          projectId: identifier,
          period,
          metrics: z.array(metric).max(measuredUsageLimits.metrics),
        }),
      )
      .max(measuredUsageLimits.projects),
    billableBranchMonthComponents: components,
    pointInTimeStorage: storage.optional(),
    unresolved: z.array(unresolved).max(3),
    formulas: z
      .record(identifier, text)
      .refine((value) => Object.keys(value).length <= measuredUsageLimits.metadataEntries),
    warnings: z.array(text).max(measuredUsageLimits.metadataEntries),
    evidence: z
      .array(z.object({ evidenceId: identifier, payloadHash: identifier }))
      .max(measuredUsageLimits.collectionEntries)
      .optional(),
  })
  .refine(
    (value) =>
      value.source.contract !== "current-period-snapshot" ||
      "requestedProjectIds" in value.coverage,
    {
      error: "Snapshot coverage requires bounded requested, returned, missing IDs and errors",
    },
  )
  .refine(
    (value) =>
      value.source.contract !== "consumption-history-v2" || value.period.granularity !== undefined,
    { error: "History requires billing granularity" },
  )
  .refine(
    (value) =>
      value.source.contract !== "current-period-snapshot" || value.pointInTimeStorage !== undefined,
    { error: "Snapshots require point-in-time storage coverage" },
  );

export type ExactRational = z.infer<typeof rational>;
export type MeasuredPresence = z.infer<typeof metric>["presence"];
export type MeasuredUsageMetric = z.infer<typeof metric>;
export type MeasuredUsageSource = z.infer<typeof source>;
export type MeasuredUsageScope = z.infer<typeof scope>;
export type MeasuredUsageCoverage = z.infer<typeof schema>["coverage"];
export type MeasuredSnapshotCoverage = z.infer<typeof snapshotCoverage>;
export type PointInTimeStorage = z.infer<typeof storage>;
export type UnresolvedComparisonField = z.infer<typeof unresolved>;
export type BillableBranchMonthComponent = z.infer<typeof component>;
export type BillableBranchMonthComponentIdentity = z.infer<typeof componentIdentity>;
export type BillableBranchMonthComponents =
  | (z.infer<typeof components> & { status: "complete" })
  | (z.infer<typeof components> & { status: "partial" })
  | (z.infer<typeof components> & { status: "unavailable" });
export type MeasuredUsageMetricSelection =
  | { mode: "default" | "explicit"; requested: HistoryProjectMetricName[] }
  | { mode: "snapshot"; requested: SnapshotProjectMetricName[] };
export type MeasuredBillingUsage = Omit<
  z.infer<typeof schema>,
  "metricSelection" | "billableBranchMonthComponents"
> & {
  metricSelection: MeasuredUsageMetricSelection;
  billableBranchMonthComponents: BillableBranchMonthComponents;
};

function consistent(condition: unknown, message: string): asserts condition {
  if (!condition) throw new MeasuredUsageContractError("INCONSISTENT_VALUE", message);
}

function unique(values: string[], label: string) {
  consistent(new Set(values).size === values.length, `${label} must be duplicate-free`);
}

function sorted(values: string[], label: string) {
  unique(values, label);
  consistent(
    values.every((value, index) => index === 0 || (values[index - 1] as string) < value),
    `${label} must be sorted`,
  );
}

function sameSet(left: string[], right: string[]) {
  const expected = new Set(right);
  return left.length === expected.size && left.every((value) => expected.has(value));
}

function validPeriod(value: { from: string; to: string }) {
  consistent(Date.parse(value.from) <= Date.parse(value.to), "Period endpoints are reversed");
}

function samePeriod(left: z.infer<typeof period>, right: z.infer<typeof period>) {
  return left.from === right.from && left.to === right.to && left.granularity === right.granularity;
}

function identityKey(value: BillableBranchMonthComponentIdentity) {
  return JSON.stringify([
    value.projectId,
    value.sourcePeriodId,
    Date.parse(value.allowanceWindow.start),
    Date.parse(value.allowanceWindow.end),
  ]);
}

function fractionEqual(left: ExactRational, right: ExactRational) {
  return (
    BigInt(left.numerator) * BigInt(right.denominator) ===
    BigInt(right.numerator) * BigInt(left.denominator)
  );
}

function validateMetrics(metrics: MeasuredUsageMetric[], value: MeasuredBillingUsage) {
  unique(
    metrics.map((item) => item.name),
    "Metric names",
  );
  const requested = new Set<string>(value.metricSelection.requested);
  consistent(
    sameSet(
      metrics.map((item) => item.name),
      [...requested],
    ),
    "Metrics must match the selected metric set",
  );
  for (const item of metrics) {
    consistent(
      Object.hasOwn(metricDefinitions, item.name),
      `Unknown normalized metric: ${item.name}`,
    );
    const definition = metricDefinitions[item.name as KnownMetricName];
    consistent(item.raw.unit === definition.rawUnit, `Wrong raw unit for ${item.name}`);
    consistent(
      item.presence !== "projected_zero" || item.raw.value === "0",
      "Projected zeros must be zero",
    );
    consistent(item.derived, `Missing conversion for ${item.name}`);
    const expected = deriveBillingValue(item.name, item.raw.value);
    consistent(
      item.derived.unit === expected.unit && fractionEqual(item.derived.exact, expected.exact),
      `Wrong conversion for ${item.name}`,
    );
    consistent(
      new Decimal(item.derived.decimalApproximation).equals(expected.decimalApproximation),
      `Wrong decimal approximation for ${item.name}`,
    );
    const formula = baseMetricFormulas[definition.derivedUnit] ?? definition.formula;
    consistent(
      value.formulas[definition.derivedUnit] === formula,
      `Wrong formula for ${item.name}`,
    );
  }
}

function validateComponents(value: MeasuredBillingUsage) {
  const { status, reasons, items, expectedIdentities } = value.billableBranchMonthComponents;
  const projects = new Map(value.projects.map((project) => [project.projectId, project]));
  const expectedKeys = expectedIdentities.map(identityKey);
  unique(expectedKeys, "Expected component identities");
  const keys = items.map((item) =>
    identityKey({ ...item, sourcePeriodId: item.billingPeriod.sourcePeriodId }),
  );
  unique(keys, "Component identities");
  const expectedSet = new Set(expectedKeys);
  consistent(
    keys.every((key) => expectedSet.has(key)),
    "Component identity was not expected",
  );
  consistent(
    status === "complete"
      ? reasons.length === 0 && sameSet(keys, expectedKeys)
      : reasons.length > 0 &&
          (status === "partial"
            ? items.length > 0 && items.length < expectedKeys.length
            : items.length === 0),
    "Component status disagrees with identity coverage",
  );
  const rawSums = new Map<string, bigint>();
  consistent(
    expectedIdentities.length === 0 ||
      value.metricSelection.requested.some((name) => name === "extra_branches_month"),
    "Branch components require the selected branch metric",
  );
  for (const expected of expectedIdentities) {
    consistent(projects.has(expected.projectId), "Expected component project is absent");
    validateAllowanceWindow(expected.allowanceWindow);
    consistent(
      Date.parse(expected.allowanceWindow.start) < Date.parse(value.period.to) &&
        Date.parse(expected.allowanceWindow.end) > Date.parse(value.period.from),
      "Expected component window falls outside measured period",
    );
  }
  for (const item of items) {
    consistent(projects.has(item.projectId), "Component project is absent");
    consistent(
      value.source.contract === "consumption-history-v2",
      "Snapshots cannot carry branch billing components",
    );
    validateAllowanceWindow(item.allowanceWindow);
    const start = Date.parse(item.billingPeriod.start);
    const end = item.billingPeriod.end ? Date.parse(item.billingPeriod.end) : Infinity;
    consistent(start <= end, "Component source period is reversed");
    consistent(
      start < Date.parse(item.allowanceWindow.end) && end > Date.parse(item.allowanceWindow.start),
      "Component source period and allowance window do not overlap",
    );
    consistent(
      start < Date.parse(value.period.to) &&
        end > Date.parse(value.period.from) &&
        Date.parse(item.allowanceWindow.start) < Date.parse(value.period.to) &&
        Date.parse(item.allowanceWindow.end) > Date.parse(value.period.from),
      "Component falls outside measured period",
    );
    unique(item.approximations, "Component approximation flags");
    consistent(
      item.certainty === (item.approximations.length ? "approximate" : "exact"),
      "Component certainty loses approximation flags",
    );
    const raw = BigInt(item.raw.value);
    const applied = BigInt(item.allowanceApplied.exact.numerator);
    const divisor = BigInt(item.allowanceApplied.exact.denominator);
    consistent(applied <= raw * divisor, "Allowance exceeds raw branch hours");
    consistent(
      (raw * divisor - applied) * BigInt(item.billable.exact.denominator) ===
        BigInt(item.billable.exact.numerator) * divisor * 744n,
      "Billable branch-month arithmetic is inconsistent",
    );
    rawSums.set(item.projectId, (rawSums.get(item.projectId) ?? 0n) + raw);
  }
  if (status !== "unavailable") {
    for (const project of value.projects) {
      const raw = project.metrics.find((item) => item.name === "extra_branches_month")?.raw.value;
      const measuredRaw = BigInt(raw ?? "0");
      const componentRaw = rawSums.get(project.projectId) ?? 0n;
      consistent(
        status === "complete" ? componentRaw === measuredRaw : componentRaw <= measuredRaw,
        "Component raw sum exceeds or disagrees with project branch hours",
      );
    }
  }
}

function validateAllowanceWindow(value: z.infer<typeof window>) {
  const start = new Date(value.start);
  const end = new Date(value.end);
  const next = new Date(start);
  next.setUTCMonth(next.getUTCMonth() + 1);
  consistent(
    start.getUTCDate() === 1 &&
      start.getUTCHours() === 0 &&
      start.getUTCMinutes() === 0 &&
      start.getUTCSeconds() === 0 &&
      start.getUTCMilliseconds() === 0 &&
      end.getTime() === next.getTime(),
    "Allowance window must be one UTC calendar month",
  );
}

function validateSnapshot(value: MeasuredBillingUsage) {
  consistent(value.scope.kind === "projects", "Snapshots require project scope");
  const coverage = snapshotCoverage.safeParse(value.coverage);
  if (!coverage.success)
    throw new MeasuredUsageContractError(
      "INVALID_SHAPE",
      "Snapshot coverage requires requested, returned, missing IDs and errors",
    );
  const { requestedProjectIds, returnedProjectIds, missingProjectIds, errors } = coverage.data;
  for (const list of [
    value.scope.projectIds,
    requestedProjectIds,
    returnedProjectIds,
    missingProjectIds,
  ])
    sorted(list, "Snapshot project IDs");
  consistent(
    sameSet(requestedProjectIds, value.scope.projectIds),
    "Requested IDs differ from scope",
  );
  consistent(
    sameSet(
      returnedProjectIds,
      value.projects.map((project) => project.projectId),
    ),
    "Returned IDs differ from projects",
  );
  const returned = new Set(returnedProjectIds);
  const requested = new Set(requestedProjectIds);
  consistent(
    returnedProjectIds.every((id) => requested.has(id)),
    "Returned project is outside requested scope",
  );
  consistent(
    sameSet(
      missingProjectIds,
      requestedProjectIds.filter((id) => !returned.has(id)),
    ),
    "Missing IDs are inconsistent",
  );
  consistent(
    value.coverage.status !== "complete" || (missingProjectIds.length === 0 && errors.length === 0),
    "Complete snapshot has missing projects or errors",
  );
  consistent(
    errors.every((error) => error.projectId === null || requested.has(error.projectId)),
    "Snapshot error project is outside scope",
  );
  const first = value.projects[0];
  const envelope = value.projects.reduce(
    (result, project) => ({
      from:
        Date.parse(project.period.from) < Date.parse(result.from)
          ? project.period.from
          : result.from,
      to: Date.parse(project.period.to) > Date.parse(result.to) ? project.period.to : result.to,
    }),
    first?.period ?? { from: value.generatedAt, to: value.generatedAt },
  );
  consistent(
    value.period.from === envelope.from && value.period.to === envelope.to,
    "Snapshot period is not the exact project envelope",
  );
  const storage = value.pointInTimeStorage;
  if (storage) {
    unique(
      storage.projects.map((project) => project.projectId),
      "Storage project IDs",
    );
    consistent(
      sameSet(
        storage.projects.map((project) => project.projectId),
        requestedProjectIds,
      ),
      "Storage must cover every requested project",
    );
    consistent(
      storage.projects.every(
        (project) => returned.has(project.projectId) || project.totalLogicalSizeBytes === null,
      ),
      "Missing project has storage",
    );
    const complete =
      value.coverage.status === "complete" &&
      storage.projects.every((project) => project.totalLogicalSizeBytes !== null);
    consistent(storage.complete === complete, "Storage completeness is inconsistent");
    const total = complete
      ? storage.projects
          .reduce((sum, project) => sum + BigInt(project.totalLogicalSizeBytes as string), 0n)
          .toString()
      : null;
    consistent(storage.totalLogicalSizeBytes === total, "Storage total is inconsistent");
  }
}

function invalidShape(): never {
  throw new MeasuredUsageContractError(
    "INVALID_SHAPE",
    "Invalid or oversized measured usage document",
  );
}

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function fields(
  value: unknown,
  keys: readonly string[],
  replacements: Record<string, unknown> = {},
): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const copy: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.hasOwn(replacements, key)) copy[key] = replacements[key];
    else if (Object.hasOwn(value, key)) copy[key] = field(value, key);
  }
  return copy;
}

/** Capture only schema-owned containers so getters cannot swap in larger arrays during parsing. */
function boundedInput(input: unknown): unknown {
  let entries = 0;
  const reserve = (count: number) => {
    entries += count;
    if (entries > maxDocumentEntries) invalidShape();
  };
  const array = (value: unknown, maximum: number, visit?: (item: unknown) => unknown): unknown => {
    if (!Array.isArray(value)) return value;
    const length = value.length;
    if (length > maximum) invalidShape();
    reserve(length);
    const copy = new Array<unknown>(length);
    for (let index = 0; index < length; index++) {
      if (!Object.hasOwn(value, index)) invalidShape();
      const item: unknown = value[index];
      copy[index] = visit ? visit(item) : item;
    }
    return copy;
  };
  const limits = measuredUsageLimits;
  const projects = array(field(input, "projects"), limits.projects, (project) =>
    fields(project, ["projectId", "period", "metrics"], {
      metrics: array(field(project, "metrics"), limits.metrics),
    }),
  );
  const componentInput = field(input, "billableBranchMonthComponents");
  const componentValue = fields(
    componentInput,
    ["status", "reasons", "expectedIdentities", "items"],
    {
      reasons: array(field(componentInput, "reasons"), limits.metadataEntries),
      expectedIdentities: array(
        field(componentInput, "expectedIdentities"),
        limits.collectionEntries,
      ),
      items: array(field(componentInput, "items"), limits.collectionEntries, (item) =>
        fields(
          item,
          [
            "projectId",
            "billingPeriod",
            "allowanceWindow",
            "raw",
            "allowanceApplied",
            "billable",
            "rateCardRevision",
            "approximations",
            "certainty",
          ],
          {
            approximations: array(field(item, "approximations"), limits.metadataEntries),
          },
        ),
      ),
    },
  );
  const sourceValue = fields(field(input, "source"), ["contract", "authoritative"]);
  const coverageInput = field(input, "coverage");
  const coverageArrays: Record<string, unknown> = {
    qualityFlags: array(field(coverageInput, "qualityFlags"), limits.metadataEntries),
    omittedMetrics: array(field(coverageInput, "omittedMetrics"), limits.metadataEntries),
  };
  if (field(sourceValue, "contract") === "current-period-snapshot") {
    for (const key of ["requestedProjectIds", "returnedProjectIds", "missingProjectIds", "errors"])
      coverageArrays[key] = array(field(coverageInput, key), limits.projects);
  }
  const scopeInput = field(input, "scope");
  const scopeValue = fields(
    scopeInput,
    ["kind", "organizationId", "projectIds"],
    field(scopeInput, "kind") === "projects"
      ? { projectIds: array(field(scopeInput, "projectIds"), limits.projects) }
      : { projectIds: undefined },
  );
  const selectionInput = field(input, "metricSelection");
  const storageInput = field(input, "pointInTimeStorage");
  const formulaInput = field(input, "formulas");
  let formulaValue = formulaInput;
  if (formulaInput !== null && typeof formulaInput === "object" && !Array.isArray(formulaInput)) {
    const copy: Record<string, unknown> = Object.create(null);
    const keys: string[] = [];
    let scanned = 0;
    for (const key in formulaInput) {
      if (++scanned > limits.metadataEntries) invalidShape();
      if (!Object.hasOwn(formulaInput, key)) continue;
      keys.push(key);
    }
    reserve(keys.length);
    for (const key of keys) copy[key] = field(formulaInput, key);
    formulaValue = copy;
  }
  return fields(
    input,
    [
      "kind",
      "schemaVersion",
      "producerVersion",
      "generatedAt",
      "asOf",
      "period",
      "scope",
      "source",
      "metricSelection",
      "coverage",
      "metrics",
      "projects",
      "billableBranchMonthComponents",
      "pointInTimeStorage",
      "unresolved",
      "formulas",
      "warnings",
      "evidence",
    ],
    {
      projects,
      metrics: array(field(input, "metrics"), limits.metrics),
      billableBranchMonthComponents: componentValue,
      source: sourceValue,
      coverage: fields(
        coverageInput,
        ["status", "authoritative", ...Object.keys(coverageArrays)],
        coverageArrays,
      ),
      scope: scopeValue,
      metricSelection: fields(selectionInput, ["mode", "requested"], {
        requested: array(field(selectionInput, "requested"), limits.metrics),
      }),
      pointInTimeStorage: fields(storageInput, ["totalLogicalSizeBytes", "complete", "projects"], {
        projects: array(field(storageInput, "projects"), limits.projects),
      }),
      unresolved: array(field(input, "unresolved"), 3),
      formulas: formulaValue,
      warnings: array(field(input, "warnings"), limits.metadataEntries),
      evidence: array(field(input, "evidence"), limits.collectionEntries),
    },
  );
}

/** Bounds the entire shape before cloning or allocating exact numeric representations. */
export function parseMeasuredBillingUsage(input: unknown): MeasuredBillingUsage {
  try {
    return parseBoundedMeasuredUsage(input);
  } catch (error) {
    let contractError = false;
    try {
      contractError = error instanceof MeasuredUsageContractError;
    } catch {
      /* A thrown value can itself be a revoked proxy. */
    }
    if (contractError) throw error;
    return invalidShape();
  }
}

function parseBoundedMeasuredUsage(input: unknown): MeasuredBillingUsage {
  if (input !== null && typeof input === "object") {
    if (Object.hasOwn(input, "kind") && (input as { kind: unknown }).kind !== MEASURED_USAGE_KIND) {
      throw new MeasuredUsageContractError("UNSUPPORTED_KIND", "Unsupported measured usage kind");
    }
    if (
      Object.hasOwn(input, "schemaVersion") &&
      (input as { schemaVersion: unknown }).schemaVersion !== MEASURED_USAGE_SCHEMA_VERSION
    ) {
      throw new MeasuredUsageContractError(
        "UNSUPPORTED_VERSION",
        "Unsupported measured usage schema version",
      );
    }
  }
  const parsed = schema.safeParse(boundedInput(input));
  if (!parsed.success)
    throw new MeasuredUsageContractError(
      "INVALID_SHAPE",
      "Invalid or oversized measured usage document",
    );
  const value = parsed.data as MeasuredBillingUsage;
  validPeriod(value.period);
  unique(
    value.projects.map((project) => project.projectId),
    "Project IDs",
  );
  sorted(value.coverage.omittedMetrics, "Omitted metrics");
  unique(value.coverage.qualityFlags, "Quality flags");
  consistent(
    value.coverage.qualityFlags.includes("UNKNOWN_METRIC") ===
      value.coverage.omittedMetrics.length > 0,
    "Unknown metric flag differs from omitted metrics",
  );
  sorted(value.metricSelection.requested, "Metric selection");
  const history = value.source.contract === "consumption-history-v2";
  consistent(
    history ? value.metricSelection.mode !== "snapshot" : value.metricSelection.mode === "snapshot",
    "Metric selection mode differs from source",
  );
  const endpoint = history ? "history_project" : "snapshot_project";
  for (const name of value.metricSelection.requested) {
    consistent(
      Object.hasOwn(metricDefinitions, name) &&
        metricDefinitions[name].endpoints.some((supported) => supported === endpoint),
      "Metric selection is unsupported by source endpoint",
    );
  }
  consistent(
    value.coverage.authoritative === (history && value.coverage.status === "complete"),
    "Coverage authority differs from source and completeness",
  );
  consistent(
    !history ||
      value.coverage.status !== "complete" ||
      !value.coverage.qualityFlags.some((flag) =>
        [
          "CURSOR_REPEATED",
          "EMPTY_PAGE_WITH_CURSOR",
          "SOURCE_REQUEST_FAILED",
          "ENTITY_DUPLICATED",
          "PAGE_LIMIT_REACHED",
          "TIME_LIMIT_REACHED",
          "ITEM_LIMIT_REACHED",
          "FACT_LIMIT_REACHED",
          "BYTE_LIMIT_REACHED",
        ].includes(flag),
      ),
    "Complete history carries a collection failure flag",
  );
  consistent(
    value.coverage.authoritative ? value.metrics !== null : value.metrics === null,
    "Aggregate metrics disagree with authority",
  );
  for (const [key, formula] of Object.entries(baseMetricFormulas))
    consistent(value.formulas[key] === formula, `Missing or wrong base formula ${key}`);
  unique(
    value.unresolved.map((field) => field.field),
    "Unresolved inputs",
  );
  consistent(value.unresolved.length === 3, "All comparison sizing inputs must stay unresolved");
  for (const project of value.projects) {
    validPeriod(project.period);
    if (history)
      consistent(
        samePeriod(project.period, value.period),
        "History project period differs from query period",
      );
    validateMetrics(project.metrics, value);
  }
  if (value.metrics) {
    validateMetrics(value.metrics, value);
    for (const item of value.metrics) {
      const contributions = value.projects.map(
        (project) =>
          project.metrics.find((metric) => metric.name === item.name) as MeasuredUsageMetric,
      );
      const total = contributions.reduce((sum, metric) => sum + BigInt(metric.raw.value), 0n);
      consistent(BigInt(item.raw.value) === total, "Aggregate raw value differs from project sum");
      consistent(
        item.presence ===
          (contributions.some((metric) => metric.presence === "reported")
            ? "reported"
            : "projected_zero"),
        "Aggregate presence differs from project contributions",
      );
    }
  }
  if (history) {
    consistent(
      value.scope.kind === "organization_aggregate",
      "History requires organization scope",
    );
    consistent(value.pointInTimeStorage === undefined, "History cannot carry snapshot storage");
  } else validateSnapshot(value);
  validateComponents(value);
  return value;
}
