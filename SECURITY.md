# Security model

This document defines the security boundary for Neon consumption collection and the safety gates required before resource mutation is implemented. The current CLI and application services are read-only. Future mutation support must satisfy the checklist below rather than treating these controls as follow-up hardening.

## Reporting a vulnerability

Please report security issues **privately**, not in a public issue: open a draft advisory via GitHub Security Advisories at `https://github.com/philip/neon-usage/security/advisories/new`. Include reproduction steps and the affected version. You'll get an initial response as soon as practicable; please allow time for a fix before public disclosure.

## Scope and assumptions

- Neon Management API responses, local context files, environment variables, archived payloads, policy input, and HTTP input are untrusted at runtime.
- A Neon organization, project, or branch ID identifies a provider resource; it does not authorize access to that resource.
- Local single-user execution and shared hosted deployments use the same domain invariants. Hosted deployments additionally require tenant isolation, role authorization, encrypted secret storage, and audit controls.
- Neon credentials are bearer secrets. A credential can be broader than the selected local context and must not be inferred to have only project-level authority.
- Usage and resource metadata can be commercially sensitive even when they contain no credential.
- Availability of the Neon API, beta branch history, and provider request completion is not guaranteed.

## Assets

The system protects:

- Neon API keys and future webhook or mutation-worker credentials;
- tenant, organization, project, and branch authorization boundaries;
- exact source evidence and its hashes;
- append-only canonical facts, collection runs, correction revisions, and audit records;
- report coverage, provenance, and replay semantics;
- future mutation intents, plans, approvals, idempotency keys, and outcomes;
- service availability, request budgets, and storage capacity.

## Trust boundaries

1. **Operator to CLI/library:** command arguments, environment variables, `.env.local`, `.neon` context, and profile files enter the process.
2. **Core to Neon:** the source adapter sends authenticated requests and receives untrusted status metadata and response bytes.
3. **Collector to evidence/fact store:** accepted pages cross an integrity boundary before pagination continues.
4. **Store to query/projector:** only complete, provenance-backed observations may produce authoritative organization totals or effective replay views. Replayed store pages re-run the collect path's shape and evidence-linkage validation, so a corrupt or edited store surfaces as a structured integrity failure rather than wrong totals; value-level tampering that preserves shape is out of scope, since the store is the user's own trusted local state (hash-only evidence retention means original response bytes are not kept for re-verification).
5. **Server to browser:** the `dashboard` command's local HTTP server exposes report contracts to a browser, never provider credentials. Controls: it binds a fresh ephemeral port on the loopback interfaces only (127.0.0.1 and ::1); every `/api` request requires a fresh per-process capability as an Authorization Bearer; the launch URL carries that capability in a fragment, which is never sent in HTTP; the fragment stays in the address bar, so reloads keep working while the server runs, and later occupants of a reused loopback origin cannot read a past visit's URL or history; the page and assets themselves are the public app shell. It validates `Host` and exact-origin `Origin`/fetch-metadata headers to defeat DNS rebinding and cross-site requests; API responses carry no-store/nosniff/no-referrer and the page carries CSP, worker denial, and frame denial; and the API key stays server-side, so responses carry only report JSON. Known residual exposure, accepted for a local single-user tool: the launch URL exposes the capability briefly in the browser launcher's process arguments (auto-open) and in stdout or shell history when printed with `--no-open`; a same-UID process can inspect another process; the fragment lands in browser history for the browser profile's lifetime (same-profile exposure as shell history); and the browser tab holding the capability is trusted. Restarting the dashboard rotates both the capability and browser origin, so no persistent reusable localhost origin retains access. Future webhook or external-receiver adapters must uphold the same: result contracts only, no credentials, no unrestricted destinations.
6. **Policy to mutation worker:** a policy decision can propose an effect but cannot directly perform a native Neon change.

Production source adapters must use a fixed or explicitly allowlisted HTTPS Neon API origin. The source constructor enforces a clean `https:` origin (plain HTTP is allowed only for loopback testing) and never follows redirects, so response bytes cannot be silently attributed to a redirect target. An injected `fetch` implementation remains privileged configuration suitable for tests and trusted hosts only. `.env.local` may supply only credential and context values; the environment variables that steer configuration paths and profile selection must come from the real process environment, and a profile's credentials pointer must resolve inside its configuration directory.

## Threats and controls

| Threat | Required control | Residual risk |
| --- | --- | --- |
| Credential disclosure through output, errors, URLs, logs, browser bundles, process arguments, shell history, or evidence | Resolve credentials server-side; never serialize them; redact authorization headers and query secrets; bound provider errors; store only opaque credential references in records; prefer environment or managed profile input over `--api-key` | A compromised process or operator account can access credentials available to that process |
| Cross-tenant or cross-organization access by supplying a resource ID | Authorize the local tenant and action before resolving provider scope; validate returned resources against the requested scope; separate local tenant identity from provider IDs | Provider credentials may legitimately span several organizations, so configuration errors still require operational detection |
| Hostile or changed provider payloads corrupting accounting | Bound response bytes, pages, concurrency, ranges, and decimal magnitude; parse losslessly; validate wire schemas and normalized provenance at runtime; retain unknown metrics without inventing meaning | A semantically incorrect but schema-valid provider response cannot be detected without reconciliation |
| Truncated pagination presented as a complete total | Detect cursor cycles, empty continuation pages, page limits, duplicate entities, and request failures; propagate partial coverage; refuse authoritative organization totals from incomplete project coverage | Provider-side omissions that still terminate normally require independent reconciliation |
| Evidence or fact tampering, overwrite, or revision loss | Hash exact bytes; require payload hash and source path per reported metric; append evidence and revisions idempotently; reject identity conflicts; keep corrections as new revisions; use atomic SQLite transactions for local page commits | Local SQLite is durable across normal process interruption but is not tamper-evident against a compromised host |
| Sensitive evidence or database disclosure | Classify retained source fields; restrict store access; encrypt raw payload archives and databases when deployment policy or threat exposure requires it; keep credentials out of evidence | Authorized storage operators and a compromised process can access plaintext data available to that deployment |
| Replay showing data before it became authoritative | Select only complete collection runs by immutable completion time; support strict `asCollectedAt` cutoffs; exclude partial and failed runs from effective selection | Clock integrity is currently supplied by the host process |
| Resource exhaustion or API budget starvation | Enforce response-size, history-page, project, time-range, decimal, retry, request-deadline, concurrency, and account-rate limits; avoid unbounded provider bodies in errors; add inventory-wide page/deadline budgets before hosted use | Current inventory walks and in-memory retention have no aggregate bound; durable deployments require quotas, retention, backpressure, and resumable collection |
| Malformed or adversarial policy input causing unauthorized scope, excessive work, or unsafe effects | Validate policy schemas and selectors at runtime; bound policy size, conditions, target expansion, and numeric magnitude; authorize referenced scopes and effect types before evaluation | A schema-valid but incorrectly approved policy can still propose harmful effects, which remain gated by immutable plans and approval |
| SSRF or secret delivery through future external effects | Use destination allowlists or a broker; reject redirects to disallowed targets; sign webhooks; omit provider credentials; include event IDs and timestamps for replay protection | Receiver compromise remains outside this system's boundary |
| Unauthorized, stale, duplicated, or ambiguous native mutation | Separate privileged credentials; require immutable inspect/plan/apply flow, authorization, approval, idempotency, stale-state preconditions, post-read verification, and reconciliation | Provider timeout can leave an outcome unknown until a fresh read resolves it |
| Audit suppression | Treat audit append failure as a blocking integrity failure for mutations; alert on audit failures; retain software, schema, policy, actor, approval, and evidence revisions | An administrator with storage-level control may still alter non-tamper-evident audit storage |

## Current read-only guarantees

- CLI commands do not create, update, suspend, or delete Neon resources.
- Source errors expose bounded structured fields rather than arbitrary response bodies; pagination anomalies — repeated cursors, empty continuation pages, page-cap overruns — raise structured errors or explicit coverage flags rather than silent completion, and inventory walks are page-capped.
- Provider strings are bounded per field at the wire schema; names and plans are stripped of control and bidirectional-override characters before terminal rendering, and metric/plan lookups use own-property access so hostile names cannot traverse the prototype chain.
- Evidence sink and fact-store failures are integrity failures, not partial-success warnings. Retained evidence bodies must hash to their payload identity.
- Reported metrics require a lowercase SHA-256 payload identity and absolute source JSON path before callbacks or persistence.
- Projected zeros are query interpretations and are never stored as reported source facts.
- Organization totals require complete project coverage.
- The CLI local database is schema-versioned, created only by commands that persist collection runs, and created with owner-only file permissions; it stores no API key, but usage evidence, resource IDs, and observed project and branch names (append-only snapshots recorded during collection) remain sensitive and require an encrypted filesystem when local disclosure is in scope.
- Configuring a fact store requires an explicit opaque credential-account identity; resuming a run requires exact immutable query, source-contract, and credential-account equality, so runs collected under different credentials never resume into each other. An explicit run ID that already exists is rejected rather than silently replayed; `--resume` is the only replay path. Run IDs remain outside report JSON. The CLI's credential fingerprint is an unsalted SHA-256 of the API key: the key itself is never stored and is not recoverable from the high-entropy digest. The store is account-identifying regardless of the fingerprint — it holds organization and project IDs, resource names, and usage evidence — so treat the store file as sensitive as the credential and protect it accordingly (owner-only permissions by default; an encrypted filesystem when local disclosure is in scope). A per-store salt would add only cross-artifact unlinkability, which the plaintext IDs in the store already dominate, so the fingerprint is left unsalted deliberately.
- Every API request passes through the injected per-account request coordinator; history collection pages, per-request retries/deadlines, concurrency, decimal magnitude, and individual response sizes are bounded. Current inventory walks and in-memory storage remain unsuitable for untrusted hosted scale until aggregate limits and retention exist.

## Mutation safety checklist

Mutation support is not releasable until every applicable item is implemented and tested.

### Capability definition

- [ ] The operation uses a documented Neon API contract and records its contract/version.
- [ ] Policy and effect specifications pass bounded runtime schema validation before evaluation or planning.
- [ ] The effect taxonomy states whether the operation alerts, limits, suspends, configures capacity, or performs an external action.
- [ ] The UI and API disclose blast radius, reversibility, and known plan limitations.
- [x] Logical-size quota enforcement follows current Neon documentation (branch-scoped, persistent, suspends only the affected branch); the earlier documentation dispute is accepted as resolved. All controls remain read-only.

### Identity and authorization

- [ ] The actor is authenticated and authorized by local tenant, action, and provider scope.
- [ ] Report reader, policy author, effect approver, native operator, credential administrator, and auditor roles are separable.
- [ ] Mutation workers use dedicated least-privilege credentials that are unavailable to browsers and policy code.
- [ ] Collectors use separate read-only/scoped credentials and cannot resolve mutation-worker credentials.
- [x] The local dashboard HTTP adapter resolves credentials server-side and never returns provider credentials to clients (loopback-only bind, per-process Bearer capability on /api, Host/exact-origin validation, hardened response headers). Future webhook or external-receiver adapters must do the same.
- [ ] Shared deployments require step-up authentication or an equivalent strong approval for quota mutations.

### Inspect and plan

- [ ] A fresh read captures the target's provider IDs, current state, provider version/ETag when available, and evidence hash.
- [ ] The immutable plan contains desired state, semantic diff, preconditions, risk class, expiry, actor, and input evidence references.
- [ ] Plan IDs and idempotency keys derive from canonical intent and observed-state identities rather than mutable names.
- [ ] A no-op diff produces no mutation request.
- [ ] Stale, expired, already-applied, or superseded plans fail closed.
- [ ] Applying a plan atomically claims a unique dispatch/lease before any provider request; concurrent workers cannot both dispatch it.

### Approve and apply

- [ ] Approval binds the exact immutable plan ID; callers cannot submit a second mutable desired-state body at apply time.
- [ ] High-risk changes require explicit confirmation that names the target and effect.
- [ ] The worker re-reads state immediately before writing and rejects changed preconditions.
- [ ] Retries use one idempotency key and never blindly repeat an ambiguous non-idempotent request.
- [ ] Provider idempotency behavior is documented and tested; if unavailable, ambiguous requests fail closed into reconciliation rather than automatic retry.
- [ ] Rate limits, deadlines, cancellation, and bounded provider errors match read-path safety controls.
- [ ] Production resources are excluded from live suspension tests.

### Verify and reconcile

- [ ] The worker performs a fresh post-write read and compares observed state with the plan.
- [ ] Outcomes are `verified`, `failed`, or `unknown`; timeout and connection loss never imply success or failure without evidence.
- [ ] Unknown outcomes suppress automatic reapplication and enter reconciliation.
- [ ] Reconciliation detects drift and records explanation without rewriting prior facts, plans, or outcomes.
- [ ] Cleanup or rollback is explicit, independently authorized when risky, and verified by another read.

### Audit and operations

- [ ] Intent, plan, actor, approval, credential reference, requests, bounded responses, provider request IDs, verification, and reconciliation are append-only audit events.
- [ ] Audit events record software, source-schema, policy, and plan revisions needed to reproduce the decision and effect.
- [ ] Audit payloads are destination-appropriate, access-controlled, and encrypted or redacted to exclude credentials and unnecessary sensitive provider fields, names, and IDs.
- [ ] Audit persistence succeeds before a mutation is sent and again before a verified outcome is reported.
- [ ] Logs redact credentials and sensitive response fields while retaining one end-to-end correlation ID across collection, decision, effect, and audit events.
- [ ] Metrics cover policy decision states, proposed/attempted/verified/failed/unknown/suppressed effects, stale-plan rejection, control drift, and audit append failure without high-cardinality resource IDs.
- [ ] Alerts cover stale plans, privilege failures, ambiguous outcomes, verification mismatch, control drift, credential revocation, and audit failure.
- [ ] Tests cover stale preconditions, duplicate apply, privilege failure, ambiguous timeout, verification mismatch, audit failure, and disposable-resource cleanup.

## Operational response

If a credential may be exposed, revoke or rotate it in Neon first, then remove it from local files, environment stores, CI secrets, process-launch configuration, shell history, logs, and evidence archives as applicable. Preserve non-secret audit metadata needed to determine affected tenants, requests, and time ranges. If evidence or facts may be corrupted, stop policy and mutation workers, retain the suspect store, recollect into a separate store, and reconcile by payload hash rather than overwriting records.
