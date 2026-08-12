import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import {
  createDashboardApp,
  dashboardApiRoutes,
  startDashboardServer,
} from "../src/dashboard-server.js";
import { ConsumptionQueryError, NeonApiError, type ReportDependencies } from "../src/index.js";

// One clock for both adapters so default ranges resolve identically.
const now = new Date("2026-08-10T12:34:56Z");

// Fakes echo their inputs so body parity also proves query-normalization
// parity, not just serialization parity.
function echoDependencies(): ReportDependencies {
  return {
    projectReport: async (query) => ({ kind: "project_report", query }),
    branchReport: async () => ({ unused: true }),
    organizationSummary: async () => ({ unused: true }),
    capabilities: async () => ({ unused: true }),
    currentReport: async (organizationId, projectIds) => ({
      kind: "current_report",
      organizationId,
      ...(projectIds ? { projectIds } : {}),
    }),
    controls: async (organizationId, projectIds) => ({
      kind: "controls",
      organizationId,
      projectIds,
    }),
    quotaUtilization: async (organizationId, projectIds) => ({
      kind: "utilization",
      organizationId,
      projectIds,
    }),
    organizations: async () => [{ id: "org-context", name: "Example" } as never],
    projects: async () => ({
      projects: [
        { id: "project-1", name: "One" },
        { id: "project-2", name: "Two" },
      ],
      unavailableProjectIds: [],
    }),
    usageOverview: async (query) => ({ kind: "usage_overview", query }) as never,
    estimate: async (query) => ({ kind: "pricing_estimate", status: "estimated", query }) as never,
    defaultOrganizationId: "org-context",
    defaultProjectId: "project-1",
    context: {
      organizationId: "org-context",
      projectId: "project-1",
      branch: "main",
      credential: "configured",
    },
  };
}

async function cliJson(args: string[], dependencies: ReportDependencies): Promise<string> {
  let stdout = "";
  await runCli(
    args,
    { ...dependencies, write: (value) => (stdout += value) },
    {
      now: () => now,
      isTTY: false,
    },
  );
  return stdout;
}

async function httpBody(
  path: string,
  dependencies: ReportDependencies,
): Promise<{ status: number; body: string; contentType: string | null }> {
  const app = createDashboardApp(dependencies, { now: () => now });
  const response = await app.request(path);
  return {
    status: response.status,
    body: await response.text(),
    contentType: response.headers.get("content-type"),
  };
}

// Every CLI invocation and the HTTP path that must return the identical body.
const parityCases: Array<{ route: string; cli: string[]; path: string }> = [
  {
    route: "/api/usage",
    cli: ["usage", "--last", "7d"],
    path: "/api/usage?last=7d",
  },
  {
    route: "/api/usage",
    cli: ["usage", "--format", "price", "--granularity", "monthly"],
    path: "/api/usage?format=price&granularity=monthly",
  },
  {
    route: "/api/project-report",
    cli: [
      "project-report",
      "--org-id",
      "org-context",
      "--from",
      "2026-08-01T00:00:00Z",
      "--to",
      "2026-08-08T00:00:00Z",
      "--metrics",
      "compute_unit_seconds",
    ],
    path: "/api/project-report?orgId=org-context&from=2026-08-01T00:00:00Z&to=2026-08-08T00:00:00Z&metrics=compute_unit_seconds",
  },
  {
    route: "/api/project-report",
    cli: ["project-report", "--project-ids", "project-2,project-1"],
    path: "/api/project-report?projectIds=project-2,project-1",
  },
  {
    route: "/api/estimate",
    cli: ["estimate", "--granularity", "hourly", "--last", "24h"],
    path: "/api/estimate?granularity=hourly&last=24h",
  },
  {
    route: "/api/project-report",
    cli: ["project-report", "--granularity", "monthly", "--month", "2026-07"],
    path: "/api/project-report?granularity=monthly&month=2026-07",
  },
  {
    route: "/api/project-report",
    cli: ["project-report", "--scope", "live-projects"],
    path: "/api/project-report?scope=live-projects",
  },
  {
    route: "/api/project-report",
    cli: ["project-report", "--scope", "organization"],
    path: "/api/project-report?scope=organization",
  },
  {
    route: "/api/estimate",
    cli: ["estimate", "--scope", "live-projects"],
    path: "/api/estimate?scope=live-projects",
  },
  {
    route: "/api/projects",
    cli: ["projects"],
    path: "/api/projects",
  },
  {
    route: "/api/current-report",
    cli: ["current-report"],
    path: "/api/current-report",
  },
  {
    route: "/api/current-report",
    cli: ["current-report", "--project-ids", "project-2,project-1"],
    path: "/api/current-report?projectIds=project-2,project-1",
  },
  {
    route: "/api/controls",
    cli: ["controls", "--project-ids", "all"],
    path: "/api/controls?projectIds=all",
  },
  {
    route: "/api/controls",
    cli: ["controls"],
    path: "/api/controls",
  },
  {
    route: "/api/utilization",
    cli: ["controls", "--utilization", "--project-ids", "project-2"],
    path: "/api/utilization?projectIds=project-2",
  },
  {
    route: "/api/organizations",
    cli: ["organizations"],
    path: "/api/organizations",
  },
  {
    route: "/api/context",
    cli: ["context"],
    path: "/api/context",
  },
];

describe("dashboard HTTP parity with the CLI", () => {
  for (const parityCase of parityCases) {
    it(`${parityCase.path} matches \`${parityCase.cli.join(" ")}\``, async () => {
      const expected = await cliJson(parityCase.cli, echoDependencies());
      const response = await httpBody(parityCase.path, echoDependencies());
      expect(response.status).toBe(200);
      expect(response.contentType).toBe("application/json; charset=utf-8");
      expect(response.body).toBe(expected);
    });
  }

  it("covers every committed route with at least one parity case", () => {
    const covered = new Set(parityCases.map((parityCase) => parityCase.route));
    expect([...covered].sort()).toEqual([...dashboardApiRoutes]);
  });

  it("scopes to live project IDs, and explicit projectIds beat the scope", async () => {
    const scoped = await httpBody("/api/project-report?scope=live-projects", echoDependencies());
    expect(JSON.parse(scoped.body).query.projectIds).toEqual(["project-1", "project-2"]);
    const priced = await httpBody(
      "/api/usage?format=price&scope=live-projects",
      echoDependencies(),
    );
    expect(JSON.parse(priced.body).query.projectIds).toEqual(["project-1", "project-2"]);
    const explicit = await httpBody(
      "/api/project-report?scope=live-projects&projectIds=project-2",
      echoDependencies(),
    );
    expect(JSON.parse(explicit.body).query.projectIds).toEqual(["project-2"]);
    const invalid = await httpBody("/api/usage?scope=everything", echoDependencies());
    expect(invalid.status).toBe(400);
  });

  it("refuses live scope on the whole-org gb overview with a clear message", async () => {
    const response = await httpBody("/api/usage?scope=live-projects", echoDependencies());
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body).error.message).toContain("whole-org by definition");
  });

  it("defaults the linked project exactly like the CLI when another org is selected", async () => {
    const expected = await cliJson(["project-report", "--org-id", "org-other"], echoDependencies());
    const response = await httpBody("/api/project-report?orgId=org-other", echoDependencies());
    expect(response.body).toBe(expected);
    expect(JSON.parse(response.body).query).not.toHaveProperty("projectIds");
  });

  it("never lets explicit organization scope inherit the linked project", async () => {
    // The dependencies link project-1; a report labeled "All projects" must
    // not silently collect only that one.
    const unscoped = await httpBody("/api/project-report", echoDependencies());
    expect(JSON.parse(unscoped.body).query.projectIds).toEqual(["project-1"]);
    const explicit = await httpBody("/api/project-report?scope=organization", echoDependencies());
    expect(JSON.parse(explicit.body).query).not.toHaveProperty("projectIds");
    const cli = await cliJson(["project-report", "--scope", "organization"], echoDependencies());
    expect(JSON.parse(cli).query).not.toHaveProperty("projectIds");
    // Explicit IDs still beat the explicit scope.
    const ids = await httpBody(
      "/api/project-report?scope=organization&projectIds=project-2",
      echoDependencies(),
    );
    expect(JSON.parse(ids.body).query.projectIds).toEqual(["project-2"]);
  });
});

describe("dashboard HTTP error and coverage semantics", () => {
  it("reports bounded fan-out refusals as invalid requests, not server failures", async () => {
    const dependencies = echoDependencies();
    dependencies.controls = async () => {
      throw new RangeError("controls must request at most 100 unique projects");
    };
    const response = await httpBody("/api/controls?projectIds=all", dependencies);
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe("INVALID_REQUEST");
  });

  it("keeps partial coverage in the report with HTTP 200, like exit code 2", async () => {
    const dependencies = echoDependencies();
    dependencies.usageOverview = async () =>
      ({ kind: "usage_overview", coverage: { status: "partial" } }) as never;
    const response = await httpBody("/api/usage", dependencies);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).coverage.status).toBe("partial");
  });

  it("maps query validation to 400 with the stable ConsumptionQueryError code", async () => {
    const dependencies = echoDependencies();
    dependencies.projectReport = async () => {
      throw new ConsumptionQueryError("INVALID_METRIC", "metrics must be supported");
    };
    const response = await httpBody("/api/project-report", dependencies);
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body).error).toEqual({
      code: "INVALID_METRIC",
      message: "metrics must be supported",
    });
  });

  it("maps option-parsing failures to 400 INVALID_REQUEST", async () => {
    const response = await httpBody(
      "/api/usage?last=7d&from=2026-08-01T00:00:00Z&to=2026-08-08T00:00:00Z",
      echoDependencies(),
    );
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe("INVALID_REQUEST");
  });

  it("rejects an unknown granularity before calling any service", async () => {
    const dependencies = echoDependencies();
    dependencies.usageOverview = async () => {
      throw new Error("must not reach the service");
    };
    const response = await httpBody("/api/usage?granularity=weekly", dependencies);
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe("INVALID_REQUEST");
  });

  it("maps provider failures to 502 with the bounded structured detail", async () => {
    const dependencies = echoDependencies();
    dependencies.currentReport = async () => {
      throw new NeonApiError(401, '{"code":"UNAUTHORIZED","message":"bad key"}', "req-1");
    };
    const response = await httpBody("/api/current-report", dependencies);
    expect(response.status).toBe(502);
    const detail = JSON.parse(response.body).error;
    expect(detail.code).toBe("UNAUTHORIZED");
    expect(detail.status).toBe(401);
    expect(detail.requestId).toBe("req-1");
  });

  it("adds plan guidance to the Launch-and-above history refusal", async () => {
    const dependencies = echoDependencies();
    dependencies.projectReport = async () => {
      throw new NeonApiError(
        403,
        '{"message":"This endpoint is not available. It is included with Launch plans and above."}',
      );
    };
    const response = await httpBody("/api/project-report", dependencies);
    expect(response.status).toBe(502);
    expect(JSON.parse(response.body).error.message).toContain("use current-report");
  });

  it("maps unexpected faults to 500 without leaking a body", async () => {
    const dependencies = echoDependencies();
    dependencies.currentReport = async () => {
      throw new TypeError("boom");
    };
    const response = await httpBody("/api/current-report", dependencies);
    expect(response.status).toBe(500);
    expect(JSON.parse(response.body).error.code).toBe("INTERNAL_ERROR");
  });

  it("answers unknown routes with a JSON 404 naming the contract", async () => {
    const response = await httpBody("/api/unknown", echoDependencies());
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body).error.routes).toEqual([...dashboardApiRoutes]);
  });

  it("sets no-store / nosniff / no-referrer on report responses", async () => {
    const app = createDashboardApp(echoDependencies(), { now: () => now });
    const response = await app.request("/api/context");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });
});

describe("dashboard DNS-rebinding defense", () => {
  const app = () => createDashboardApp(echoDependencies(), { now: () => now });

  it("serves loopback Host names", async () => {
    for (const host of ["127.0.0.1:4321", "localhost:4321", "[::1]:4321", "localhost"]) {
      const response = await app().request("/api/context", { headers: { host } });
      expect(response.status).toBe(200);
    }
  });

  it("refuses a non-loopback Host (the rebinding vector)", async () => {
    const response = await app().request("/api/context", { headers: { host: "evil.example.com" } });
    expect(response.status).toBe(403);
    expect(JSON.parse(await response.text()).error.code).toBe("FORBIDDEN_HOST");
  });

  it("refuses a cross-origin request but allows a loopback Origin", async () => {
    const forbidden = await app().request("/api/usage?last=7d", {
      headers: { host: "localhost:4321", origin: "https://evil.example.com" },
    });
    expect(forbidden.status).toBe(403);
    expect(JSON.parse(await forbidden.text()).error.code).toBe("FORBIDDEN_ORIGIN");

    const allowed = await app().request("/api/context", {
      headers: { host: "localhost:4321", origin: "http://localhost:4321" },
    });
    expect(allowed.status).toBe(200);
  });

  it("refuses a loopback Origin from a different port (another local server's page)", async () => {
    const otherPort = await app().request("/api/context", {
      headers: { host: "localhost:4321", origin: "http://localhost:9999" },
    });
    expect(otherPort.status).toBe(403);
    expect(JSON.parse(await otherPort.text()).error.code).toBe("FORBIDDEN_ORIGIN");
  });

  it("refuses an opaque (null) Origin and cross-site fetch metadata", async () => {
    const opaque = await app().request("/api/context", {
      headers: { host: "localhost:4321", origin: "null" },
    });
    expect(opaque.status).toBe(403);

    const crossSite = await app().request("/api/context", {
      headers: { host: "localhost:4321", "sec-fetch-site": "cross-site" },
    });
    expect(crossSite.status).toBe(403);
    expect(JSON.parse(await crossSite.text()).error.code).toBe("FORBIDDEN_CROSS_SITE");
  });

  it("refuses same-site fetch metadata (a page on another localhost port sends no Origin)", async () => {
    // An <img>/<script> GET from http://localhost:9999 carries NO Origin but
    // Sec-Fetch-Site: same-site — it must not trigger a collection.
    const sameSite = await app().request("/api/usage?last=7d", {
      headers: { host: "localhost:4321", "sec-fetch-site": "same-site" },
    });
    expect(sameSite.status).toBe(403);

    // The dashboard's own page (same-origin) and a direct navigation (none)
    // stay allowed, as do non-browser clients that send no metadata.
    for (const value of ["same-origin", "none"]) {
      const allowed = await app().request("/api/context", {
        headers: { host: "localhost:4321", "sec-fetch-site": value },
      });
      expect(allowed.status).toBe(200);
    }
  });
});

describe("dashboard queue visibility", () => {
  it("reports live queue depth on /api/queue, only to the capability holder", async () => {
    const dependencies = echoDependencies();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    dependencies.projectReport = (async (query: unknown) => {
      await gate;
      return { kind: "project_report", query };
    }) as never;
    const token = "a".repeat(64);
    const app = createDashboardApp(dependencies, { now: () => now }, { apiToken: token });
    const auth = { authorization: `Bearer ${token}` };
    const depth = async () => (await app.request("/api/queue", { headers: auth })).json();

    // Guarded like every /api route, and not part of the report contract.
    expect((await app.request("/api/queue")).status).toBe(401);
    expect([...dashboardApiRoutes]).not.toContain("/api/queue");
    await expect(depth()).resolves.toEqual({ running: 0, queued: 0 });

    const first = app.request("/api/project-report?projectIds=project-1", { headers: auth });
    const second = app.request("/api/project-report?projectIds=project-2", { headers: auth });
    // Let both handlers reach the queue before reading its depth.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(depth()).resolves.toEqual({ running: 1, queued: 1 });

    release();
    const settled = await Promise.all([first, second]);
    expect(settled.map((response) => response.status)).toEqual([200, 200]);
    await expect(depth()).resolves.toEqual({ running: 0, queued: 0 });
  });
});

describe("dashboard collection serialization", () => {
  it("forwards the HTTP request signal into report work", async () => {
    const dependencies = echoDependencies();
    let received: AbortSignal | undefined;
    dependencies.projectReport = (async (
      _query: unknown,
      _control: unknown,
      context: { signal?: AbortSignal },
    ) => {
      received = context.signal;
      return { kind: "project_report" };
    }) as never;
    const controller = new AbortController();
    const app = createDashboardApp(dependencies, { now: () => now });
    const response = await app.request(
      new Request("http://localhost/api/project-report", { signal: controller.signal }),
    );
    expect(response.status).toBe(200);
    expect(received).toBeDefined();
    expect(received?.aborted).toBe(false);
  });

  it("never executes a queued request after its HTTP signal is cancelled", async () => {
    const dependencies = echoDependencies();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    dependencies.projectReport = (async (query: { projectIds?: string[] }) => {
      calls.push(query.projectIds?.[0] ?? "all");
      if (calls.length === 1) await gate;
      return { kind: "project_report", query };
    }) as never;
    const app = createDashboardApp(dependencies, { now: () => now });
    const first = app.request("/api/project-report?projectIds=first");
    const controller = new AbortController();
    const second = app.request(
      new Request("http://localhost/api/project-report?projectIds=second", {
        signal: controller.signal,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await expect(second).resolves.toMatchObject({ status: 408 });
    release();
    await first;
    expect(calls).toEqual(["first"]);
  });

  it("never interleaves collection-backed calls from concurrent requests", async () => {
    const dependencies = echoDependencies();
    let active = 0;
    let overlapped = false;
    const collect = async (result: unknown) => {
      active += 1;
      if (active > 1) overlapped = true;
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return result;
    };
    dependencies.projectReport = (query) => collect({ kind: "project_report", query });
    dependencies.usageOverview = ((query: unknown) =>
      collect({ kind: "usage_overview", query })) as never;
    dependencies.estimate = ((query: unknown) =>
      collect({ kind: "pricing_estimate", status: "estimated", query })) as never;
    dependencies.currentReport = (organizationId, projectIds) =>
      collect({ kind: "current_report", organizationId, projectIds }) as never;
    dependencies.controls = (organizationId, projectIds) =>
      collect({ kind: "controls", organizationId, projectIds }) as never;
    dependencies.quotaUtilization = (organizationId, projectIds) =>
      collect({ kind: "utilization", organizationId, projectIds }) as never;
    const app = createDashboardApp(dependencies, { now: () => now });
    const responses = await Promise.all([
      app.request("/api/usage"),
      app.request("/api/usage?format=price"),
      app.request("/api/project-report"),
      app.request("/api/current-report"),
      app.request("/api/controls?projectIds=project-1"),
      app.request("/api/utilization?projectIds=project-1"),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(overlapped).toBe(false);
  });
});

describe("dashboard report memoization", () => {
  it("shares one collection across identical queries inside the TTL, then expires", async () => {
    const dependencies = echoDependencies();
    let calls = 0;
    dependencies.usageOverview = (async (query: unknown) => {
      calls += 1;
      return { kind: "usage_overview", query } as never;
    }) as never;
    let clock = now.getTime();
    const app = createDashboardApp(dependencies, { now: () => new Date(clock) });
    await Promise.all([app.request("/api/usage"), app.request("/api/usage")]);
    expect(calls).toBe(1);
    await app.request("/api/usage");
    expect(calls).toBe(1);
    await app.request("/api/usage?last=14d");
    expect(calls).toBe(2);
    clock += 6 * 60_000;
    await app.request("/api/usage");
    expect(calls).toBe(3);
  });

  it("evicts failures so a retry re-collects", async () => {
    const dependencies = echoDependencies();
    let calls = 0;
    dependencies.currentReport = async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("boom");
      return { kind: "current_report" };
    };
    const app = createDashboardApp(dependencies, { now: () => now });
    expect((await app.request("/api/current-report")).status).toBe(500);
    expect((await app.request("/api/current-report")).status).toBe(200);
    expect(calls).toBe(2);
  });
});

describe("dashboard page serving", () => {
  const assets = async () => {
    const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "dashboard-assets-"));
    await writeFile(join(directory, "index.html"), "<!doctype html><title>page</title>");
    await mkdir(join(directory, "assets"));
    await writeFile(join(directory, "assets", "app.js"), "console.log('page');");
    return directory;
  };

  it("serves the built page at / with a locked-down CSP", async () => {
    const app = createDashboardApp(
      echoDependencies(),
      { now: () => now },
      {
        assetsDirectory: await assets(),
      },
    );
    const response = await app.request("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(response.headers.get("content-security-policy")).toContain("worker-src 'none'");
    expect(await response.text()).toContain("<title>page</title>");
  });

  it("serves hashed assets and rejects traversal and unknown extensions", async () => {
    const app = createDashboardApp(
      echoDependencies(),
      { now: () => now },
      {
        assetsDirectory: await assets(),
      },
    );
    expect((await app.request("/assets/app.js")).status).toBe(200);
    expect((await app.request("/assets/..%2Findex.html")).status).toBe(404);
    expect((await app.request("/assets/app.wasm")).status).toBe(404);
  });

  it("falls back to the JSON route index when no page is built", async () => {
    const app = createDashboardApp(
      echoDependencies(),
      { now: () => now },
      {
        assetsDirectory: null,
      },
    );
    const response = await app.request("/");
    expect(response.status).toBe(200);
    expect(JSON.parse(await response.text()).routes).toEqual([...dashboardApiRoutes]);
  });

  it("refuses an oversized serialized report with a stable 413", async () => {
    const app = createDashboardApp(echoDependencies(), { now: () => now }, { maxJsonBytes: 20 });
    const response = await app.request("/api/context");
    expect(response.status).toBe(413);
    expect(JSON.parse(await response.text()).error).toMatchObject({
      code: "SERIALIZED_OUTPUT_TOO_LARGE",
      maxBytes: 20,
    });
  });
});

describe("dashboard server binding", () => {
  it("serves on 127.0.0.1 with an ephemeral port and closes cleanly", async () => {
    const server = await startDashboardServer(echoDependencies(), {}, { now: () => now });
    try {
      expect(server.url).toBe(`http://127.0.0.1:${server.port}`);
      expect(server.pageUrl).toBe(`${server.url}/#token=${server.token}`);
      const response = await fetch(`${server.url}/api/context`, {
        headers: { authorization: `Bearer ${server.token}` },
      });
      expect(response.status).toBe(200);
      expect((await response.json()) as Record<string, unknown>).toMatchObject({
        organizationId: "org-context",
        credential: "configured",
      });
    } finally {
      await server.close();
    }
  });

  it("requires the capability on /api as a Bearer; the app shell stays public", async () => {
    const server = await startDashboardServer(echoDependencies(), {}, { now: () => now });
    try {
      // A local process without the token reads no data — and no cookie is ever
      // set, so nothing ambient can leak to other loopback services.
      const denied = await fetch(`${server.url}/api/context`);
      expect(denied.status).toBe(401);
      expect(JSON.parse(await denied.text()).error.code).toBe("UNAUTHORIZED");
      expect(denied.headers.get("set-cookie")).toBeNull();

      // The page (the published app shell, no account data) serves without
      // auth; its JS reads the launch URL's fragment token on every load.
      const page = await fetch(`${server.url}/`);
      expect(page.status).toBe(200);
      expect(page.headers.get("set-cookie")).toBeNull();
      const tokened = await fetch(server.pageUrl);
      expect(tokened.status).toBe(200);
      expect(tokened.headers.get("set-cookie")).toBeNull();

      // The Bearer authorizes API calls (what the page's fetches send).
      const viaBearer = await fetch(`${server.url}/api/context`, {
        headers: { authorization: `Bearer ${server.token}` },
      });
      expect(viaBearer.status).toBe(200);

      // A wrong bearer stays out.
      const wrong = await fetch(`${server.url}/api/context`, {
        headers: { authorization: `Bearer ${"0".repeat(64)}` },
      });
      expect(wrong.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it("apiToken: null disables enforcement for embedding/tests", async () => {
    const server = await startDashboardServer(
      echoDependencies(),
      { apiToken: null },
      { now: () => now },
    );
    try {
      expect(server.token).toBeUndefined();
      expect(server.pageUrl).toBe(server.url);
      const response = await fetch(`${server.url}/api/context`);
      expect(response.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("serves full bodies for differently sized responses over real HTTP", async () => {
    // Regression: @hono/node-server's Response override mutates the headers
    // init it is given; a shared headers object froze the FIRST response's
    // content-length onto every later response, truncating larger bodies
    // ("JSON.parse: unterminated string literal" in the browser).
    const server = await startDashboardServer(echoDependencies(), {}, { now: () => now });
    const authorization = { authorization: `Bearer ${server.token}` };
    try {
      const small = await fetch(`${server.url}/api/context`, { headers: authorization });
      const smallBody = await small.text();
      expect(() => JSON.parse(smallBody)).not.toThrow();

      const larger = await fetch(`${server.url}/api/organizations`, { headers: authorization });
      const largerBody = await larger.text();
      expect(() => JSON.parse(largerBody)).not.toThrow();
      expect(Number(larger.headers.get("content-length"))).toBe(Buffer.byteLength(largerBody));
      expect(largerBody.length).not.toBe(smallBody.length);
    } finally {
      await server.close();
    }
  });

  it("creates a fresh capability for each server process", async () => {
    const first = await startDashboardServer(echoDependencies(), {}, { now: () => now });
    const second = await startDashboardServer(echoDependencies(), {}, { now: () => now });
    try {
      expect(first.token).toMatch(/^[a-f0-9]{64}$/);
      expect(second.token).toMatch(/^[a-f0-9]{64}$/);
      expect(second.token).not.toBe(first.token);
      expect(first.pageUrl).not.toContain("?token=");
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });
});
