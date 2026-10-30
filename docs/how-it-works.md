# How neon-usage works

## Honesty rules

Every report follows the same rules, whether it reaches you as CLI JSON, a table, or the dashboard:

- **Coverage is explicit.** Every report says `complete` or `partial`; nothing is silently truncated. Quality flags and provider request IDs ride along for support escalation.
- **Only complete buckets.** An in-progress day or month is never presented as if it were finished. The current billing period's live counters are a separate, clearly labeled report (`current-report`).
- **Lossless numbers.** Counters are decimal strings end to end (Neon counters can exceed JavaScript's safe integer range); billing-unit conversion is exact fraction math (`src/metric-catalog.ts`).
- **Money is always an estimate.** Every monetary output carries `disposition: "estimate"` and discloses its exclusions (credits, taxes, contract terms, …). Unknown plans and unpublished rates produce unavailable lines, except Enterprise explicitly uses Scale defaults labeled `PLAN_RATES_ASSUMED`; negotiated contract rates can differ. Windows outside the rate card's effective dates estimate only with an explicit `RATE_CARD_DATE_EXTRAPOLATION` label per line.
- **Staleness is derivable.** Reports carry `generatedAt` (when produced) and `asOf` (the end of the last complete bucket they can reflect).
- **Partial coverage exits 2.** Scripts can distinguish "complete" from "collected with gaps" without parsing.

## Credentials and context

Credentials resolve in order: `--api-key`, `--profile`, `NEON_API_KEY`, `NEON_PROFILE`, then the Neon CLI's stored login — where the default profile follows the CLI's own `profiles.json`, so it tracks `neon auth` wherever it points. `NEON_API_KEY`, `NEON_PROFILE`, and context values (`NEON_ORG_ID`, `NEON_PROJECT_ID`, `NEON_BRANCH`) may also come from the nearest `.env.local`, found walking up from the working directory; an exported environment value always wins. The organization resolves from `NEON_ORG_ID`, then the nearest `.neon`, else it is auto-selected when the credential sees exactly one. A `neon auth` login is an OAuth token that expires (~hourly); this tool only reads it, so when it is stale, rerun `neon auth` (or any `neon` command) to refresh it, or use a non-expiring API key. `neon-usage doctor` shows, offline, exactly what resolved and when it expires.

## Scopes

Every collection also runs under aggregate budgets — defaults: 10 minutes wall-clock, 10,000 entities, 1,000,000 history facts, 100 MB of response bytes, alongside the page cap; the global `--max-duration <minutes>`, `--max-items`, `--max-facts`, and `--max-bytes` flags adjust them. History retains accepted pages as a partial report with the specific limit flag (`TIME_LIMIT_REACHED`, `ITEM_LIMIT_REACHED`, `FACT_LIMIT_REACHED`, `BYTE_LIMIT_REACHED`, `PAGE_LIMIT_REACHED`). Current report/export share their deadline, combined project/branch item allowance, and response-byte budget across the entire walk. Their deadline or an initial inventory limit fails the operation; a later item/byte limit yields partial project/storage coverage, with a fixed `COLLECTION_LIMIT_REACHED` diagnostic in measured output. Serialized machine output is capped at 25 MB per response.

Branch pricing has a separate 100,000-component output budget matching the measured contract. It counts project/source-period/calendar-month identities, so 10,000 projects across 12 months can exceed it even when collection fits its budgets. The shared pricing path fails with `COLLECTION_LIMIT_REACHED` before generating excess lines; export also checks supplied estimates before constructing component arrays. CLI export exits 1 without JSON, and the SDK rejects with that typed code. Shorten the history window to retry. Results within this budget preserve the collected scope and any available exact pricing totals.

Public network transfer allowances are monthly and per project, never pooled across an organization: 5 GB on Free, 500 GB on Launch and Scale, and 100 GB on Agent ([plans](https://neon.com/docs/introduction/plans#public-network-transfer), [Agent plan](https://neon.com/docs/introduction/agent-plan#pricing)). Free per-project storage headroom comes from the live project quota and branch-size reads rather than a baked-in limit; current plan documentation specifies 1 GB per project and 20 GB across all projects ([storage](https://neon.com/docs/introduction/plans#storage)).

Project history also collects Functions active capacity, waiting capacity, invocations, and egress; the branch-history endpoint does not provide these metrics. Database public transfer and Functions egress are separate meters that draw from the same per-project public transfer allowance. Estimates preserve both raw quantities and apply the shared allowance once. Object Storage also shares this allowance, but its egress is not exposed by the project consumption endpoint and remains an explicit exclusion ([Functions pricing](https://neon.com/docs/introduction/plans#functions), [project consumption API](https://neon.com/docs/reference/api/consumption/get-consumption-history-per-project-v2)).

Free includes 10 active Capacity-Hours, 400 waiting Capacity-Hours, and 1 million Function invocations per project each month. Launch and Scale bill those dimensions at their published rates after collection; Functions egress uses the public transfer overage rate after the shared allowance is exhausted.

`project-report` and `estimate` accept `--scope`:

- `organization` — the invoice-aligned whole-organization collection. Projects deleted during the window still bill, and this scope includes them. Typed explicitly it always means the whole organization, overriding the linked-project default that an unscoped `project-report` applies (`estimate` is whole-organization unless scoped). The dashboard labels this **All projects**.
- `live-projects` — collects only currently existing projects (resolved from the project directory). Much faster on organizations with heavy project churn, but **can undercount the invoice**; every surface that shows it says so. Estimates larger than the source's 100-project filter collect in chunks and price the honestly merged report once, so allowances retain their documented scope. The dashboard labels this **Live only (fast)**.

## The local store and serve-from-store

Collections persist to a local SQLite store in a per-user data directory (macOS `~/Library/Application Support/neon-usage/`, Windows `%LOCALAPPDATA%\neon-usage\`, otherwise `$XDG_STATE_HOME` or `~/.local/state/neon-usage/`), overridable with `--store` or `NEON_USAGE_STORE`. One store per user rather than per working directory, so it never litters the folder you run in and serve-from-store works regardless of where the tool is invoked. It records full provenance: response evidence hashes, collection runs, and append-only fact revisions. Reports serve already-collected buckets from that store and collect only what is missing, so a repeat query that once walked the whole organization returns in about a second, and prior months are served from the store without re-collecting. Scope matching is covering, not exact: a completed whole-organization (or superset) run also serves narrower project-scoped queries — clicking one project in the dashboard reuses the stored organization walk — while the reverse never holds, because a run filtered to some projects cannot certify anything about the rest. That is a local performance policy, not a provider finality guarantee: Neon's metering rarely revises a closed bucket, but if you need to catch a late correction, re-collect with `--fresh` or a nonzero `--store-tail`.

Everything served is labeled — `servedFromStore` in report JSON with the range and the original collection time — and:

- `--fresh` bypasses the store and re-collects everything.
- `--store-tail <n>` always re-collects the trailing n buckets (default 0 treats closed buckets as final; raise it to re-catch a late metering correction).
- `--run-id`/`--resume` (explicit collection-run control) always collect.

The store never contains your API key. See [SECURITY.md](../SECURITY.md) for its threat model and limits.

## The dashboard

`neon-usage dashboard` starts a loopback-only HTTP server (127.0.0.1 and ::1) that serves both the JSON routes (`/api/*`) and the built page. Every `/api` request requires a fresh per-process access token (Authorization Bearer): the launch URL carries it in its fragment, which never reaches the server and stays in the address bar — the page re-reads it on every load, so reloads keep working while the server runs, and other local clients cannot read this account's data. The API key stays in the local process; the browser only ever receives report JSON. The JSON routes are held byte-identical to CLI `--output json` by parity tests — the committed route list plus those tests are the contract.

The page is built on Neon's official UI component registry, [ui.neon.com](https://ui.neon.com) ([neondatabase/ui](https://github.com/neondatabase/ui)): its consumption components — the time-series chart, cost-estimate card, per-project table, and storage breakdown — plus the shared design tokens that also drive light/dark theming. Components are vendored (copied in, MIT-licensed) rather than depended on at runtime; see [DEVELOPMENT.md](../DEVELOPMENT.md) for how they were added and updated.

The page is fast-first: it boots on cheap routes (context, organizations, project directory), and gates the heavy sections (cost estimate, snapshot, quota utilization) behind an explicit "collect" action that states its cost. One thing does collect automatically on load: the default **Live only (fast)** view walks live-project history in chunks, which on a large or churn-heavy organization can take up to a few minutes the first time (subsequent loads serve from the store). Identical queries within five minutes are served from an in-process memo; the report's `generatedAt` always states when it was actually collected. Free-plan organizations get a plan-aware page built on the current-period snapshot, since Neon's history API is available on Launch and above.

## Plan capability

`capabilities` reports declared plan capability (a data table) separately from observed endpoint availability. When a plan cannot answer a question — Free organizations and the history API — the CLI and HTTP API refuse with guidance naming what the plan *can* answer rather than silently substituting a different report kind.

## Export measured usage

`export --format measured-usage-json` is the stable, versioned contract for downstream cost tools (for example a cross-vendor estimator that must never see a credential). It is a projection of the same honest reports above, not a new collection:

- **One kind, one vocabulary.** The output is `kind: "measured_billing_usage"` with a `schemaVersion` that bumps only on a breaking change. Consumers must reject an unrecognized version rather than best-effort parse it. Snapshot counters are mapped onto the raw v2 metric names their values are compatible with, so a consumer reads one metric vocabulary regardless of source.
- **Measured, never predicted.** The export answers "what did this consume or cost". It always leaves the comparison sizing inputs (`peakCu`, `avgCu`, `activeHours`) unresolved, because billed CU-hours do not determine a peak or an active-hours denominator. A consumer that wants to rank vendors must supply those separately; the export refuses to fabricate them.
- **Authority is explicit.** `source.authoritative` identifies the billing-history source; `coverage.authoritative` is true only for complete consumption-history v2 coverage. The current-period snapshot is always non-authoritative, its aggregate `metrics` are withheld (null), and its legacy `dataStorageByteHours` is omitted in favor of a separately labeled `pointInTimeStorage` (a live logical-size read, not billed byte-months).
- **Lossless and provenance-preserving.** Every metric carries its raw decimal-string counter and an exact-rational derived value. Projected zeros (a source-omitted row filled with zero) stay distinguishable from reported values via `presence`. Pre-netted billable branch-months are copied verbatim from the pricing estimate so the consumer never re-derives Neon's bucket-aware allowance netting.
- **Scripting.** Exit `0` for authoritative complete output, `2` for partial or non-authoritative output, and `1` for invalid input or a hard failure. `--source auto` uses history only after observing it as available and falls back only on confirmed `unsupported_by_plan`. Forbidden, transient, authentication, and transport failures do not trigger fallback.

Source-specific options select the source and cannot be mixed:

| Explicit options | `--source auto` or omitted | `--source history` | `--source current` |
| --- | --- | --- | --- |
| No history or project options | Capability-based selection | History required | Current snapshot |
| Any history option | History required | History required | Usage error |
| `--project-ids` only | Current snapshot | Usage error | Current snapshot |
| History option plus `--project-ids` | Usage error | Usage error | Usage error |

History options are `--from`, `--to`, `--last`, `--month`, `--granularity`, `--metrics`, `--run-id`, `--resume`, `--fresh`, and `--store-tail`. Explicit defaults still select history. Empty or duplicate comma-separated values fail, and `all` must be the only project-ID token.

CLI JSON delivery is capped at 25,000,000 serialized bytes. Larger documents fail with `SERIALIZED_OUTPUT_TOO_LARGE`; the in-process SDK has separate collection limits.

Validate exported JSON with `parseMeasuredBillingUsage` from `neon-usage/contracts`. Version 0.4.0 emits measured schema 2 and intentionally rejects older schemas; recollect legacy exports instead of inventing omission names, project periods, or complete coverage. History requires billing granularity even when partial; snapshots require explicit `pointInTimeStorage` coverage, including null sizes when unavailable, and need no billing granularity. Metrics unsupported by the source endpoint remain evidence but appear in `coverage.omittedMetrics` with `UNKNOWN_METRIC` when excluded from normalized totals, including globally known snapshot-only metrics returned by history. `metricSelection` states the requested dimensions, and branch allowance components retain separate completeness and approximation status. The parser validates these accounting relationships with bounded exact quantities.

The Node.js 24 SDK uses `createNeonUsageClient` from the root; browser code uses only the pure contracts entry. The [SDK guide](sdk.md) and [migration inventory](public-package-migration.md) describe supported imports and legacy recollection.
