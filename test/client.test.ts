import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CollectMeasuredUsageInput,
  createNeonUsageClient,
  DEFAULT_CLIENT_LIMITS,
  MAX_CLIENT_LIMITS,
  type NeonUsageClientConfig,
} from "../src/client.js";
import { NeonUsageError } from "../src/client-errors.js";
import * as queries from "../src/consumption-query.js";
import * as stores from "../src/in-memory-fact-store.js";
import { measuredUsageLimits } from "../src/measured-usage-contract.js";
import { projectConsumptionMetrics } from "../src/metric-catalog.js";
import * as pricing from "../src/pricing-estimate.js";
import { createSlidingWindowRequestCoordinator } from "../src/request-coordinator.js";

const now = () => new Date("2026-08-27T12:00:00.000Z");
const query = {
  from: "2026-08-26T00:00:00.000Z",
  to: "2026-08-27T00:00:00.000Z",
  granularity: "daily" as const,
  metrics: ["compute_unit_seconds"] as const,
};
const packageVersion = (createRequire(import.meta.url)("../package.json") as { version: string })
  .version;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function historyPage(cursor: string | null = null) {
  return {
    projects: [
      {
        project_id: "project-1",
        periods: [
          {
            period_id: "period-1",
            period_plan: "launch",
            period_start: query.from,
            period_end: query.to,
            consumption: [
              {
                timeframe_start: query.from,
                timeframe_end: query.to,
                metrics: [{ metric_name: "compute_unit_seconds", value: "3600" }],
              },
            ],
          },
        ],
      },
    ],
    pagination: { cursor },
  };
}

function currentProject(projectId: string) {
  return {
    project: {
      id: projectId,
      consumption_period_start: "2026-08-01T00:00:00Z",
      consumption_period_end: "2026-09-01T00:00:00Z",
      active_time_seconds: "1",
      compute_time_seconds: "1",
      written_data_bytes: "0",
      data_transfer_bytes: "0",
      data_storage_bytes_hour: "0",
    },
  };
}

function fixtureFetch(plan = "launch", probeStatus = 200) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/organizations/org-1")) {
      return Response.json({ id: "org-1", plan });
    }
    if (url.pathname.endsWith("/users/me/organizations")) {
      return Response.json({
        organizations: [{ id: "org-1", name: "Test", handle: "test", plan }],
      });
    }
    if (url.pathname.endsWith("/consumption_history/v2/projects")) {
      return probeStatus === 200
        ? Response.json(historyPage())
        : Response.json(
            { code: "SECRET_PROVIDER_CODE", message: "secret-token raw provider body" },
            { status: probeStatus, headers: { "retry-after": "900" } },
          );
    }
    if (url.pathname.endsWith("/projects")) return Response.json({ projects: [] });
    throw new Error("Unexpected fixture request");
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("public client configuration", () => {
  it.each(["credential-short", `credential-${"x".repeat(700)}`])(
    "keeps SDK errors package-owned for credential-bearing provider diagnostics (%s)",
    async (accessToken) => {
      const client = createNeonUsageClient({
        accessToken,
        fetch: async () =>
          Response.json(
            { code: `prefix-${accessToken}-suffix`, message: `prefix-${accessToken}-suffix` },
            { status: 403 },
          ),
      });
      try {
        const error = await client.listOrganizations().catch((reason: unknown) => reason);
        expect(error).toMatchObject({
          name: "NeonUsageError",
          code: "AUTHORIZATION_FAILED",
          message: "This credential cannot access the requested Neon resource.",
          providerStatus: 403,
        });
        expect(error).not.toHaveProperty("cause");
        expect(JSON.stringify(error)).not.toContain("credential-");
      } finally {
        client.close();
      }
    },
  );
  it.each([false, true])(
    "aborts and drains fatal snapshot siblings before the next operation (cooperative=%s)",
    async (cooperative) => {
      const created: ReturnType<typeof stores.createInMemoryEvidenceFactStore>[] = [];
      const original = stores.createInMemoryEvidenceFactStore;
      const writes: Array<ReturnType<typeof vi.spyOn>> = [];
      const closes: Array<ReturnType<typeof vi.spyOn>> = [];
      vi.spyOn(stores, "createInMemoryEvidenceFactStore").mockImplementation((...args) => {
        const store = original(...args);
        created.push(store);
        writes.push(vi.spyOn(store, "writeEvidence"));
        closes.push(vi.spyOn(store, "close"));
        return store;
      });
      const siblingStarted = deferred<void>();
      const late = deferred<Response>();
      let siblingSignal: AbortSignal | null | undefined;
      let siblingAborted = false;
      const requests: string[] = [];
      const client = createNeonUsageClient({
        accessToken: "token",
        now,
        limits: { concurrency: 2 },
        fetch: async (input, init) => {
          const url = new URL(String(input));
          requests.push(url.pathname);
          if (url.pathname.endsWith("/organizations/org-1"))
            return Response.json({ id: "org-1", plan: "free" });
          if (url.pathname.endsWith("/users/me/organizations")) {
            expect(siblingAborted).toBe(true);
            return Response.json({ organizations: [] });
          }
          if (url.pathname.endsWith("/projects"))
            return Response.json({
              projects: ["a", "b", "c", "d"].map((id) => ({ id: `project-${id}`, name: id })),
            });
          if (url.pathname.endsWith("/projects/project-a")) {
            await siblingStarted.promise;
            return Response.json(currentProject("project-a"));
          }
          if (url.pathname.endsWith("/projects/project-a/branches"))
            return Response.json({
              branches: [],
              pagination: { next: "invalid-empty-continuation" },
            });
          if (url.pathname.endsWith("/projects/project-b")) {
            siblingSignal = init?.signal;
            siblingSignal?.addEventListener(
              "abort",
              () => {
                siblingAborted = true;
              },
              { once: true },
            );
            siblingStarted.resolve();
            if (cooperative)
              return new Promise<Response>((_resolve, reject) =>
                siblingSignal?.addEventListener("abort", () => reject(siblingSignal?.reason), {
                  once: true,
                }),
              );
            return late.promise;
          }
          throw new Error("Queued snapshot or branch request escaped fatal fan-out");
        },
      });
      try {
        await expect(
          client.collectMeasuredUsage({ organizationId: "org-1", source: "current" }),
        ).rejects.toMatchObject({ code: "INTEGRITY_FAILURE" });
        expect(siblingSignal?.aborted).toBe(true);
        expect(requests.some((path) => /project-[cd]|project-b\/branches$/.test(path))).toBe(false);
        const writesAtFailure = writes[0]?.mock.calls.length;
        expect(closes[0]).toHaveBeenCalledExactlyOnceWith();
        await expect(client.listOrganizations()).resolves.toEqual([]);
        const response = Response.json(currentProject("project-b"));
        if (!response.body) throw new Error("Expected a response body");
        const reader = vi.spyOn(response.body, "getReader");
        late.resolve(response);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(reader).not.toHaveBeenCalled();
        expect(writes[0]?.mock.calls.length).toBe(writesAtFailure);
        expect(created).toHaveLength(1);
      } finally {
        client.close();
        late.resolve(Response.json({}));
      }
    },
  );
  it("exports the exact frozen defaults and maxima", () => {
    expect(DEFAULT_CLIENT_LIMITS).toEqual({
      maxPages: 1_000,
      maxDurationMs: 600_000,
      maxItems: 10_000,
      maxFacts: 1_000_000,
      maxBytes: 100_000_000,
      maxProjects: 1_000,
      concurrency: 5,
      requestsPerMinute: 180,
      maxResponseBytes: 10_000_000,
    });
    expect(MAX_CLIENT_LIMITS).toEqual({
      maxPages: 10_000,
      maxDurationMs: 3_600_000,
      maxItems: 10_000_000,
      maxFacts: 100_000_000,
      maxBytes: 1_000_000_000,
      maxProjects: 10_000,
      concurrency: 100,
      requestsPerMinute: 600,
      maxResponseBytes: 100_000_000,
    });
    expect(Object.isFrozen(DEFAULT_CLIENT_LIMITS)).toBe(true);
    expect(Object.isFrozen(MAX_CLIENT_LIMITS)).toBe(true);
    createNeonUsageClient({ accessToken: "token", limits: MAX_CLIENT_LIMITS }).close();
  });

  it.each([
    null,
    {},
    { accessToken: 42 },
    { accessToken: " " },
    { accessToken: "token\nsecret" },
    { accessToken: "token😀" },
    { accessToken: "token", fetch: {} },
    { accessToken: "token", fetch: null },
    { accessToken: "token", now: null },
    { accessToken: "token", now: () => new Date("invalid") },
    {
      accessToken: "token",
      now: () => {
        throw new Error("secret");
      },
    },
    { accessToken: "token", requestCoordinator: {} },
    { accessToken: "token", limits: null },
    { accessToken: "token", limits: { intervalMs: 1 } },
    { accessToken: "token", producerVersion: "caller-value" },
    { accessToken: "token", sourceAccount: "caller-value" },
  ])("rejects invalid complete config synchronously: %j", (config) => {
    expect(() => createNeonUsageClient(config as NeonUsageClientConfig)).toThrowError(
      expect.objectContaining({ name: "NeonUsageError", code: "INVALID_INPUT" }),
    );
  });

  it("validates every limit independently", () => {
    for (const [key, maximum] of Object.entries(MAX_CLIENT_LIMITS)) {
      for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, maximum + 1, "1"]) {
        expect(() =>
          createNeonUsageClient({ accessToken: "token", limits: { [key]: value } } as never),
        ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
      }
    }
  });
});

describe("public client inputs and source selection", () => {
  it.each(["projectIds", "metrics", "metricName", "from", "to"] as const)(
    "rejects oversized %s before dependencies or element access",
    async (field) => {
      const fetch = fixtureFetch();
      const store = vi.spyOn(stores, "createInMemoryEvidenceFactStore");
      const validateQuery = vi.spyOn(queries, "validateHistoryQuery");
      const read = vi.fn(() => {
        throw new Error("must not scan oversized input");
      });
      const oversized = Array(field === "projectIds" ? 3 : projectConsumptionMetrics.length + 1);
      Object.defineProperty(oversized, 0, { get: read });
      const input =
        field === "projectIds"
          ? { organizationId: "org-1", source: "current", projectIds: oversized }
          : {
              organizationId: "org-1",
              source: "history",
              query: {
                ...query,
                ...(field === "metricName"
                  ? { metrics: ["x".repeat(257)] }
                  : {
                      [field]: field === "metrics" ? oversized : `${query.from}${"0".repeat(65)}`,
                    }),
              },
            };
      const client = createNeonUsageClient({
        accessToken: "token",
        fetch,
        now,
        limits: { maxProjects: 2 },
      });
      await expect(
        client.collectMeasuredUsage(input as CollectMeasuredUsageInput),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(read).not.toHaveBeenCalled();
      expect(store).not.toHaveBeenCalled();
      expect(validateQuery).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      client.close();
    },
  );

  it("accepts an explicit project scope at its configured ceiling and rejects duplicates", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/organizations/org-1"))
        return Response.json({ id: "org-1", plan: "free" });
      if (path.endsWith("/projects"))
        return Response.json({
          projects: [
            { id: "project-1", name: "One" },
            { id: "project-2", name: "Two" },
          ],
        });
      if (path.endsWith("/branches")) return Response.json({ branches: [] });
      if (path.endsWith("/projects/project-1")) return Response.json(currentProject("project-1"));
      if (path.endsWith("/projects/project-2")) return Response.json(currentProject("project-2"));
      throw new Error("Unexpected fixture request");
    });
    const client = createNeonUsageClient({
      accessToken: "token",
      fetch,
      now,
      limits: { maxProjects: 2 },
    });
    await expect(
      client.collectMeasuredUsage({
        organizationId: "org-1",
        source: "current",
        projectIds: ["project-1", "project-1"],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(fetch).not.toHaveBeenCalled();
    const result = await client.collectMeasuredUsage({
      organizationId: "org-1",
      source: "current",
      projectIds: ["project-1", "project-2"],
    });
    expect(result.measuredUsage.projects).toHaveLength(2);
    client.close();
  });

  it("does not probe history for an explicit current collection on a paid plan", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/organizations/org-1"))
        return Response.json({ id: "org-1", plan: "launch" });
      if (path.endsWith("/consumption_history/v2/projects"))
        throw new Error("Current collection must not probe history");
      if (path.endsWith("/projects")) return Response.json({ projects: [] });
      throw new Error(`Unexpected fixture request: ${path}`);
    });
    const client = createNeonUsageClient({ accessToken: "token", fetch, now });

    const result = await client.collectMeasuredUsage({
      organizationId: "org-1",
      source: "current",
    });

    expect(result.capability.observedAvailability.projectHistory).toBe("not_probed");
    expect(fetch.mock.calls.map(([input]) => new URL(String(input)).pathname)).not.toContain(
      "/api/v2/consumption_history/v2/projects",
    );
    client.close();
  });

  it("rejects a dense explicit project scope above the configured ceiling before dependencies", async () => {
    const fetch = fixtureFetch("free");
    const store = vi.spyOn(stores, "createInMemoryEvidenceFactStore");
    const client = createNeonUsageClient({
      accessToken: "token",
      fetch,
      now,
      limits: { maxProjects: 2 },
    });
    await expect(
      client.collectMeasuredUsage({
        organizationId: "org-1",
        source: "current",
        projectIds: ["project-1", "project-2", "project-3"],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(store).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    client.close();
  });

  it("shares the parser project ceiling and accepts all supported metrics and a boundary timestamp", async () => {
    expect(MAX_CLIENT_LIMITS.maxProjects).toBe(measuredUsageLimits.projects);
    const fetch = fixtureFetch();
    const client = createNeonUsageClient({ accessToken: "token", fetch, now });
    const from = `2026-08-26T00:00:00.${"0".repeat(43)}Z`;
    expect(from).toHaveLength(64);
    const result = await client.collectMeasuredUsage({
      organizationId: "org-1",
      source: "history",
      query: { ...query, from, metrics: projectConsumptionMetrics },
    });
    expect(result.measuredUsage.metricSelection.requested).toEqual(
      [...projectConsumptionMetrics].sort(),
    );
    client.close();
  });

  it("accepts supported nondefault history metrics without changing omitted defaults", async () => {
    vi.resetModules();
    vi.doMock("../src/metric-definitions.js", async () => {
      const actual = await vi.importActual<typeof import("../src/metric-definitions.js")>(
        "../src/metric-definitions.js",
      );
      return {
        ...actual,
        projectConsumptionMetrics: Object.freeze(
          actual.projectConsumptionMetrics.filter(
            (metric) => metric !== "snapshot_storage_bytes_month",
          ),
        ),
      };
    });
    try {
      const [{ createNeonUsageClient: createFixtureClient }, { historyContracts }] =
        await Promise.all([import("../src/client.js"), import("../src/history-contracts.js")]);
      expect(historyContracts.project.metrics).not.toContain("snapshot_storage_bytes_month");
      expect(historyContracts.project.supportedMetrics).toContain("snapshot_storage_bytes_month");
      const fetch = fixtureFetch();
      const client = createFixtureClient({ accessToken: "token", fetch, now });
      try {
        const explicit = await client.collectMeasuredUsage({
          organizationId: "org-1",
          source: "history",
          query: { ...query, metrics: ["snapshot_storage_bytes_month"] },
        });
        expect(explicit.measuredUsage.metricSelection).toEqual({
          mode: "explicit",
          requested: ["snapshot_storage_bytes_month"],
        });
        await client.collectMeasuredUsage({ organizationId: "org-1", source: "history" });
        expect(new URL(String(fetch.mock.calls.at(-1)?.[0])).searchParams.get("metrics")).toBe(
          historyContracts.project.metrics.join(","),
        );
      } finally {
        client.close();
      }
    } finally {
      vi.doUnmock("../src/metric-definitions.js");
      vi.resetModules();
    }
  });

  it.each([
    null,
    {},
    { organizationId: "../org" },
    { organizationId: "org-1", source: "other" },
    { organizationId: "org-1", source: null },
    { organizationId: "org-1", query },
    { organizationId: "org-1", source: "auto", projectIds: ["project-1"] },
    { organizationId: "org-1", source: "history", projectIds: ["project-1"] },
    { organizationId: "org-1", source: "current", query },
    { organizationId: "org-1", source: "history", query: { ...query, projectIds: [] } },
    { organizationId: "org-1", source: "history", query: { ...query, metrics: [] } },
    {
      organizationId: "org-1",
      source: "history",
      query: { ...query, metrics: ["active_time_seconds"] },
    },
    {
      organizationId: "org-1",
      source: "history",
      query: { ...query, metrics: ["compute_unit_seconds", "compute_unit_seconds"] },
    },
    { organizationId: "org-1", source: "history", query: { ...query, from: "bad" } },
    { organizationId: "org-1", source: "history", query: { ...query, to: query.from } },
    { organizationId: "org-1", source: "history", query: { ...query, granularity: "weekly" } },
    { organizationId: "org-1", source: "current", projectIds: [] },
    { organizationId: "org-1", source: "current", projectIds: ["project-1", "project-1"] },
    { organizationId: "org-1", source: "current", projectIds: [""] },
    { organizationId: "org-1", source: "current", projectIds: ["all"] },
    { organizationId: "org-1", source: "current", projectIds: Array(1) },
    {
      organizationId: "org-1",
      source: "current",
      projectIds: ["project-1"].concat(Array<string>(1)),
    },
    { organizationId: "org-1", source: "history", query: { ...query, metrics: Array(1) } },
    {
      organizationId: "org-1",
      source: "history",
      query: { ...query, metrics: ["compute_unit_seconds"].concat(Array<string>(1)) },
    },
  ])("rejects invalid input before transport: %j", async (input) => {
    const fetch = fixtureFetch();
    const client = createNeonUsageClient({ accessToken: "token", fetch, now });
    await expect(
      client.collectMeasuredUsage(input as CollectMeasuredUsageInput),
    ).rejects.toMatchObject({
      name: "NeonUsageError",
      code: "INVALID_INPUT",
    });
    expect(fetch).not.toHaveBeenCalled();
    client.close();
  });

  it("keeps only copied configuration and validates inventory input/options", async () => {
    const fetch = fixtureFetch();
    const config = { accessToken: "original-token", fetch, limits: { maxItems: 10 } };
    const client = createNeonUsageClient(config);
    config.accessToken = "mutated-token";
    config.limits.maxItems = 0;
    await expect(client.listProjects("../org")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(client.inspectCapability(42 as never)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(client.listOrganizations({ signal: {} } as never)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await client.listOrganizations();
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
      "Bearer original-token",
    );
    client.close();
  });

  it.each(["launch", "custom-paid-plan"])(
    "probes %s and collects history once for export and estimate",
    async (plan) => {
      const fetch = fixtureFetch(plan);
      const client = createNeonUsageClient({ accessToken: "token", fetch, now });
      const result = await client.collectMeasuredUsage({
        organizationId: "org-1",
        source: "history",
        query,
      });
      expect(result.measuredUsage.producerVersion).toBe(packageVersion);
      expect(result.measuredUsage.source.contract).toBe("consumption-history-v2");
      expect(result.measuredUsage.metricSelection).toEqual({
        mode: "explicit",
        requested: ["compute_unit_seconds"],
      });
      expect(result.measuredUsage.metrics?.[0]?.raw.value).toBe("3600");
      expect(result.estimate).not.toBeNull();
      expect(
        fetch.mock.calls.filter(([input]) => String(input).includes("consumption_history")).length,
      ).toBe(2);
      client.close();
    },
  );

  it("auto falls back only on confirmed unsupported plans", async () => {
    const fetch = fixtureFetch("free");
    const client = createNeonUsageClient({ accessToken: "token", fetch, now });
    const result = await client.collectMeasuredUsage({ organizationId: "org-1" });
    expect(result.measuredUsage.source).toEqual({
      contract: "current-period-snapshot",
      authoritative: false,
    });
    expect(result.estimate).toBeNull();
    expect(fetch.mock.calls.some(([input]) => String(input).includes("consumption_history"))).toBe(
      false,
    );
    await expect(
      client.collectMeasuredUsage({ organizationId: "org-1", source: "history" }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    client.close();
  });

  it("defaults an omitted metric list and probes unknown plans in auto mode", async () => {
    const fetch = fixtureFetch("custom-paid-plan");
    const client = createNeonUsageClient({ accessToken: "token", fetch, now });
    const automatic = await client.collectMeasuredUsage({ organizationId: "org-1" });
    expect(automatic.measuredUsage.source.contract).toBe("consumption-history-v2");
    const explicitPeriod = await client.collectMeasuredUsage({
      organizationId: "org-1",
      source: "history",
      query: { from: query.from, to: query.to, granularity: query.granularity },
    });
    expect(explicitPeriod.measuredUsage.metricSelection).toEqual({
      mode: "default",
      requested: [...projectConsumptionMetrics].sort(),
    });
    client.close();
  });

  it.each([401, 403, 404, 500])(
    "does not auto-fallback on history probe HTTP %i",
    async (status) => {
      const fetch = fixtureFetch("custom", status);
      const client = createNeonUsageClient({ accessToken: "secret-token", fetch, now });
      await expect(client.collectMeasuredUsage({ organizationId: "org-1" })).rejects.toMatchObject({
        code: status === 500 ? "PROVIDER_UNAVAILABLE" : "AUTHORIZATION_FAILED",
      });
      expect(
        fetch.mock.calls.some(
          ([input]) =>
            new URL(String(input)).pathname.endsWith("/projects") &&
            !String(input).includes("history"),
        ),
      ).toBe(false);
      client.close();
    },
  );

  it.each([
    ["2026-08-27T12:00:00.000Z", "2026-08-01T00:00:00.000Z", "2026-08-27T00:00:00.000Z"],
    ["2026-09-01T00:00:00.000Z", "2026-08-25T00:00:00.000Z", "2026-09-01T00:00:00.000Z"],
    ["2026-09-01T23:59:59.999Z", "2026-08-25T00:00:00.000Z", "2026-09-01T00:00:00.000Z"],
  ])("uses complete UTC default days at %s", async (clock, from, to) => {
    const fetch = fixtureFetch();
    const client = createNeonUsageClient({
      accessToken: "token",
      fetch,
      now: () => new Date(clock),
    });
    await client.collectMeasuredUsage({ organizationId: "org-1" });
    const url = new URL(String(fetch.mock.calls.at(-1)?.[0]));
    expect(url.searchParams.get("from")).toBe(from);
    expect(url.searchParams.get("to")).toBe(to);
    expect(url.searchParams.get("granularity")).toBe("daily");
    expect(url.searchParams.get("metrics")).toBe(projectConsumptionMetrics.join(","));
    client.close();
  });
});

describe("public operation lifecycle and bounds", () => {
  it("records unsolicited snapshot-only metrics in history coverage", async () => {
    const client = createNeonUsageClient({
      accessToken: "token",
      now,
      fetch: async (input) => {
        if (String(input).includes("/organizations/org-1"))
          return Response.json({ id: "org-1", plan: "launch" });
        const page = historyPage();
        page.projects[0]?.periods[0]?.consumption[0]?.metrics.push({
          metric_name: "active_time_seconds",
          value: "120",
        });
        return Response.json(page);
      },
    });
    try {
      const result = await client.collectMeasuredUsage({
        organizationId: "org-1",
        source: "history",
        query,
      });
      expect(result.measuredUsage.coverage.omittedMetrics).toEqual(["active_time_seconds"]);
      expect(result.measuredUsage.coverage.qualityFlags).toContain("SOURCE_METRIC_UNKNOWN");
      expect(result.measuredUsage.coverage.qualityFlags).toContain("UNKNOWN_METRIC");
    } finally {
      client.close();
    }
  });

  it("preserves package-owned diagnostics for a requested project missing from inventory", async () => {
    const client = createNeonUsageClient({
      accessToken: "token",
      fetch: fixtureFetch("free"),
      now,
    });
    try {
      const result = await client.collectMeasuredUsage({
        organizationId: "org-1",
        source: "current",
        projectIds: ["project-missing"],
      });
      expect(result.measuredUsage.coverage).toMatchObject({
        status: "partial",
        errors: [
          {
            source: "project_list",
            message: "Requested project is not in the organization inventory",
            detail: {
              code: "PROJECT_NOT_IN_INVENTORY",
              message: "Requested project is not in the organization inventory",
            },
          },
        ],
      });
    } finally {
      client.close();
    }
  });

  it.each([
    [false, 5, "partial"],
    [true, 5, "partial"],
    [false, 9, "complete"],
    [true, 9, "complete"],
  ] as const)(
    "shares the snapshot item limit across projects and branch inventories (paginated=%s, maxItems=%i)",
    async (paginated, maxItems, status) => {
      const client = createNeonUsageClient({
        accessToken: "token",
        now,
        limits: { maxItems, concurrency: 3 },
        fetch: async (input) => {
          const url = new URL(String(input));
          if (url.pathname.endsWith("/organizations/org-1"))
            return Response.json({ id: "org-1", plan: "free" });
          if (url.pathname.endsWith("/projects"))
            return Response.json({
              projects: [1, 2, 3].map((id) => ({ id: `project-${id}`, name: `${id}` })),
            });
          const projectId = url.pathname.split("/").find((part) => part.startsWith("project-"));
          if (url.pathname.endsWith("/branches"))
            return Response.json({
              branches: (paginated ? [url.searchParams.has("cursor") ? 2 : 1] : [1, 2]).map(
                (id) => ({ id: `branch-${projectId}-${id}`, logical_size: "10" }),
              ),
              pagination: { next: paginated && !url.searchParams.has("cursor") ? "next" : null },
            });
          return Response.json(currentProject(projectId as string));
        },
      });
      try {
        const result = await client.collectMeasuredUsage({
          organizationId: "org-1",
          source: "current",
        });
        expect(result.measuredUsage.coverage).toMatchObject({
          status,
          returnedProjectIds: ["project-1", "project-2", "project-3"],
        });
        expect(result.measuredUsage.pointInTimeStorage).toMatchObject({
          complete: status === "complete",
          totalLogicalSizeBytes: status === "complete" ? "60" : null,
        });
        const retainedBranchBytes = result.measuredUsage.pointInTimeStorage?.projects.reduce(
          (sum, project) => sum + BigInt(project.totalLogicalSizeBytes ?? "0"),
          0n,
        );
        expect(retainedBranchBytes).toBeLessThanOrEqual(BigInt(maxItems - 3) * 10n);
      } finally {
        client.close();
      }
    },
  );

  it("uses the shared snapshot budget with a tiny positive maxBytes", async () => {
    const client = createNeonUsageClient({
      accessToken: "token",
      now,
      fetch: fixtureFetch("free"),
      limits: { maxBytes: 64 },
    });
    try {
      await expect(
        client.collectMeasuredUsage({ organizationId: "org-1", source: "current" }),
      ).resolves.toMatchObject({ measuredUsage: { coverage: { status: "complete" } } });
    } finally {
      client.close();
    }
    const exhausted = createNeonUsageClient({
      accessToken: "token",
      now,
      fetch: fixtureFetch("free"),
      limits: { maxBytes: 1 },
    });
    try {
      await expect(
        exhausted.collectMeasuredUsage({ organizationId: "org-1", source: "current" }),
      ).rejects.toMatchObject({ name: "NeonUsageError", code: "COLLECTION_LIMIT_REACHED" });
    } finally {
      exhausted.close();
    }
  });

  it("allows a large inventory within the default shared snapshot budget", async () => {
    const inventory = {
      projects: Array.from({ length: 400 }, (_, index) => ({
        id: `project-${index}`,
        name: "x".repeat(200),
      })),
    };
    expect(Buffer.byteLength(JSON.stringify(inventory))).toBeGreaterThan(
      DEFAULT_CLIENT_LIMITS.maxBytes / (DEFAULT_CLIENT_LIMITS.maxProjects * 2 + 1),
    );
    const client = createNeonUsageClient({
      accessToken: "token",
      now,
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/organizations/org-1"))
          return Response.json({ id: "org-1", plan: "free" });
        if (url.pathname.endsWith("/projects")) return Response.json(inventory);
        if (url.pathname.endsWith("/branches")) return Response.json({ branches: [] });
        return Response.json(currentProject("project-0"));
      },
    });
    try {
      const result = await client.collectMeasuredUsage({
        organizationId: "org-1",
        source: "current",
        projectIds: ["project-0"],
      });
      expect(result.measuredUsage.coverage.status).toBe("complete");
      expect(result.measuredUsage.projects).toHaveLength(1);
    } finally {
      client.close();
    }
  });

  it("bounds combined snapshot retention across individually fitting branch inventories", async () => {
    const branchPage = (projectId: string, next: boolean) => ({
      branches: [
        {
          id: `branch-${projectId}-${next ? "1" : "2"}`,
          name: "x".repeat(400),
          logical_size: "10",
        },
      ],
      pagination: { next: next ? "second" : null },
    });
    const inventoryBytes =
      Buffer.byteLength(JSON.stringify(branchPage("project-1", true))) +
      Buffer.byteLength(JSON.stringify(branchPage("project-1", false)));
    expect(inventoryBytes).toBeLessThan(2_000);
    expect(inventoryBytes * 2).toBeGreaterThan(2_000);
    const client = createNeonUsageClient({
      accessToken: "token",
      now,
      limits: { maxProjects: 2, concurrency: 2, maxBytes: 2_000, maxResponseBytes: 10_000 },
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/organizations/org-1"))
          return Response.json({ id: "org-1", plan: "free" });
        if (url.pathname.endsWith("/projects"))
          return Response.json({
            projects: [
              { id: "project-1", name: "One" },
              { id: "project-2", name: "Two" },
            ],
          });
        const projectId = url.pathname
          .split("/")
          .find((part) => part.startsWith("project-")) as string;
        if (url.pathname.endsWith("/branches"))
          return Response.json(branchPage(projectId, !url.searchParams.has("cursor")));
        return Response.json(currentProject(projectId));
      },
    });
    try {
      const result = await client.collectMeasuredUsage({
        organizationId: "org-1",
        source: "current",
      });
      expect(result.measuredUsage.coverage).toMatchObject({
        status: "partial",
        returnedProjectIds: ["project-1", "project-2"],
      });
      const coverage = result.measuredUsage.coverage;
      expect("errors" in coverage && coverage.errors.length).toBeGreaterThanOrEqual(1);
      expect(
        "errors" in coverage && coverage.errors.every((error) => error.source === "branch_sizes"),
      ).toBe(true);
      expect(result.measuredUsage.projects).toHaveLength(2);
      expect(result.measuredUsage.pointInTimeStorage).toMatchObject({
        complete: false,
        totalLogicalSizeBytes: null,
      });
      expect(result.measuredUsage.metrics).toBeNull();
      const repeated = await client.collectMeasuredUsage({
        organizationId: "org-1",
        source: "current",
      });
      expect(repeated.measuredUsage.projects).toHaveLength(2);
      expect(repeated.measuredUsage.coverage.status).toBe("partial");
    } finally {
      client.close();
    }
  });

  it("owns a new store and source identity per collection, and closes every store", async () => {
    const createStore = stores.createInMemoryEvidenceFactStore;
    const accounts: string[] = [];
    const closed: ReturnType<typeof vi.fn>[] = [];
    vi.spyOn(stores, "createInMemoryEvidenceFactStore").mockImplementation(() => {
      const store = createStore();
      const begin = store.beginCollectionRun;
      store.beginCollectionRun = async (input, signal) => {
        accounts.push(input.intent.sourceAccount);
        return begin(input, signal);
      };
      const close = vi.fn(() => store.close());
      closed.push(close);
      return { ...store, close };
    });
    const client = createNeonUsageClient({ accessToken: "token", fetch: fixtureFetch(), now });
    const first = await client.collectMeasuredUsage({
      organizationId: "org-1",
      source: "history",
      query,
    });
    const second = await client.collectMeasuredUsage({
      organizationId: "org-1",
      source: "history",
      query,
    });
    expect(new Set(accounts).size).toBe(2);
    expect(first.measuredUsage.metrics).toEqual(second.measuredUsage.metrics);
    expect(first.measuredUsage.evidence).not.toEqual(second.measuredUsage.evidence);
    expect(closed).toHaveLength(2);
    expect(closed.every((close) => close.mock.calls.length === 1)).toBe(true);
    client.close();
  });

  it("rejects concurrent calls, close aborts non-cooperative fetch, and close is idempotent", async () => {
    const started = deferred<AbortSignal>();
    const client = createNeonUsageClient({
      accessToken: "token",
      fetch: async (_input, init) => {
        started.resolve(init?.signal as AbortSignal);
        return new Promise<Response>(() => {});
      },
    });
    const pending = client.listOrganizations();
    const signal = await started.promise;
    await expect(client.listProjects("org-1")).rejects.toMatchObject({ code: "CLIENT_BUSY" });
    client.close();
    client.close();
    expect(signal.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({ name: "NeonUsageError", code: "CANCELLED" });
    for (const operation of [
      () => client.listOrganizations(),
      () => client.listProjects("org-1"),
      () => client.inspectCapability("org-1"),
      () => client.collectMeasuredUsage({ organizationId: "org-1" }),
    ]) {
      await expect(operation()).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
    }
  });

  it("releases the operation and closes its store on caller abort of an uncooperative coordinator", async () => {
    vi.useFakeTimers();
    const createStore = stores.createInMemoryEvidenceFactStore;
    const close = vi.fn();
    vi.spyOn(stores, "createInMemoryEvidenceFactStore").mockImplementation(() => ({
      ...createStore(),
      close,
    }));
    const entered = deferred<void>();
    let hang = true;
    const fetch = fixtureFetch("free");
    const client = createNeonUsageClient({
      accessToken: "token",
      fetch,
      now,
      limits: { requestsPerMinute: 1 },
      requestCoordinator: {
        acquire: async () => {
          entered.resolve();
          if (hang) await new Promise(() => {});
        },
      },
    });
    const abort = new AbortController();
    const pending = client.collectMeasuredUsage(
      { organizationId: "org-1" },
      { signal: abort.signal },
    );
    await entered.promise;
    abort.abort(new Error("secret abort reason"));
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    expect(close).toHaveBeenCalledOnce();
    hang = false;
    const recovered = client.listOrganizations();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledOnce();
    await expect(recovered).resolves.toHaveLength(1);
    client.close();
  });

  it("applies a deadline to non-cooperative body reads and recovers after failure", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const entered = deferred<void>();
    const client = createNeonUsageClient({
      accessToken: "token",
      limits: { maxDurationMs: 20 },
      fetch: async () =>
        new Response(
          new ReadableStream({
            pull() {
              entered.resolve();
              return new Promise(() => {});
            },
            cancel,
          }),
        ),
    });
    const pending = client.listOrganizations();
    const rejected = expect(pending).rejects.toMatchObject({ code: "COLLECTION_LIMIT_REACHED" });
    await entered.promise;
    await vi.advanceTimersByTimeAsync(20);
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
    client.close();
  });

  it("keeps the local window fixed at 60 seconds with an additional host coordinator", async () => {
    vi.useFakeTimers();
    const fetch = fixtureFetch("free");
    const host = { acquire: vi.fn(async () => {}) };
    const client = createNeonUsageClient({
      accessToken: "token",
      fetch,
      requestCoordinator: host,
      limits: { requestsPerMinute: 1 },
    });
    await client.listOrganizations();
    const pending = client.listOrganizations();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(fetch).toHaveBeenCalledOnce();
    expect(host.acquire).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(host.acquire).toHaveBeenCalledTimes(2);
    client.close();
  });

  it("collects healthy snapshot fan-out at one request per minute within the operation deadline", async () => {
    vi.useFakeTimers();
    const startedAt = performance.now();
    const dispatched: number[] = [];
    const projectIds = ["a", "b", "c", "d"].map((id) => `project-${id}`);
    const client = createNeonUsageClient({
      accessToken: "token",
      now,
      limits: { requestsPerMinute: 1, concurrency: 5 },
      fetch: async (input) => {
        dispatched.push(performance.now() - startedAt);
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/organizations/org-1"))
          return Response.json({ id: "org-1", plan: "free" });
        if (path.endsWith("/projects"))
          return Response.json({ projects: projectIds.map((id) => ({ id, name: id })) });
        if (path.endsWith("/branches")) return Response.json({ branches: [] });
        return Response.json(currentProject(path.split("/").at(-1) ?? ""));
      },
    });
    try {
      const result = client.collectMeasuredUsage({ organizationId: "org-1", source: "current" });
      await vi.advanceTimersByTimeAsync(540_000);
      const collected = await result;
      expect(dispatched).toEqual(Array.from({ length: 10 }, (_, index) => index * 60_000));
      expect(collected.measuredUsage.coverage).toMatchObject({ status: "complete", errors: [] });
      expect(collected.measuredUsage.projects).toHaveLength(4);
    } finally {
      client.close();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["caller", "deadline"] as const)(
    "stops queued admission on %s cancellation",
    async (kind) => {
      vi.useFakeTimers();
      let admissionSignal: AbortSignal | undefined;
      const fetch = fixtureFetch("free");
      const client = createNeonUsageClient({
        accessToken: "token",
        fetch,
        limits: { maxDurationMs: 100, requestsPerMinute: 1 },
        requestCoordinator: {
          acquire: async (signal) => {
            admissionSignal = signal;
            return new Promise(() => {});
          },
        },
      });
      const controller = new AbortController();
      try {
        const request = client
          .listOrganizations({ signal: controller.signal })
          .catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(99);
        expect(admissionSignal?.aborted).toBe(false);
        if (kind === "caller") controller.abort();
        else await vi.advanceTimersByTimeAsync(1);
        await expect(request).resolves.toMatchObject({
          code: kind === "caller" ? "CANCELLED" : "COLLECTION_LIMIT_REACHED",
        });
        expect(admissionSignal?.aborted).toBe(true);
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        client.close();
      }
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("keeps a shared host permit fresh while another client's local window waits", async () => {
    vi.useFakeTimers();
    const startedAt = performance.now();
    const dispatched: number[] = [];
    const fetch = fixtureFetch("free");
    const transport: typeof globalThis.fetch = (input, init) => {
      dispatched.push(performance.now() - startedAt);
      return fetch(input, init);
    };
    const host = createSlidingWindowRequestCoordinator({ limit: 1, intervalMs: 30_000 });
    const slow = createNeonUsageClient({
      accessToken: "token",
      fetch: transport,
      requestCoordinator: host,
      limits: { requestsPerMinute: 1 },
    });
    const fast = createNeonUsageClient({
      accessToken: "token",
      fetch: transport,
      requestCoordinator: host,
    });
    await slow.listOrganizations();
    const waitingLocal = slow.listOrganizations();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(dispatched).toEqual([0]);
    const otherClient = fast.listOrganizations();
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatched).toEqual([0, 30_000]);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(dispatched).toEqual([0, 30_000]);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([waitingLocal, otherClient]);
    expect(dispatched).toEqual([0, 30_000, 60_000]);
    slow.close();
    fast.close();
  });

  it("starts the local window when a slower shared host admits the request", async () => {
    vi.useFakeTimers();
    const startedAt = performance.now();
    const dispatched: number[] = [];
    const host = createSlidingWindowRequestCoordinator({ limit: 2, intervalMs: 90_000 });
    const fetch = fixtureFetch("free");
    const primer = createNeonUsageClient({ accessToken: "token", fetch, requestCoordinator: host });
    await primer.listOrganizations();
    await primer.listOrganizations();
    const client = createNeonUsageClient({
      accessToken: "token",
      fetch: (input, init) => {
        dispatched.push(performance.now() - startedAt);
        return fetch(input, init);
      },
      requestCoordinator: host,
      limits: { requestsPerMinute: 1 },
    });
    const waitingHost = client.listOrganizations();
    await vi.advanceTimersByTimeAsync(89_999);
    expect(dispatched).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await waitingHost;
    expect(dispatched).toEqual([90_000]);
    const waitingLocal = client.listOrganizations();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(dispatched).toEqual([90_000]);
    await vi.advanceTimersByTimeAsync(1);
    await waitingLocal;
    expect(dispatched).toEqual([90_000, 150_000]);
    client.close();
    primer.close();
  });

  it("does not spend shared host capacity on a cancelled local wait", async () => {
    vi.useFakeTimers();
    const fetch = fixtureFetch("free");
    const host = createSlidingWindowRequestCoordinator({ limit: 1, intervalMs: 30_000 });
    const client = createNeonUsageClient({
      accessToken: "token",
      fetch,
      requestCoordinator: host,
      limits: { requestsPerMinute: 1 },
    });
    const other = createNeonUsageClient({ accessToken: "token", fetch, requestCoordinator: host });
    await client.listOrganizations();
    const abort = new AbortController();
    const waiting = client.listOrganizations({ signal: abort.signal });
    const cancelled = expect(waiting).rejects.toMatchObject({ code: "CANCELLED" });
    await vi.advanceTimersByTimeAsync(40_000);
    expect(fetch).toHaveBeenCalledOnce();
    abort.abort();
    await cancelled;
    const next = other.listOrganizations();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(2);
    await next;
    client.close();
    other.close();
  });

  it.each(["listOrganizations", "listProjects"] as const)(
    "never returns truncated %s inventory",
    async (method) => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () =>
        Response.json({
          organizations: [
            { id: "org-1", name: "One", handle: "one", plan: "free" },
            { id: "org-2", name: "Two", handle: "two", plan: "free" },
          ],
          projects: [
            { id: "project-1", name: "One" },
            { id: "project-2", name: "Two" },
          ],
        }),
      );
      const client = createNeonUsageClient({
        accessToken: "token",
        fetch,
        limits: { maxItems: 1 },
      });
      await expect(
        method === "listOrganizations" ? client.listOrganizations() : client.listProjects("org-1"),
      ).rejects.toMatchObject({ code: "COLLECTION_LIMIT_REACHED" });
      client.close();
    },
  );

  it("maps repeated inventory cursors to integrity failure", async () => {
    const client = createNeonUsageClient({
      accessToken: "token",
      fetch: async () =>
        Response.json({
          projects: [{ id: "project-1", name: "One" }],
          pagination: { cursor: "repeat" },
        }),
    });
    await expect(client.listProjects("org-1")).rejects.toMatchObject({ code: "INTEGRITY_FAILURE" });
    client.close();
  });

  it("enforces project and per-body ceilings", async () => {
    const fetch = fixtureFetch("free");
    fetch.mockImplementation(async (input) =>
      String(input).includes("/organizations/")
        ? Response.json({ id: "org-1", plan: "free" })
        : Response.json({
            projects: [
              { id: "project-1", name: "One" },
              { id: "project-2", name: "Two" },
            ],
          }),
    );
    const client = createNeonUsageClient({
      accessToken: "token",
      fetch,
      now,
      limits: { maxProjects: 1 },
    });
    await expect(
      client.collectMeasuredUsage({ organizationId: "org-1", source: "current" }),
    ).rejects.toMatchObject({ code: "COLLECTION_LIMIT_REACHED" });
    client.close();
    const small = createNeonUsageClient({
      accessToken: "token",
      fetch,
      limits: { maxResponseBytes: 1 },
    });
    await expect(small.inspectCapability("org-1")).rejects.toMatchObject({
      code: "COLLECTION_LIMIT_REACHED",
    });
    small.close();
  });

  it.each([
    ["single page", 1, 10, "partial", 0],
    ["single page", 2, 10, "complete", 2],
    ["single page", 2, 1, "partial", 0],
    ["paginated", 1, 10, "partial", 1],
    ["paginated", 2, 10, "complete", 2],
    ["paginated", 2, 1, "partial", 1],
  ] as const)(
    "bounds %s history with maxProjects=%i and maxItems=%i",
    async (pagination, maxProjects, maxItems, status, projectCount) => {
      const cursors: Array<string | null> = [];
      const client = createNeonUsageClient({
        accessToken: "token",
        now,
        limits: { maxProjects, maxItems },
        fetch: async (input) => {
          const url = new URL(String(input));
          if (url.pathname.endsWith("/organizations/org-1"))
            return Response.json({ id: "org-1", plan: "launch" });
          const cursor = url.searchParams.get("cursor");
          cursors.push(cursor);
          const page = historyPage(pagination === "paginated" && cursor === null ? "next" : null);
          const second = page.projects.map((project) => ({ ...project, project_id: "project-2" }));
          if (pagination === "single page") page.projects.push(...second);
          else if (cursor !== null) page.projects = second;
          return Response.json(page);
        },
      });
      try {
        const result = await client.collectMeasuredUsage({
          organizationId: "org-1",
          source: "history",
          query,
        });
        expect(result.measuredUsage.projects).toHaveLength(projectCount);
        expect(result.measuredUsage.coverage).toMatchObject({
          status,
          authoritative: status === "complete",
        });
        if (status === "partial") {
          expect(result.measuredUsage.coverage.qualityFlags).toContain("ITEM_LIMIT_REACHED");
          expect(result.measuredUsage.metrics).toBeNull();
          expect(result.estimate?.status).toBe("unavailable_partial_coverage");
        } else {
          expect(result.measuredUsage.metrics).not.toBeNull();
          expect(result.measuredUsage.coverage.qualityFlags).not.toContain("ITEM_LIMIT_REACHED");
        }
        expect(cursors).toEqual(
          pagination === "paginated" && status === "complete" ? [null, null, "next"] : [null, null],
        );
      } finally {
        client.close();
      }
    },
  );

  it.each(["cooperative", "rejecting", "pending"] as const)(
    "releases an oversized header body with %s cancellation before the next operation",
    async (cancellation) => {
      const pull = vi.fn();
      let rejectCancellation: (reason: Error) => void = () => {};
      const cancel = vi.fn(() => {
        if (cancellation === "rejecting") return Promise.reject(new Error("cancel failed"));
        if (cancellation === "pending")
          return new Promise<void>((_resolve, reject) => {
            rejectCancellation = reject;
          });
      });
      const oversized = new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), {
        headers: { "content-length": "1000" },
      });
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(oversized)
        .mockResolvedValue(Response.json({ organizations: [] }));
      const acquire = vi.fn(async () => {});
      const client = createNeonUsageClient({
        accessToken: "token",
        limits: { maxResponseBytes: 100 },
        requestCoordinator: { acquire },
        fetch,
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          client.listOrganizations().catch((error: unknown) => error),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve("stalled"), 100);
          }),
        ]);
        expect(result).toMatchObject({ name: "NeonUsageError", code: "COLLECTION_LIMIT_REACHED" });
        expect(cancel).toHaveBeenCalledOnce();
        expect(pull).not.toHaveBeenCalled();
        expect(fetch).toHaveBeenCalledOnce();
        expect(acquire).toHaveBeenCalledOnce();
        await expect(client.listOrganizations()).resolves.toEqual([]);
        rejectCancellation(new Error("late cancellation rejection"));
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(cancel).toHaveBeenCalledOnce();
        expect(pull).not.toHaveBeenCalled();
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(acquire).toHaveBeenCalledTimes(2);
      } finally {
        clearTimeout(timer);
        client.close();
      }
    },
  );

  it("returns valid explicit partial history with withheld authoritative totals", async () => {
    const client = createNeonUsageClient({
      accessToken: "token",
      now,
      limits: { maxPages: 1 },
      fetch: async (input) =>
        String(input).includes("/organizations/")
          ? Response.json({ id: "org-1", plan: "launch" })
          : Response.json(historyPage("next")),
    });
    const result = await client.collectMeasuredUsage({
      organizationId: "org-1",
      source: "history",
      query,
    });
    expect(result.measuredUsage.coverage.status).toBe("partial");
    expect(result.measuredUsage.metrics).toBeNull();
    expect(result.estimate?.status).toBe("unavailable_partial_coverage");
    client.close();
  });

  it("bounds retained history pages independently of each response body", async () => {
    const page = historyPage("next");
    const pageBytes = Buffer.byteLength(JSON.stringify(page));
    const client = createNeonUsageClient({
      accessToken: "token",
      now,
      limits: { maxBytes: pageBytes, maxResponseBytes: pageBytes + 100 },
      fetch: async (input) =>
        String(input).includes("/organizations/")
          ? Response.json({ id: "org-1", plan: "launch" })
          : Response.json(page),
    });
    const result = await client.collectMeasuredUsage({
      organizationId: "org-1",
      source: "history",
      query,
    });
    expect(result.measuredUsage.projects).toHaveLength(1);
    expect(result.measuredUsage.coverage).toMatchObject({
      status: "partial",
      qualityFlags: expect.arrayContaining(["BYTE_LIMIT_REACHED"]),
    });
    expect(result.measuredUsage.metrics).toBeNull();
    client.close();
  });

  it("bounds facts even when the response and page count fit", async () => {
    const page = historyPage();
    page.projects[0]?.periods[0]?.consumption[0]?.metrics.push({
      metric_name: "root_branch_bytes_month",
      value: "0",
    });
    const client = createNeonUsageClient({
      accessToken: "token",
      now,
      limits: { maxFacts: 1 },
      fetch: async (input) =>
        String(input).includes("/organizations/")
          ? Response.json({ id: "org-1", plan: "launch" })
          : Response.json(page),
    });
    const result = await client.collectMeasuredUsage({
      organizationId: "org-1",
      source: "history",
      query,
    });
    expect(result.measuredUsage.coverage).toMatchObject({
      status: "partial",
      qualityFlags: expect.arrayContaining(["FACT_LIMIT_REACHED"]),
    });
    expect(result.measuredUsage.metrics).toBeNull();
    client.close();
  });

  it("applies one deadline across capability and collection calls", async () => {
    vi.useFakeTimers();
    const createStore = stores.createInMemoryEvidenceFactStore;
    const close = vi.fn();
    vi.spyOn(stores, "createInMemoryEvidenceFactStore").mockImplementation(() => ({
      ...createStore(),
      close,
    }));
    const fetch = fixtureFetch();
    const client = createNeonUsageClient({
      accessToken: "token",
      now,
      limits: { maxDurationMs: 25 },
      fetch: async (...args) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return fetch(...args);
      },
    });
    const pending = client.collectMeasuredUsage({
      organizationId: "org-1",
      source: "history",
      query,
    });
    const rejected = expect(pending).rejects.toMatchObject({ code: "COLLECTION_LIMIT_REACHED" });
    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledOnce();
    client.close();
  });

  it.each(["deadline", "caller", "close"] as const)(
    "handles %s after an accepted history page while a non-cooperative continuation stalls",
    async (stop) => {
      vi.useFakeTimers();
      const entered = deferred<void>();
      const createStore = stores.createInMemoryEvidenceFactStore;
      const close = vi.fn();
      vi.spyOn(stores, "createInMemoryEvidenceFactStore").mockImplementation(() => ({
        ...createStore(),
        close,
      }));
      const controller = new AbortController();
      const fixture = fixtureFetch();
      const client = createNeonUsageClient({
        accessToken: "token",
        now,
        limits: { maxDurationMs: 25 },
        fetch: async (input, init) => {
          const url = new URL(String(input));
          if (url.searchParams.has("cursor")) {
            entered.resolve();
            return new Promise(() => {});
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
          if (url.pathname.endsWith("/consumption_history/v2/projects"))
            return Response.json(historyPage("next"));
          return fixture(input, init);
        },
      });
      const pending = client.collectMeasuredUsage(
        { organizationId: "org-1", source: "history", query },
        { signal: controller.signal },
      );
      const settled = pending.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(15);
      await entered.promise;
      if (stop === "caller") controller.abort();
      if (stop === "close") client.close();
      await vi.advanceTimersByTimeAsync(10);
      const result = await settled;
      if (stop === "deadline") {
        expect(result).toMatchObject({
          measuredUsage: {
            coverage: {
              status: "partial",
              authoritative: false,
              qualityFlags: expect.arrayContaining(["TIME_LIMIT_REACHED"]),
            },
            metrics: null,
            projects: [expect.objectContaining({ projectId: "project-1" })],
          },
          estimate: { status: "unavailable_partial_coverage", totalAmount: null },
        });
        const recovered = client.listOrganizations();
        await vi.advanceTimersByTimeAsync(5);
        await expect(recovered).resolves.toHaveLength(1);
      } else expect(result).toMatchObject({ code: "CANCELLED" });
      expect(close).toHaveBeenCalledOnce();
      client.close();
    },
  );

  it("rejects a pre-aborted operation before any transport", async () => {
    const fetch = fixtureFetch();
    const client = createNeonUsageClient({ accessToken: "token", fetch });
    await expect(
      client.listOrganizations({ signal: AbortSignal.abort("secret") }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(fetch).not.toHaveBeenCalled();
    client.close();
  });

  it("checks the overall deadline even when injected work settles before timers run", async () => {
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    const client = createNeonUsageClient({
      accessToken: "token",
      now,
      limits: { maxDurationMs: 20 },
      fetch: async () => {
        elapsed = 21;
        return Response.json({ id: "org-1", plan: "free" });
      },
    });
    await expect(client.inspectCapability("org-1")).rejects.toMatchObject({
      code: "COLLECTION_LIMIT_REACHED",
    });
    client.close();
  });
});

describe("sanitized public errors", () => {
  it.each(["failure", "history", "current"] as const)(
    "suppresses a long credential before request-ID truncation in %s diagnostics",
    async (path) => {
      const accessToken = `credential-${"s".repeat(300)}`;
      const fixture = fixtureFetch(path === "current" ? "free" : "launch");
      const client = createNeonUsageClient({
        accessToken,
        now,
        fetch: async (input, init) => {
          const url = new URL(String(input));
          if (path === "failure" || url.pathname.endsWith("/projects/project-1"))
            return Response.json({}, { status: 403, headers: { "x-request-id": accessToken } });
          if (path === "current" && url.pathname.endsWith("/projects"))
            return Response.json({ projects: [{ id: "project-1", name: "One" }] });
          const response = await fixture(input, init);
          response.headers.set("x-request-id", `prefix-${accessToken}-suffix`);
          return response;
        },
      });
      try {
        const result = await (path === "failure"
          ? client.listOrganizations().catch((error: unknown) => error)
          : client.collectMeasuredUsage({
              organizationId: "org-1",
              source: path,
              ...(path === "history" ? { query } : {}),
            } as CollectMeasuredUsageInput));
        if (path === "failure") expect(result).toMatchObject({ code: "AUTHORIZATION_FAILED" });
        expect(JSON.stringify(result)).not.toContain("credential-");
        if (path === "history") expect(result).not.toHaveProperty("estimate.requestIds");
        if (path === "current")
          expect(result).toHaveProperty("measuredUsage.coverage.status", "partial");
      } finally {
        client.close();
      }
    },
  );
  it("filters credential-bearing successful history diagnostics without mutating service output", async () => {
    const estimateProjectCosts = pricing.estimateProjectCosts;
    const originalEstimates: pricing.PricingEstimate[] = [];
    vi.spyOn(pricing, "estimateProjectCosts").mockImplementation((...args) => {
      const estimate = estimateProjectCosts(...args);
      // Inject a service diagnostic to retain the public boundary's independent redaction check.
      estimate.requestIds = ["secret-token"];
      if (estimate.requestIds) Object.freeze(estimate.requestIds);
      originalEstimates.push(Object.freeze(estimate));
      return estimate;
    });
    const fetch = fixtureFetch();
    const client = createNeonUsageClient({
      accessToken: "secret-token",
      now,
      fetch: async (...args) => {
        const response = await fetch(...args);
        response.headers.set("x-request-id", "secret-token");
        return response;
      },
    });
    try {
      const result = await client.collectMeasuredUsage({
        organizationId: "org-1",
        source: "history",
        query,
      });
      expect(result.measuredUsage.coverage.status).toBe("complete");
      expect(originalEstimates[0]?.requestIds).toEqual(["secret-token"]);
      expect(result.estimate).not.toBe(originalEstimates[0]);
      expect(result.estimate?.requestIds).toEqual([]);
      expect(JSON.stringify(result)).not.toContain("secret-token");
    } finally {
      client.close();
    }
  });

  it.each(["listProjects", "inspectCapability", "collectMeasuredUsage"] as const)(
    "maps structured failures from %s",
    async (method) => {
      for (const [status, code] of [
        [401, "AUTHENTICATION_FAILED"],
        [403, "AUTHORIZATION_FAILED"],
        [404, "PROVIDER_UNAVAILABLE"],
        [503, "PROVIDER_UNAVAILABLE"],
      ] as const) {
        const client = createNeonUsageClient({
          accessToken: "token",
          fetch: async () =>
            Response.json({ message: "raw body" }, { status, headers: { "retry-after": "900" } }),
        });
        const pending =
          method === "collectMeasuredUsage"
            ? client.collectMeasuredUsage({ organizationId: "org-1" })
            : client[method]("org-1");
        await expect(pending).rejects.toMatchObject({
          name: "NeonUsageError",
          code,
          providerStatus: status,
        });
        client.close();
      }
    },
  );

  it.each([
    [401, "AUTHENTICATION_FAILED"],
    [403, "AUTHORIZATION_FAILED"],
    [404, "PROVIDER_UNAVAILABLE"],
    [503, "PROVIDER_UNAVAILABLE"],
  ])("maps directory HTTP %i without leaking raw provider fields", async (status, code) => {
    const client = createNeonUsageClient({
      accessToken: "secret-token",
      fetch: async () =>
        Response.json(
          { message: "secret-token raw body", code: "RAW_CODE" },
          {
            status: Number(status),
            headers: { "x-request-id": "request-1", "retry-after": "900" },
          },
        ),
    });
    const error: unknown = await client.listOrganizations().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(NeonUsageError);
    expect(error).toMatchObject({ code, providerStatus: status, requestId: "request-1" });
    expect(error).not.toHaveProperty("cause");
    expect(String(error)).not.toMatch(/secret-token|raw body|RAW_CODE/);
    client.close();
  });

  it("bounds metadata and never accepts a caller-owned message or cause", () => {
    const error = new NeonUsageError("PROVIDER_UNAVAILABLE", {
      providerStatus: 999,
      requestId: `request\n\u202e${"😀".repeat(300)}`,
    });
    expect(error).not.toHaveProperty("providerStatus");
    expect(error).not.toHaveProperty("cause");
    expect([...error.message].length).toBeLessThanOrEqual(512);
    expect([...(error.requestId ?? "")].length).toBeLessThanOrEqual(256);
    expect(error.requestId).not.toMatch(/[\n\u202e]/);
  });

  it("maps malformed JSON and injected failures without raw causes", async () => {
    for (const fetch of [
      async () => new Response("not JSON secret-token"),
      async () => {
        throw new Error("secret-token transport");
      },
    ]) {
      const client = createNeonUsageClient({ accessToken: "secret-token", fetch });
      const error: unknown = await client.listOrganizations().catch((value: unknown) => value);
      expect(error).toBeInstanceOf(NeonUsageError);
      expect(error).not.toHaveProperty("cause");
      expect(String(error)).not.toContain("secret-token");
      client.close();
    }
  });

  it("rebuilds even injected public errors using package-owned messages", async () => {
    const injected = new NeonUsageError("PROVIDER_UNAVAILABLE", { requestId: "secret-token" });
    injected.message = "secret-token injected message";
    Object.defineProperty(injected, "cause", { value: new Error("raw secret") });
    const client = createNeonUsageClient({
      accessToken: "secret-token",
      requestCoordinator: {
        acquire: async () => {
          throw injected;
        },
      },
    });
    const error: unknown = await client.listOrganizations().catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(error).not.toHaveProperty("cause");
    expect(error).not.toHaveProperty("requestId");
    expect(String(error)).not.toContain("secret-token");
    client.close();
  });

  it("sanitizes injected rejection values that cannot be inspected", async () => {
    const injected = Proxy.revocable({}, {});
    injected.revoke();
    const client = createNeonUsageClient({
      accessToken: "token",
      requestCoordinator: {
        acquire: async () => {
          throw injected.proxy;
        },
      },
    });
    await expect(client.listOrganizations()).rejects.toMatchObject({
      name: "NeonUsageError",
      code: "PROVIDER_UNAVAILABLE",
    });
    client.close();
  });

  it("propagates an oversized history probe as a collection limit", async () => {
    const client = createNeonUsageClient({
      accessToken: "token",
      now,
      limits: { maxResponseBytes: 100 },
      fetch: fixtureFetch(),
    });
    await expect(client.collectMeasuredUsage({ organizationId: "org-1" })).rejects.toMatchObject({
      code: "COLLECTION_LIMIT_REACHED",
    });
    client.close();
  });

  it("maps private-store failure to sanitized integrity failure and closes the store", async () => {
    const createStore = stores.createInMemoryEvidenceFactStore;
    const close = vi.fn();
    vi.spyOn(stores, "createInMemoryEvidenceFactStore").mockImplementation(() => ({
      ...createStore(),
      close,
      writeEvidence: async () => {
        throw new Error("secret-token store failure");
      },
    }));
    const client = createNeonUsageClient({
      accessToken: "secret-token",
      fetch: fixtureFetch("free"),
      now,
    });
    const error: unknown = await client
      .collectMeasuredUsage({ organizationId: "org-1" })
      .catch((value: unknown) => value);
    expect(error).toMatchObject({ name: "NeonUsageError", code: "INTEGRITY_FAILURE" });
    expect(error).not.toHaveProperty("cause");
    expect(String(error)).not.toContain("secret-token");
    expect(close).toHaveBeenCalledOnce();
    client.close();
  });

  it("sanitizes provider errors inside a partial snapshot", async () => {
    const client = createNeonUsageClient({
      accessToken: "secret-token",
      now,
      fetch: async (input) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/organizations/org-1"))
          return Response.json({ id: "org-1", plan: "free" });
        if (path.endsWith("/projects"))
          return Response.json({ projects: [{ id: "project-1", name: "One" }] });
        return Response.json(
          { code: "RAW_PROVIDER_CODE", message: "secret-token provider body" },
          { status: 403, headers: { "x-request-id": "request-1" } },
        );
      },
    });
    const result = await client.collectMeasuredUsage({
      organizationId: "org-1",
      source: "current",
    });
    expect(result.measuredUsage.coverage).toMatchObject({
      status: "partial",
      errors: [
        {
          projectId: "project-1",
          detail: { code: "AUTHORIZATION_FAILED", status: 403, requestId: "request-1" },
        },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/secret-token|provider body|RAW_PROVIDER_CODE/);
    client.close();
  });
});
