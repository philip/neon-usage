# neon-usage

Read-only CLI, local web dashboard, and TypeScript library for [Neon](https://neon.com) usage: what your organization, projects, and branches actually consumed, with lossless numbers, explicit coverage, and labeled cost estimates (never an invoice). Nothing here changes Neon resources.

Unofficial; not affiliated with or endorsed by Neon, Inc. [Apache-2.0](./LICENSE); bundled third-party components credited in [NOTICE](./NOTICE).

## Quick start

```sh
npm install -g neon-usage        # or: npx neon-usage <command>

neon auth                        # official Neon CLI, once
neon link
neon-usage dashboard             # local dashboard on http://127.0.0.1:<port>
```

For a dashboard you leave open, mint a non-expiring API key into a profile once and point the tool at it (a `neon auth` login expires hourly — see below):

```sh
neon profile create neon-usage --mint          # official Neon CLI: mints an API key
neon-usage dashboard --profile neon-usage       # or: export NEON_PROFILE=neon-usage
```

Or straight to the terminal:

```sh
neon-usage usage                 # organization overview: totals, active projects
neon-usage usage --format price  # the same, in estimated dollars
```

Credentials resolve from `--api-key`, `--profile`, `NEON_API_KEY`, `NEON_PROFILE`, then the Neon CLI's stored credential — where the default profile follows the CLI's own `profiles.json`, so it tracks `neon auth` wherever it points. `NEON_API_KEY`, `NEON_PROFILE`, and context values (`NEON_ORG_ID`, `NEON_PROJECT_ID`, `NEON_BRANCH`) may also come from the nearest `.env.local` (found walking up from the working directory; an exported value wins). Organization: `NEON_ORG_ID`, then the nearest `.neon`, else auto-selected when the credential sees exactly one.

A `neon auth` login is an OAuth token that **expires (~hourly)**; the official CLI refreshes it, but this read-only tool only reads it, so a stale token is reported plainly (run `neon auth` to refresh). `neon-usage doctor` shows, offline, which credential resolved and when it expires. For anything long-running — the dashboard especially — prefer a non-expiring **API key**. The tidiest way is a minted profile, `neon profile create <name> --mint`, which the tool reads via `--profile <name>` (or `NEON_PROFILE`); a console key in `NEON_API_KEY` works too.

## Commands

| Command | What it answers |
|---|---|
| `usage` | Overview: totals and active projects (`--format gb\|price`) |
| `dashboard` | Local web dashboard over the same services |
| `project-report` | Invoice-aligned per-project history buckets |
| `estimate` | Labeled cost estimate over complete history |
| `organization-summary` | Whole-org totals aggregated from complete project history |
| `current-report` | Current billing period's live counters (works on Free) |
| `controls` | Spending notification + project quotas (`--utilization`) |
| `organizations` / `projects` | What the credential can see |
| `capabilities` | Declared plan capability vs observed availability |
| `branch-report` | Beta branch-attributed history |
| `context` | Resolved credential/organization context |
| `doctor` | Offline local diagnosis: credential source/expiry, context, store health, request budget |

`usage`, `project-report`, `estimate`, `current-report`, `controls`, and `doctor` take `--output table|json` (JSON is the machine contract; default when piped); the other commands emit JSON only. Report commands take `--org-id`; history commands (`usage`, `project-report`, `estimate`, `organization-summary`, `branch-report`) additionally take windows via `--from`/`--to`, `--last 7d` (units follow `--granularity`: h/d/w for hourly, d/w for daily, mo for monthly), or `--month 2026-07|current|previous`, with `--granularity hourly|daily|monthly`. With no window given, the daily default is the current month to date (the billing-period view). Partial coverage is labeled in the report and signaled with exit code 2.

By default, per-project commands (`project-report`, `branch-report`, `current-report`) report the **one project linked in the nearest `.neon`** — a couple of requests, not a whole-org fan-out. `--org-id` selects the organization, not the projects; to widen the project set use `--project-ids <ids>`, `--project-ids all` (`current-report`, `controls`), or `--scope live-projects` (all currently-existing projects). `project-report` and `estimate` accept `--scope organization|live-projects` (invoice-aligned vs fast); those two plus `usage` and `organization-summary` accept `--fresh` (ignore the local store) and `--store-tail <n>` (`branch-report` always re-collects and takes none of the three). Collections walk the API under an account request budget of 45 requests/minute by default — the global `--request-budget <perMinute>` flag (1-600) raises or lowers it, at your own rate-limit risk. Each collection also runs under adjustable aggregate ceilings (`--max-duration <minutes>`, `--max-items`, `--max-facts`, `--max-bytes`); past one, the report stops honestly as `partial` with the specific limit flag. Collections persist to a local SQLite store and repeat queries serve from it in about a second — see [docs/how-it-works.md](https://github.com/philip/neon-usage/blob/main/docs/how-it-works.md) for scopes, serve-from-store, and the honesty rules every report follows.

Persistence uses `better-sqlite3`, an **optional** native dependency. If it can't build (an unsupported platform, or an npm policy that blocks install scripts), the tool still works — it warns once and runs against an in-memory store for that session, losing only persistence and serve-from-store speed. Reinstalling so the native binary builds restores it.

## Dashboard

`neon-usage dashboard` serves a local web page on a fresh ephemeral loopback port, guarded by a fresh per-process access token that keeps other OS accounts, hostile web pages, and blind local clients out. Your API key never reaches the browser; only report JSON is sent to the page. The dashboard is built on Neon's official UI component registry, [ui.neon.com](https://ui.neon.com), and shows usage by project, history charts, cost estimates, the current-period snapshot, and quota utilization, with a billing-period picker and light/dark themes. It opens your browser automatically; with `--no-open` (or `BROWSER=none`) it prints the token-carrying URL instead. The token is carried in the URL fragment, which is not sent to the server; it stays in the address bar, so reloading the page keeps working while the server runs. Restart the command and use its newly opened or printed URL to reconnect.

It offers two collection **scopes**, honestly labeled:

- **All projects** — the invoice-aligned whole-organization collection (the CLI's explicit `--scope organization`). Complete, but slower on large organizations.
- **Live only (fast)** — collects history for currently existing projects only (`--scope live-projects`). Much faster on large or churn-heavy organizations, but **can undercount the invoice**: projects deleted during the window still bill and are excluded, which the page states plainly.

Free-plan organizations get a plan-aware view built on the current-period snapshot, since Neon's consumption history API is available on Launch and above.

## Documentation

Full docs live in the repository (the npm package ships only this README, SECURITY.md, and the license files):

- [docs/how-it-works.md](https://github.com/philip/neon-usage/blob/main/docs/how-it-works.md) — honesty rules, scopes, the local store, the dashboard's design
- [SECURITY.md](https://github.com/philip/neon-usage/blob/main/SECURITY.md) — threat model and limits
- [DEVELOPMENT.md](https://github.com/philip/neon-usage/blob/main/DEVELOPMENT.md) — module map and contributing
- [docs/system-design.md](https://github.com/philip/neon-usage/blob/main/docs/system-design.md) — architecture (historical/aspirational in parts)

Versioning: report `schemaVersion` governs output compatibility (additive fields are non-breaking); the package follows semver at `0.x`.
