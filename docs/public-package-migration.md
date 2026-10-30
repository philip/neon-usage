# Migrate to the public package

## Choose supported imports

Use the Node.js SDK from `neon-usage`. Use `neon-usage/contracts` for measured types, constants, validation, semantic metric definitions, explicit default metric lists, and exact conversion. Contract exports remain available at the root for convenience; browser code must use the contracts entry. The package export map exposes exactly these two entries, plus the `neon-usage` executable through `bin`.

Internal source, stores, transport adapters, presenters, CLI parsers, dependency composition, and dashboard hosting have no public subpath. Importing `neon-usage/src/index.ts`, `neon-usage/dist/index.js`, or `neon-usage/hosted` fails package resolution. If you used a removed service factory, migrate to `createNeonUsageClient` or the standalone CLI; deep imports are not a compatibility route.

The table inventories all 169 named exports from the root barrel immediately before its public-boundary reduction. “Move” means a preferred contracts import with the root alias retained. “Remove” means removal from the public API, even when the implementation remains in the tarball for the CLI. These names include local, unpublished additions; the table does not claim that every name shipped in v0.3.0.

| Former module | Every former root export | Disposition | Replacement |
| --- | --- | --- | --- |
| `adapter-support` | `CollectionControl`, `HistoryScope`, `ReportDependencies`, `ResolvedContextReport` | Remove | Private implementation; no supported deep import. |
| `adapter-support` | `assertWithinHistoryFilter`, `CollectionQueueFullError`, `commaSeparatedValues`, `contextReport`, `defaultHistoryProjectIds`, `hasPartialCoverage`, `historyQueryFromOptions`, `historyScopes`, `liveProjectIds`, `memoizeReports`, `resolveControlsProjectIds`, `resolvedContext`, `resolveOrganizationId`, `serializeCollections`, `withPlanHint` | Remove | Private implementation; no supported deep import. |
| `capability-service` | `CapabilityReport`, `CapabilityState` | Keep | Continue importing from `neon-usage`. |
| `capability-service` | `CapabilityService` | Remove | Private implementation; no supported deep import. |
| `capability-service` | `createCapabilityService` | Remove | Private implementation; no supported deep import. |
| `consumption-query` | `EffectiveRange`, `Granularity`, `ProjectReportQuery` | Keep | Continue importing from `neon-usage`. |
| `consumption-query` | `BranchReportQuery` | Remove | Private implementation; no supported deep import. |
| `consumption-query` | `ConsumptionQueryError` | Remove | Private implementation; no supported deep import. |
| `consumption-source` | `EvidenceRef`, `HistoryProbeResult`, `NeonOrganization` | Keep | Continue importing from `neon-usage`. |
| `consumption-source` | `BranchConsumptionPage`, `BranchConsumptionSource`, `BranchSizeCollection`, `BranchSizeSnapshot`, `CurrentSnapshotSource`, `DirectoryQualityFlag`, `FactEvidenceRef`, `OrganizationDirectorySource`, `OrganizationSource`, `ProjectConsumptionPage`, `ProjectConsumptionSource`, `ProjectCurrentSnapshot`, `SourceBranchConsumption`, `SourceBucket`, `SourceMetric`, `SourcePeriod`, `SourceProjectConsumption` | Remove | Private implementation; no supported deep import. |
| `controls-presenter` | `renderControlsTable`, `renderUtilizationTable` | Remove | Private implementation; no supported deep import. |
| `controls-service` | `ControlsInspection`, `ControlsService`, `ControlsSource`, `ProjectQuotaReading`, `ProjectQuotaUtilization`, `QuotaUtilizationMetric`, `QuotaUtilizationReport`, `QuotaUtilizationService`, `SpendingNotificationReading` | Remove | Private implementation; no supported deep import. |
| `controls-service` | `createControlsService`, `createQuotaUtilizationService` | Remove | Private implementation; no supported deep import. |
| `current-snapshot-service` | `CurrentPeriodSnapshotReport`, `CurrentSnapshotError`, `CurrentSnapshotService` | Remove | Private implementation; no supported deep import. |
| `current-snapshot-service` | `createCurrentSnapshotService` | Remove | Private implementation; no supported deep import. |
| `errors` | `CliErrorParts`, `SourceErrorDetail` | Remove | Private implementation; no supported deep import. |
| `errors` | `CliError`, `ConsumptionSourceIntegrityError` | Remove | Private implementation; no supported deep import. |
| `estimate-presenter` | `renderEstimateTable`, `renderPriceTable` | Remove | Private implementation; no supported deep import. |
| `evidence-fact-store` | `AppendReceipt`, `CanonicalConsumptionFact`, `CollectionIntent`, `CollectionPageWrite`, `CollectionRunCompletion`, `CollectionRunRecord`, `CollectionTerminalState`, `EvidenceFactStore`, `FactRevisionQuery` | Remove | Private implementation; no supported deep import. |
| `fact-identity` | `EffectiveFactIdentityInput`, `ObservationIdentityInput`, `ObservationScopeIdentity` | Remove | Private implementation; no supported deep import. |
| `fact-identity` | `effectiveFactIdentity`, `observationRevisionIdentity` | Remove | Private implementation; no supported deep import. |
| `history-collection` | `CollectionCheckpoint`, `CollectionRunId`, `CollectionRunIdFactory`, `CollectionRunStatus`, `HistoryBudget`, `HistoryCollectionQualityFlag` | Remove | Private implementation; no supported deep import. |
| `history-report` | `BranchConsumptionReport`, `BranchConsumptionResult`, `BranchConsumptionService`, `ConsumptionService`, `HistoryCoverage`, `HistoryQualityFlag`, `HistoryServiceOptions`, `OrganizationConsumptionSummary`, `ProjectConsumptionReport`, `ProjectConsumptionResult` | Remove | Private implementation; no supported deep import. |
| `history-report` | `createBranchConsumptionService`, `createConsumptionService`, `mergeProjectConsumptionReports` | Remove | Private implementation; no supported deep import. |
| `in-memory-fact-store` | `createInMemoryEvidenceFactStore` | Remove | Private implementation; no supported deep import. |
| `machine-json` | `SerializedOutputTooLargeError`, `serializeMachineJson` | Remove | Private implementation; no supported deep import. |
| `measured-usage-contract` | `BillableBranchMonthComponent`, `BillableBranchMonthComponentIdentity`, `BillableBranchMonthComponents`, `ExactRational`, `MeasuredBillingUsage`, `MeasuredPresence`, `MeasuredSnapshotCoverage`, `MeasuredUsageContractErrorCode`, `MeasuredUsageCoverage`, `MeasuredUsageMetric`, `MeasuredUsageMetricSelection`, `MeasuredUsageScope`, `MeasuredUsageSource`, `PointInTimeStorage`, `UnresolvedComparisonField` | Move | Prefer `neon-usage/contracts`; root convenience re-export remains. |
| `measured-usage-contract` | `MEASURED_USAGE_KIND`, `MEASURED_USAGE_SCHEMA_VERSION`, `MeasuredUsageContractError`, `parseMeasuredBillingUsage` | Move | Prefer `neon-usage/contracts`; root convenience re-export remains. |
| `measured-usage-export` | `buildMeasuredUsageExport` | Remove | Use the SDK's `collectMeasuredUsage` or parse CLI JSON. |
| `metric-catalog` | `KnownMetricName`, `RawUnit` | Move | Prefer `neon-usage/contracts`; root convenience re-export remains. |
| `metric-catalog` | `branchConsumptionMetrics`, `deriveBillingValue`, `projectConsumptionMetrics` | Move | Prefer `neon-usage/contracts`; root convenience re-export remains. |
| `metric-catalog` | `metricCatalog` | Remove | Use public `metricDefinitions` for semantics; presentation metadata is private. |
| `neon-api-source` | `NeonApiSourceOptions`, `NeonSourceEvidence` | Remove | Private implementation; no supported deep import. |
| `neon-api-source` | `createNeonApiSource`, `NeonApiError`, `NeonEvidenceError`, `NeonResponseError`, `NeonResponseTooLargeError`, `NeonTransportError` | Remove | Private implementation; no supported deep import. |
| `operation-context` | `OperationContext` | Remove | Private implementation; no supported deep import. |
| `operation-context` | `OperationByteLimitError`, `OperationCancelledError` | Remove | Private implementation; no supported deep import. |
| `pricing-estimate` | `MoneyAmount`, `PricingApproximation`, `PricingEstimate`, `PricingEstimateLine`, `PricingLineStatus` | Keep | Continue importing from `neon-usage`. |
| `pricing-estimate` | `PricingEstimateOptions` | Remove | Private implementation; no supported deep import. |
| `pricing-estimate` | `estimateProjectCosts` | Remove | Private implementation; no supported deep import. |
| `rate-card` | `AllowanceScope`, `RateCard`, `RateCardAllowance`, `RateCardPlan` | Keep | Continue importing from `neon-usage`. |
| `rate-card` | `neonDocumentationRateCard` | Remove | Private implementation; no supported deep import. |
| `report-presenter` | `renderHistoryTable`, `renderSnapshotTable` | Remove | Private implementation; no supported deep import. |
| `request-coordinator` | `RequestCoordinator` | Keep | Continue importing from `neon-usage`. |
| `request-coordinator` | `SlidingWindowCoordinatorOptions` | Keep | Import from `neon-usage` for the process-local coordinator. |
| `request-coordinator` | `createSlidingWindowRequestCoordinator` | Keep | Import from `neon-usage` for process-local sharing. |
| `sqlite-fact-store` | `createSqliteEvidenceFactStore`, `SqliteModuleUnavailableError` | Remove | Private implementation; no supported deep import. |
| `stored-history` | `StoreServingOptions` | Remove | Private implementation; no supported deep import. |
| `stored-history` | `DEFAULT_STORE_TAIL_BUCKETS` | Remove | Private implementation; no supported deep import. |
| `usage-overview-service` | `UsageOverview`, `UsageOverviewService` | Remove | Private implementation; no supported deep import. |
| `usage-overview-service` | `createUsageOverviewService` | Remove | Private implementation; no supported deep import. |
| `usage-presenter` | `renderUsageTable` | Remove | Private implementation; no supported deep import. |

## Replace the unpublished hosted entry

Version 0.4.0 intentionally removes `createHostedUsageClient` and `neon-usage/hosted` without deprecated aliases. Replace them with root `createNeonUsageClient`. The former hosted types `HostedCollectionBudget`, `HostedUsageConfig`, `HostedMeasuredUsageInput`, `HostedMeasuredUsageResult`, and `HostedUsageClient` become `NeonUsageClientLimits`, `NeonUsageClientConfig`, `CollectMeasuredUsageInput`, `CollectedMeasuredUsage`, and `NeonUsageClient` respectively, with the new source-discriminated input and limits.

Drop `sourceAccount` and `producerVersion`: the package generates an operation-specific opaque identity and its own producer version. Replace `collectionBudget`, `snapshotBudget`, and `requestBudget` with the corresponding `limits` fields. `requestTimeoutMs` is no longer caller-configurable. For clients in one process, share `createSlidingWindowRequestCoordinator({ limit, intervalMs })` from the package root. Its state is process-local. For distributed admission, supply a host-owned `RequestCoordinator`; each client retains local limits. Close clients in `finally`. The [SDK guide](sdk.md) covers current scope, errors, limits, and coordinator sharing.

## Recollect measured documents

Version 0.4.0 emits measured schema 2. The redesigned contract requires explicit metric selection, project periods, unknown-metric omission names, and checked branch allowance components. The parser rejects version-one documents with `UNSUPPORTED_VERSION`.

Recollect version-one documents from Neon with the new CLI or SDK. Do not fabricate `omittedMetrics`, project periods, metric selections, branch components, or complete coverage.

Only complete coverage can authorize aggregate metrics. `coverage.omittedMetrics` names excluded metrics unsupported by the source endpoint, and `UNKNOWN_METRIC` identifies the omission. A snapshot-only metric returned by history is included in those omissions even if its name is globally known. Check requested dimensions before forecasting. Branch components carry their own `complete`, `partial`, or `unavailable` status; never subtract allowances twice or treat incomplete components as complete. The package does not infer peak CU, average CU, active hours, or period extrapolation.

## Upgrade Node and check CLI options

The engine floor rises from v0.3.0's Node.js 22.12 to Node.js 24. Node.js 22 users must upgrade Node or stay on v0.3.0. Ordinary CLI commands, tables, local profiles, SQLite fallback, and the dashboard remain available.

`export` now rejects contradictory or previously ignored options. Explicit history options require history; `--project-ids` requires current. Conflicts and unsupported explicit history exit 1, replacing silent option ignoring or fallback. Current snapshots and safe partial output exit 2; authoritative complete measured output exits 0. See [how measured export works](how-it-works.md#export-measured-usage) for the full source-selection matrix and delivery limit.
