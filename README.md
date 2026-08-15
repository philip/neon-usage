# neon-usage

Read-only CLI, local web dashboard, and TypeScript library for [Neon](https://neon.com) usage: what your organization, projects, and branches actually consumed, with lossless numbers, explicit coverage, and labeled cost estimates (never an invoice). Nothing here changes Neon resources.

Unofficial; not affiliated with or endorsed by Neon, Inc. [Apache-2.0](./LICENSE); bundled third-party components credited in [NOTICE](./NOTICE).

![The local dashboard's estimated-price view, rendered from synthetic demo data](https://raw.githubusercontent.com/philip/neon-usage/main/docs/dashboard-demo.png)

The same services drive the terminal (this too is the built-in demo — run it yourself, no account needed):

```text
$ npx neon-usage@latest usage --demo --format price

DEMO MODE: every value is synthetic (fictional organization; no Neon account involved).
Neon cost estimate · org-demo-42813975 · not an invoice
Window: 2026-08-01T00:00:00.000Z -> 2026-08-12T00:00:00.000Z UTC · daily
Rate card: neon-docs-2026-08-08 (documentation, retrieved 2026-08-08)

PROJECT         ID                       COMPUTE  STORAGE  EGRESS  BRANCHES   TOTAL
--------------  -----------------------  -------  -------  ------  --------  ------
api-production  api-production-11837462   $24.63    $2.15  $12.18     $0.00  $38.96
analytics       analytics-90315377        $17.60    $3.11   $0.00     $0.00  $20.71
web-frontend    web-frontend-55118210      $9.05    $0.87   $0.00     $0.00   $9.92
ml-pipeline     ml-pipeline-68821903       $6.45    $1.33   $0.00     $0.00   $7.78
staging         staging-27604154           $3.00    $0.43   $0.00     $0.00   $3.43
--------------  -----------------------  -------  -------  ------  --------  ------
TOTAL                                     $60.73    $7.89  $12.18     $0.00  $80.80
```

## Quick start

```sh
npx neon-usage@latest dashboard --demo  # try it right now: synthetic data, no Neon account needed
npx neon-usage@latest usage --demo      # the same demo, straight to the terminal
```

Then, with your own account:

```sh
npm install -g neon-usage        # or keep using: npx neon-usage <command>

neon auth                        # official Neon CLI, once
neon link
neon-usage dashboard             # local dashboard on http://127.0.0.1:<port>

neon-usage usage                 # or straight to the terminal
neon-usage usage --format price  # the same, in estimated dollars
```

The demo is a fictional organization run through the real report pipeline — deterministic synthetic data, zero credentials, nothing real, and labeled as such (it is how the screenshot above was made). `--demo` works on the report commands too (all but `branch-report`).

A `neon auth` login expires (~hourly) and this tool only reads it. For anything long-running — the dashboard especially — mint a non-expiring API key into a profile once:

```sh
neon profile create neon-usage --mint           # official Neon CLI
neon-usage dashboard --profile neon-usage       # or: export NEON_PROFILE=neon-usage
```

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
| `doctor` | Offline diagnosis: credential, context, store health, budgets |

How the commands behave (details in `--help` and [docs/how-it-works.md](https://github.com/philip/neon-usage/blob/main/docs/how-it-works.md)):

- **Output** — `usage`, `project-report`, `estimate`, `current-report`, `controls`, and `doctor` take `--output table|json`; the rest emit JSON only. JSON is the lossless machine contract (default when piped). Partial coverage is labeled in the report and signaled with exit code 2.
- **Windows** — `--last 7d`, `--month 2026-07|current|previous`, or `--from`/`--to`, with `--granularity hourly|daily|monthly`. Default: the current month to date, daily.
- **Project scope** — per-project commands default to the project linked in the nearest `.neon`. Widen with `--project-ids <ids>` (`all` on `current-report` and `controls`), or with `--scope organization|live-projects` on `project-report` and `estimate` — invoice-aligned versus fast; live scope excludes projects deleted in-window and says so.
- **Budgets** — collections walk the API at 180 requests/minute (`--request-budget`) under aggregate ceilings (`--max-duration`, `--max-items`, `--max-facts`, `--max-bytes`); a hit ceiling stops honestly as `partial` with the specific limit flag.
- **Local store** — collections persist to per-user SQLite and repeat queries serve from it in about a second (`--fresh` recollects; `--store-tail <n>` re-observes the tail; `branch-report` always re-collects). `better-sqlite3` is an optional native dependency: if it can't build, the tool warns once and runs in-memory for the session.
- **Credentials** — `--api-key`, `--profile`, `NEON_API_KEY`, `NEON_PROFILE`, then the Neon CLI's stored login; `.env.local` may supply key, profile, and context values. `neon-usage doctor` shows what resolved and when it expires, offline.

## Dashboard

A local page over the same services: usage by project, history charts, cost estimates, the current-period snapshot, and quota utilization, with a billing-period picker and light/dark themes — built on Neon's official UI registry, [ui.neon.com](https://ui.neon.com). Free-plan organizations get a plan-aware view built on the current-period snapshot.

It binds a fresh ephemeral loopback port behind a fresh per-process access token; your API key never reaches the browser — only report JSON does. The token travels in the URL fragment (never sent to the server) and reloads keep working while the server runs; `--no-open` prints the URL instead of launching a browser. Threat model and limits: [SECURITY.md](https://github.com/philip/neon-usage/blob/main/SECURITY.md).

Collection scope is a visible toggle, honestly labeled: **All projects** (invoice-aligned, slower on large fleets) or **Live only (fast)** (excludes projects deleted in-window — can undercount the invoice, and the page says so).

## Documentation

Full docs live in the repository (the npm package ships only this README, SECURITY.md, and the license files):

- [docs/how-it-works.md](https://github.com/philip/neon-usage/blob/main/docs/how-it-works.md) — honesty rules, scopes, the local store, the dashboard's design
- [SECURITY.md](https://github.com/philip/neon-usage/blob/main/SECURITY.md) — threat model and limits
- [DEVELOPMENT.md](https://github.com/philip/neon-usage/blob/main/DEVELOPMENT.md) — module map and contributing
- [docs/system-design.md](https://github.com/philip/neon-usage/blob/main/docs/system-design.md) — architecture (historical/aspirational in parts)

Versioning: report `schemaVersion` governs output compatibility (additive fields are non-breaking); the package follows semver at `0.x`.
