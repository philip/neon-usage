# Neon consumption system design

> **Historical design document.** This is the original architecture proposal
> (2026-08-08), kept for reference. The shipped tool is **neon-usage** — a
> read-only subset of what follows; the mutation, policy, webhook, and hosted
> features, and the broader command surface in the examples below, are design
> vision, much of it unbuilt (see the roadmap in [`DEVELOPMENT.md`](../DEVELOPMENT.md) for what is parked).
> For what actually ships and how it works today, see [`README.md`](../README.md)
> and [`how-it-works.md`](./how-it-works.md).

Status: proposed architecture and delivery plan
Research date: **2026-08-08**
Scope: implementation-agnostic; suitable for a standalone tool, embedded library, hosted application, or an integration with an existing CLI

## 1. Purpose

Design a system that can:

- gather Neon consumption and related resource/configuration data without waking computes;
- retain normalized, lossless historical snapshots;
- answer project, branch, and inferred organization-level usage questions;
- evaluate user-defined limits and policies without conflating observation, notification, and enforcement;
- safely manage Neon's documented native organization spending notifications and project quotas;
- optionally execute external policy automation through a separate, explicitly enabled subsystem;
- reconcile repeated collection, derived totals, estimates, configured controls, and observed outcomes; and
- expose the same semantics through CLI, HTTP, and in-process library interfaces.

This design does **not** assume that the system is part of Neon's official CLI. Interface shells should be thin adapters over the same application modules. It does not rely on undocumented `/account`, invoice, endpoint-consumption, or hard-dollar-cap APIs.

## 2. Source-backed constraints

These constraints are architectural inputs, not implementation preferences.

1. The public invoice-aligned history surfaces are `GET /consumption_history/v2/projects` and beta `GET /consumption_history/v2/branches`. Project history has eight metrics; branch history has six and excludes snapshot storage and extra branches. Both require an organization ID. The branch route also requires one or more project IDs ([consumption guide](https://neon.com/docs/guides/consumption-metrics), [project API](https://neon.com/docs/reference/api/consumption/get-consumption-history-per-project-v2), [branch API](https://neon.com/docs/reference/api/consumption/get-consumption-history-per-branch-v2)).
2. No organization/account consumption-history route or endpoint-level consumption attribution appears in the published Neon OpenAPI. Organization consumption must be labeled as an aggregate inferred from complete project results. Branch compute cannot be reliably split among a primary endpoint and read replicas because history records have no endpoint ID ([published OpenAPI](https://neon.tech/api_spec/release/v2.json), [compute hierarchy](https://neon.com/docs/manage/computes)).
3. Consumption data updates approximately every 15 minutes; Neon recommends at least 15 minutes between polls. The two history routes share an approximate 50-request-per-minute-per-account token bucket, and querying them does not wake suspended computes ([polling guidance](https://neon.com/docs/guides/consumption-metrics#consumption-polling)).
4. Hourly, daily, and monthly queries are limited to the last 168 hours, 60 days, and one year respectively. Project history begins no earlier than 2024-03-01 and actual account history starts on upgrade to an eligible plan. Timestamps are rounded to the requested granularity ([date and granularity rules](https://neon.com/docs/guides/consumption-metrics#date-format-range-and-granularity)).
5. Raw units are CU-seconds, byte-months (the v2 storage metrics), bytes, and branch-hours. Neon uses decimal GB and a fixed 744-hour billing month. These dimensions must not be collapsed into generic "bytes" or silently converted ([usage calculations](https://neon.com/docs/introduction/usage-calculations#converting-raw-values-to-readable-numbers)).
6. Zero-valued requested metrics may be omitted from a response. A known requested metric omitted from an otherwise valid bucket can be projected as zero, but the source omission must remain distinguishable in lossless storage ([response guidance](https://neon.com/docs/guides/consumption-metrics#example-request-and-response)).
7. Neon's organization `spending_limit` is currently a Launch/Scale email-notification threshold. Neon checks it approximately every 15 minutes, emails organization admins at 80% and 100%, and continues running projects and accumulating charges. It is not a hard cap ([spending notifications](https://neon.com/docs/introduction/spending-notifications)).
8. Project `settings.quota` exposes native hard limits for `active_time_seconds`, `compute_time_seconds`, `written_data_bytes`, `data_transfer_bytes`, and `logical_size_bytes`. The first four are current-period cumulative project metrics and are not the same metric family as invoice-aligned v2 history ([quota guide](https://neon.com/docs/guides/consumption-limits), [update project API](https://neon.com/docs/reference/api/projects/update-project)).
9. The current narrative quota guide says `logical_size_bytes` suspends the affected branch compute, while the published OpenAPI description inspected in the companion research says growth writes are rejected while compute can start. The system must preserve this as a disputed/unknown effect until live behavior or official documentation resolves it ([quota guide](https://neon.com/docs/guides/consumption-limits#corresponding-quotas), [published OpenAPI](https://neon.tech/api_spec/release/v2.json)).
10. Setting an organization threshold uses a positive integer number of cents; `0` and `null` are rejected, and clearing uses idempotent `DELETE`. Mutations require organization-admin privileges; reads are available to organization members on supported plans ([spending notification API summary](https://neon.com/docs/introduction/spending-notifications#manage-spending-notifications-with-the-neon-api)).
11. Authentication uses bearer API keys. Personal, organization, and project-scoped keys have different scopes; project-key behavior for an organization-scoped history request requires live validation ([API get started](https://neon.com/docs/reference/api/get-started), [API key types](https://neon.com/docs/manage/api-keys#types-of-api-keys)).

## 3. Explicit non-goals

- Recreate a Neon invoice or claim accounting authority.
- Infer endpoint-level historical consumption.
- Treat a spending notification as enforcement.
- Treat autoscaling maximum or idle timeout as a cumulative usage or dollar budget.
- Mix legacy/current-period quota metrics with invoice-aligned v2 metrics under shared names.
- Depend on an undocumented API discovered in network traffic or downstream code.
- Automatically suspend, resize, delete, or otherwise alter Neon resources merely because a policy evaluated true.
- Require a hosted control plane. A local-only CLI/library deployment remains a valid profile.

## 4. Architectural principles

### 4.1 Raw facts before interpretation

The source response is evidence. Normalization, unit conversion, aggregation, estimation, policy evaluation, and presentation are successive derivations. Each result carries provenance back to a collection run and source payload.

### 4.2 Deep modules at stable seams

Each external interface calls a small set of high-leverage application interfaces. Source pagination, metric omission rules, decimal arithmetic, policy windows, retries, and safety checks stay behind those interfaces rather than leaking into CLI commands or HTTP handlers.

### 4.3 Facts, projections, decisions, and effects are different records

- A **fact** is observed from Neon or another source.
- A **projection** is a deterministic aggregate, conversion, estimate, or joined view.
- A **decision** is a policy evaluation against facts and projections.
- An **effect** is an attempted change or notification.

Persist these independently. Re-evaluation can then change decisions without rewriting evidence, and retries can occur without re-evaluating policy.

### 4.4 Native and external control planes remain separate

The native-control module only manages documented Neon controls. The optional automation module executes user-configured external effects and may propose a native change, but cannot disguise an external loop as Neon-native enforcement.

### 4.5 Conservative uncertainty

Unknown metric, plan, permission, coverage, freshness, disputed effect, or partial pagination states propagate as explicit quality flags. They never become zero, compliant, or safe by default.

## 5. Logical architecture

```text
CLI shell       HTTP shell       Library facade       Scheduled runner
    \               |                 |                    /
     +--------------+-----------------+-------------------+
                            |
                   Application interfaces
                            |
       +--------------------+-----------------------+
       |                    |                       |
 Collection module     Query module          Policy module
       |                    |                       |
 Source adapters       Projection engine      Decision records
       |                    |                       |
 Neon Management API   Canonical store   +--------+---------+
                                            |                |
                                    Native controls   External automation
                                            |                |
                                      Neon adapter     Effect adapters

 Cross-cutting: credential broker, audit log, clock, rate coordinator,
 telemetry, schema/metric catalog, immutable source archive
```

Deployment profiles:

| Profile | State | Scheduling | Mutations | Intended use |
| --- | --- | --- | --- | --- |
| Ephemeral library | Caller memory | Caller | Optional | One-shot integrations and tests |
| Local CLI | Local file/embedded database | OS/user invocation | Interactive | Personal or CI reporting |
| Shared application | Durable database/object storage | Worker/queue | Role-gated | Teams, dashboards, recurring policies |
| Collector plus read replicas | Central durable store | Central scheduler | Separate controller | Larger organizations and least-privilege deployments |

The architecture does not require these to share a language or process. Their contracts and invariants should remain equivalent.

## 6. Deep module boundaries

### 6.1 Source gateway

**Purpose:** hide Neon transport, endpoint schemas, pagination, throttling, retries, and auth while returning source-faithful pages.

```text
SourceGateway.collect(request, sink) -> CollectionReceipt
SourceGateway.readNativeControl(query) -> SourceControlState
SourceGateway.executeNativeCommand(command, requestToken) -> SourceCommandReceipt
```

Interface invariants:

- `collect` emits every accepted page to `sink` before requesting the next page.
- A receipt declares `complete`, `partial`, or `failed`; partial data is never silently complete.
- GET retries are bounded and rate-aware. Ambiguous mutations are not blindly retried.
- Unknown response fields and metric names survive capture.
- The adapter returns server request IDs and status metadata when available but never credentials.

Concrete adapters should initially include only:

- Neon v2 project consumption history;
- Neon beta branch consumption history;
- Neon project/list/detail data needed for names, lifecycle, current-period metrics, and quotas;
- Neon branch/list/detail data needed for names and logical size;
- documented organization spending-notification GET/PUT/DELETE; and
- documented project create/update quota fields.

A Free-plan snapshot adapter can gather documented project and branch snapshots, but its records must use a different source schema and coverage type. It is not a substitute implementation of v2 history ([Free-plan tracking](https://neon.com/docs/introduction/usage-calculations#tracking-usage-on-the-free-plan)).

### 6.2 Collection module

**Purpose:** turn a collection intent into one coherent, resumable snapshot.

```text
Collector.run(CollectionSpec) -> CollectionRun
Collector.resume(runId) -> CollectionRun
```

`CollectionSpec` describes scopes, time window, requested source metrics, freshness tolerance, and source profile. The module owns:

- range/granularity validation;
- project-ID chunking for branch history;
- cursor loop detection and entity deduplication;
- bounded concurrency under one account-level rate budget;
- checkpointing after each page;
- source payload hashing and normalization;
- run-level coverage and quality computation; and
- preventing duplicate concurrent polls for the same logical request.

The interface does not expose page loops. Deleting this module would force every shell and scheduler to reproduce correctness-critical collection behavior, which is why this is a deep module.

### 6.3 Canonical store

**Purpose:** atomically retain source evidence, normalized facts, snapshots, derivation lineage, decisions, effects, and audit events.

```text
Store.commitCollection(run, pages, facts) -> CommitReceipt
Store.query(FactQuery) -> FactSet
Store.appendDecision(decision) -> DecisionReceipt
Store.reserveEffect(effectKey) -> EffectLease
Store.completeEffect(lease, result) -> EffectReceipt
```

The interface promises append-only evidence and idempotent logical writes. Storage adapters may use an embedded database, Postgres, object storage plus an index, or memory. Callers must not rely on physical tables.

### 6.4 Catalog and projection module

**Purpose:** interpret known metric schemas and derive explicitly named views without changing raw facts.

```text
Projector.build(ProjectionQuery) -> ProjectionResult
```

It owns:

- known metric definitions and valid scope/source combinations;
- dimensional conversion using arbitrary-precision decimal arithmetic;
- zero projection for known requested-but-omitted metrics;
- project/branch enrichment from as-of resource snapshots;
- inferred organization aggregation;
- period and plan segmentation;
- optional rate-card estimates; and
- quality/coverage propagation.

Unknown metrics are returned as raw observations. Adding a catalog entry should make them queryable without migrating or rewriting source evidence.

### 6.5 Policy module

**Purpose:** deterministically evaluate declarative policies against a coherent as-of view and return decisions, never perform effects.

```text
PolicyEvaluator.evaluate(policySet, evaluationContext) -> EvaluationReport
```

Inputs include a fixed `asOf`, policy revision, fact cutoff, requested consistency, and missing-data behavior. Outputs include evidence references, result, reason, proposed effects, and next eligible evaluation time. The same inputs must produce the same result.

### 6.6 Native control module

**Purpose:** safely inspect, plan, and apply only documented Neon-native controls.

```text
NativeControls.inspect(scope) -> NativeControlState
NativeControls.plan(intent, expectedState) -> NativeChangePlan
NativeControls.apply(planId, authorization) -> NativeChangeReceipt
NativeControls.reconcile(desiredState) -> ReconciliationReport
```

This module owns read-before-write, semantic diffs, privilege checks, risk classification, preconditions, confirmation requirements, post-write verification, and audit. It has no generic webhook or arbitrary command support.

### 6.7 External automation module

**Purpose:** execute explicitly enabled non-native effects from immutable decision records.

```text
Automation.dispatch(decisionId, effectSpec) -> EffectReceipt
Automation.reconcile(effectId) -> EffectReceipt
```

Adapters may include webhook, email, incident/ticket, queue, or a user-supplied integration. Any future adapter that changes Neon resources must invoke `NativeControls` rather than bypassing its plans and safety checks.

External automation is disabled by default, separately authorized, and visibly labeled `external`. It does not imply that Neon guarantees the policy interval, delivery, or enforcement.

### 6.8 Query module

**Purpose:** provide stable consumption, controls, decisions, and audit contracts to all presentation shells.

```text
Queries.execute(QuerySpec) -> ResultEnvelope
Queries.stream(QuerySpec) -> ResultEnvelope stream
```

It handles pagination, stable sorting, field selection, output schema negotiation, and authorization. It does not format terminal tables or HTML.

## 7. Normalized, lossless domain model

### 7.1 Identity and temporal metadata

```text
TenantId           local isolation identity; never inferred from a Neon org ID
SourceAccountId    credential/rate-limit domain; opaque and locally assigned
OrganizationRef    provider="neon", orgId
ProjectRef         provider="neon", orgId, projectId
BranchRef          provider="neon", orgId, projectId, branchId
EndpointRef        provider="neon", projectId, endpointId (resource metadata only)
```

Names are mutable labels and never keys. Resource metadata is modeled as valid-time snapshots (`observedAt`, optional provider timestamps), so deleted or renamed resources remain joinable to historical consumption.

### 7.2 Collection evidence

```json
{
  "runId": "run_...",
  "tenantId": "tenant_...",
  "source": "neon-management-api",
  "sourceContract": "consumption-history-v2-projects",
  "sourceContractStatus": "stable",
  "requestFingerprint": "sha256:...",
  "requestedAt": "2026-08-08T12:00:00Z",
  "completedAt": "2026-08-08T12:00:03Z",
  "sourceFreshnessHint": "PT15M",
  "status": "complete",
  "pageCount": 3,
  "qualityFlags": [],
  "payloadRefs": ["blob:sha256:..."]
}
```

Each page archive records the canonical request excluding secrets, response body bytes or a lossless parsed form, content hash, cursor-in, cursor-out, HTTP status, fetch time, and provider request ID. Sensitive source fields may be encrypted or selectively retained according to deployment policy, but normalized facts always retain a payload hash and JSON pointer/path.

### 7.3 Consumption observation

```json
{
  "observationId": "obs_...",
  "runId": "run_...",
  "scope": {
    "kind": "project",
    "orgId": "org_...",
    "projectId": "project_..."
  },
  "billingPeriod": {
    "sourcePeriodId": "...",
    "plan": "launch",
    "start": "2026-08-01T00:00:00Z",
    "end": null
  },
  "bucket": {
    "start": "2026-08-07T00:00:00Z",
    "end": "2026-08-08T00:00:00Z",
    "granularity": "daily"
  },
  "metric": {
    "sourceName": "root_branch_bytes_month",
    "catalogId": "neon.root_branch_storage.byte_months.v1"
  },
  "value": {
    "decimalInteger": "758611968",
    "rawUnit": "byte_month"
  },
  "presence": "reported",
  "provenance": {
    "payloadHash": "sha256:...",
    "sourcePath": "/projects/0/periods/0/consumption/1/metrics/1"
  }
}
```

Design decisions:

- Raw integer values cross public interfaces as decimal strings to avoid precision loss.
- `sourceName` is always retained, even when the catalog recognizes the metric.
- `rawUnit` can be `unknown`; ingestion does not reject a future metric merely because interpretation lags.
- Reported observations and projected zeros are distinct. A projected zero references the query's requested metric set and source omission rule; it is not inserted as source evidence.
- Billing plan belongs to the period, not globally to an organization or query.
- Branch observations do not carry a synthetic endpoint ID.
- Organization totals are projections whose scope is `organization_aggregate`, never observations.

### 7.4 Related data

Store related source snapshots in separate typed records rather than widening consumption observations:

- `ResourceSnapshot`: organization/project/branch/endpoint identity, names, lifecycle fields, parent references, and observed provider fields;
- `CurrentPeriodSnapshot`: project cumulative usage fields and period boundaries;
- `BranchSizeSnapshot`: branch logical size and observation time;
- `NativeControlSnapshot`: spending notification, quota, or endpoint configuration as observed;
- `EntitlementObservation`: only plan/feature availability explicitly returned or reliably sourced, with provenance;
- `RateCard`: user-supplied or source-versioned rates, effective interval, currency, allowance rules, and source citation.

No join should overwrite conflicting source facts. A view can select the newest resource name as of the bucket or show `[deleted/unknown]` while retaining IDs.

### 7.5 Quality and coverage

Every result carries:

```text
coverage.status = complete | partial | unavailable | not_applicable | unknown
coverage.scopesRequested / scopesReturned
coverage.timeRequested / timeReturned
coverage.metricsRequested / metricsReturned
freshness.observedAt / expectedSourceLag / age
qualityFlags[]
```

Representative flags include `BETA_SOURCE`, `PAGINATION_INCOMPLETE`, `CURSOR_REPEATED`, `SOURCE_METRIC_UNKNOWN`, `SOURCE_ZERO_OMITTED`, `RESOURCE_METADATA_MISSING`, `PLAN_UNKNOWN`, `AUTH_SCOPE_UNVERIFIED`, `GRANULARITY_APPROXIMATION`, `RATE_CARD_MISSING`, and `DOCUMENTATION_CONFLICT`.

## 8. Source adapter behavior

### 8.1 Project history adapter

- Requests all eight known metrics by default.
- Supports explicit subsets but records the requested set.
- Exhaustively paginates when an organization aggregate or complete report is requested.
- Stops and marks partial on empty pages with a continuation cursor, repeated cursors, repeated entity keys with conflicting bodies, or page caps.
- Retains projects found in history even if current resource listing no longer returns them; deleted-project coverage is not promised beyond what the API actually returns.

### 8.2 Branch history adapter

- Marks every run `BETA_SOURCE`.
- Requires explicit project IDs or obtains them from a complete project inventory/history result.
- Chunks project and branch filters to documented maximums and independently paginates every chunk.
- Does not request or synthesize snapshot storage or extra-branch metrics.
- Attributes observations to branches only, regardless of endpoint inventory.

### 8.3 Current-period and resource adapters

These adapters gather resource labels, period boundaries, current-period quota metrics, quotas, logical sizes, and endpoint configuration. Their metric catalog is separate from invoice history. Snapshot timestamps matter because these are changing states, not bucketed historical facts.

### 8.4 Native control adapter

Supported initial mutations are deliberately narrow:

| Intent | Documented operation | Modeled effect |
| --- | --- | --- |
| Set organization spending notification | `PUT /organizations/{org_id}/billing/spending_limit` with positive integer cents | Native email alerts; usage continues |
| Clear organization spending notification | `DELETE` same path | Removes native email alerts |
| Set/clear project quota fields | Update project `settings.quota`; zero means unlimited | Native quota enforcement |

Endpoint autoscaling/idle configuration may be shown as related data. If mutation support is later added, it remains `CAPACITY_CONFIGURATION`, not budget enforcement. Manual endpoint suspension is not modeled as durable threshold enforcement because normal lifecycle behavior differs from quota suspension ([compute management](https://neon.com/docs/manage/computes)).

## 9. Storage and snapshot strategy

### 9.1 Three layers

1. **Evidence archive:** immutable source pages addressed by content hash; optional for lightweight local use, required for accounting/reconciliation deployments.
2. **Canonical fact store:** normalized observations and temporal snapshots keyed by provider identities and source intervals.
3. **Derived cache:** rebuildable aggregates, converted values, policy windows, and report materializations.

Only the first two are authoritative. Derived cache records include algorithm/catalog revisions and input hashes.

### 9.2 Idempotent keys

Recommended logical identities:

- page: `sourceAccount + sourceContract + canonicalRequest + cursorIn + payloadHash`;
- observation revision: `sourceContract + scope + periodId + bucket + sourceMetric + payloadHash`;
- effective observation: same key without `payloadHash`, resolved by an explicit revision rule;
- resource/control snapshot: `scope + sourceType + observedAt + payloadHash`;
- decision: `policyRevision + asOf + inputSetHash`;
- effect: `decisionId + effectSpecHash + target`;
- native plan: `intentHash + observedStateHash + target`.

Do not assume history is immutable. Metering data can arrive late or be corrected. Re-collection creates a new observation revision; it does not overwrite the earlier payload. Queries default to the latest successfully collected revision and can request `asCollectedAt` for reproducibility.

### 9.3 Collection cadence and overlap

- Default scheduled cadence is no more frequent than every 15 minutes per source account.
- Re-query a bounded overlap window to capture late updates.
- Close older buckets only after a configurable stabilization delay; "closed" means locally stable, not provider-final unless Neon publishes that guarantee.
- Use one distributed rate coordinator per credential/account domain in shared deployments.
- Cache identical recent requests, but permit explicit bypass for diagnosis.

### 9.4 Retention

Retention is deployment policy:

- audit/effect records: longest retention, append-only;
- canonical facts: retain for all required reporting and policy windows;
- raw payloads: retain long enough for schema debugging/reconciliation, encrypted where appropriate;
- derived caches: evict freely.

Deletion must respect tenant requests without erasing shared audit evidence improperly. Store tenant identity separately from provider IDs to avoid cross-tenant collisions.

## 10. Projection and reconciliation

### 10.1 Supported projections

- CU-hours = CU-seconds / 3,600.
- Invoice GB-month = byte-months / 1,000,000,000 for the v2 `*_bytes_month` metrics (they arrive already divided by 744); the legacy `data_storage_bytes_hour` field is byte-hours / 744 / 1,000,000,000.
- Transfer GB = bytes / 1,000,000,000.
- Raw branch-months = branch-hours / 744; billable branch-months additionally require allowance calculation at project/bucket scope ([official formulas](https://neon.com/docs/introduction/usage-calculations)).

Use exact decimal/rational arithmetic internally and round only at presentation. Output includes raw numerator, formula ID, and rounding mode where relevant.

### 10.2 Aggregation rules

- Aggregate only observations with compatible metric catalog definitions and raw units.
- Segment by billing period and plan before cost calculation.
- Sum organization usage only after complete project pagination; otherwise label the total partial.
- Preserve project attribution when calculating allowances. Current public-transfer allowances are per project, and extra-branch allowances are evaluated by project and time bucket ([allowance rules](https://neon.com/docs/introduction/usage-calculations#billing-mechanics)).
- Never sum current-period quota metrics into v2 history metrics merely because descriptions appear similar.

### 10.3 Reconciliation modes

| Mode | Compared records | Purpose |
| --- | --- | --- |
| Source replay | Archived page vs normalized facts | Detect parser/schema regressions |
| Repeat collection | Earlier vs later revision of same bucket | Detect late/corrected metering |
| Hierarchy | Project history vs sum of available branch history | Diagnose branch attribution gaps; not an invariant because two metrics are project-only and beta coverage may differ |
| Current period | Project snapshot vs compatible v2 totals | Directional validation only; categories and timing can differ |
| Cost estimate | Derived estimate vs user-entered bill/weekly figure | Explain rate, allowance, timing, granularity, and rounding variance |
| Control desired state | Stored desired control vs fresh Neon state | Detect drift or out-of-band changes |
| Effect outcome | Intended native/external effect vs observed result | Verify completion and expose unknown outcomes |

Reconciliation emits differences and explanations; it does not rewrite facts. A mismatch becomes an alert only through an explicit policy.

### 10.4 Cost estimation

Cost estimation is an optional projection, not a core ingestion requirement. It requires a versioned `RateCard`, effective dates, explicit currency, plan-specific rates, project-scoped allowance logic, and custom-rate input where applicable. Results are labeled `estimate`, never `invoice` or `amount_due`. Coarser-than-hourly branch data carries `GRANULARITY_APPROXIMATION` because hourly allowance evaluation can differ ([granularity and precision](https://neon.com/docs/introduction/usage-calculations#granularity-and-precision)).

## 11. Policy and effect taxonomy

### 11.1 Policy shape

```json
{
  "id": "compute-warning",
  "revision": 3,
  "selector": {"orgId": "org_...", "projectTags": ["production"]},
  "signal": {
    "kind": "consumption",
    "metric": "neon.compute.cu_seconds.v1",
    "window": "billing_period_to_date",
    "aggregate": "sum"
  },
  "condition": {"operator": ">=", "threshold": "2880000"},
  "dataRequirement": {
    "maxAge": "PT30M",
    "coverage": "complete",
    "onUnknown": "do_not_trigger"
  },
  "effects": [
    {"kind": "EXTERNAL_NOTIFICATION", "channel": "ops-webhook"}
  ],
  "cooldown": "PT24H"
}
```

Policy revisions are immutable. Selectors resolve to concrete targets at evaluation time and are included in decision evidence.

### 11.2 Decision states

`SATISFIED`, `NOT_SATISFIED`, `INSUFFICIENT_DATA`, `STALE_DATA`, `NOT_APPLICABLE`, `ERROR`, and `SUPPRESSED` are first-class outcomes. Only `SATISFIED` may propose effects, and an effect's own authorization gate still applies.

### 11.3 Effect classes

| Class | Example | Enforcement owner | Default execution |
| --- | --- | --- | --- |
| `OBSERVATION_ONLY` | Exit nonzero, annotate dashboard | This system/interface | Automatic |
| `EXTERNAL_NOTIFICATION` | Webhook, email, ticket | External adapter | Automatic if configured |
| `NATIVE_SPENDING_NOTIFICATION_CONFIG` | Set Neon organization email threshold | Neon sends alerts, not enforcement | Approval required |
| `NATIVE_PROJECT_CUMULATIVE_QUOTA` | Set active/compute/write/transfer quota | Neon suspends project computes | Strong approval required |
| `NATIVE_BRANCH_LOGICAL_SIZE_QUOTA` | Set project-wide per-branch logical-size quota | Neon; exact effect disputed in docs | Disabled pending explicit risk acceptance/live validation |
| `NATIVE_CAPACITY_CONFIGURATION` | Autoscaling max, idle timeout | Neon endpoint lifecycle/configuration | Separate opt-in |
| `EXTERNAL_RESOURCE_ACTION` | User integration invokes a runbook | External controller | Disabled by default |

Every effect includes `provider`, `effectClass`, `scope`, `reversibility`, `blastRadius`, `nativeOrExternal`, `requiresApproval`, and an expected observable outcome.

### 11.4 Separation rule

A policy such as "notify at estimated $100" is an external policy based on a local estimate. It is not the same as configuring Neon's native `spending_limit`, which uses Neon's own monthly-charge evaluation and emails admins. The interface must show these as two separate policies even if thresholds have the same number.

## 12. Native control safety, idempotency, and audit

### 12.1 Plan then apply

All mutations are two-phase at the application interface:

1. Read fresh current state.
2. Validate intent and permissions as far as observable.
3. Produce an immutable semantic diff and risk summary.
4. Bind the plan to target, current-state hash, actor, expiry, and nonce.
5. Require the appropriate approval.
6. Re-read immediately before apply; reject stale preconditions.
7. Send one mutation attempt.
8. If transport outcome is ambiguous, mark `UNKNOWN` and reconcile with GET before any retry.
9. Read back and compare desired state.
10. Append audit events for every stage.

### 12.2 Native risk checks

- Spending notification: state explicitly `ALERT_ONLY; projects continue running`.
- Spending clear: use documented `DELETE`, not `PUT 0`.
- Cumulative quota: compare proposed quota to current-period usage. At or below current usage requires a suspension-specific approval and warns about all project computes.
- Transfer quota: warn that it can block operations needed for backup/export or cleanup, as Neon documents ([quota guidelines](https://neon.com/docs/guides/consumption-limits#guidelines)).
- Logical-size quota: surface the documentation conflict and require explicit acceptance; do not promise suspend or write rejection.
- Clear quota: show that zero means unlimited and may remove the condition keeping computes suspended.
- Partial updates: send only intended fields if the documented update semantics support it; verify unrelated quota fields remain unchanged.

### 12.3 Audit event

```json
{
  "eventId": "audit_...",
  "occurredAt": "2026-08-08T12:05:00Z",
  "tenantId": "tenant_...",
  "actor": {"kind": "user", "id": "user_..."},
  "action": "native-control.apply",
  "target": {"kind": "project", "projectId": "..."},
  "planId": "plan_...",
  "decisionId": null,
  "beforeHash": "sha256:...",
  "intendedAfterHash": "sha256:...",
  "providerRequestId": "...",
  "outcome": "verified",
  "reason": "approved change request CR-123",
  "credentialRef": "credential_..."
}
```

Audit data contains credential references and scopes, never secret material. Shared deployments should make audit append-only and separately access-controlled.

## 13. Public output and interface contracts

### 13.1 Stable result envelope

All machine interfaces use a versioned envelope:

```json
{
  "schemaVersion": "1.0",
  "kind": "consumption-report",
  "generatedAt": "2026-08-08T12:10:00Z",
  "asOf": "2026-08-08T12:00:00Z",
  "scope": {"kind": "organization_aggregate", "orgId": "org_..."},
  "source": {
    "provider": "neon",
    "contracts": ["consumption-history-v2-projects"],
    "organizationAggregated": true,
    "beta": false
  },
  "query": {},
  "coverage": {"status": "complete"},
  "data": [],
  "warnings": [],
  "page": {"nextCursor": null}
}
```

Contract rules:

- Raw integers are decimal strings.
- Timestamps are RFC 3339 UTC.
- Enums may gain values; clients must tolerate unknown values.
- Unknown metrics remain in raw output.
- Additive fields are backward compatible within a major schema version.
- Field removal, semantic changes, or unit changes require a major version.
- Stable cursor pagination applies to large result sets and audit logs.
- Errors have stable codes, human messages, retryability, provider request ID, and structured details; they never expose tokens.
- Human formatting is not a contract. JSON/JSONL is.

### 13.2 Example CLI

The executable name is illustrative.

```text
neon-consumption collect --org-id ORG --from 2026-08-01 --to now --granularity daily
neon-consumption usage projects --org-id ORG --last 30d --metrics all --output table
neon-consumption usage branches --org-id ORG --project-id PROJECT --last 7d --output json
neon-consumption usage summary --org-id ORG --billing-period current --output json
neon-consumption resources projects --org-id ORG
neon-consumption controls status --org-id ORG --project-id PROJECT
neon-consumption policies evaluate --policy-file policies.yaml --as-of 2026-08-08T12:00:00Z

neon-consumption controls spending-notification plan --org-id ORG --usd 100.00
neon-consumption controls spending-notification apply --plan-id PLAN --yes
neon-consumption controls spending-notification plan-clear --org-id ORG

neon-consumption controls project-quota plan --project-id PROJECT --compute-time-seconds 2880000
neon-consumption controls project-quota apply --plan-id PLAN --confirm-suspension

neon-consumption reconcile usage --org-id ORG --billing-period current
neon-consumption reconcile controls --org-id ORG
neon-consumption audit list --org-id ORG --since 2026-08-01
```

CLI behavior:

- table output labels organization totals `aggregated from projects`;
- branch commands reject project-only metrics before I/O;
- totals are computed before display limits;
- mutation plans go to the selected output stream without contaminating JSON stdout;
- non-interactive application requires explicit confirmation flags and a reason;
- exit codes distinguish policy breach, incomplete data, authentication, validation, and mutation uncertainty.

### 13.3 Example HTTP interface

```http
POST /v1/collection-runs
GET  /v1/collection-runs/{runId}
GET  /v1/consumption?orgId=...&scope=project&from=...&to=...&granularity=daily
GET  /v1/consumption/summary?orgId=...&period=current
GET  /v1/resources/projects?orgId=...
GET  /v1/native-controls?orgId=...&projectId=...
POST /v1/policy-evaluations
GET  /v1/policy-evaluations/{evaluationId}
POST /v1/native-change-plans
GET  /v1/native-change-plans/{planId}
POST /v1/native-change-plans/{planId}/apply
GET  /v1/reconciliations/{reconciliationId}
GET  /v1/audit-events?orgId=...&cursor=...
```

`POST /native-change-plans/{planId}/apply` accepts an idempotency key and plan approval, not a second mutable copy of the desired state. HTTP authentication/authorization is the host application's concern; provider credentials are resolved server-side by opaque reference.

### 13.4 Example library interface

```ts
type ConsumptionSystem = {
  collect(spec: CollectionSpec): Promise<CollectionRun>;
  query(spec: QuerySpec): Promise<ResultEnvelope>;
  evaluate(spec: EvaluationSpec): Promise<EvaluationReport>;
  planNativeChange(intent: NativeChangeIntent): Promise<NativeChangePlan>;
  applyNativeChange(planId: string, approval: Approval): Promise<NativeChangeReceipt>;
  reconcile(spec: ReconciliationSpec): Promise<ReconciliationReport>;
};
```

The facade accepts injected clock, source gateway, store, credential broker, and telemetry sink. It returns values rather than printing or terminating the process.

## 14. Textual data flows

### 14.1 Scheduled collection

```text
Scheduler -> Collector: run organization/time-window spec
Collector -> Credential broker: obtain scoped credential reference
Collector -> Rate coordinator: reserve read budget
Collector -> Neon source gateway: fetch project page
Neon source gateway -> Collector: return source-faithful page
Collector -> Evidence archive: persist page before continuing
Collector -> Canonical store: checkpoint cursor and normalized observations
Collector -> Neon source gateway: continue until terminal cursor
Collector -> Canonical store: commit coverage-complete run
Collector -> Telemetry: emit freshness, pages, records, throttles, duration
```

### 14.2 Organization report

```text
CLI/HTTP/library -> Query module: organization summary as of T
Query module -> Store: select latest complete project observations at cutoff T
Query module -> Projector: normalize missing known metrics, convert, aggregate
Projector -> Query module: totals plus project attribution and quality
Query module -> Caller: versioned envelope labeled organization_aggregate
```

### 14.3 Policy evaluation and external notification

```text
Scheduler -> Policy evaluator: policy revision + fixed asOf
Policy evaluator -> Query module: coherent fact/projection set
Policy evaluator -> Store: append immutable decision and evidence refs
Policy evaluator -> Automation: proposed EXTERNAL_NOTIFICATION effect
Automation -> Store: reserve idempotency key
Automation -> Webhook adapter: deliver signed event
Automation -> Store: append delivery receipt or retry state
```

### 14.4 Native quota change

```text
Operator -> Native controls: intent + reason
Native controls -> Neon gateway: read project current usage and quotas
Native controls -> Operator: plan, blast radius, preconditions, warnings
Operator -> Native controls: approve immutable plan
Native controls -> Neon gateway: re-read and compare state hash
Native controls -> Neon gateway: one documented update request
Native controls -> Neon gateway: read back state
Native controls -> Audit store: append verified/unknown/failed receipt
Native controls -> Operator: result with provider request ID
```

## 15. Extensibility

### 15.1 New source versions and providers

A source adapter emits source-faithful pages and normalized facts against the canonical model. New source contracts get new identifiers rather than silently replacing semantics. A provider other than Neon can reuse policy/query modules only if its metric definitions and native effect ownership are explicit.

### 15.2 Metric catalog evolution

Catalog definitions are versioned data:

```text
catalogId, provider, sourceContract, sourceName, supportedScopes,
rawDimension, accumulationKind, conversion formulas, omission semantics,
effective interval, documentation source
```

Unknown facts remain queryable before catalog support. A new catalog revision can re-project old evidence without re-ingestion.

### 15.3 Policy extensions

Add signal types and effect adapters through registries with capability declarations. Do not offer arbitrary expression evaluation or shell execution in the core. Custom code runs out of process with a signed, minimized decision payload.

### 15.4 Presentation extensions

Terminal tables, dashboards, Prometheus exporters, and SDKs consume the stable query envelope. They cannot call source adapters directly, which prevents divergent pagination and conversion logic.

## 16. Testing strategy

### 16.1 Contract and fixture tests

- Validate adapters against sanitized source payloads and the published OpenAPI.
- Cover all eight project metrics, all six branch metrics, omitted zeros, unknown fields/metrics, multiple periods/plans, deleted/unknown resources, empty pages, and every documented error.
- Capture fixtures from eligible Launch and Scale organizations where permitted.
- Live-validate personal, organization, and project-scoped key behavior.
- Make beta branch fixtures explicitly versioned.

### 16.2 Property tests

- Pagination terminates under arbitrary empty/repeated/non-advancing cursor sequences.
- Chunking neither drops nor duplicates requested project/branch IDs.
- Normalization plus source-path lookup recovers each source metric exactly.
- Aggregation is order-independent and preserves exact integers.
- Unit conversions are dimensionally valid and round only at presentation.
- Re-running the same collection/effect input is idempotent.

### 16.3 Policy tests

- Golden tests for threshold edges, stale/partial data, missing metrics, unknown plans, cooldowns, billing-period rollover, and late revisions.
- Determinism tests freeze clock, catalog revision, rate card, policy revision, and input-set hash.
- Policies never produce effects from `INSUFFICIENT_DATA` unless that behavior is explicitly configured and risk-approved.

### 16.4 Mutation tests

- Fake adapters test plans, stale preconditions, privilege failures, ambiguous timeouts, verification mismatch, and audit completeness.
- Live tests use disposable projects/organizations where available, smallest safe values, and explicit cleanup.
- Do not live-test suspension against production resources.
- Validate `logical_size_bytes` behavior and plan availability before enabling that effect generally.

### 16.5 End-to-end tests

Run the same scenario through library, HTTP, and CLI shells and compare normalized envelopes. Test local storage migration, hosted concurrent workers, restart from page checkpoints, credential revocation, rate limiting, and retention deletion.

## 17. Observability

### 17.1 Metrics

- collection runs by status/source contract;
- source request count, latency, status, retries, and rate-limit waits;
- time since last complete run and source-data freshness;
- pages, observations, unknown metrics, and correction revisions;
- coverage/quality flags by type;
- projection and query latency/cache hit rate;
- policy decisions by state and policy revision;
- effects proposed/attempted/verified/failed/unknown/suppressed;
- native-control drift and stale-plan rejection;
- audit append failures.

Avoid high-cardinality project/branch IDs in general metrics. Put scoped identifiers in access-controlled traces/logs.

### 17.2 Logs and traces

Use correlation IDs spanning collection run, source request, decision, effect, and audit event. Structured logs include adapter/contract and provider request ID. Redact authorization headers, API keys, URL query secrets, webhook credentials, and sensitive response fields.

### 17.3 Operational alerts

Alert on stale complete snapshots, sustained 403/404/429 rates, parser/schema drift, pagination loops, effect states stuck `UNKNOWN`, control drift, audit write failure, and credential expiry/revocation. Do not alert merely because a metric is absent when the contract permits omitted zero.

## 18. Security and tenancy

- Apply least privilege: use read-only/scoped credentials for collectors and separate admin-capable credentials for native mutation workers.
- Never deliver provider credentials to browsers, CLI output, policy code, or external effect payloads.
- Encrypt credentials with an OS keychain/KMS/secret manager; store only opaque references in records.
- Encrypt raw payload archives and databases where threat model or policy requires it.
- Authorize by local tenant and action, then by provider scope. Possession of an org ID is not authorization.
- Separate roles for report reader, policy author, effect approver, native-control operator, credential administrator, and auditor.
- Require step-up authentication or equivalent strong approval for quota mutations in shared deployments.
- Sign outbound webhooks, include event IDs/timestamps, and support receiver replay protection.
- Enforce SSRF-safe allowlists or brokered destinations for external effects.
- Validate all source and policy data at runtime; cap page count, response size, time range, concurrency, and decimal magnitude to resist resource exhaustion.
- Redact names/IDs according to log destination; usage patterns and resource metadata may be commercially sensitive.
- Record software/schema/policy revisions in audit evidence for reproducibility.

## 19. Phased delivery plan

### Phase 0: contract validation and walking skeleton

Deliver:

- minimal source gateway, in-memory store, and library query facade;
- sanitized project/branch fixtures and OpenAPI contract checks;
- live validation matrix for key scopes, plan eligibility, cursors, quota availability, and logical-size behavior;
- one end-to-end project-history query retaining raw evidence and normalized observations;
- written threat model and mutation safety checklist.

Exit criteria:

- all unknowns are either validated or surfaced as explicit capability/quality states;
- no undocumented route is required;
- one fixture can be replayed into byte-for-byte stable machine output.

### Phase 1: read-only PoC

Deliver:

- complete project collection and inferred organization summaries;
- branch beta collection for explicit projects;
- embedded/local durable store with collection checkpoints;
- related project/branch names and current-period snapshots;
- CLI and library interfaces with JSON and table output;
- exact conversions, coverage metadata, and basic observability.

Defer recurring policies, mutations, hosted HTTP, and cost estimates.

Exit criteria:

- multi-page results are complete and deduplicated;
- raw values and unknown metrics are lossless;
- totals are calculated before presentation limits;
- source failures produce partial/unavailable states, never misleading totals.

### Phase 2: read-only MVP

Deliver:

- shared query envelope and HTTP interface;
- scheduled overlapping collection and correction revisions;
- resource/control snapshots and quota-status views;
- deterministic policy evaluation with observation-only outcomes and external notifications;
- reconciliation reports and full audit for policy/effects;
- role-based hosted deployment profile.

Exit criteria:

- CLI, HTTP, and library return equivalent semantics;
- policies refuse stale/incomplete evidence according to configuration;
- external effects are idempotent, signed where applicable, and separately enabled.

### Phase 3: native control MVP

Deliver:

- inspect/plan/apply/reconcile for organization spending notifications;
- inspect/plan/apply/reconcile for the four cumulative project quota fields;
- read-only handling of logical-size quota until the conflict is resolved or explicitly accepted;
- strong approvals, stale-plan rejection, ambiguous-outcome reconciliation, and append-only audit;
- disposable-resource live mutation suite.

Exit criteria:

- every mutation is read-before-write and read-after-write;
- no policy directly executes a native change without a valid plan/authorization;
- interfaces always disclose effect semantics and blast radius.

### Phase 4: optional estimates and advanced automation

Deliver only after demand and validation:

- versioned/custom rate cards and estimate reconciliation;
- control desired-state drift management;
- approval workflows for policy-proposed native plans;
- additional effect adapters;
- endpoint capacity configuration as a separately labeled capability.

Do not add automatic hard-dollar enforcement unless Neon publishes a native contract or users explicitly choose an external controller whose limitations are clear.

## 20. Explicit decisions

1. **Deployment-neutral core:** the system is not designed specifically as an upstream official CLI feature.
2. **Project history is the organization aggregation base:** there is no assumed `/account` route.
3. **No endpoint consumption model:** endpoint resources may be shown, but history remains branch/project scoped.
4. **Lossless evidence plus normalized facts:** raw payloads and source names survive schema evolution.
5. **Decimal strings at public interfaces:** potentially large counters do not pass through unsafe floating-point integers.
6. **Separate metric families:** invoice history, current-period quota metrics, branch logical size, native spending thresholds, and endpoint configuration do not share a generic `limit` model.
7. **Explicit projection semantics:** reported zero, omitted/projected zero, unknown, unavailable, and partial are distinct.
8. **Organization totals require complete pagination:** partial totals are never presented as organization totals without a warning/status.
9. **Native spending notification is alert-only:** external dollar policies are separate.
10. **Policy evaluation is pure:** it records decisions and proposes effects but does not perform them.
11. **Native changes use immutable plans:** all shells share the same safety and audit path.
12. **Corrections append revisions:** repeated collection never destroys earlier evidence.
13. **Cost is optional and labeled estimate:** rate cards and allowance rules are versioned inputs.
14. **Branch beta status propagates:** it remains visible in records and outputs until Neon declares otherwise.
15. **Logical-size enforcement remains disputed:** write/suspend behavior is not asserted as settled.

## 21. Open questions and validation backlog

### Neon contract questions

- Can a project-scoped key call either v2 history route when `org_id` and project filters match its scope?
- Which current plans/accounts can configure project quotas?
- What is the observed `logical_size_bytes` effect: branch-compute suspension, growth-write rejection, or another behavior?
- How soon after a quota update does suspension or unsuspension occur, and how should existing sessions be expected to behave?
- Are corrected historical buckets expected, and does Neon publish any finalization guarantee?
- What are the exact cursor terminal semantics for empty and deleted-resource cases?
- Is beta branch history complete for deleted branches and all read-replica compute use?
- Which response headers consistently expose request IDs and retry guidance?

### Product decisions

- Is the first deployment local-only, hosted multi-tenant, or both?
- Is raw payload retention mandatory, optional, or prohibited for the target users?
- What freshness and retention objectives are required?
- Should the MVP support Free-plan snapshots, or return an explicit unsupported-history result?
- Which external notification adapters are needed first?
- May policies ever propose native changes, or should that remain operator-only?
- What approval model is acceptable for unattended native mutations?
- Is cost estimation needed before reliable invoice/charge comparison data is available?
- How should resource tags/ownership metadata be sourced without inventing Neon attributes?

### Operational decisions

- Which store adapters and migration guarantees are required?
- How are credentials shared or isolated across organizations and workers?
- What is the maximum supported organization/project/branch scale?
- Which audit retention and tamper-evidence requirements apply?
- What service-level objective should govern collection freshness and effect delivery?

## 22. Primary sources

- [Neon consumption metrics guide](https://neon.com/docs/guides/consumption-metrics)
- [Neon usage and cost calculations](https://neon.com/docs/introduction/usage-calculations)
- [Neon consumption limits guide](https://neon.com/docs/guides/consumption-limits)
- [Neon spending notifications](https://neon.com/docs/introduction/spending-notifications)
- [Neon published OpenAPI v2](https://neon.tech/api_spec/release/v2.json)
- [Neon API key types](https://neon.com/docs/manage/api-keys)
- [Neon compute management](https://neon.com/docs/manage/computes)
