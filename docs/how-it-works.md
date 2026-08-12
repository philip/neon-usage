# How neon-usage works

## Honesty rules

Every report follows the same rules, whether it reaches you as CLI JSON, a table, or the dashboard:

- **Coverage is explicit.** Every report says `complete` or `partial`; nothing is silently truncated. Quality flags and provider request IDs ride along for support escalation.
- **Only complete buckets.** An in-progress day or month is never presented as if it were finished. The current billing period's live counters are a separate, clearly labeled report (`current-report`).
- **Lossless numbers.** Counters are decimal strings end to end (Neon counters can exceed JavaScript's safe integer range); billing-unit conversion is exact fraction math (`src/metric-catalog.ts`).
- **Money is always an estimate.** Every monetary output carries `disposition: "estimate"` and discloses its exclusions (credits, taxes, contract terms, …). Unknown plans and unpublished rates produce unavailable lines, never guesses. Windows outside the rate card's effective dates estimate only with an explicit `RATE_CARD_DATE_EXTRAPOLATION` label per line.
- **Staleness is derivable.** Reports carry `generatedAt` (when produced) and `asOf` (the end of the last complete bucket they can reflect).
- **Partial coverage exits 2.** Scripts can distinguish "complete" from "collected with gaps" without parsing.

## Scopes

Every collection also runs under aggregate budgets — defaults: 10 minutes wall-clock, 10,000 entities, 1,000,000 facts, 100 MB of response bytes, alongside the page cap; the global `--max-duration <minutes>`, `--max-items`, `--max-facts`, and `--max-bytes` flags adjust them. A budget that runs out never fails the report: it stops collecting, keeps what was accepted, and labels the result `partial` with the specific flag (`TIME_LIMIT_REACHED`, `ITEM_LIMIT_REACHED`, `FACT_LIMIT_REACHED`, `BYTE_LIMIT_REACHED`, `PAGE_LIMIT_REACHED`) — the same honesty rule as any other gap. Serialized machine output is capped at 25 MB per response.

`project-report` and `estimate` accept `--scope`:

- `organization` — the invoice-aligned whole-organization collection. Projects deleted during the window still bill, and this scope includes them. Typed explicitly it always means the whole organization, overriding the linked-project default that an unscoped `project-report` applies (`estimate` is whole-organization unless scoped). The dashboard labels this **All projects**.
- `live-projects` — collects only currently existing projects (resolved from the project directory). Much faster on organizations with heavy project churn, but **can undercount the invoice**; every surface that shows it says so. Estimates larger than the source's 100-project filter collect in chunks and price the honestly merged report once, so per-organization allowances apply exactly once. The dashboard labels this **Live only (fast)**.

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
