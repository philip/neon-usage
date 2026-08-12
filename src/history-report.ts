import { compareCanonicalText } from "./canonical-order.js";
import {
  type BranchReportQuery,
  ConsumptionQueryError,
  type EffectiveRange,
  isNeonId,
  type ProjectReportQuery,
  validateHistoryQuery,
} from "./consumption-query.js";
import type {
  BranchConsumptionPage,
  BranchConsumptionSource,
  EvidenceRef,
  ProjectConsumptionPage,
  ProjectConsumptionSource,
  SourcePeriod,
} from "./consumption-source.js";
import { ConsumptionSourceIntegrityError, type SourceErrorDetail } from "./errors.js";
import type { EvidenceFactStore } from "./evidence-fact-store.js";
import type { ObservationScopeIdentity } from "./fact-identity.js";
import {
  type CollectionCheckpoint,
  type CollectionRunId,
  type CollectionRunIdFactory,
  collectHistoryPages,
  type HistoryBudget,
} from "./history-collection.js";
import { type HistoryContract, historyContracts } from "./history-contracts.js";
import { canonicalFactsFromPeriods } from "./history-facts.js";
import { type ProjectedHistoryPeriod, projectHistoryPeriods } from "./history-projection.js";
import { deriveBillingValue, type RawUnit, rawUnits } from "./metric-catalog.js";
import type { OperationContext } from "./operation-context.js";
import {
  assertMetricEvidenceLinkedToPage,
  assertValidPeriodFacts,
  canonicalEvidenceReferences,
  isIntegrityFailure,
} from "./report-support.js";
import {
  mergePeriods,
  planStoredServing,
  replayStoredProjects,
  type StoreServingOptions,
} from "./stored-history.js";

const projectHistoryContract = historyContracts.project;
const branchHistoryContract = historyContracts.branch;
const projectMetricNames = new Set<string>(projectHistoryContract.metrics);
const branchMetricNames = new Set<string>(branchHistoryContract.metrics);

export type HistoryServiceOptions<Page> = {
  now?: () => Date;
  maxPages?: number;
  maxDurationMs?: number;
  maxItems?: number;
  maxFacts?: number;
  maxBytes?: number;
  budget?: HistoryBudget;
  createRunId?: CollectionRunIdFactory;
  factStore?: EvidenceFactStore;
  /**
   * Opaque identity of the credential account facts are collected under,
   * for example a hash of the API key. Required with factStore: resume
   * equality must distinguish credentials, so there is no fallback.
   */
  sourceAccount?: string;
  resumeRunId?: CollectionRunId;
  onPage?(page: Page, checkpoint: CollectionCheckpoint, context?: OperationContext): Promise<void>;
  /**
   * Serve already-collected buckets from the fact store and collect only
   * the uncovered remainder plus the re-observation tail. Requires
   * factStore and sourceAccount; ignored under explicit run control.
   */
  storeServing?: StoreServingOptions;
};

export type HistoryQualityFlag =
  | "BETA_SOURCE"
  | "BRANCH_HISTORY_COVERAGE_UNVERIFIED"
  | "CURSOR_REPEATED"
  | "EMPTY_PAGE_WITH_CURSOR"
  | "SOURCE_REQUEST_FAILED"
  | "ENTITY_DUPLICATED"
  | "PAGE_LIMIT_REACHED"
  | "TIME_LIMIT_REACHED"
  | "ITEM_LIMIT_REACHED"
  | "FACT_LIMIT_REACHED"
  | "BYTE_LIMIT_REACHED"
  | "SOURCE_ZERO_OMITTED"
  | "SOURCE_METRIC_UNKNOWN";

export type HistoryCoverage = {
  status: "complete" | "partial";
  pageCount: number;
  /** Distinct entities observed after deduplication (projects or branches). */
  entityCount: number;
  qualityFlags: HistoryQualityFlag[];
  /** Provider request IDs of the collected pages, in page order. */
  requestIds?: string[];
  errors?: string[];
  errorDetails?: SourceErrorDetail[];
};

export type ProjectConsumptionResult = {
  projectId: string;
  periods: ProjectedHistoryPeriod[];
};

export type BranchConsumptionResult = ProjectConsumptionResult & {
  branchId: string;
};

export type ProjectConsumptionReport = {
  schemaVersion: 1;
  /** When this report was produced. */
  generatedAt: string;
  /** End of the last complete requested bucket the data can reflect. */
  asOf: string;
  coverage: HistoryCoverage;
  query: ProjectReportQuery;
  effectiveRange: EffectiveRange;
  evidence?: EvidenceRef[];
  /** Present when leading buckets came from the local store instead of a
   * fresh collection; collectedAt is when they were originally collected. */
  servedFromStore?: { from: string; to: string; collectedAt: string };
  projects: ProjectConsumptionResult[];
};

export type BranchConsumptionReport = {
  schemaVersion: 1;
  generatedAt: string;
  asOf: string;
  source: { contract: "consumption-history-v2-branches"; beta: true };
  coverage: HistoryCoverage & { historicalCoverage: "unverified" };
  query: BranchReportQuery;
  effectiveRange: EffectiveRange;
  evidence?: EvidenceRef[];
  branches: BranchConsumptionResult[];
};

export type OrganizationConsumptionSummary = {
  schemaVersion: 1;
  generatedAt: string;
  asOf: string;
  scope: { kind: "organization_aggregate"; organizationId: string };
  coverage: HistoryCoverage;
  query: ProjectReportQuery;
  effectiveRange: EffectiveRange;
  evidence?: EvidenceRef[];
  servedFromStore?: { from: string; to: string; collectedAt: string };
  aggregation: "across_projects_periods_buckets_before_allowances";
  metrics: Array<{
    name: string;
    raw: { value: string; unit: RawUnit };
    derived: ReturnType<typeof deriveBillingValue>;
  }> | null;
  attribution: { projects: ProjectConsumptionResult[] };
};

export interface ConsumptionService {
  projectReport(
    query: ProjectReportQuery,
    context?: OperationContext,
  ): Promise<ProjectConsumptionReport>;
  organizationSummary(
    query: ProjectReportQuery,
    context?: OperationContext,
  ): Promise<OrganizationConsumptionSummary>;
}

export interface BranchConsumptionService {
  branchReport(
    query: BranchReportQuery,
    context?: OperationContext,
  ): Promise<BranchConsumptionReport>;
}

function validatedHistoryOptions<Page>(
  options: HistoryServiceOptions<Page>,
): HistoryServiceOptions<Page> & { maxPages: number } {
  const maxPages = options.maxPages ?? 1000;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10_000) {
    throw new RangeError("maxPages must be an integer between 1 and 10000");
  }
  for (const [name, value, maximum] of [
    ["maxDurationMs", options.maxDurationMs, 3_600_000],
    ["maxItems", options.maxItems, 10_000_000],
    ["maxFacts", options.maxFacts, 100_000_000],
    ["maxBytes", options.maxBytes, 1_000_000_000],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > maximum)) {
      throw new RangeError(`${name} must be an integer between 1 and ${maximum}`);
    }
  }
  if (options.factStore && !options.sourceAccount?.trim()) {
    throw new TypeError(
      "a fact store requires an explicit sourceAccount credential-account identity",
    );
  }
  return { ...options, maxPages };
}

type HistoryRun<Page, Entity extends { periods: SourcePeriod[] }> = {
  serviceOptions: HistoryServiceOptions<Page> & { maxPages: number };
  contract: HistoryContract;
  requestedMetrics: string[];
  collectionQuery: ProjectReportQuery;
  context?: OperationContext;
  getPage(cursor: string | null, context?: OperationContext): Promise<Page>;
  getItems(page: Page): readonly Entity[];
  getItemKey(entity: Entity): string;
  validateItem(entity: Entity): void;
  getNextCursor(page: Page): string | null;
  getEvidence(page: Page): EvidenceRef[];
  getRequestId(page: Page): string | undefined;
  scopeLabel(entity: Entity): string;
  scope(entity: Entity): ObservationScopeIdentity;
  compare(left: Entity, right: Entity): number;
};

/**
 * The one collection-and-projection path both history products share:
 * bounded cursor walking, optional durable page commits, canonical entity
 * ordering, metric projection, and evidence/coverage assembly. Contract
 * differences stay in the thin service wrappers.
 */
async function runHistoryReport<Page, Entity extends { periods: SourcePeriod[] }>(
  run: HistoryRun<Page, Entity>,
): Promise<{
  entities: Array<{ entity: Entity; periods: ProjectedHistoryPeriod[] }>;
  evidence: EvidenceRef[];
  status: "complete" | "partial";
  pageCount: number;
  requestIds: string[];
  qualityFlags: HistoryQualityFlag[];
  errors: string[];
  errorDetails: SourceErrorDetail[];
}> {
  const { serviceOptions } = run;
  const collection = await collectHistoryPages<Page, Entity>({
    maxPages: serviceOptions.maxPages,
    ...(serviceOptions.maxDurationMs ? { maxDurationMs: serviceOptions.maxDurationMs } : {}),
    ...(serviceOptions.maxItems ? { maxItems: serviceOptions.maxItems } : {}),
    ...(serviceOptions.maxFacts ? { maxFacts: serviceOptions.maxFacts } : {}),
    ...(serviceOptions.maxBytes ? { maxBytes: serviceOptions.maxBytes } : {}),
    ...(serviceOptions.budget ? { budget: serviceOptions.budget } : {}),
    ...(serviceOptions.now ? { now: serviceOptions.now } : {}),
    ...(serviceOptions.createRunId ? { createRunId: serviceOptions.createRunId } : {}),
    ...(serviceOptions.resumeRunId ? { resumeRunId: serviceOptions.resumeRunId } : {}),
    ...(serviceOptions.factStore && serviceOptions.sourceAccount
      ? {
          store: serviceOptions.factStore,
          intent: {
            sourceAccount: serviceOptions.sourceAccount,
            sourceContract: run.contract.sourceContract,
            request: run.collectionQuery,
          },
          pageWrite: (page: Page) => ({
            evidence: run.getEvidence(page),
            facts: run.getItems(page).flatMap((entity) =>
              canonicalFactsFromPeriods({
                sourceContract: run.contract.sourceContract,
                scope: run.scope(entity),
                periods: entity.periods,
              }),
            ),
          }),
        }
      : {}),
    ...(run.context ? { context: run.context } : {}),
    getPage: run.getPage,
    validatePage: (page) => {
      const evidence = run.getEvidence(page);
      for (const entity of run.getItems(page)) {
        assertMetricEvidenceLinkedToPage(entity.periods, evidence, run.scopeLabel(entity));
      }
    },
    getItems: run.getItems,
    getFactCount: (entity) =>
      entity.periods.reduce(
        (periodTotal, period) =>
          periodTotal +
          period.buckets.reduce((bucketTotal, bucket) => bucketTotal + bucket.metrics.length, 0),
        0,
      ),
    getByteCount: (page) =>
      "responseBytes" in (page as object)
        ? ((page as { responseBytes?: number }).responseBytes ?? 0)
        : 0,
    getItemKey: run.getItemKey,
    validateItem: run.validateItem,
    getNextCursor: run.getNextCursor,
    ...(serviceOptions.onPage ? { onPage: serviceOptions.onPage } : {}),
  });

  let projectedZero = false;
  let unknownMetric = false;
  const entities = [...collection.items].sort(run.compare).map((entity) => {
    const projection = projectHistoryPeriods(entity.periods, run.requestedMetrics);
    projectedZero ||= projection.projectedZero;
    unknownMetric ||= projection.unknownMetric;
    return { entity, periods: projection.periods };
  });
  const evidence = canonicalEvidenceReferences(collection.pages.flatMap(run.getEvidence));
  const requestIds = [
    ...new Set(
      collection.pages.flatMap((page) => {
        const requestId = run.getRequestId(page);
        return requestId === undefined ? [] : [requestId];
      }),
    ),
  ];
  const elapsed =
    serviceOptions.budget?.maxDurationMs !== undefined &&
    performance.now() - serviceOptions.budget.startedAt >= serviceOptions.budget.maxDurationMs;
  return {
    entities,
    evidence,
    status: elapsed ? "partial" : collection.status,
    pageCount: collection.pages.length,
    requestIds,
    qualityFlags: [
      ...collection.qualityFlags,
      ...(elapsed && !collection.qualityFlags.includes("TIME_LIMIT_REACHED")
        ? ["TIME_LIMIT_REACHED" as const]
        : []),
      ...(projectedZero ? ["SOURCE_ZERO_OMITTED" as const] : []),
      ...(unknownMetric ? ["SOURCE_METRIC_UNKNOWN" as const] : []),
    ],
    errors: collection.errors,
    errorDetails: collection.errorDetails,
  };
}

function coverageExtras(errors: string[], errorDetails: SourceErrorDetail[]) {
  return {
    ...(errors.length > 0 ? { errors } : {}),
    ...(errorDetails.length > 0 ? { errorDetails } : {}),
  };
}

export function createConsumptionService(
  source: ProjectConsumptionSource,
  options: HistoryServiceOptions<ProjectConsumptionPage> = {},
): ConsumptionService {
  const serviceOptions = validatedHistoryOptions(options);
  const service: ConsumptionService = {
    async organizationSummary(query: ProjectReportQuery, context?: OperationContext) {
      if (query.projectIds) {
        throw new ConsumptionQueryError(
          "INVALID_FILTER",
          "organization summaries cannot filter projects",
        );
      }
      const report = await service.projectReport(query, context);
      const common = {
        schemaVersion: 1 as const,
        generatedAt: report.generatedAt,
        asOf: report.asOf,
        scope: { kind: "organization_aggregate" as const, organizationId: query.organizationId },
        coverage: report.coverage,
        query,
        effectiveRange: report.effectiveRange,
        ...(report.evidence ? { evidence: report.evidence } : {}),
        ...(report.servedFromStore ? { servedFromStore: report.servedFromStore } : {}),
        aggregation: "across_projects_periods_buckets_before_allowances" as const,
        attribution: { projects: report.projects },
      };
      if (report.coverage.status !== "complete") {
        return { ...common, metrics: null };
      }
      const totals = new Map(query.metrics.map((name) => [name, 0n]));
      for (const project of report.projects) {
        for (const period of project.periods) {
          for (const bucket of period.buckets) {
            for (const metric of bucket.metrics) {
              if (totals.has(metric.name) && metric.value !== null) {
                totals.set(metric.name, (totals.get(metric.name) ?? 0n) + BigInt(metric.value));
              }
            }
          }
        }
      }
      return {
        ...common,
        metrics: query.metrics.map((name) => {
          const value = (totals.get(name) ?? 0n).toString();
          return {
            name,
            raw: { value, unit: rawUnits[name] ?? "unknown" },
            derived: deriveBillingValue(name, value),
          };
        }),
      };
    },

    async projectReport(query: ProjectReportQuery, context?: OperationContext) {
      if (
        query.projectIds &&
        (query.projectIds.length > 100 ||
          new Set(query.projectIds).size !== query.projectIds.length ||
          query.projectIds.some((id) => !isNeonId(id)))
      ) {
        throw new ConsumptionQueryError(
          "INVALID_FILTER",
          "project IDs must be unique and contain at most 100 valid values",
        );
      }
      const effectiveRange = validateHistoryQuery(
        query,
        serviceOptions.now?.() ?? new Date(),
        projectMetricNames,
      );
      const generatedAt = (serviceOptions.now?.() ?? new Date()).toISOString();
      // An EXPLICITLY empty project filter is a real scope, not an error:
      // live-projects on an organization with zero live projects must yield
      // an empty complete report (an org-wide walk would wrongly include
      // deleted projects). No source request is made.
      if (query.projectIds && query.projectIds.length === 0) {
        return {
          schemaVersion: 1 as const,
          generatedAt,
          asOf: effectiveRange.to,
          coverage: {
            status: "complete" as const,
            pageCount: 0,
            entityCount: 0,
            qualityFlags: [],
          },
          query,
          effectiveRange,
          projects: [],
        };
      }
      const collectionQuery: ProjectReportQuery = { ...query, ...effectiveRange };
      const budget: HistoryBudget = serviceOptions.budget ?? {
        maxPages: serviceOptions.maxPages,
        ...(serviceOptions.maxDurationMs ? { maxDurationMs: serviceOptions.maxDurationMs } : {}),
        ...(serviceOptions.maxItems ? { maxItems: serviceOptions.maxItems } : {}),
        ...(serviceOptions.maxFacts ? { maxFacts: serviceOptions.maxFacts } : {}),
        ...(serviceOptions.maxBytes ? { maxBytes: serviceOptions.maxBytes } : {}),
        startedAt: performance.now(),
        items: 0,
        facts: 0,
        bytes: 0,
        pages: 0,
      };
      const reportOptions = { ...serviceOptions, budget };

      const collect = (rangeQuery: ProjectReportQuery) =>
        runHistoryReport({
          serviceOptions: reportOptions,
          contract: projectHistoryContract,
          requestedMetrics: query.metrics,
          collectionQuery: rangeQuery,
          ...(context ? { context } : {}),
          getPage: (cursor, operation) => source.getProjectPage(rangeQuery, cursor, operation),
          getItems: (page: ProjectConsumptionPage) => page.projects,
          getItemKey: (project) => project.projectId,
          validateItem: (project) => {
            if (query.projectIds && !query.projectIds.includes(project.projectId)) {
              throw new ConsumptionSourceIntegrityError(
                `Project history returned out-of-scope project ${project.projectId}`,
              );
            }
            assertValidPeriodFacts(project.periods, `Project ${project.projectId}`, effectiveRange);
          },
          getNextCursor: (page: ProjectConsumptionPage) => page.nextCursor,
          getEvidence: (page: ProjectConsumptionPage) => (page.evidence ? [page.evidence] : []),
          getRequestId: (page: ProjectConsumptionPage) => page.requestId,
          scope: (project) => ({
            kind: "project",
            organizationId: query.organizationId,
            projectId: project.projectId,
          }),
          scopeLabel: (project) => `Project ${project.projectId}`,
          compare: (left, right) => compareCanonicalText(left.projectId, right.projectId),
        });

      // Serve already-collected buckets from the store when configured;
      // explicit run control (resume / fixed run IDs) always collects.
      const serving = serviceOptions.storeServing;
      if (
        serving?.serve &&
        serviceOptions.factStore &&
        serviceOptions.sourceAccount &&
        !serviceOptions.resumeRunId &&
        !serviceOptions.createRunId
      ) {
        const store = serviceOptions.factStore;
        const runs = await store.listCollectionRuns({
          sourceAccount: serviceOptions.sourceAccount,
          sourceContract: projectHistoryContract.sourceContract,
        });
        const plan = planStoredServing({
          collectionQuery,
          runs: runs.map((run) => ({
            runId: run.runId,
            status: run.status,
            ...(run.completedAt ? { completedAt: run.completedAt } : {}),
            request: run.intent.request as ProjectReportQuery,
          })),
          tailBuckets: serving.tailBuckets,
        });
        if (plan.served.length > 0) {
          // Restrict replay to the requested projects: the owning runs may be
          // whole-org or superset walks (storedScopeCovers), whose pages also
          // carry projects this query did not ask for.
          const replayed = await replayStoredProjects(
            store,
            plan,
            (runId) => store.getCollectionRun(runId),
            collectionQuery.projectIds,
            {
              ...(serviceOptions.maxDurationMs
                ? { maxDurationMs: serviceOptions.maxDurationMs }
                : {}),
              ...(serviceOptions.maxItems ? { maxItems: serviceOptions.maxItems } : {}),
              ...(serviceOptions.maxFacts ? { maxFacts: serviceOptions.maxFacts } : {}),
              ...(serviceOptions.maxBytes ? { maxBytes: serviceOptions.maxBytes } : {}),
              budget,
              ...(context ? { context } : {}),
              // The store is a plain user-writable SQLite file: replayed
              // pages get the collect path's validation (evidence linkage,
              // timestamps, duplicate buckets/metrics, non-negative-integer
              // values), so corruption or edits surface as an integrity
              // failure instead of silently wrong totals. Range containment
              // is not checked here: a run's pages legitimately span the
              // RUN's window, and clipping to owned buckets follows.
              validatePage: (storedPage, pageEvidence) => {
                for (const project of storedPage.projects ?? []) {
                  const label = `Stored project ${project.projectId}`;
                  try {
                    assertValidPeriodFacts(project.periods, label);
                    assertMetricEvidenceLinkedToPage(project.periods, pageEvidence, label);
                  } catch (error) {
                    if (isIntegrityFailure(error)) throw error;
                    throw new ConsumptionSourceIntegrityError(
                      `${label} has a malformed stored page: ${
                        error instanceof Error ? error.message : String(error)
                      }`,
                    );
                  }
                }
              },
            },
          );
          const replayLimited = replayed.qualityFlags.some((flag) =>
            [
              "TIME_LIMIT_REACHED",
              "ITEM_LIMIT_REACHED",
              "FACT_LIMIT_REACHED",
              "BYTE_LIMIT_REACHED",
              "PAGE_LIMIT_REACHED",
            ].includes(flag),
          );
          const fresh =
            plan.collectRange && !replayLimited
              ? await collect({ ...collectionQuery, ...plan.collectRange })
              : null;
          const combined = new Map<string, SourcePeriod[]>(replayed.projects);
          for (const { entity } of fresh?.entities ?? []) {
            combined.set(
              entity.projectId,
              mergePeriods(combined.get(entity.projectId) ?? [], entity.periods),
            );
          }
          let projectedZero = false;
          let unknownMetric = false;
          const projects = [...combined.entries()]
            .sort((left, right) => compareCanonicalText(left[0], right[0]))
            .map(([projectId, periods]) => {
              const projection = projectHistoryPeriods(periods, query.metrics);
              projectedZero ||= projection.projectedZero;
              unknownMetric ||= projection.unknownMetric;
              return { projectId, periods: projection.periods };
            });
          const qualityFlags = [
            ...new Set<HistoryQualityFlag>([
              ...replayed.qualityFlags,
              ...(fresh?.qualityFlags ?? []),
              ...(projectedZero ? ["SOURCE_ZERO_OMITTED" as const] : []),
              ...(unknownMetric ? ["SOURCE_METRIC_UNKNOWN" as const] : []),
            ]),
          ];
          const evidence = canonicalEvidenceReferences([
            ...replayed.evidence,
            ...(fresh?.evidence ?? []),
          ]);
          const elapsed =
            budget.maxDurationMs !== undefined &&
            performance.now() - budget.startedAt >= budget.maxDurationMs;
          if (elapsed && !qualityFlags.includes("TIME_LIMIT_REACHED")) {
            qualityFlags.push("TIME_LIMIT_REACHED");
          }
          return {
            schemaVersion: 1 as const,
            generatedAt,
            asOf: effectiveRange.to,
            coverage: {
              status:
                fresh?.status === "partial" || replayLimited || elapsed
                  ? "partial"
                  : ("complete" as const),
              pageCount: replayed.pageCount + (fresh?.pageCount ?? 0),
              entityCount: projects.length,
              qualityFlags,
              ...((fresh?.requestIds.length ?? 0) > 0
                ? { requestIds: fresh?.requestIds ?? [] }
                : {}),
              ...coverageExtras(fresh?.errors ?? [], fresh?.errorDetails ?? []),
            },
            query,
            effectiveRange,
            ...(evidence.length > 0 ? { evidence } : {}),
            // A budget-truncated replay must not claim the full served
            // prefix: the label would be false, so it is omitted (coverage
            // is already partial with the specific limit flag).
            ...(replayLimited
              ? {}
              : {
                  servedFromStore: {
                    from: effectiveRange.from,
                    to: plan.collectRange?.from ?? effectiveRange.to,
                    collectedAt: replayed.collectedAt,
                  },
                }),
            projects,
          };
        }
      }

      const result = await collect(collectionQuery);
      return {
        schemaVersion: 1 as const,
        generatedAt,
        asOf: effectiveRange.to,
        coverage: {
          status: result.status,
          pageCount: result.pageCount,
          entityCount: result.entities.length,
          qualityFlags: result.qualityFlags,
          ...(result.requestIds.length > 0 ? { requestIds: result.requestIds } : {}),
          ...coverageExtras(result.errors, result.errorDetails),
        },
        query,
        effectiveRange,
        ...(result.evidence.length > 0 ? { evidence: result.evidence } : {}),
        projects: result.entities.map(({ entity, periods }) => ({
          projectId: entity.projectId,
          periods,
        })),
      };
    },
  };
  return service;
}

export function createBranchConsumptionService(
  source: BranchConsumptionSource,
  options: HistoryServiceOptions<BranchConsumptionPage> = {},
): BranchConsumptionService {
  const serviceOptions = validatedHistoryOptions(options);
  return {
    async branchReport(query: BranchReportQuery, context?: OperationContext) {
      if (
        query.projectIds.length === 0 ||
        query.projectIds.length > 100 ||
        new Set(query.projectIds).size !== query.projectIds.length
      ) {
        throw new ConsumptionQueryError(
          "PROJECT_IDS_REQUIRED",
          "branch history requires between 1 and 100 project IDs",
        );
      }
      if (query.projectIds.some((id) => !isNeonId(id))) {
        throw new ConsumptionQueryError("INVALID_FILTER", "project IDs are malformed");
      }
      if (
        query.branchIds &&
        (query.branchIds.length > 100 ||
          new Set(query.branchIds).size !== query.branchIds.length ||
          query.branchIds.some((id) => !isNeonId(id)))
      ) {
        throw new ConsumptionQueryError(
          "INVALID_FILTER",
          "branch IDs must be unique and contain at most 100 values",
        );
      }
      const effectiveRange = validateHistoryQuery(
        query,
        serviceOptions.now?.() ?? new Date(),
        branchMetricNames,
      );
      const generatedAt = (serviceOptions.now?.() ?? new Date()).toISOString();
      const collectionQuery: BranchReportQuery = { ...query, ...effectiveRange };
      const result = await runHistoryReport({
        serviceOptions,
        contract: branchHistoryContract,
        requestedMetrics: query.metrics,
        collectionQuery,
        ...(context ? { context } : {}),
        getPage: (cursor, operation) => source.getBranchPage(collectionQuery, cursor, operation),
        getItems: (page: BranchConsumptionPage) => page.branches,
        getItemKey: (branch) => `${branch.projectId}:${branch.branchId}`,
        validateItem: (branch) => {
          if (
            !query.projectIds.includes(branch.projectId) ||
            (query.branchIds && !query.branchIds.includes(branch.branchId))
          ) {
            throw new ConsumptionSourceIntegrityError(
              `Branch history returned out-of-scope branch ${branch.projectId}/${branch.branchId}`,
            );
          }
          assertValidPeriodFacts(
            branch.periods,
            `Branch ${branch.projectId}/${branch.branchId}`,
            effectiveRange,
          );
        },
        getNextCursor: (page: BranchConsumptionPage) => page.nextCursor,
        getEvidence: (page: BranchConsumptionPage) => (page.evidence ? [page.evidence] : []),
        getRequestId: (page: BranchConsumptionPage) => page.requestId,
        scope: (branch) => ({
          kind: "branch",
          organizationId: query.organizationId,
          projectId: branch.projectId,
          branchId: branch.branchId,
        }),
        scopeLabel: (branch) => `Branch ${branch.projectId}/${branch.branchId}`,
        compare: (left, right) =>
          compareCanonicalText(left.projectId, right.projectId) ||
          compareCanonicalText(left.branchId, right.branchId),
      });
      return {
        schemaVersion: 1 as const,
        generatedAt,
        asOf: effectiveRange.to,
        source: {
          contract: branchHistoryContract.sourceContract,
          beta: branchHistoryContract.beta,
        },
        coverage: {
          status: result.status,
          historicalCoverage: branchHistoryContract.historicalCoverage,
          pageCount: result.pageCount,
          entityCount: result.entities.length,
          qualityFlags: [...branchHistoryContract.qualityFlags, ...result.qualityFlags],
          ...(result.requestIds.length > 0 ? { requestIds: result.requestIds } : {}),
          ...coverageExtras(result.errors, result.errorDetails),
        },
        query,
        effectiveRange,
        ...(result.evidence.length > 0 ? { evidence: result.evidence } : {}),
        branches: result.entities.map(({ entity, periods }) => ({
          projectId: entity.projectId,
          branchId: entity.branchId,
          periods,
        })),
      };
    },
  };
}

/**
 * Merges chunked project reports over the same effective range into one
 * report, so a query larger than the source's 100-project filter can be
 * collected in chunks and still estimated (or presented) as a whole.
 * Coverage merges honestly: complete only when every chunk is complete,
 * counts summed, quality flags unioned, request IDs and evidence
 * concatenated (evidence deduplicated canonically). Chunks must not
 * overlap in projects and must share range, granularity, and metrics.
 */
export function mergeProjectConsumptionReports(
  reports: ProjectConsumptionReport[],
): ProjectConsumptionReport {
  const [first] = reports;
  if (!first) {
    throw new Error("mergeProjectConsumptionReports requires at least one report");
  }
  if (reports.length === 1) return first;
  const metricKey = (metrics: readonly string[]) => [...metrics].sort().join(",");
  const firstMetrics = metricKey(first.query.metrics);
  for (const report of reports) {
    if (
      report.effectiveRange.from !== first.effectiveRange.from ||
      report.effectiveRange.to !== first.effectiveRange.to ||
      report.effectiveRange.granularity !== first.effectiveRange.granularity
    ) {
      throw new Error("mergeProjectConsumptionReports requires one shared effective range");
    }
    // Chunks of one query must be the same collection: same organization,
    // metric set, schema, and as-of instant. Without this a caller could merge
    // different organizations or metric sets into one apparently coherent report
    // and then price it.
    if (report.query.organizationId !== first.query.organizationId) {
      throw new Error("mergeProjectConsumptionReports requires one shared organization");
    }
    if (metricKey(report.query.metrics) !== firstMetrics) {
      throw new Error("mergeProjectConsumptionReports requires one shared metric set");
    }
    if (report.schemaVersion !== first.schemaVersion) {
      throw new Error("mergeProjectConsumptionReports requires one shared schema version");
    }
    if (report.asOf !== first.asOf) {
      throw new Error("mergeProjectConsumptionReports requires one shared as-of instant");
    }
  }
  // Chunks must all be filtered: an unfiltered chunk is org-wide, so it
  // overlaps any other chunk's scope by definition — including another
  // unfiltered chunk — even when its result body happens to be empty.
  const declaredCount = reports.filter((report) => report.query.projectIds).length;
  if (declaredCount !== reports.length) {
    throw new Error(
      "mergeProjectConsumptionReports requires every chunk to declare projectIds (an unfiltered report is org-wide and cannot be one chunk of several)",
    );
  }
  const seenProjects = new Set<string>();
  const declaredIds = new Set<string>();
  for (const report of reports) {
    // A chunk's declared filter must not overlap another chunk's, and every
    // returned project must belong to its own chunk's declared filter — else
    // two chunks could double-declare or smuggle projects across filters.
    const declared = report.query.projectIds ? new Set(report.query.projectIds) : undefined;
    if (declared) {
      for (const id of declared) {
        if (declaredIds.has(id)) {
          throw new Error(
            `mergeProjectConsumptionReports received project ${id} declared in more than one chunk filter`,
          );
        }
        declaredIds.add(id);
      }
    }
    for (const project of report.projects) {
      if (seenProjects.has(project.projectId)) {
        throw new Error(
          `mergeProjectConsumptionReports received project ${project.projectId} in more than one chunk`,
        );
      }
      if (declared && !declared.has(project.projectId)) {
        throw new Error(
          `mergeProjectConsumptionReports received project ${project.projectId} outside its chunk's declared filter`,
        );
      }
      seenProjects.add(project.projectId);
    }
  }
  const requestIds = reports.flatMap((report) => report.coverage.requestIds ?? []);
  const errors = reports.flatMap((report) => report.coverage.errors ?? []);
  const errorDetails = reports.flatMap((report) => report.coverage.errorDetails ?? []);
  const evidence = canonicalEvidenceReferences(reports.flatMap((report) => report.evidence ?? []));
  const projectIds = reports.flatMap((report) => report.query.projectIds ?? []);
  // Staleness disclosure must survive a merge whenever ANY chunk was served
  // from the store: absence reads as "freshly collected", which a half-stale
  // merge must not claim. The label spans the widest served range and carries
  // the OLDEST collection instant — over-disclosing staleness is the
  // conservative direction for a freshness label.
  const stored = reports.flatMap((report) =>
    report.servedFromStore ? [report.servedFromStore] : [],
  );
  const servedFromStore =
    stored.length > 0
      ? {
          from: stored.map((entry) => entry.from).reduce((l, r) => (l < r ? l : r)),
          to: stored.map((entry) => entry.to).reduce((l, r) => (l > r ? l : r)),
          collectedAt: stored
            .map((entry) => entry.collectedAt)
            .reduce((left, right) => (left < right ? left : right)),
        }
      : undefined;
  return {
    schemaVersion: 1,
    generatedAt: reports
      .map((report) => report.generatedAt)
      .reduce((left, right) => (left > right ? left : right)),
    asOf: first.asOf,
    coverage: {
      status: reports.every((report) => report.coverage.status === "complete")
        ? "complete"
        : "partial",
      pageCount: reports.reduce((total, report) => total + report.coverage.pageCount, 0),
      entityCount: reports.reduce((total, report) => total + report.coverage.entityCount, 0),
      qualityFlags: [...new Set(reports.flatMap((report) => report.coverage.qualityFlags))],
      ...(requestIds.length > 0 ? { requestIds } : {}),
      ...(errors.length > 0 ? { errors } : {}),
      ...(errorDetails.length > 0 ? { errorDetails } : {}),
    },
    query: { ...first.query, ...(projectIds.length > 0 ? { projectIds } : {}) },
    effectiveRange: first.effectiveRange,
    ...(servedFromStore ? { servedFromStore } : {}),
    ...(evidence.length > 0 ? { evidence } : {}),
    projects: reports.flatMap((report) => report.projects),
  };
}
