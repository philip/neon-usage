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

## Run the standalone CLI

Use Node.js 24 or later for the CLI and SDK. Node.js 22 users must upgrade Node or stay on `neon-usage@0.3.0`, whose minimum is Node.js 22.12.

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
| `export` | Stable, lossless measured-usage JSON contract for downstream cost tools |
| `current-report` | Current billing period's live counters (works on Free) |
| `controls` | Spending notification + project quotas (`--utilization`) |
| `organizations` / `projects` | What the credential can see |
| `capabilities` | Declared plan capability vs observed availability |
| `branch-report` | Beta branch-attributed history |
| `context` | Resolved credential/organization context |
| `doctor` | Offline diagnosis: credential, context, store health, budgets |

How the commands behave (details in `--help` and [docs/how-it-works.md](https://github.com/philip/neon-usage/blob/main/docs/how-it-works.md)):

- **Output:** Human-facing commands support tables and JSON. Partial coverage is labeled and exits 2.
- **History:** Defaults to complete billing periods and persists locally so repeated queries can reuse collected data.
- **Scope:** History can cover the organization or only live projects. Current reports can select specific projects.
- **Credentials:** Uses an explicit API key or profile, environment variables, then the Neon CLI login.

## Export measured usage

```sh
neon-usage export --source history --last 7d --format measured-usage-json > usage.json
neon-usage export --source current --project-ids all --format measured-usage-json > current.json
```

The measured-usage export is a versioned, lossless contract for downstream cost tools. History can be authoritative when coverage is complete; current snapshots are always non-authoritative. The export never invents forecasting inputs such as peak CU.

See [how measured export works](https://github.com/philip/neon-usage/blob/main/docs/how-it-works.md#export-measured-usage) for source selection, exit codes, limits, and coverage rules.

## Collect usage from a Node.js server

Install `neon-usage` and import the SDK from its root. Keep the access token in your server process; the SDK does not discover CLI credentials or manage token refresh.

<!-- README example: history -->

```ts
import { createNeonUsageClient, NeonUsageError } from "neon-usage";

export async function collectHistory(accessToken: string, organizationId: string) {
  const client = createNeonUsageClient({ accessToken });
  try {
    return await client.collectMeasuredUsage({
      organizationId,
      source: "history",
      query: {
        from: "2026-10-23T00:00:00.000Z",
        to: "2026-10-24T00:00:00.000Z",
        granularity: "daily",
        metrics: ["compute_unit_seconds"],
      },
    });
  } catch (error) {
    if (error instanceof NeonUsageError && error.code === "AUTHENTICATION_FAILED") {
      console.error("Refresh the server-held Neon credential before retrying.");
    }
    throw error;
  } finally {
    client.close();
  }
}
```

The result contains capability information, measured usage, and a labeled estimate when history pricing is available. See the [SDK guide](https://github.com/philip/neon-usage/blob/main/docs/sdk.md) for current snapshots, errors, cancellation, limits, and shared request coordination.

## Validate CLI JSON without the SDK

Use the browser-safe `neon-usage/contracts` entry to validate untrusted CLI JSON without importing the server SDK.

<!-- README example: contracts -->

```ts
import { parseMeasuredBillingUsage } from "neon-usage/contracts";

export function parseCliExport(jsonText: string) {
  const input: unknown = JSON.parse(jsonText);
  return parseMeasuredBillingUsage(input);
}
```

The parser preserves exact numeric strings and rejects malformed, inconsistent, or unsupported documents. Check coverage and metric selection before using a complete export for forecasting.

## Migrate library imports and saved exports

Version 0.4.0 intentionally breaks the 0.3.x library API and measured schema 1. See the [migration guide](https://github.com/philip/neon-usage/blob/main/docs/public-package-migration.md) for replacement imports and recollection guidance.

## Dashboard

A local page over the same services: usage by project, history charts, cost estimates, the current-period snapshot, and quota utilization, with a billing-period picker and light/dark themes — built on Neon's official UI registry, [ui.neon.com](https://ui.neon.com). Free-plan organizations get a plan-aware view built on the current-period snapshot.

It binds a fresh ephemeral loopback port behind a fresh per-process access token; your API key never reaches the browser — only report JSON does. The token travels in the URL fragment (never sent to the server) and reloads keep working while the server runs; `--no-open` prints the URL instead of launching a browser. Threat model and limits: [SECURITY.md](https://github.com/philip/neon-usage/blob/main/SECURITY.md).

Collection scope is a visible toggle, honestly labeled: **All projects** (invoice-aligned, slower on large fleets) or **Live only (fast)** (excludes projects deleted in-window — can undercount the invoice, and the page says so).

## Documentation

Full docs live in the repository (the npm package ships this README, CHANGELOG.md, SECURITY.md, and the license files):

- [docs/how-it-works.md](https://github.com/philip/neon-usage/blob/main/docs/how-it-works.md) — honesty rules, scopes, the local store, the dashboard's design
- [docs/sdk.md](https://github.com/philip/neon-usage/blob/main/docs/sdk.md) — SDK sources, errors, cancellation, coordination, and limits
- [SECURITY.md](https://github.com/philip/neon-usage/blob/main/SECURITY.md) — threat model and limits
- [DEVELOPMENT.md](https://github.com/philip/neon-usage/blob/main/DEVELOPMENT.md) — module map and contributing
- [docs/public-package-migration.md](https://github.com/philip/neon-usage/blob/main/docs/public-package-migration.md) — complete 0.3.x library migration inventory
- [docs/system-design.md](https://github.com/philip/neon-usage/blob/main/docs/system-design.md) — architecture (historical/aspirational in parts)

Versioning: report `schemaVersion` governs output compatibility (additive fields are non-breaking); the package follows semver at `0.x`.
