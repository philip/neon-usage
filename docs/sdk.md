# Use neon-usage as a library

The root `neon-usage` entry is a server-only SDK. Your application supplies a current Neon access token, owns token refresh, and authorizes the requested organization. Use `neon-usage/contracts` in browser code or anywhere that only needs to validate measured-usage JSON.

The [README](../README.md#collect-usage-from-a-nodejs-server) shows a complete history collection. History covers the organization and can include a labeled pricing estimate. Current snapshots are non-authoritative and return `estimate: null`.

## Collect a current snapshot

<!-- README example: current -->

```ts
import { createNeonUsageClient as createCurrentClient } from "neon-usage";

export async function collectCurrent(accessToken: string, organizationId: string) {
  const client = createCurrentClient({ accessToken });
  try {
    return await client.collectMeasuredUsage({
      organizationId,
      source: "current",
      projectIds: ["project-fixture"],
    });
  } finally {
    client.close();
  }
}
```

Omit `projectIds` to include all projects. The SDK rejects empty or duplicate project and metric arrays with `INVALID_INPUT`; it does not use the CLI's `"all"` sentinel.

Omit `source` to use automatic selection. Automatic selection uses history when it is available and falls back to current only when the plan confirms that history is unsupported. Authentication, authorization, transport, and temporary provider failures do not trigger fallback.

## Handle lifecycle and errors

One client permits one active operation. Pass `{ signal }` as the second argument to a collection call, or as the options argument to inventory and capability methods. `close()` cancels active work, is safe to call more than once, and prevents new operations.

Operational failures reject with `NeonUsageError`. Handle its `code` rather than matching its message:

- `INVALID_INPUT`
- `AUTHENTICATION_FAILED`
- `AUTHORIZATION_FAILED`
- `UNSUPPORTED_CAPABILITY`
- `PROVIDER_UNAVAILABLE`
- `COLLECTION_LIMIT_REACHED`
- `CANCELLED`
- `CLIENT_BUSY`
- `CLIENT_CLOSED`
- `INTEGRITY_FAILURE`

Errors contain package-owned messages and may include a bounded provider status or request ID. They do not expose raw provider response bodies or causes. A safe partial collection returns measured usage with explicit coverage instead of throwing. Standalone inventory methods fail rather than return an unlabeled truncated list.

## Share a request budget

Each client enforces its own request limit. Applications with multiple clients in one process can also share a coordinator:

<!-- README example: coordinator -->

```ts
import {
  createNeonUsageClient as createCoordinatedClient,
  type RequestCoordinator,
} from "neon-usage";

export async function listWithSharedCoordinator(
  accessToken: string,
  requestCoordinator: RequestCoordinator,
) {
  const first = createCoordinatedClient({ accessToken, requestCoordinator });
  const second = createCoordinatedClient({ accessToken, requestCoordinator });
  try {
    return await Promise.all([first.listOrganizations(), second.listOrganizations()]);
  } finally {
    first.close();
    second.close();
  }
}
```

Create a process-local coordinator with `createSlidingWindowRequestCoordinator({ limit, intervalMs })`. Separate processes do not share its state. For distributed admission, provide a host-owned `RequestCoordinator` whose `acquire(signal?)` method waits for account-wide admission.

## Configure collection limits

Pass positive integer limits when creating a client. Values cannot exceed `MAX_CLIENT_LIMITS`.

| Limit | Default | Maximum |
| --- | ---: | ---: |
| `maxPages` | 1,000 | 10,000 |
| `maxDurationMs` | 600,000 | 3,600,000 |
| `maxItems` | 10,000 | 10,000,000 |
| `maxFacts` | 1,000,000 | 100,000,000 |
| `maxBytes` | 100,000,000 | 1,000,000,000 |
| `maxProjects` | 1,000 | 10,000 |
| `concurrency` | 5 | 100 |
| `requestsPerMinute` | 180 | 600 |
| `maxResponseBytes` | 10,000,000 | 100,000,000 |

Project inventory stops at 100 pages and branch inventory at 1,000 pages. Current project scopes must fit `maxProjects`. Collection limits bound accepted work and retained data, but applications still need their own authorization, tenant isolation, and durable-storage policies.

Branch pricing has a separate 100,000-component limit. A component represents a project, source period, and calendar month, including zero or unavailable pricing lines. Shorten the history window if pricing fails with `COLLECTION_LIMIT_REACHED` despite collection fitting its limits.

## Validate measured usage

Parse untrusted CLI or stored JSON with `parseMeasuredBillingUsage` from `neon-usage/contracts`. The parser preserves exact numeric strings and rejects malformed documents, unsupported schema versions, and inconsistent accounting relationships.

Complete history coverage does not prove that the query selected every metric a forecast needs. Check `coverage.authoritative`, `metricSelection`, `coverage.omittedMetrics`, and branch-component status before applying forecasting policy. Schema 1 documents must be recollected with version 0.4.0; do not invent missing fields.
