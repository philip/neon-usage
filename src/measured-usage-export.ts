import { NeonUsageError } from "./client-errors.js";
import type { CurrentPeriodSnapshotReport } from "./current-snapshot-service.js";
import { historyContracts } from "./history-contracts.js";
import type { OrganizationConsumptionSummary } from "./history-report.js";
import type { HistoryMetricSelectionMode } from "./internal-history.js";
import {
  MEASURED_USAGE_KIND,
  MEASURED_USAGE_SCHEMA_VERSION,
  type MeasuredBillingUsage,
  MeasuredUsageContractError,
  type MeasuredUsageMetric,
  measuredUsageLimits,
  parseMeasuredBillingUsage,
  type UnresolvedComparisonField,
} from "./measured-usage-contract.js";
import { deriveBillingValue, type KnownMetricName, metricCatalog } from "./metric-catalog.js";
import { baseMetricFormulas, type HistoryProjectMetricName } from "./metric-definitions.js";
import type { PricingEstimate } from "./pricing-estimate.js";

export type {
  ExactRational,
  MeasuredBillingUsage,
  MeasuredPresence,
  MeasuredUsageCoverage,
  MeasuredUsageMetric,
  MeasuredUsageScope,
  MeasuredUsageSource,
  PointInTimeStorage,
  UnresolvedComparisonField,
} from "./measured-usage-contract.js";
export { MEASURED_USAGE_KIND, MEASURED_USAGE_SCHEMA_VERSION } from "./measured-usage-contract.js";

const historyMetricNames = new Set<string>(historyContracts.project.supportedMetrics);

function isKnownMetric(name: string): name is KnownMetricName {
  return Object.hasOwn(metricCatalog, name);
}

function formulasFor(names: readonly string[]): Record<string, string> {
  const formulas = { ...baseMetricFormulas };
  for (const name of names) {
    if (!isKnownMetric(name)) continue;
    const definition = metricCatalog[name];
    formulas[definition.derivedUnit] ??= definition.formula;
  }
  return formulas;
}

function derivedFor(name: string, rawValue: string): MeasuredUsageMetric["derived"] {
  if (!isKnownMetric(name)) return undefined;
  const derived = deriveBillingValue(name, rawValue);
  return {
    exact: derived.exact,
    decimalApproximation: derived.decimalApproximation,
    unit: derived.unit,
  };
}

const UNRESOLVED: UnresolvedComparisonField[] = [
  {
    field: "peakCu",
    reason:
      "Billing usage measures consumption, not the peak compute a comparison needs; supply it separately.",
  },
  {
    field: "avgCu",
    reason:
      "Average compute size is not determinable from billed CU-hours without an active-hours denominator the consumer must choose.",
  },
  {
    field: "activeHours",
    reason:
      "Measured active time is org-scoped and product-blended; a per-workload active-hours assumption must be supplied for comparison.",
  },
];

type BuildInput = {
  /** Opaque version string of the producing neon-usage build. */
  producerVersion: string;
  /** Authoritative billing-aligned aggregate (Launch/Scale and above). */
  history?: OrganizationConsumptionSummary;
  /** Free-compatible current-period snapshot. */
  snapshot?: CurrentPeriodSnapshotReport;
  /** Pricing of the same collected history used for the summary. */
  estimate?: PricingEstimate;
  metricSelectionMode?: HistoryMetricSelectionMode;
  now?: () => Date;
};

/**
 * Projects an authoritative history summary or a Free-plan current snapshot
 * into the public measured-usage contract. Exactly one of `history` or
 * `snapshot` must be supplied.
 */
export function buildMeasuredUsageExport(input: BuildInput): MeasuredBillingUsage {
  if (Boolean(input.history) === Boolean(input.snapshot)) {
    throw new TypeError("buildMeasuredUsageExport requires exactly one of history or snapshot");
  }
  const generatedAt = (input.now?.() ?? new Date()).toISOString();
  return input.history
    ? fromHistory(
        input.history,
        input.producerVersion,
        generatedAt,
        input.estimate,
        input.metricSelectionMode,
      )
    : fromSnapshot(
        input.snapshot as CurrentPeriodSnapshotReport,
        input.producerVersion,
        generatedAt,
      );
}

function fromHistory(
  summary: OrganizationConsumptionSummary,
  producerVersion: string,
  generatedAt: string,
  estimate?: PricingEstimate,
  metricSelectionMode: HistoryMetricSelectionMode = "explicit",
): MeasuredBillingUsage {
  const authoritative = summary.coverage.status === "complete";
  const billableBranchMonthComponents = branchComponents(estimate);
  const warnings: string[] = [];
  if (!authoritative) {
    warnings.push(
      "Coverage is partial; authoritative aggregate metrics are withheld. Do not treat this as an invoice.",
    );
  }
  const requested = [...new Set(summary.query.metrics)]
    .filter((name): name is HistoryProjectMetricName => historyMetricNames.has(name))
    .sort();
  const projectPeriod = {
    from: summary.effectiveRange.from,
    to: summary.effectiveRange.to,
    granularity: summary.effectiveRange.granularity,
  };
  const projects = summary.attribution.projects.map((project) => ({
    projectId: project.projectId,
    period: { ...projectPeriod },
    metrics: sumProjectMetrics(project, requested),
  }));
  const omittedMetrics = [
    ...new Set(
      summary.attribution.projects.flatMap((project) =>
        project.periods.flatMap((period) =>
          period.buckets.flatMap((bucket) =>
            bucket.metrics
              .filter((metric) => !historyMetricNames.has(metric.name))
              .map((metric) => metric.name),
          ),
        ),
      ),
    ),
  ].sort();
  const aggregate: MeasuredUsageMetric[] | null =
    authoritative && summary.metrics
      ? summary.metrics
          .filter((metric) => requested.includes(metric.name as HistoryProjectMetricName))
          .map((metric) => ({
            name: metric.name,
            raw: { value: metric.raw.value, unit: metric.raw.unit },
            derived: {
              exact: metric.derived.exact,
              decimalApproximation: metric.derived.decimalApproximation,
              unit: metric.derived.unit,
            },
            presence: projects.some((project) =>
              project.metrics.some(
                (item) => item.name === metric.name && item.presence === "reported",
              ),
            )
              ? ("reported" as const)
              : ("projected_zero" as const),
          }))
      : null;

  return parseMeasuredBillingUsage({
    kind: MEASURED_USAGE_KIND,
    schemaVersion: MEASURED_USAGE_SCHEMA_VERSION,
    producerVersion,
    generatedAt,
    asOf: summary.asOf,
    period: projectPeriod,
    scope: { kind: "organization_aggregate", organizationId: summary.scope.organizationId },
    source: { contract: "consumption-history-v2", authoritative: true },
    metricSelection: { mode: metricSelectionMode, requested },
    coverage: {
      status: summary.coverage.status,
      authoritative,
      qualityFlags: [
        ...new Set([
          ...summary.coverage.qualityFlags,
          ...(omittedMetrics.length ? ["UNKNOWN_METRIC"] : []),
        ]),
      ],
      omittedMetrics,
    },
    metrics: aggregate,
    projects,
    billableBranchMonthComponents,
    unresolved: UNRESOLVED,
    formulas: formulasFor(requested),
    warnings,
    ...(summary.evidence ? { evidence: summary.evidence } : {}),
  });
}

function sumProjectMetrics(
  project: OrganizationConsumptionSummary["attribution"]["projects"][number],
  requested: string[],
): MeasuredUsageMetric[] {
  const totals = new Map<string, bigint>();
  const reported = new Set<string>();
  for (const period of project.periods) {
    for (const bucket of period.buckets) {
      for (const metric of bucket.metrics) {
        if (!requested.includes(metric.name) || metric.value === null) continue;
        totals.set(metric.name, (totals.get(metric.name) ?? 0n) + BigInt(metric.value));
        if (metric.presence === "reported") reported.add(metric.name);
      }
    }
  }
  return requested.map((name) => {
    const value = (totals.get(name) ?? 0n).toString();
    const derived = derivedFor(name, value);
    return {
      name,
      raw: { value, unit: isKnownMetric(name) ? metricCatalog[name].rawUnit : "unknown" },
      ...(derived ? { derived } : {}),
      presence: reported.has(name) ? ("reported" as const) : ("projected_zero" as const),
    };
  });
}

function unavailableComponents(): MeasuredBillingUsage["billableBranchMonthComponents"] {
  return {
    status: "unavailable",
    reasons: ["Source-period branch pricing components are unavailable"],
    expectedIdentities: [],
    items: [],
  };
}

function branchComponents(
  estimate?: PricingEstimate,
): MeasuredBillingUsage["billableBranchMonthComponents"] {
  const lines: PricingEstimate["lines"] = [];
  for (const line of estimate?.lines ?? []) {
    if (line.metric !== "extra_branches_month") continue;
    // Defend direct projections too; never construct an over-limit public component array.
    if (lines.length >= measuredUsageLimits.collectionEntries)
      throw new NeonUsageError("COLLECTION_LIMIT_REACHED");
    lines.push(line);
  }
  if (!estimate || !lines.length) return unavailableComponents();
  const expectedIdentities = lines.map((line) => ({
    projectId: line.projectId,
    sourcePeriodId: line.billingPeriod.sourcePeriodId,
    allowanceWindow: { ...line.allowanceWindow },
  }));
  const items: MeasuredBillingUsage["billableBranchMonthComponents"]["items"] = [];
  const reasons = new Set<string>();
  for (const line of lines) {
    if (!line.billable) {
      reasons.add("Branch pricing lines are missing billable quantities");
      continue;
    }
    if (line.allowanceApplied && line.allowanceApplied.scope !== "per_project") {
      reasons.add("Branch pricing allowances are not project-scoped");
      continue;
    }
    if (
      line.raw.unit !== "branch_hour" ||
      !["branch_month_before_allowance", "branch_month"].includes(line.billable.unit)
    ) {
      throw new MeasuredUsageContractError(
        "INCONSISTENT_VALUE",
        "Branch pricing units are inconsistent",
      );
    }
    items.push({
      projectId: line.projectId,
      billingPeriod: { ...line.billingPeriod },
      allowanceWindow: { ...line.allowanceWindow },
      raw: { value: line.raw.value, unit: "branch_hour" },
      allowanceApplied: {
        exact: { ...(line.allowanceApplied?.exact ?? { numerator: "0", denominator: "1" }) },
        unit: "branch_hour",
        scope: "per_project",
      },
      billable: { exact: { ...line.billable.exact }, unit: "branch_month" },
      rateCardRevision: estimate.rateCard.revision,
      approximations: [...line.approximations],
      certainty: line.approximations.length ? "approximate" : "exact",
    });
  }
  return {
    status: items.length === lines.length ? "complete" : items.length ? "partial" : "unavailable",
    reasons: [...reasons],
    expectedIdentities,
    items,
  };
}

// Snapshot counters map to the v2 metric names their values are compatible
// with, so a downstream Neon repricer reads one metric vocabulary regardless
// of source. computeTimeSeconds is CU-seconds; dataTransferBytes is public
// transfer bytes. activeTimeSeconds is exported under its own name because it
// is not a billed metric (it is active wall-clock time, not CU-weighted).
function fromSnapshot(
  report: CurrentPeriodSnapshotReport,
  producerVersion: string,
  generatedAt: string,
): MeasuredBillingUsage {
  if (
    report.coverage.projectsRequested !== report.requestedProjectIds.length ||
    report.coverage.projectsReturned !== report.projects.length
  ) {
    throw new MeasuredUsageContractError(
      "INCONSISTENT_VALUE",
      "Snapshot coverage counts differ from requested or returned project IDs",
    );
  }
  const warnings: string[] = [
    "Source is the current-period snapshot: operational telemetry, not billing authoritative. Aggregate metrics are withheld.",
    "Legacy dataStorageByteHours is unreliable and omitted; use pointInTimeStorage (a live logical-size read) for a storage signal.",
  ];
  if (report.coverage.status === "partial") {
    warnings.push("Snapshot coverage is partial; project or storage data may be incomplete.");
  }

  const projects = report.projects.map((project) => {
    const metrics: MeasuredUsageMetric[] = [
      snapshotMetric("compute_unit_seconds", project.metrics.computeTimeSeconds, "cu_second"),
      snapshotMetric("public_network_transfer_bytes", project.metrics.dataTransferBytes, "byte"),
      snapshotMetric("active_time_seconds", project.metrics.activeTimeSeconds, "second"),
      snapshotMetric("written_data_bytes", project.metrics.writtenDataBytes, "byte"),
    ];
    return {
      projectId: project.projectId,
      period: { from: project.period.start, to: project.period.end },
      metrics,
    };
  });

  const projectsById = new Map(report.projects.map((project) => [project.projectId, project]));
  const storageProjects = report.requestedProjectIds.map((projectId) => {
    const storage = projectsById.get(projectId)?.branchStorage;
    return {
      projectId,
      totalLogicalSizeBytes: storage?.status === "available" ? storage.totalLogicalSizeBytes : null,
    };
  });
  const pointInTimeComplete =
    report.coverage.status === "complete" &&
    storageProjects.every((project) => project.totalLogicalSizeBytes !== null);
  const pointInTimeTotal = pointInTimeComplete
    ? storageProjects
        .reduce((sum, project) => sum + BigInt(project.totalLogicalSizeBytes ?? "0"), 0n)
        .toString()
    : null;

  const returnedProjectIds = report.projects.map((project) => project.projectId).sort();
  const returned = new Set(returnedProjectIds);
  const missingProjectIds = report.requestedProjectIds.filter(
    (projectId) => !returned.has(projectId),
  );
  const period = projects.reduce(
    (envelope, project) => ({
      from:
        Date.parse(project.period.from) < Date.parse(envelope.from)
          ? project.period.from
          : envelope.from,
      to: Date.parse(project.period.to) > Date.parse(envelope.to) ? project.period.to : envelope.to,
    }),
    projects[0]?.period ?? { from: generatedAt, to: generatedAt },
  );

  return parseMeasuredBillingUsage({
    kind: MEASURED_USAGE_KIND,
    schemaVersion: MEASURED_USAGE_SCHEMA_VERSION,
    producerVersion,
    generatedAt,
    asOf: report.generatedAt,
    period,
    scope: {
      kind: "projects",
      organizationId: report.organizationId,
      projectIds: report.requestedProjectIds,
    },
    source: { contract: "current-period-snapshot", authoritative: false },
    metricSelection: {
      mode: "snapshot",
      requested: [
        "active_time_seconds",
        "compute_unit_seconds",
        "public_network_transfer_bytes",
        "written_data_bytes",
      ],
    },
    coverage: {
      status: report.coverage.status,
      authoritative: false,
      qualityFlags: [],
      omittedMetrics: [],
      requestedProjectIds: report.requestedProjectIds,
      returnedProjectIds,
      missingProjectIds,
      errors: report.coverage.errors,
    },
    metrics: null,
    projects,
    billableBranchMonthComponents: unavailableComponents(),
    pointInTimeStorage: {
      totalLogicalSizeBytes: pointInTimeTotal,
      complete: pointInTimeComplete,
      projects: storageProjects,
    },
    unresolved: UNRESOLVED,
    formulas: formulasFor(
      projects.flatMap((project) => project.metrics.map((metric) => metric.name)),
    ),
    warnings,
    ...(report.evidence ? { evidence: report.evidence } : {}),
  });
}

function snapshotMetric(name: string, value: string, unit: string): MeasuredUsageMetric {
  const derived = derivedFor(name, value);
  return {
    name,
    raw: { value, unit },
    ...(derived ? { derived } : {}),
    // Snapshot counters are always populated by the source (zero is a real
    // reading, not an omitted row), so they are reported, never projected.
    presence: "reported",
  };
}
