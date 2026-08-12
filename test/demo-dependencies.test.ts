import { describe, expect, it } from "vitest";
import { createDashboardApp } from "../src/dashboard-server.js";
import { createDemoDependencies, demoProjectPage } from "../src/demo-dependencies.js";

// A mid-month instant so daily buckets, the snapshot period, and the
// billing-period math all have room on both sides.
const NOW = new Date("2026-08-12T15:00:00Z");

function demoApp() {
  return createDashboardApp(createDemoDependencies({ now: () => NOW }), { now: () => NOW });
}

async function json(path: string): Promise<{ status: number; body: never }> {
  const response = await demoApp().request(path);
  return { status: response.status, body: (await response.json()) as never };
}

describe("demo dependencies through the real dashboard routes", () => {
  it("serves every page-driving route with complete synthetic reports", async () => {
    // The demo source runs through the REAL services, so a validator or
    // shape failure here would surface as a non-200.
    const context = await json("/api/context");
    expect(context.status).toBe(200);
    expect(context.body).toMatchObject({
      organizationId: "org-demo-42813975",
      credential: "demo",
    });

    const organizations = await json("/api/organizations");
    expect(organizations.status).toBe(200);
    expect(organizations.body).toEqual([
      expect.objectContaining({ id: "org-demo-42813975", name: "Acme Cloud", plan: "launch" }),
    ]);

    const projects = await json("/api/projects");
    expect(projects.status).toBe(200);
    expect((projects.body as { projects: unknown[] }).projects).toHaveLength(5);

    const usage = await json("/api/usage?last=7d");
    expect(usage.status).toBe(200);
    expect(usage.body).toMatchObject({
      organization: { name: "Acme Cloud" },
      coverage: { status: "complete" },
      observedProjectCount: 5,
    });

    const history = await json("/api/project-report?scope=organization&last=7d");
    expect(history.status).toBe(200);
    const historyBody = history.body as {
      coverage: { status: string };
      projects: Array<{ projectId: string; periods: Array<{ buckets: unknown[] }> }>;
    };
    expect(historyBody.coverage.status).toBe("complete");
    expect(historyBody.projects).toHaveLength(5);
    expect(historyBody.projects[0]?.periods[0]?.buckets).toHaveLength(7);

    const detail = await json("/api/project-report?projectIds=analytics-90315377&last=7d");
    expect(detail.status).toBe(200);
    expect((detail.body as { projects: Array<{ projectId: string }> }).projects).toEqual([
      expect.objectContaining({ projectId: "analytics-90315377" }),
    ]);

    const estimate = await json("/api/estimate?scope=organization&month=current");
    expect(estimate.status).toBe(200);
    expect(estimate.body).toMatchObject({ disposition: "estimate", status: "estimated" });
    expect(
      Number(
        (estimate.body as { totalAmount: { decimalApproximation: string } }).totalAmount
          .decimalApproximation,
      ),
    ).toBeGreaterThan(0);

    const snapshot = await json("/api/current-report?projectIds=api-production-11837462");
    expect(snapshot.status).toBe(200);
    expect(snapshot.body).toMatchObject({ coverage: { status: "complete" } });

    const utilization = await json("/api/utilization?projectIds=api-production-11837462");
    expect(utilization.status).toBe(200);
    const utilizationBody = utilization.body as {
      projects: Array<{ metrics: { computeTimeSeconds: { percentUsed: string | null } } }>;
    };
    expect(utilizationBody.projects[0]?.metrics.computeTimeSeconds.percentUsed).not.toBeNull();

    const controls = await json("/api/controls?projectIds=all");
    expect(controls.status).toBe(200);
    expect(controls.body).toMatchObject({
      readOnly: true,
      spendingNotification: { status: "configured", semantics: "alert_only" },
    });
  });

  it("is deterministic for a fixed clock and window", async () => {
    const first = await demoApp().request("/api/project-report?scope=organization&last=7d");
    const second = await demoApp().request("/api/project-report?scope=organization&last=7d");
    const normalize = (text: string) => text.replaceAll(/"generatedAt": "[^"]+"/g, "");
    expect(normalize(await second.text())).toBe(normalize(await first.text()));
  });

  it("contains no real account identifiers anywhere in its output", async () => {
    const bodies = await Promise.all(
      ["/api/organizations", "/api/projects", "/api/usage?last=7d", "/api/context"].map(
        async (path) => (await demoApp().request(path)).text(),
      ),
    );
    const combined = bodies.join("\n");
    // The fictional org and Neon-shaped-but-fake project IDs only.
    expect(combined).toContain("org-demo-42813975");
    expect(combined).not.toMatch(/org-(?!demo-42813975)[a-z]+-[a-z]+-\d+/);
  });
});

describe("demo data semantics", () => {
  it("gives a date the same value in every window that contains it", async () => {
    const seven = (await (
      await demoApp().request("/api/project-report?scope=organization&last=7d")
    ).json()) as never as {
      projects: Array<{
        projectId: string;
        periods: Array<{
          buckets: Array<{ start: string; metrics: Array<{ name: string; value: string }> }>;
        }>;
      }>;
    };
    const month = (await (
      await demoApp().request("/api/project-report?scope=organization&month=current")
    ).json()) as typeof seven;
    const value = (report: typeof seven, start: string) => {
      for (const project of report.projects) {
        if (project.projectId !== "api-production-11837462") continue;
        for (const period of project.periods)
          for (const bucket of period.buckets)
            if (bucket.start === start)
              return bucket.metrics.find((metric) => metric.name === "compute_unit_seconds")?.value;
      }
      return undefined;
    };
    const start = "2026-08-08T00:00:00.000Z";
    expect(value(seven, start)).toBeDefined();
    expect(value(seven, start)).toBe(value(month, start));
  });

  it("splits multi-month queries into one billing period per calendar month", async () => {
    const response = await demoApp().request(
      "/api/project-report?scope=organization&granularity=monthly&from=2026-05-01T00:00:00Z&to=2026-08-01T00:00:00Z",
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      projects: Array<{ periods: Array<{ id: string; start: string }> }>;
    };
    expect(body.projects[0]?.periods.map((period) => period.id)).toEqual([
      "period-2026-05",
      "period-2026-06",
      "period-2026-07",
    ]);
  });

  it("refuses organizations other than the fictional one", async () => {
    const response = await demoApp().request(
      "/api/project-report?orgId=org-real-looking-12345678&scope=organization&last=7d",
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("demo mode serves only the fictional organization");
  });
});

describe("demo provenance and budgets", () => {
  it("payloadHash verifies the represented payload content", async () => {
    const { createHash } = await import("node:crypto");
    const page = demoProjectPage({
      organizationId: "org-demo-42813975",
      from: "2026-08-05T00:00:00.000Z",
      to: "2026-08-08T00:00:00.000Z",
      granularity: "daily",
      metrics: ["compute_unit_seconds", "public_network_transfer_bytes"],
    });
    // Reconstruct the bare payload the hash claims to identify.
    const bare = page.projects.map((project) => ({
      projectId: project.projectId,
      periods: project.periods.map((period) => ({
        id: period.id,
        plan: period.plan,
        start: period.start,
        buckets: period.buckets.map((bucket) => ({
          start: bucket.start,
          end: bucket.end,
          metrics: bucket.metrics.map((metric) => ({ name: metric.name, value: metric.value })),
        })),
      })),
    }));
    const digest = `sha256:${createHash("sha256").update(JSON.stringify(bare)).digest("hex")}`;
    expect(page.evidence?.payloadHash).toBe(digest);
    // A mutated payload no longer matches its own hash.
    const mutated = structuredClone(bare);
    const metric = mutated[0]?.periods[0]?.buckets[0]?.metrics[0];
    if (!metric) throw new Error("expected a metric");
    metric.value = "999999";
    expect(`sha256:${createHash("sha256").update(JSON.stringify(mutated)).digest("hex")}`).not.toBe(
      page.evidence?.payloadHash,
    );
  });

  it("honors the collection ceilings with honest-partial semantics", async () => {
    const app = createDashboardApp(
      createDemoDependencies({ now: () => NOW, collectionBudget: { maxItems: 1 } }),
      { now: () => NOW },
    );
    const body = (await (await app.request("/api/usage?last=7d")).json()) as {
      coverage: { status: string; qualityFlags: string[] };
    };
    expect(body.coverage.status).toBe("partial");
    expect(body.coverage.qualityFlags).toContain("ITEM_LIMIT_REACHED");
  });
});
