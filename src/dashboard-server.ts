// Local dashboard HTTP layer: a thin Hono app over the same dependencies the
// CLI uses, mounted on node:http and bound to the loopback interfaces only
// (127.0.0.1 and ::1). Each route
// parses with the shared adapter machinery, calls the injected service, and
// returns the report bytes serializeMachineJson produces — the parity tests
// hold HTTP bodies byte-identical to CLI JSON output for the same query.
//
// The committed route list plus those parity tests are the contract; there is
// deliberately no OpenAPI generation while the dashboard is the only consumer.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import {
  assertWithinHistoryFilter,
  CollectionQueueFullError,
  type CollectionQueueState,
  commaSeparatedValues,
  contextReport,
  defaultHistoryProjectIds,
  historyQueryFromOptions,
  historyScopes,
  liveProjectIds,
  memoizeReports,
  type ReportDependencies,
  resolveControlsProjectIds,
  resolvedContext,
  resolveOrganizationId,
  serializeCollections,
  withPlanHint,
} from "./adapter-support.js";
import { ConsumptionQueryError } from "./consumption-query.js";
import {
  ConsumptionSourceIntegrityError,
  sanitizeErrorText,
  toSourceErrorDetail,
} from "./errors.js";
import { SerializedOutputTooLargeError, serializeMachineJson } from "./machine-json.js";
import {
  NeonApiError,
  NeonEvidenceError,
  NeonResponseError,
  NeonTransportError,
} from "./neon-api-source.js";
import {
  isCancellationFailure,
  OperationCancelledError,
  type OperationContext,
} from "./operation-context.js";

/** The committed JSON route list — with the parity tests, this is the contract. */
export const dashboardApiRoutes = [
  "/api/context",
  "/api/controls",
  "/api/current-report",
  "/api/estimate",
  "/api/organizations",
  "/api/project-report",
  "/api/projects",
  "/api/usage",
  "/api/utilization",
] as const;

export type DashboardRuntime = { now(): Date };

export type DashboardServer = {
  /** Base origin, without the capability token. */
  url: string;
  /** The URL to open: carries the one-time capability token when enabled. */
  pageUrl: string;
  /** The API capability token, for Authorization: Bearer use; undefined when disabled. */
  token?: string;
  port: number;
  close(): Promise<void>;
};

/** A request the handler itself rejected: bad parameter, missing capability. */
class DashboardRequestError extends Error {
  override readonly name = "DashboardRequestError";
  constructor(
    readonly status: 400 | 501,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function choice<T extends string>(value: string, allowed: readonly T[], parameter: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new DashboardRequestError(
      400,
      "INVALID_REQUEST",
      `${parameter} must be one of: ${allowed.join(", ")}`,
    );
  }
  return value as T;
}

function unavailable(capability: string): DashboardRequestError {
  return new DashboardRequestError(
    501,
    "CAPABILITY_UNAVAILABLE",
    `${capability} is unavailable in the configured dependencies`,
  );
}

/**
 * Maps a thrown error onto the existing stable codes: query validation keeps
 * its ConsumptionQueryError code (400), provider failures keep their bounded
 * structured detail (502; the upstream status rides in detail.status),
 * evidence-integrity failures are never downgraded (500), and plain Errors
 * from the shared option machinery are input problems (400). Anything else is
 * an internal fault (500) with a sanitized message.
 */
function errorResponse(error: unknown): {
  status: 400 | 408 | 413 | 500 | 501 | 502 | 503;
  body: string;
} {
  const body = (
    status: 400 | 408 | 413 | 500 | 501 | 502 | 503,
    detail: Record<string, unknown>,
  ) => ({
    status,
    body: serializeMachineJson({ error: detail }),
  });
  if (error instanceof CollectionQueueFullError) {
    // A capacity condition, not a bad request: retriable by status.
    return body(503, { code: "SERVICE_BUSY", message: error.message });
  }
  if (error instanceof SerializedOutputTooLargeError) {
    return body(413, {
      code: error.code,
      message: error.message,
      actualBytes: error.actualBytes,
      maxBytes: error.maxBytes,
    });
  }
  if (error instanceof OperationCancelledError || isCancellationFailure(error)) {
    return body(408, {
      code: "REQUEST_CANCELLED",
      message: error instanceof Error ? error.message : "The request was cancelled",
    });
  }
  if (error instanceof DashboardRequestError) {
    return body(error.status, { code: error.code, message: error.message });
  }
  if (error instanceof ConsumptionQueryError) {
    return body(400, {
      code: error.code,
      message: error.message,
      ...(error.field ? { field: error.field } : {}),
    });
  }
  if (
    error instanceof NeonApiError ||
    error instanceof NeonTransportError ||
    error instanceof NeonResponseError ||
    error instanceof NeonEvidenceError
  ) {
    const detail = toSourceErrorDetail(error);
    return body(502, { ...detail, message: withPlanHint(detail.message, detail.status) });
  }
  if (error instanceof ConsumptionSourceIntegrityError) {
    return body(500, {
      code: "SOURCE_INTEGRITY_FAILURE",
      message: sanitizeErrorText(error.message, 500),
    });
  }
  if (error instanceof RangeError) {
    return body(400, { code: "INVALID_REQUEST", message: sanitizeErrorText(error.message, 500) });
  }
  if (error instanceof Error && error.constructor === Error) {
    return body(400, { code: "INVALID_REQUEST", message: sanitizeErrorText(error.message, 500) });
  }
  return body(500, {
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? sanitizeErrorText(error.message, 500) : "Internal error",
  });
}

const granularities = ["hourly", "daily", "monthly"] as const;

/** A loopback authority (host[:port]) is the only Host this server answers. */
function isLoopbackHost(value: string | undefined): boolean {
  if (!value) return false;
  const host = value
    .replace(/:\d+$/, "")
    .replace(/^\[(.+)\]$/, "$1")
    .toLowerCase();
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/**
 * An acceptable Origin is not merely loopback — it must be THIS server's own
 * origin, i.e. its host:port must equal the request's Host header. A page
 * served from another localhost port is a different (possibly hostile) origin
 * that could otherwise fire collection-triggering requests.
 */
function isOwnOrigin(origin: string, requestHost: string): boolean {
  try {
    const parsed = new URL(origin);
    return (
      // This server only ever speaks plain http on loopback; an https origin
      // with the same authority is a different origin.
      parsed.protocol === "http:" &&
      isLoopbackHost(parsed.host) &&
      parsed.host.toLowerCase() === requestHost.toLowerCase()
    );
  } catch {
    return false;
  }
}

/** Constant-time token equality over sha256 digests (inputs may differ in length). */
function tokenMatches(candidate: string | undefined, expected: string): boolean {
  if (!candidate) return false;
  return timingSafeEqual(
    createHash("sha256").update(candidate).digest(),
    createHash("sha256").update(expected).digest(),
  );
}

function bearerToken(authorization: string | undefined): string | undefined {
  // The auth scheme is case-insensitive per RFC 7235.
  return authorization && /^bearer /i.test(authorization)
    ? authorization.slice(7).trim()
    : undefined;
}

// Every JSON response — success, error, 403, 404 — carries the same hardening:
// never cached, never sniffed into another type, no referrer leakage. A FRESH
// object per response: @hono/node-server's Response override mutates the
// headers init it is given (it stamps the computed content-length onto it), so
// a shared object would freeze the first response's length onto every later
// one and truncate their bodies.
const jsonResponseHeaders = () => ({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
});

function jsonError(status: number, code: string, message: string): Response {
  return new Response(serializeMachineJson({ error: { code, message } }), {
    status,
    headers: jsonResponseHeaders(),
  });
}

const assetContentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

/**
 * The built page ships as dist/dashboard next to the compiled server; a tsx
 * run from src/ reaches the same build one level up. No build present is a
 * supported state — the JSON route index serves at / instead.
 */
export function defaultAssetsDirectory(): string | null {
  for (const candidate of ["./dashboard/", "../dist/dashboard/"]) {
    const directory = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(join(directory, "index.html"))) return directory;
  }
  return null;
}

export type DashboardAppOptions = {
  /** Directory of the built page; undefined resolves the default, null disables it. */
  assetsDirectory?: string | null;
  /** Per-query report memo TTL; defaults to 5 minutes, 0 disables. */
  reportTtlMs?: number;
  /** Maximum serialized report response; defaults to 25 MB. */
  maxJsonBytes?: number;
  /**
   * Startup capability required on every /api request as an Authorization
   * Bearer. The launch URL carries it in a fragment, which the page re-reads
   * on every load; the page and assets themselves stay public
   * (they are the app shell, not data). Undefined disables enforcement
   * (embedding/tests).
   */
  apiToken?: string;
};

export function createDashboardApp(
  rawDependencies: ReportDependencies,
  runtime: DashboardRuntime = { now: () => new Date() },
  options: DashboardAppOptions = {},
): Hono {
  // The page requests several reports at once; collections must not
  // interleave on the shared store (see serializeCollections). The memo sits
  // outside the queue so an identical query inside the TTL never waits.
  let queueState: CollectionQueueState = { running: 0, queued: 0 };
  const dependencies = memoizeReports(
    serializeCollections(rawDependencies, {
      onQueueChange: (state) => {
        queueState = state;
      },
    }),
    {
      ...(options.reportTtlMs !== undefined ? { ttlMs: options.reportTtlMs } : {}),
      now: () => runtime.now().getTime(),
    },
  );
  const app = new Hono();

  // DNS-rebinding defense. The only legitimate clients reach this server as a
  // loopback host; any other Host — or any cross-origin Origin — is a browser
  // that resolved an attacker-controlled name to 127.0.0.1 to read the API
  // same-origin, which loopback binding and the absent-CORS posture cannot
  // stop on their own. Allow any port: the server never learns its own bound
  // port (0 picks an ephemeral one).
  app.use("*", async (c, next) => {
    // The node server builds the request URL from the Host header, so the URL
    // authority is a faithful fallback when the header isn't separately exposed
    // (e.g. Hono's in-process request()); a rebinding attacker's Host still
    // appears in both.
    const host = c.req.header("host") ?? new URL(c.req.url).host;
    if (!isLoopbackHost(host)) {
      return jsonError(403, "FORBIDDEN_HOST", "Unrecognized Host header");
    }
    const origin = c.req.header("origin");
    if (origin !== undefined && origin !== "null" && !isOwnOrigin(origin, host)) {
      return jsonError(403, "FORBIDDEN_ORIGIN", "Cross-origin request refused");
    }
    if (origin === "null") {
      // An opaque origin (sandboxed iframe, some file:// pages) is never the
      // dashboard's own page.
      return jsonError(403, "FORBIDDEN_ORIGIN", "Opaque origin refused");
    }
    // Refuse foreign-site requests even without an Origin header (e.g. a
    // hostile page's <img>/<script> GET, which carries no Origin but would
    // still trigger a collection). A page on ANOTHER localhost port is
    // "same-site" (same registrable host), so only "same-origin" (the
    // dashboard's own page) and "none" (a direct navigation) are legitimate;
    // an absent header is a non-browser client (curl) or an old browser.
    const fetchSite = c.req.header("sec-fetch-site");
    if (fetchSite !== undefined && fetchSite !== "same-origin" && fetchSite !== "none") {
      return jsonError(403, "FORBIDDEN_CROSS_SITE", "Cross-site request refused");
    }
    // Startup capability: loopback binding alone leaves the API readable by any
    // local process or account. When a token is configured, every /api request
    // must present it as an Authorization Bearer. The page bootstraps its copy
    // from the launch URL fragment (re-read on every load), so the capability
    // is never sent ambiently to this or other loopback services. The page
    // and its assets stay public: they are the published open-source app shell
    // and carry no account data.
    const apiToken = options.apiToken;
    if (apiToken && new URL(c.req.url).pathname.startsWith("/api/")) {
      if (!tokenMatches(bearerToken(c.req.header("authorization")), apiToken)) {
        return jsonError(
          401,
          "UNAUTHORIZED",
          "Open the URL printed by `neon-usage dashboard`, or send Authorization: Bearer <token>",
        );
      }
    }
    return next();
  });

  // The report bytes are exactly what the CLI writes for --output json.
  // Billing data is never written to the browser cache and never sniffed into
  // another content type.
  const report = (value: unknown) =>
    new Response(serializeMachineJson(value, { maxBytes: options.maxJsonBytes ?? 25_000_000 }), {
      status: 200,
      headers: jsonResponseHeaders(),
    });

  // Only the listed parameters participate; empty values read as absent.
  const requestOptions = (
    query: Record<string, string>,
    keys: readonly string[],
  ): Record<string, string> => {
    const options: Record<string, string> = {};
    for (const key of keys) {
      const value = query[key];
      if (value !== undefined && value !== "") options[key] = value;
    }
    return options;
  };

  const historyQuery = async (options: Record<string, string>, context?: OperationContext) => {
    options.granularity = choice(options.granularity ?? "daily", granularities, "granularity");
    const query = historyQueryFromOptions(options, runtime.now());
    query.organizationId = await resolveOrganizationId(query.organizationId, dependencies, context);
    return query;
  };

  // fresh=1 bypasses the local store; storeTail=<n> adjusts how many
  // trailing buckets are always re-collected when serving from it.
  const servingControl = (options: Record<string, string>) => {
    if (options.fresh === "1" || options.fresh === "true") {
      return { storeServing: { serve: false, tailBuckets: 0 } };
    }
    if (options.storeTail !== undefined) {
      const tail = Number(options.storeTail);
      if (!Number.isInteger(tail) || tail < 0 || tail > 1000) {
        throw new DashboardRequestError(
          400,
          "INVALID_REQUEST",
          "storeTail must be an integer between 0 and 1000",
        );
      }
      return { storeServing: { serve: true, tailBuckets: tail } };
    }
    return undefined;
  };

  app.onError((error) => {
    const mapped = errorResponse(error);
    return new Response(mapped.body, { status: mapped.status, headers: jsonResponseHeaders() });
  });

  app.notFound(
    () =>
      new Response(
        serializeMachineJson({
          error: { code: "NOT_FOUND", message: "Unknown route", routes: dashboardApiRoutes },
        }),
        { status: 404, headers: jsonResponseHeaders() },
      ),
  );

  app.get("/api/usage", async (c) => {
    const context = { signal: c.req.raw.signal };
    const options = requestOptions(c.req.query(), [
      "orgId",
      "from",
      "to",
      "last",
      "month",
      "granularity",
      "format",
      "scope",
      "fresh",
      "storeTail",
    ]);
    const format = choice(options.format ?? "gb", ["gb", "price"] as const, "format");
    const scope = choice(options.scope ?? "organization", historyScopes, "scope");
    const control = servingControl(options);
    const query = await historyQuery(options, context);
    if (scope === "live-projects") {
      // The gb overview is an organization summary — whole-org by definition
      // (the service refuses project filters). Price mode is a per-project
      // estimate, which scoping fits.
      if (format !== "price") {
        throw new DashboardRequestError(
          400,
          "INVALID_REQUEST",
          "the organization overview is whole-org by definition; live-projects scope applies to project-report and estimate",
        );
      }
      query.projectIds = await liveProjectIds(query.organizationId, dependencies, context);
    }
    if (format === "price") {
      if (!dependencies.estimate) throw unavailable("Cost estimation");
      return report(await dependencies.estimate(query, control, context));
    }
    if (!dependencies.usageOverview) throw unavailable("Usage overview");
    return report(await dependencies.usageOverview(query, control, context));
  });

  app.get("/api/project-report", async (c) => {
    const context = { signal: c.req.raw.signal };
    const options = requestOptions(c.req.query(), [
      "orgId",
      "projectIds",
      "from",
      "to",
      "last",
      "month",
      "granularity",
      "metrics",
      "scope",
      "fresh",
      "storeTail",
    ]);
    const scope = choice(options.scope ?? "organization", historyScopes, "scope");
    const control = servingControl(options);
    const query = await historyQuery(options, context);
    // Explicit IDs win; an EXPLICIT scope=organization means the whole
    // organization (never the linked-project default — the page's "All
    // projects" label must match the query); live scope resolves live IDs.
    // Only a request with neither IDs nor scope falls back to the linked
    // project, mirroring the unscoped CLI. A single project-report cannot
    // chunk, so oversized live fleets are refused here (the page passes
    // explicit chunks instead).
    const projectIds =
      !options.projectIds && scope === "live-projects"
        ? assertWithinHistoryFilter(
            await liveProjectIds(query.organizationId, dependencies, context),
          )
        : !options.projectIds && options.scope !== undefined
          ? undefined
          : defaultHistoryProjectIds(options, dependencies);
    if (projectIds) query.projectIds = projectIds;
    return report(await dependencies.projectReport(query, control, context));
  });

  app.get("/api/estimate", async (c) => {
    const context = { signal: c.req.raw.signal };
    const options = requestOptions(c.req.query(), [
      "orgId",
      "from",
      "to",
      "last",
      "month",
      "granularity",
      "metrics",
      "scope",
      "fresh",
      "storeTail",
    ]);
    const scope = choice(options.scope ?? "organization", historyScopes, "scope");
    const control = servingControl(options);
    if (!dependencies.estimate) throw unavailable("Cost estimation");
    const query = await historyQuery(options, context);
    if (scope === "live-projects") {
      query.projectIds = await liveProjectIds(query.organizationId, dependencies, context);
    }
    return report(await dependencies.estimate(query, control, context));
  });

  app.get("/api/current-report", async (c) => {
    const context = { signal: c.req.raw.signal };
    const options = requestOptions(c.req.query(), ["orgId", "projectIds"]);
    // Mirror the CLI: default to the linked project, 'all' widens to the org.
    const projectIds =
      options.projectIds === "all"
        ? undefined
        : options.projectIds
          ? commaSeparatedValues(options.projectIds)
          : defaultHistoryProjectIds(options, dependencies);
    return report(
      await dependencies.currentReport(
        await resolveOrganizationId(options.orgId, dependencies, context),
        projectIds,
        context,
      ),
    );
  });

  app.get("/api/controls", async (c) => {
    const context = { signal: c.req.raw.signal };
    const options = requestOptions(c.req.query(), ["orgId", "projectIds"]);
    if (!dependencies.controls) throw unavailable("Controls inspection");
    const organizationId = await resolveOrganizationId(options.orgId, dependencies, context);
    const projectIds = await resolveControlsProjectIds(
      options,
      organizationId,
      dependencies,
      context,
    );
    return report(await dependencies.controls(organizationId, projectIds, context));
  });

  app.get("/api/utilization", async (c) => {
    const context = { signal: c.req.raw.signal };
    const options = requestOptions(c.req.query(), ["orgId", "projectIds"]);
    if (!dependencies.quotaUtilization) throw unavailable("Quota utilization");
    const organizationId = await resolveOrganizationId(options.orgId, dependencies, context);
    const projectIds = await resolveControlsProjectIds(
      options,
      organizationId,
      dependencies,
      context,
    );
    return report(await dependencies.quotaUtilization(organizationId, projectIds, context));
  });

  app.get("/api/organizations", async (c) => {
    if (!dependencies.organizations) throw unavailable("Organization discovery");
    return report(await dependencies.organizations({ signal: c.req.raw.signal }));
  });

  app.get("/api/projects", async (c) => {
    const context = { signal: c.req.raw.signal };
    const options = requestOptions(c.req.query(), ["orgId"]);
    if (!dependencies.projects) throw unavailable("Project discovery");
    return report(
      await dependencies.projects(
        await resolveOrganizationId(options.orgId, dependencies, context),
        context,
      ),
    );
  });

  app.get("/api/context", () => report(contextReport(resolvedContext(dependencies))));

  // Queue visibility, deliberately NOT in dashboardApiRoutes: it is server
  // status for the page's loading copy (queued vs collecting), not a report
  // contract, and has no CLI counterpart to hold parity with.
  app.get("/api/queue", () => report(queueState));

  const assetsDirectory =
    options.assetsDirectory === undefined ? defaultAssetsDirectory() : options.assetsDirectory;

  const pageAsset = async (fileName: string, contentType: string): Promise<Response | null> => {
    if (!assetsDirectory) return null;
    try {
      const body = await readFile(join(assetsDirectory, fileName));
      return new Response(new Uint8Array(body), {
        status: 200,
        headers: {
          "content-type": contentType,
          // The page is self-contained; everything else is a defect worth
          // blocking. frame-ancestors/base-uri/form-action/object-src are not
          // covered by default-src, so they are named explicitly.
          "content-security-policy":
            "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; worker-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'",
          "x-frame-options": "DENY",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          // index.html must revalidate every load (a stale page references
          // gone asset hashes after a rebuild); hashed assets are immutable.
          "cache-control": fileName.startsWith("assets")
            ? "public, max-age=31536000, immutable"
            : "no-cache",
        },
      });
    } catch {
      return null;
    }
  };

  app.get("/", async () => {
    // Without a built page (development from source), the root names the API.
    const response =
      (await pageAsset("index.html", assetContentTypes[".html"] ?? "text/html")) ??
      report({ name: "neon-usage dashboard", routes: dashboardApiRoutes });
    return response;
  });

  app.get("/assets/:name", async (c) => {
    const name = c.req.param("name");
    // One flat directory of Vite output; anything fancier is not an asset.
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || name.includes("..")) return c.notFound();
    const extension = name.slice(name.lastIndexOf("."));
    const contentType = assetContentTypes[extension];
    if (!contentType) return c.notFound();
    return (await pageAsset(join("assets", name), contentType)) ?? c.notFound();
  });

  return app;
}

/**
 * Serves the app on node:http, bound to the loopback interfaces only —
 * 127.0.0.1, plus ::1 on the same port so http://localhost works where the
 * resolver prefers IPv6. The Neon key never reaches this layer: dependencies
 * close over it, responses carry report JSON.
 */
export function startDashboardServer(
  dependencies: ReportDependencies,
  options: { port?: number; apiToken?: string | null } & Omit<DashboardAppOptions, "apiToken"> = {},
  runtime?: DashboardRuntime,
): Promise<DashboardServer> {
  // A startup capability by default: null disables it (tests/embedding that
  // guard by other means), a string supplies one, undefined generates one.
  const { apiToken: tokenOption, ...appOptions } = options;
  const apiToken =
    tokenOption === null ? undefined : (tokenOption ?? randomBytes(32).toString("hex"));
  const app = createDashboardApp(dependencies, runtime, {
    ...appOptions,
    ...(apiToken ? { apiToken } : {}),
  });
  return new Promise((resolve, reject) => {
    const server = serve(
      {
        fetch: app.fetch,
        hostname: "127.0.0.1",
        port: options.port ?? 0,
      },
      (info) => {
        // Best-effort IPv6 loopback on the same port; a machine without
        // ::1 (or with the port taken there) still serves on 127.0.0.1.
        const v6 = serve({ fetch: app.fetch, hostname: "::1", port: info.port });
        v6.on("error", (error) => {
          if (process.env.NEON_USAGE_DEBUG) {
            process.stderr.write(`dashboard ::1 bind unavailable: ${String(error)}\n`);
          }
        });
        const url = `http://127.0.0.1:${info.port}`;
        resolve({
          url,
          pageUrl: apiToken ? `${url}/#token=${apiToken}` : url,
          ...(apiToken ? { token: apiToken } : {}),
          port: info.port,
          close: () =>
            new Promise<void>((closed, failed) => {
              v6.close(() => {});
              server.close((error) => (error ? failed(error) : closed()));
            }),
        });
      },
    );
    server.on("error", reject);
  });
}
