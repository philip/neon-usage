import { describe, expect, it } from "vitest";
import { mergeProjectConsumptionReports, type ProjectConsumptionReport } from "../src/index.js";

function chunk(
  projectIds: string[],
  overrides: Partial<ProjectConsumptionReport> = {},
): ProjectConsumptionReport {
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-10T12:00:00.000Z",
    asOf: "2026-08-10T00:00:00.000Z",
    coverage: {
      status: "complete",
      pageCount: 2,
      entityCount: projectIds.length,
      qualityFlags: ["SOURCE_ZERO_OMITTED"],
      requestIds: [`req-${projectIds[0]}`],
    },
    query: {
      organizationId: "org-1",
      projectIds,
      from: "2026-08-01T00:00:00Z",
      to: "2026-08-10T00:00:00Z",
      granularity: "daily",
      metrics: ["compute_unit_seconds"],
    },
    effectiveRange: {
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-10T00:00:00.000Z",
      granularity: "daily",
    },
    evidence: [{ evidenceId: `evidence-${projectIds[0]}`, payloadHash: "sha256:0" }],
    projects: projectIds.map((projectId) => ({ projectId, periods: [] })),
    ...overrides,
  };
}

describe("mergeProjectConsumptionReports", () => {
  it("merges chunked reports with honest coverage and combined identity", () => {
    const merged = mergeProjectConsumptionReports([
      chunk(["project-1", "project-2"]),
      chunk(["project-3"], { generatedAt: "2026-08-10T12:05:00.000Z" }),
    ]);

    expect(merged.projects.map((project) => project.projectId)).toEqual([
      "project-1",
      "project-2",
      "project-3",
    ]);
    expect(merged.coverage).toEqual({
      status: "complete",
      pageCount: 4,
      entityCount: 3,
      qualityFlags: ["SOURCE_ZERO_OMITTED"],
      requestIds: ["req-project-1", "req-project-3"],
    });
    expect(merged.generatedAt).toBe("2026-08-10T12:05:00.000Z");
    expect(merged.query.projectIds).toEqual(["project-1", "project-2", "project-3"]);
    expect(merged.evidence?.map((entry) => entry.evidenceId)).toEqual([
      "evidence-project-1",
      "evidence-project-3",
    ]);
  });

  it("degrades to partial when any chunk is partial", () => {
    const merged = mergeProjectConsumptionReports([
      chunk(["project-1"]),
      chunk(["project-2"], {
        coverage: {
          status: "partial",
          pageCount: 1,
          entityCount: 1,
          qualityFlags: ["SOURCE_REQUEST_FAILED"],
        },
      }),
    ]);
    expect(merged.coverage.status).toBe("partial");
    expect(merged.coverage.qualityFlags).toEqual(["SOURCE_ZERO_OMITTED", "SOURCE_REQUEST_FAILED"]);
  });

  it("rejects overlapping chunks and mismatched ranges", () => {
    expect(() =>
      mergeProjectConsumptionReports([chunk(["project-1"]), chunk(["project-1"])]),
    ).toThrow("more than one chunk");
    expect(() =>
      mergeProjectConsumptionReports([
        chunk(["project-1"]),
        chunk(["project-2"], {
          effectiveRange: {
            from: "2026-07-01T00:00:00.000Z",
            to: "2026-08-01T00:00:00.000Z",
            granularity: "daily",
          },
        }),
      ]),
    ).toThrow("one shared effective range");
    expect(() => mergeProjectConsumptionReports([])).toThrow("at least one report");
  });

  it("rejects chunks that are not the same collection", () => {
    const base = chunk(["a"]);
    const withQuery = (over: Partial<ProjectConsumptionReport["query"]>) =>
      chunk(["b"], { query: { ...base.query, projectIds: ["b"], ...over } });

    expect(() =>
      mergeProjectConsumptionReports([base, withQuery({ organizationId: "org-2" })]),
    ).toThrow(/one shared organization/);
    expect(() =>
      mergeProjectConsumptionReports([
        base,
        withQuery({ metrics: ["compute_unit_seconds", "root_branch_bytes_month"] }),
      ]),
    ).toThrow(/one shared metric set/);
    expect(() =>
      mergeProjectConsumptionReports([base, chunk(["b"], { asOf: "2026-08-11T00:00:00.000Z" })]),
    ).toThrow(/one shared as-of/);
    expect(() =>
      mergeProjectConsumptionReports([base, chunk(["b"], { schemaVersion: 2 as 1 })]),
    ).toThrow(/one shared schema/);
  });

  it("rejects chunks whose declared filters overlap or whose projects escape them", () => {
    // Declared filters overlap even though the returned bodies do not.
    const empty = { ...chunk(["a"]), projects: [] };
    expect(() => mergeProjectConsumptionReports([empty, chunk(["a", "b"])])).toThrow(
      /declared in more than one chunk filter/,
    );
    // A returned project outside its own chunk's declared filter.
    const smuggled = { ...chunk(["a"]), projects: [{ projectId: "z", periods: [] }] };
    expect(() => mergeProjectConsumptionReports([smuggled, chunk(["b"])])).toThrow(
      /outside its chunk's declared filter/,
    );
  });

  it("discloses store provenance whenever any chunk was served, oldest instant first", () => {
    const served = (ids: string[], collectedAt: string) => ({
      ...chunk(ids),
      servedFromStore: {
        from: "2026-08-01T00:00:00.000Z",
        to: "2026-08-10T00:00:00.000Z",
        collectedAt,
      },
    });
    const merged = mergeProjectConsumptionReports([
      served(["a"], "2026-08-10T10:00:00.000Z"),
      served(["b"], "2026-08-10T09:00:00.000Z"),
    ]);
    // Oldest collection instant wins: the most conservative staleness claim.
    expect(merged.servedFromStore?.collectedAt).toBe("2026-08-10T09:00:00.000Z");

    // A half-stale merge must not read as freshly collected: the label stays.
    const mixed = mergeProjectConsumptionReports([
      served(["a"], "2026-08-10T10:00:00.000Z"),
      chunk(["b"]),
    ]);
    expect(mixed.servedFromStore?.collectedAt).toBe("2026-08-10T10:00:00.000Z");
  });

  it("rejects a mix of filtered and unfiltered chunks", () => {
    const unfiltered = {
      ...chunk(["a"]),
      projects: [],
      query: { ...chunk(["a"]).query, projectIds: undefined },
    };
    // biome-ignore lint/suspicious/noExplicitAny: exercising the undeclared-filter shape
    expect(() => mergeProjectConsumptionReports([unfiltered as any, chunk(["b"])])).toThrow(
      /every chunk to declare projectIds/,
    );
  });
});
