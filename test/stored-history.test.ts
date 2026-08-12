import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createConsumptionService,
  createInMemoryEvidenceFactStore,
  createSqliteEvidenceFactStore,
  type EvidenceFactStore,
  type ProjectConsumptionSource,
  type ProjectReportQuery,
} from "../src/index.js";
import { bucketStarts, planStoredServing } from "../src/stored-history.js";
import { sqliteModule } from "./support/sqlite-availability.js";

const NOW = new Date("2026-08-11T06:00:00Z");

function query(overrides: Partial<ProjectReportQuery> = {}): ProjectReportQuery {
  return {
    organizationId: "org-1",
    from: "2026-08-01T00:00:00Z",
    to: "2026-08-11T00:00:00Z",
    granularity: "daily",
    metrics: ["compute_unit_seconds"],
    ...overrides,
  };
}

/** One page per request; every requested day reports 3600 CU-seconds per
 * project. Honors the query's projectIds filter like the real API. Mimics
 * the real adapter by sinking page evidence into the store. */
function countingSource(
  store: EvidenceFactStore,
  allProjects: string[] = ["project-1"],
): ProjectConsumptionSource & { requests: ProjectReportQuery[] } {
  const requests: ProjectReportQuery[] = [];
  return {
    requests,
    async getProjectPage(pageQuery) {
      requests.push(structuredClone(pageQuery));
      const call = requests.length;
      const evidenceId = `evidence:${call}`;
      const payloadHash = `sha256:${String(call % 10).repeat(64)}`;
      await store.writeEvidence(
        {
          evidenceId,
          sourceAccount: "credential:test",
          sourceContract: "consumption-history-v2-projects",
          requestedAt: "2026-08-11T00:00:00Z",
          completedAt: "2026-08-11T00:00:01Z",
          request: {
            method: "GET",
            path: "/consumption_history/v2/projects",
            query: "",
            cursorIn: null,
            fingerprint: `sha256:${call}`,
          },
          response: { status: 200, cursorOut: null, payloadHash },
          attempt: 1,
        },
        new AbortController().signal,
      );
      const buckets = bucketStarts({
        from: pageQuery.from,
        to: pageQuery.to,
        granularity: pageQuery.granularity,
      }).map((start, index, starts) => ({
        start,
        end: starts[index + 1] ?? pageQuery.to,
        metrics: [
          {
            name: "compute_unit_seconds",
            value: "3600",
            evidence: { evidenceId, payloadHash, sourcePath: "/projects/0/metrics/0" },
          },
        ],
      }));
      const requestedProjects = pageQuery.projectIds
        ? allProjects.filter((projectId) => pageQuery.projectIds?.includes(projectId))
        : allProjects;
      return {
        projects: requestedProjects.map((projectId) => ({
          projectId,
          periods: [{ id: "period-1", plan: "scale", start: "2026-08-01T00:00:00Z", buckets }],
        })),
        nextCursor: null,
        requestId: `req-${call}`,
        evidence: { evidenceId, payloadHash },
      };
    },
  };
}

const stores: Array<[string, () => EvidenceFactStore]> = [
  ["in-memory", () => createInMemoryEvidenceFactStore()],
  ...(sqliteModule
    ? [
        [
          "sqlite",
          () =>
            createSqliteEvidenceFactStore(join(mkdtempSync(join(tmpdir(), "serve-")), "s.sqlite")),
        ] satisfies [string, () => EvidenceFactStore],
      ]
    : []),
];

describe.each(stores)("serve-from-store (%s)", (_name, makeStore) => {
  it("collects once, then serves stored buckets and re-collects only the tail", async () => {
    const store = makeStore();
    const source = countingSource(store);
    const service = () =>
      createConsumptionService(source, {
        factStore: store,
        sourceAccount: "credential:test",
        now: () => NOW,
        storeServing: { serve: true, tailBuckets: 2 },
      });

    const first = await service().projectReport(query());
    expect(first.coverage.status).toBe("complete");
    expect(first.servedFromStore).toBeUndefined();
    expect(source.requests).toHaveLength(1);

    const second = await service().projectReport(query());
    expect(source.requests).toHaveLength(2);
    // Only the 2-bucket tail was re-collected.
    expect(source.requests[1]?.from).toBe("2026-08-09T00:00:00.000Z");
    expect(source.requests[1]?.to).toBe("2026-08-11T00:00:00.000Z");
    expect(second.servedFromStore).toEqual({
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-09T00:00:00.000Z",
      collectedAt: expect.any(String),
    });
    // The merged report carries every requested bucket exactly once.
    const buckets = second.projects[0]?.periods[0]?.buckets ?? [];
    expect(buckets.map((bucket) => bucket.start.slice(8, 10))).toEqual([
      "01",
      "02",
      "03",
      "04",
      "05",
      "06",
      "07",
      "08",
      "09",
      "10",
    ]);
    expect(buckets.every((bucket) => bucket.metrics[0]?.value === "3600")).toBe(true);
    expect(second.coverage.status).toBe("complete");
    store.close();
  });

  it("serves entirely from the store with tail 0 — zero API requests", async () => {
    const store = makeStore();
    const source = countingSource(store);
    const options = {
      factStore: store,
      sourceAccount: "credential:test",
      now: () => NOW,
      storeServing: { serve: true, tailBuckets: 0 },
    };
    await createConsumptionService(source, options).projectReport(query());
    expect(source.requests).toHaveLength(1);

    const served = await createConsumptionService(source, options).projectReport(query());
    expect(source.requests).toHaveLength(1);
    expect(served.servedFromStore?.to).toBe("2026-08-11T00:00:00.000Z");
    expect(served.coverage.status).toBe("complete");
    expect(served.projects[0]?.periods[0]?.buckets).toHaveLength(10);
    store.close();
  });

  it("applies aggregate item budgets while replaying stored pages", async () => {
    const store = makeStore();
    const source = countingSource(store);
    const base = {
      factStore: store,
      sourceAccount: "credential:test",
      now: () => NOW,
      storeServing: { serve: true, tailBuckets: 0 },
    };
    await createConsumptionService(source, base).projectReport(query());

    const served = await createConsumptionService(source, {
      ...base,
      maxItems: 1,
    }).projectReport(query());
    expect(source.requests).toHaveLength(1);
    expect(served.coverage.status).toBe("complete");

    const refused = await createConsumptionService(source, {
      ...base,
      maxFacts: 1,
    }).projectReport(query());
    expect(refused.coverage).toMatchObject({
      status: "partial",
      qualityFlags: expect.arrayContaining(["FACT_LIMIT_REACHED"]),
    });
    // A truncated replay must not claim the full served prefix.
    expect(refused.servedFromStore).toBeUndefined();
  });

  it("collects everything when serving is disabled or the scope differs", async () => {
    const store = makeStore();
    const source = countingSource(store);
    const base = { factStore: store, sourceAccount: "credential:test", now: () => NOW };
    await createConsumptionService(source, {
      ...base,
      storeServing: { serve: true, tailBuckets: 0 },
    }).projectReport(query());

    await createConsumptionService(source, {
      ...base,
      storeServing: { serve: false, tailBuckets: 0 },
    }).projectReport(query());
    expect(source.requests).toHaveLength(2);

    // A different metric set is a different scope: full collection again.
    await createConsumptionService(source, {
      ...base,
      storeServing: { serve: true, tailBuckets: 0 },
    }).projectReport(query({ metrics: ["compute_unit_seconds", "root_branch_bytes_month"] }));
    expect(source.requests).toHaveLength(3);
    store.close();
  });

  it("serves a single-project query from a stored whole-org run, that project only", async () => {
    const store = makeStore();
    const source = countingSource(store, ["project-1", "project-2"]);
    const options = {
      factStore: store,
      sourceAccount: "credential:test",
      now: () => NOW,
      storeServing: { serve: true, tailBuckets: 0 },
    };
    // One whole-org collection certifies the window for every project.
    const orgWide = await createConsumptionService(source, options).projectReport(query());
    expect(orgWide.projects.map((project) => project.projectId)).toEqual([
      "project-1",
      "project-2",
    ]);
    expect(source.requests).toHaveLength(1);

    // The dashboard's project click: zero API requests, only that project.
    const detail = await createConsumptionService(source, options).projectReport(
      query({ projectIds: ["project-2"] }),
    );
    expect(source.requests).toHaveLength(1);
    expect(detail.servedFromStore?.to).toBe("2026-08-11T00:00:00.000Z");
    expect(detail.projects.map((project) => project.projectId)).toEqual(["project-2"]);
    expect(detail.projects[0]?.periods[0]?.buckets).toHaveLength(10);
    expect(
      detail.projects[0]?.periods[0]?.buckets.every(
        (bucket) => bucket.metrics[0]?.value === "3600",
      ),
    ).toBe(true);
    expect(detail.coverage.status).toBe("complete");

    // A multi-project subset serves too, still without leaking the rest.
    const pair = await createConsumptionService(source, options).projectReport(
      query({ projectIds: ["project-2", "project-1"] }),
    );
    expect(source.requests).toHaveLength(1);
    expect(pair.projects.map((project) => project.projectId)).toEqual(["project-1", "project-2"]);
    store.close();
  });

  it("never serves a wider query from a narrower stored run", async () => {
    const store = makeStore();
    const source = countingSource(store, ["project-1", "project-2"]);
    const options = {
      factStore: store,
      sourceAccount: "credential:test",
      now: () => NOW,
      storeServing: { serve: true, tailBuckets: 0 },
    };
    // A run filtered to project-1 certifies nothing about project-2 or the org.
    await createConsumptionService(source, options).projectReport(
      query({ projectIds: ["project-1"] }),
    );
    expect(source.requests).toHaveLength(1);

    const widened = await createConsumptionService(source, options).projectReport(
      query({ projectIds: ["project-1", "project-2"] }),
    );
    expect(widened.servedFromStore).toBeUndefined();
    expect(source.requests).toHaveLength(2);
    expect(widened.projects.map((project) => project.projectId)).toEqual([
      "project-1",
      "project-2",
    ]);

    const orgWide = await createConsumptionService(source, options).projectReport(query());
    expect(orgWide.servedFromStore).toBeUndefined();
    expect(source.requests).toHaveLength(3);
    store.close();
  });
});

describe("planStoredServing", () => {
  const collectionQuery = query();
  const run = (from: string, to: string, overrides = {}) => ({
    runId: `run_${from.slice(8, 10)}` as const,
    status: "complete",
    completedAt: "2026-08-10T00:00:00Z",
    request: query({ from, to }),
    ...overrides,
  });

  it("serves the covered prefix and collects from the first gap", () => {
    const plan = planStoredServing({
      collectionQuery,
      runs: [run("2026-08-01T00:00:00Z", "2026-08-05T00:00:00Z")],
      tailBuckets: 0,
    });
    expect(plan.served).toHaveLength(4);
    expect(plan.collectRange).toEqual({
      from: "2026-08-05T00:00:00.000Z",
      to: "2026-08-11T00:00:00Z",
    });
  });

  it("never serves the tail, ignores partial runs and foreign scopes", () => {
    const plan = planStoredServing({
      collectionQuery,
      runs: [
        run("2026-08-01T00:00:00Z", "2026-08-11T00:00:00Z"),
        run("2026-08-01T00:00:00Z", "2026-08-11T00:00:00Z", { status: "partial" }),
      ],
      tailBuckets: 3,
    });
    expect(plan.served).toHaveLength(7);
    expect(plan.collectRange?.from).toBe("2026-08-08T00:00:00.000Z");

    const foreign = planStoredServing({
      collectionQuery,
      runs: [
        run("2026-08-01T00:00:00Z", "2026-08-11T00:00:00Z", {
          request: query({
            from: "2026-08-01T00:00:00Z",
            to: "2026-08-11T00:00:00Z",
            organizationId: "org-2",
          }),
        }),
      ],
      tailBuckets: 0,
    });
    expect(foreign.served).toHaveLength(0);
    expect(foreign.collectRange?.from).toBe("2026-08-01T00:00:00.000Z");
  });

  it("lets a covering scope serve a subset, never the reverse", () => {
    const fullRange = ["2026-08-01T00:00:00Z", "2026-08-11T00:00:00Z"] as const;
    const withScope = (projectIds?: string[]) =>
      run(...fullRange, {
        request: query({
          from: fullRange[0],
          to: fullRange[1],
          ...(projectIds ? { projectIds } : {}),
        }),
      });

    // Whole-org and superset runs both cover a subset request.
    for (const stored of [withScope(), withScope(["project-1", "project-2"])]) {
      const plan = planStoredServing({
        collectionQuery: query({ projectIds: ["project-1"] }),
        runs: [stored],
        tailBuckets: 0,
      });
      expect(plan.served).toHaveLength(10);
      expect(plan.collectRange).toBeNull();
    }

    // A narrower run covers neither a wider list nor a whole-org request.
    for (const requested of [query({ projectIds: ["project-1", "project-2"] }), query()]) {
      const plan = planStoredServing({
        collectionQuery: requested,
        runs: [withScope(["project-1"])],
        tailBuckets: 0,
      });
      expect(plan.served).toHaveLength(0);
    }

    // Duplicate-bearing metric lists must not fake coverage by length.
    const duplicated = planStoredServing({
      collectionQuery: query({ metrics: ["compute_unit_seconds", "root_branch_bytes_month"] }),
      runs: [
        run(...fullRange, {
          request: {
            ...query({ from: fullRange[0], to: fullRange[1] }),
            metrics: ["compute_unit_seconds", "compute_unit_seconds"],
          },
        }),
      ],
      tailBuckets: 0,
    });
    expect(duplicated.served).toHaveLength(0);
  });
});

describe.each(stores)("replay integrity (%s)", (_name, makeStore) => {
  it("rejects a tampered stored page as an integrity failure, never a report", async () => {
    const store = makeStore();
    const source = countingSource(store);
    const options = {
      factStore: store,
      sourceAccount: "credential:test",
      now: () => NOW,
      storeServing: { serve: true, tailBuckets: 0 },
    };
    await createConsumptionService(source, options).projectReport(query());
    expect(source.requests).toHaveLength(1);

    // Simulate a corrupt or edited store at the READ seam: replay must
    // treat a negative value as an integrity failure, never sum it.
    const tampering: EvidenceFactStore = Object.create(store, {
      getRunPage: {
        value: async (runId: `run_${string}`, pageNumber: number) => {
          const committed = await store.getRunPage(runId, pageNumber);
          if (!committed) return committed;
          const clone = structuredClone(committed) as typeof committed & {
            page: {
              projects: Array<{
                periods: Array<{ buckets: Array<{ metrics: Array<{ value: string }> }> }>;
              }>;
            };
          };
          const metric = clone.page.projects[0]?.periods[0]?.buckets[0]?.metrics[0];
          if (metric) metric.value = "-999";
          return clone;
        },
      },
    });

    await expect(
      createConsumptionService(source, { ...options, factStore: tampering }).projectReport(query()),
    ).rejects.toMatchObject({ name: "ConsumptionSourceIntegrityError" });
    store.close();
  });
});

describe.each(stores)("empty explicit scope (%s)", (_name, makeStore) => {
  it("returns an empty complete report for zero project IDs without a request", async () => {
    // live-projects on an org with no live projects: an empty report, not
    // INVALID_FILTER, and never a widened org-wide walk.
    const store = makeStore();
    const source = countingSource(store);
    const report = await createConsumptionService(source, {
      factStore: store,
      sourceAccount: "credential:test",
      now: () => NOW,
      storeServing: { serve: true, tailBuckets: 0 },
    }).projectReport(query({ projectIds: [] }));
    expect(source.requests).toHaveLength(0);
    expect(report.coverage).toMatchObject({ status: "complete", entityCount: 0, pageCount: 0 });
    expect(report.projects).toEqual([]);
    store.close();
  });
});
