# Development

## Commands

```sh
npm test
npm run typecheck
npm run lint
npm run build
npm run dev -- project-report --help
npm run dev:dashboard            # hot-reloading dashboard on demo data
npm run preview:dashboard        # build the page, then serve your own account
```

Live smoke tests are read-only and use the local `.neon` context plus `.env.local`, `NEON_API_KEY`, or existing Neon CLI credentials. `npm run dev -- capabilities` should work without `--org-id` after `neon link`. Mutation support is outside the current slice.

To work on the page itself, `npm run dev:dashboard` starts the API and the Vite dev server together, so edits under `dashboard/` hot-reload. Open the printed Vite URL (http://localhost:5173); it proxies `/api` to the server on port 4321. This loop serves demo data and disables the API token, so the open port never exposes a real account; Ctrl+C stops both processes. To see the built page against your own account instead, `npm run preview:dashboard` builds it and serves it through the ordinary `dashboard` command, keeping the per-launch token and ephemeral port (a valid credential is required). The orchestrator is a small first-party script, `scripts/dev-dashboard.ts`, with no added dependency.

Sanitized live captures for Free, Launch, and Scale live under `test/fixtures/replay/live` with byte-stable expected output (`test/live-replay.test.ts`). Two live-validated wire behaviors are encoded in the Neon adapter: the `/projects` endpoint terminates with an empty page that still carries a cursor, and `/branches` omits `logical_size` for branches whose size has not been computed (reported as an explicit unknown). Regenerate captures with a recording `fetch` around `createNeonApiSource`; sanitize every organization/project/branch identifier and name, including JSON object keys, and scrub `email`/`created_by` before committing.

## Module map

`src/index.ts` is a pure domain barrel; adapters import domain code only from it. Adapter-to-adapter wiring (the CLI starting the dashboard server, CLI-context resolution) imports the sibling adapter modules directly and stays out of the barrel. The implementation lives in modules grouped by seam (the principal ones below):

**Queries and sources**

- `consumption-query.ts` — query types, RFC 3339/range/granularity validation with complete-bucket flooring, and the single home of the Neon resource-ID rule.
- `consumption-source.ts` — source-facing types and interfaces (`ProjectConsumptionSource`, `BranchConsumptionSource`, `OrganizationSource`, `OrganizationDirectorySource`, `CurrentSnapshotSource`). Transport fakes implement these; tests never mock private methods or the Neon SDK.
- `neon-api-source.ts` — the one Neon Management API adapter: lossless parsing, Zod wire validation, bounded retries/deadlines/response sizes, evidence capture, and structured errors.
- `request-coordinator.ts` — sliding-window account request budget shared by every request a source makes.

**History collection and reports**

- `history-contracts.ts` — runtime-frozen project and branch policy: source contract, endpoint, page size, beta/coverage status, and supported metrics. A future Neon product adds a descriptor here plus a wire adapter, reusing everything below.
- `history-collection.ts` — bounded cursor walking with cycle/empty-page/page-limit detection, durable page commits, and resume.
- `history-projection.ts` — shared period/bucket/metric projection, including projected-zero and unknown-metric semantics.
- `history-facts.ts`, `fact-identity.ts` — canonical facts from source periods; effective-fact and observation-revision identities.
- `history-report.ts` — the one collection-and-projection path both history products share; `createConsumptionService` and `createBranchConsumptionService` are thin wrappers over it.

**Other services and presentation**

- `capability-service.ts` — declared plan capability as a data table, kept separate from observed endpoint availability.
- `current-snapshot-service.ts` — Free-compatible current-period snapshots with per-project coverage errors and bounded fan-out. The project-detail cumulative metrics it reads are the quota-enforcement family and are live; `data_storage_bytes_hour` alone is legacy and observed unpopulated (reported as-is; branch logical size is the storage signal).
- `usage-overview-service.ts` — enriches complete accounting projections with names; never weakens cancellation or evidence-integrity guarantees.
- `controls-service.ts` — read-only inspection of Neon's native controls: the alert-only organization spending-notification threshold and per-project quotas (suspend enforcement), plus the quota-utilization join against current-period usage. The two control kinds are separate domain concepts and never merge.
- `rate-card.ts`, `pricing-estimate.ts` — pricing as a separate projection: an immutable source-cited rate card and an estimator over complete project reports. Exact fraction money math; unknown plans and unpublished rates produce unavailable lines, never guesses; Free is not billed.
- `usage-presenter.ts`, `report-presenter.ts`, `estimate-presenter.ts`, `controls-presenter.ts` — human table rendering for the overview, history time-series and snapshot reports, estimates/price tables, and controls/utilization; presenters collect and reinterpret nothing, and JSON stays the machine contract.
- `machine-json.ts`, `canonical-order.ts` — machine-output bytes and canonical ordering.

**Adapters and composition**

- `adapter-support.ts` — machinery shared by the delivery adapters: string-option parsing into report queries (including `--month`/`?month`), default ranges, organization and project-ID resolution, partial-coverage detection, the `context` report body, `serializeCollections`/`memoizeReports` wrappers, `withPlanHint`, and the `ReportDependencies` seam both adapters call through.
- `default-dependencies.ts` — the composition root: `createNeonDependencies(config)` wires a credential and store path into the real Neon-backed `ReportDependencies` (collecting/reading sources, the durable store with in-memory fallback, serve-from-store, chunked estimation, name enrichment). Adapter-neutral — CLI-specific side effects arrive via callbacks. `defaultStorePath` resolves the per-user store location. Both adapters build identical dependencies through this one seam.
- `demo-dependencies.ts` — the demo composition root (`--demo` on the dashboard and report commands): a deterministic synthetic source wired through the REAL services (collection validation, projection, estimation), so demo reports have genuine shapes and honest coverage; no credential, Neon API, external network, or store is touched, only one fictional organization is served, and the page and CLI both label the output as demo data.
- `bin.ts` — the executable entry point (`neon-usage`); it only imports `runCli` and runs it, so there is no fragile main-module detection under a bin symlink.
- `doctor.ts` — the offline `doctor` diagnosis: credential source and OAuth-expiry state (via `diagnoseNeonCliContext`, which never returns credential values), resolved context, store path/backend/health (read-only SQLite inspection that creates nothing), the built-in request budget, and the bundled rate-card revision.
- `cli.ts` — the command-line adapter over `ReportDependencies`: commander wiring, table/JSON output selection, exit code 2 on partial coverage, and the CLI-specific credential/store/warning glue.
- `dashboard-server.ts` — the local dashboard HTTP adapter: a Hono app mounted on node:http, bound to a fresh ephemeral port on the loopback interfaces (127.0.0.1 and ::1) with Host/exact-origin/fetch-metadata validation (DNS-rebinding and cross-site defense) and a fresh per-process Bearer capability on every /api route (carried in the launch URL fragment, which stays in the address bar so reloads keep working, read by `dashboard/src/lib/auth.ts`), one JSON route per service plus the built page, and an `/api/queue` status route (not part of the report contract) that the page polls while collecting so a request waiting in the serial collection queue says so. Closing the HTTP request cancels its work end-to-end: a queued operation is removed before it dispatches, and an in-flight one aborts once its last memo subscriber leaves (a report still awaited by another request keeps running); cancelled requests map to 408 REQUEST_CANCELLED, oversized serialized reports to 413 (25 MB default). The committed route list plus the CLI/HTTP parity tests (`test/dashboard-server.test.ts`) are the contract; bodies are byte-identical to CLI JSON output, partial coverage stays HTTP 200 in the report, responses carry no-store/nosniff/CSP hardening, and errors map to the existing stable codes (`ConsumptionQueryError` codes → 400, bounded provider details → 502).

**Storage**

- `evidence-fact-store.ts` — the adapter-neutral store contract: evidence, intent, runs, checkpoints, pages, fact revisions, occurrences, append-only resource-name observations, and replay. Writes and reads are asynchronous so a hosted networked store can implement it without a contract change.
- `fact-store-support.ts` — validation and idempotency rules shared by every store implementation.
- `in-memory-fact-store.ts`, `sqlite-fact-store.ts` — implementations with parity tests (`test/evidence-fact-store-parity.test.ts`).
- `stored-history.ts` — serve-from-store: plans which buckets completed runs already certify, replays their stored pages (bucket-owner dedupe), and merges with the freshly collected remainder; reports label served ranges as `servedFromStore`. The re-observation tail defaults to 0 (closed buckets are final; owner decision 2026-08-11) and is adjustable per query.

Each capability is developed as one failing behavior test followed by the minimum implementation needed to pass it.

## Dashboard components (vendored from ui.neon.com)

The web page under `dashboard/` builds its visual layer on Neon's official UI component registry, [ui.neon.com](https://ui.neon.com) ([neondatabase/ui](https://github.com/neondatabase/ui), MIT). The consumption components (`consumption-chart`, `cost-estimate-card`, `branch-usage-table`, `storage-breakdown`), the `neon-loader` brand loading indicator, the shared chart/skeleton primitives under `dashboard/src/components/ui/`, and the design tokens (`tokens.css`, which also drives light/dark theming) were added with the shadcn registry CLI:

```sh
cd dashboard
npx shadcn@latest add https://ui.neon.com/r/<component>.json
```

These are **vendored** (copied into the repo, presentational-first), not a runtime dependency — so we own the source and have made local edits (e.g. `branch-usage-table` gained an `entity` prop so it can label rows "projects", and `ui/chart.tsx` restricts CSS keys). Re-running `shadcn add --overwrite` to pull upstream updates will clobber those edits, so update by diffing, not blind overwrite. `shadcn-tailwind.css` is vendored from the shadcn package because its stylesheet export exists only in prerelease shadcn. Credited in [NOTICE](./NOTICE).

## Transport precision

Consumption and snapshot counters can exceed JavaScript's safe integer range. The Neon adapter uses the public API with `lossless-json` and validates responses with Zod, preserving JSON integers as decimal strings. A defensive 40-digit ceiling bounds arbitrary-precision work against hostile responses; this is a local safety limit, not a published Neon counter limit. Known metric dimensions and exact conversion live in `metric-catalog.ts`; unknown source metrics remain source observations and cannot be assigned an arbitrary billing unit.

Every API request passes through the injected account request coordinator (the CLI defaults to 45 requests/minute; `--request-budget` raises or lowers it, 1-600), with bounded GET retries, request deadlines, and independent cancellation via `OperationContext`; a source may also receive `shutdownSignal` to stop every operation of a shared adapter. A cancelled operation never dispatches its request.

## Evidence and stores

The Neon adapter hashes exact response bytes before UTF-8 decoding and can retain Base64 bodies through an injected evidence sink. Evidence identities include source account, contract, canonical request, cursor, and payload hash. A body must hash to its payload identity; a hash-only record is upgraded in place when the exact body later arrives, so switching retention modes never conflicts. Evidence sink failures are integrity failures and cannot be downgraded to partial coverage.

Provider failures expose bounded structured details (`code`, message, status, request ID, attempts, retryability, retry delay) and never retain arbitrary response bodies. Pagination anomalies — repeated cursors, empty continuation pages, repeated entities — raise structured errors or coverage flags rather than silent completion.

Each history collection receives one opaque run ID; configuring a fact store requires an explicit `sourceAccount` credential identity. Accepted pages commit facts, revisions, occurrences, evidence references, and a checkpoint atomically before the collector requests a continuation page. Exact retries are idempotent everywhere: pages, evidence, and run finalization. Resume requires exact source-account, source-contract, and effective-query equality; cancellation after a committed page leaves the run `running` (resumable), while ordinary failures, continuation defects, page limits, and completion finalize it. Projected zeros are never stored as reported facts, and report JSON does not expose run IDs.

The SQLite store stamps `PRAGMA user_version` (currently 2; v1 stores migrate in place by gaining the append-only `resource_names` table), refuses newer or foreign databases, and waits on busy databases so concurrent invocations do not conflict. The local CLI store is not a substitute for hosted tenant isolation, retention policy, encryption, or tamper evidence; see [`SECURITY.md`](./SECURITY.md).

## Neon tooling

The official `neon` CLI owns authentication and project linking. This package reads compatible context and credentials but never invokes interactive login:

```sh
neon auth
neon link
```

## Limitations & roadmap

The full quality gate is `npm run check` (root typecheck, dashboard typecheck, lint, tests). Development and publishing require a full `npm ci`: the toolchain itself (native TypeScript, Biome, Vitest's Rolldown) ships its platform binaries as npm optional dependencies, so an `--omit=optional` checkout cannot typecheck, lint, test, or build at all — omit-optional source builds are explicitly unsupported (verified empirically). What IS supported is the realistic degraded install: better-sqlite3 present but with its native binding unbuilt or blocked (`--ignore-scripts`, unbuildable platform). SQLite-dependent suites probe and skip there (`test/support/sqlite-availability.ts`), keeping `npm test` green — the same probe-then-degrade behavior the installed product applies at runtime.

Known limitations:

- Large organizations collect slowly: the v2 history endpoint caps `limit` at 100, a cursor walk is serial (~1.3 s/page), and snapshot/quota endpoints cost two requests per project (project record plus branch listing). Serve-from-store, chunked estimation, scoped per-project sections, and memoization mitigate this; the default 45 req/min budget bounds it (`--request-budget` adjusts the dial).
- Only Free, Launch, and Scale plan capabilities are live-validated; Agent, Business, and Enterprise entries in `capability-service.ts` are declared, not observed.

Roadmap (roughly ordered):

- Run chunked collections concurrently under the request coordinator as one run (chunks are sequential today).
- Per-project named rows in the `estimate` table (`renderPriceTable` already has the pattern).
- Named billing-period presets and shell completion once output contracts stabilize.
- Store retention: a read-only `store-status` view plus dry-run/apply pruning by age and terminal state (the evidence/fact store is append-only and grows without bound today).
- A supported high-level TypeScript client (`createNeonUsageClient`): typed report methods and errors, cancellation, `close()`, a stable-vs-advanced export boundary.

The parked hosted-service track (scheduled collection, Postgres store, retention, policies/webhooks, audit, auth) and phase-3 read-write workflows are described as vision in [`docs/system-design.md`](./docs/system-design.md), gated by the [`SECURITY.md`](./SECURITY.md) mutation-safety checklist.
