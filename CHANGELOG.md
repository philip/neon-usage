# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.1] - 2026-10-30

### Added

- Added project-level Functions consumption metrics and Launch/Scale cost estimates. Enterprise estimates use labeled Scale defaults. Functions egress and database public transfer share one per-project allowance.

### Changed

- Stopped estimating unpublished Agent rates from Scale defaults.
- Improved dashboard project tables to show all used metrics with compact, grouped, responsive columns and clearer zero values.

### Fixed

- Corrected Free public network transfer netting to apply its 5 GB allowance per project.
- Updated plan guidance for Agent metrics export and the current 1 GB Free storage limit.

## [0.4.0] - 2026-10-30

Version 0.4.0 intentionally breaks the 0.3.x library API. CLI workflows remain, but library consumers must migrate to the root SDK or `neon-usage/contracts`. Removed exports and `neon-usage/hosted` have no compatibility aliases.

### Added

- Added the server-only `createNeonUsageClient` SDK with bounded collection, cancellation, typed errors, and optional shared request limits.
- Added the browser-safe `neon-usage/contracts` entry for measured-usage validation, metric definitions, and exact conversions.
- Added `export --format measured-usage-json` for lossless downstream usage data with explicit metric selection and coverage. Current snapshots remain non-authoritative, and forecasting inputs such as peak CU remain unresolved.
- Added verification for the packed CLI, SDK, browser contracts, and exact release tarball.

### Changed

- Raised the minimum Node.js version from 22.12 to 24. Node.js 22 users must remain on `neon-usage@0.3.0`.
- Replaced the broad 0.3.x library surface, including `neon-usage/hosted`, with the root SDK and contracts entry. See the [migration inventory](docs/public-package-migration.md).
- Bumped the measured-usage contract to schema 2. Recollect schema 1 exports rather than inventing the new integrity fields.
- Made export source selection strict. History options select history, while `--project-ids` selects a current snapshot; conflicting or malformed options now fail instead of being ignored.
- Limited automatic fallback to plans that confirm history is unsupported. Authentication, authorization, transport, and temporary provider failures remain hard failures.
- Standardized measured-export exit codes: `0` for complete authoritative history, `2` for partial or non-authoritative output, and `1` for invalid input or hard failure.
- Stopped explicit current SDK collection from probing the history endpoint.
- Rejected duplicate entries in comma-separated options such as `--project-ids` and `--metrics`; a repeated value now fails instead of being accepted.

### Fixed

- Partial coverage now exits 2 as documented. Earlier releases always exited 0, so scripts using `set -e` may now stop on partial data.
- Explained a keyring-held Neon CLI login instead of reporting that no credential exists, and pointed to the file-backed profile and `NEON_API_KEY` alternatives that work.
- Kept full-metric demo exports within contract limits and made non-authoritative demo exports return exit 2.
- Corrected the Agent plan's public network transfer allowance from 500 GB to 100 GB per project.

## [0.3.0] - 2026-08-20

### Changed

- Increased the default request budget from 45 to 180 requests per minute, speeding up reports for large organizations.
- Improved CLI error messages with clearer descriptions and steps to fix the problem, especially for credential issues.

## [0.2.0] - 2026-08-12

### Added

- Added `--demo`, which runs reports and the dashboard on sample data, with no Neon account needed.

## [0.1.0] - 2026-08-12

Initial release.

[0.4.1]: https://github.com/philip/neon-usage/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/philip/neon-usage/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/philip/neon-usage/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/philip/neon-usage/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/philip/neon-usage/releases/tag/v0.1.0
