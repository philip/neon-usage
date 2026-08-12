// Public surface of the neon-usage library — the domain barrel.
// Implementation lives in the focused modules re-exported here; adapters
// import domain code only from this barrel. Adapter modules themselves
// (cli.ts, dashboard-server.ts, neon-cli-context.ts) are not re-exported:
// adapter-to-adapter wiring imports them directly.

export type {
  CollectionControl,
  HistoryScope,
  ReportDependencies,
  ResolvedContextReport,
} from "./adapter-support.js";
export {
  assertWithinHistoryFilter,
  CollectionQueueFullError,
  commaSeparatedValues,
  contextReport,
  defaultHistoryProjectIds,
  hasPartialCoverage,
  historyQueryFromOptions,
  historyScopes,
  liveProjectIds,
  memoizeReports,
  resolveControlsProjectIds,
  resolvedContext,
  resolveOrganizationId,
  serializeCollections,
  withPlanHint,
} from "./adapter-support.js";
export type {
  CapabilityReport,
  CapabilityService,
  CapabilityState,
} from "./capability-service.js";
export { createCapabilityService } from "./capability-service.js";
export type {
  BranchReportQuery,
  EffectiveRange,
  Granularity,
  ProjectReportQuery,
} from "./consumption-query.js";
export { ConsumptionQueryError } from "./consumption-query.js";
export type {
  BranchConsumptionPage,
  BranchConsumptionSource,
  BranchSizeCollection,
  BranchSizeSnapshot,
  CurrentSnapshotSource,
  DirectoryQualityFlag,
  EvidenceRef,
  FactEvidenceRef,
  HistoryProbeResult,
  NeonOrganization,
  OrganizationDirectorySource,
  OrganizationSource,
  ProjectConsumptionPage,
  ProjectConsumptionSource,
  ProjectCurrentSnapshot,
  SourceBranchConsumption,
  SourceBucket,
  SourceMetric,
  SourcePeriod,
  SourceProjectConsumption,
} from "./consumption-source.js";
export { renderControlsTable, renderUtilizationTable } from "./controls-presenter.js";
export type {
  ControlsInspection,
  ControlsService,
  ControlsSource,
  ProjectQuotaReading,
  ProjectQuotaUtilization,
  QuotaUtilizationMetric,
  QuotaUtilizationReport,
  QuotaUtilizationService,
  SpendingNotificationReading,
} from "./controls-service.js";
export { createControlsService, createQuotaUtilizationService } from "./controls-service.js";
export type {
  CurrentPeriodSnapshotReport,
  CurrentSnapshotError,
  CurrentSnapshotService,
} from "./current-snapshot-service.js";
export { createCurrentSnapshotService } from "./current-snapshot-service.js";
export type { SourceErrorDetail } from "./errors.js";
export { ConsumptionSourceIntegrityError } from "./errors.js";
export { renderEstimateTable, renderPriceTable } from "./estimate-presenter.js";
export type {
  AppendReceipt,
  CanonicalConsumptionFact,
  CollectionIntent,
  CollectionPageWrite,
  CollectionRunCompletion,
  CollectionRunRecord,
  CollectionTerminalState,
  EvidenceFactStore,
  FactRevisionQuery,
} from "./evidence-fact-store.js";
export type {
  EffectiveFactIdentityInput,
  ObservationIdentityInput,
  ObservationScopeIdentity,
} from "./fact-identity.js";
export { effectiveFactIdentity, observationRevisionIdentity } from "./fact-identity.js";
export type {
  CollectionCheckpoint,
  CollectionRunId,
  CollectionRunIdFactory,
  CollectionRunStatus,
  HistoryBudget,
  HistoryCollectionQualityFlag,
} from "./history-collection.js";
export type {
  BranchConsumptionReport,
  BranchConsumptionResult,
  BranchConsumptionService,
  ConsumptionService,
  HistoryCoverage,
  HistoryQualityFlag,
  HistoryServiceOptions,
  OrganizationConsumptionSummary,
  ProjectConsumptionReport,
  ProjectConsumptionResult,
} from "./history-report.js";
export {
  createBranchConsumptionService,
  createConsumptionService,
  mergeProjectConsumptionReports,
} from "./history-report.js";
export { createInMemoryEvidenceFactStore } from "./in-memory-fact-store.js";
export { SerializedOutputTooLargeError, serializeMachineJson } from "./machine-json.js";
export type { KnownMetricName, RawUnit } from "./metric-catalog.js";
export {
  branchConsumptionMetrics,
  deriveBillingValue,
  metricCatalog,
  projectConsumptionMetrics,
} from "./metric-catalog.js";
export type { NeonApiSourceOptions, NeonSourceEvidence } from "./neon-api-source.js";
export {
  createNeonApiSource,
  NeonApiError,
  NeonEvidenceError,
  NeonResponseError,
  NeonResponseTooLargeError,
  NeonTransportError,
} from "./neon-api-source.js";
export type { OperationContext } from "./operation-context.js";
export { OperationByteLimitError, OperationCancelledError } from "./operation-context.js";
export type {
  MoneyAmount,
  PricingApproximation,
  PricingEstimate,
  PricingEstimateLine,
  PricingEstimateOptions,
  PricingLineStatus,
} from "./pricing-estimate.js";
export { estimateProjectCosts } from "./pricing-estimate.js";
export type {
  AllowanceScope,
  RateCard,
  RateCardAllowance,
  RateCardPlan,
} from "./rate-card.js";
export { neonDocumentationRateCard } from "./rate-card.js";
export { renderHistoryTable, renderSnapshotTable } from "./report-presenter.js";
export type {
  RequestCoordinator,
  SlidingWindowCoordinatorOptions,
} from "./request-coordinator.js";
export { createSlidingWindowRequestCoordinator } from "./request-coordinator.js";
export {
  createSqliteEvidenceFactStore,
  SqliteModuleUnavailableError,
} from "./sqlite-fact-store.js";
export type { StoreServingOptions } from "./stored-history.js";
export { DEFAULT_STORE_TAIL_BUCKETS } from "./stored-history.js";
export type { UsageOverview, UsageOverviewService } from "./usage-overview-service.js";
export { createUsageOverviewService } from "./usage-overview-service.js";
export { renderUsageTable } from "./usage-presenter.js";
