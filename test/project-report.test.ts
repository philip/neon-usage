import { describe, expect, it } from "vitest";
import { createInMemoryEvidenceFactStore } from "../src/in-memory-fact-store.js";
import {
  createConsumptionService,
  type ProjectConsumptionPage,
  type ProjectConsumptionSource,
  type ProjectReportQuery,
} from "../src/index.js";
import { NeonApiError } from "../src/neon-api-source.js";

describe("ConsumptionService.projectReport", () => {
  it("rejects invalid runtime granularity", async () => {
    const source: ProjectConsumptionSource = {
      getProjectPage: async () => ({ projects: [], nextCursor: null }),
    };

    await expect(
      createTestConsumptionService(source).projectReport({
        ...baseQuery,
        granularity: "weekly" as never,
      }),
    ).rejects.toMatchObject({ code: "INVALID_GRANULARITY" });
  });

  it("sends canonical rounded timestamps to the source", async () => {
    let collectedQuery: ProjectReportQuery | undefined;
    const source: ProjectConsumptionSource = {
      getProjectPage: async (query) => {
        collectedQuery = query;
        return { projects: [], nextCursor: null };
      },
    };

    const report = await createTestConsumptionService(source).projectReport({
      ...baseQuery,
      from: "2026-08-07T12:34:56Z",
      to: "2026-08-08T12:34:56Z",
    });

    expect(report.query.from).toBe("2026-08-07T12:34:56Z");
    expect(collectedQuery?.from).toBe("2026-08-07T00:00:00.000Z");
    expect(collectedQuery?.to).toBe("2026-08-08T00:00:00.000Z");
  });

  it("floors hourly buckets and rejects the in-progress hour", async () => {
    let collectedQuery: ProjectReportQuery | undefined;
    const source: ProjectConsumptionSource = {
      getProjectPage: async (query) => {
        collectedQuery = query;
        return { projects: [], nextCursor: null };
      },
    };
    const service = createConsumptionService(source, {
      now: () => new Date("2026-08-08T12:31:00Z"),
    });

    await service.projectReport({
      ...baseQuery,
      granularity: "hourly",
      from: "2026-08-08T10:45:00Z",
      to: "2026-08-08T11:59:59Z",
    });
    expect(collectedQuery?.from).toBe("2026-08-08T10:00:00.000Z");
    expect(collectedQuery?.to).toBe("2026-08-08T11:00:00.000Z");

    // At 12:31 the 12:00-13:00 bucket is still in progress; before the
    // flooring fix, round-to-nearest treated 12:31 as 13:00 and let this
    // incomplete bucket through.
    await expect(
      service.projectReport({
        ...baseQuery,
        granularity: "hourly",
        from: "2026-08-08T10:45:00Z",
        to: "2026-08-08T13:00:00Z",
      }),
    ).rejects.toMatchObject({ code: "RANGE_OUTSIDE_GRANULARITY" });
  });

  it("rejects malformed project filters", async () => {
    const source: ProjectConsumptionSource = {
      getProjectPage: async () => ({ projects: [], nextCursor: null }),
    };

    await expect(
      createTestConsumptionService(source).projectReport({
        ...baseQuery,
        projectIds: ["INVALID PROJECT"],
      }),
    ).rejects.toMatchObject({ code: "INVALID_FILTER" });
  });

  it("rejects out-of-scope projects returned by a source", async () => {
    const source: ProjectConsumptionSource = {
      getProjectPage: async () => ({
        projects: [projectWithCompute("project-other", "3600")],
        nextCursor: null,
      }),
    };

    await expect(
      createTestConsumptionService(source).projectReport({
        ...baseQuery,
        projectIds: ["project-requested"],
      }),
    ).rejects.toMatchObject({ name: "ConsumptionSourceIntegrityError" });
  });

  it("rejects duplicate source metrics instead of silently taking the last value", async () => {
    const project = projectWithCompute("project-1", "3600");
    project.periods[0]?.buckets[0]?.metrics.push(sourceMetric("compute_unit_seconds", "7200"));
    const source: ProjectConsumptionSource = {
      getProjectPage: async () => ({ projects: [project], nextCursor: null }),
    };

    await expect(
      createTestConsumptionService(source).projectReport(baseQuery),
    ).rejects.toMatchObject({ name: "ConsumptionSourceIntegrityError" });
  });

  it("rejects a source metric without provenance", async () => {
    const project = projectWithCompute("project-1", "3600");
    const metric = project.periods[0]?.buckets[0]?.metrics[0];
    if (!metric) throw new Error("fixture metric missing");
    delete (metric as Partial<typeof metric>).evidence;
    const source: ProjectConsumptionSource = {
      getProjectPage: async () => ({ projects: [project], nextCursor: null }),
    };

    await expect(
      createTestConsumptionService(source).projectReport(baseQuery),
    ).rejects.toMatchObject({ name: "ConsumptionSourceIntegrityError" });
  });

  it.each([
    { payloadHash: "sha256:short", sourcePath: "/metrics/compute_unit_seconds" },
    { payloadHash: `sha256:${"a".repeat(64)}`, sourcePath: "metrics/compute_unit_seconds" },
    { payloadHash: `sha256:${"a".repeat(64)}` } as never,
    { payloadHash: `sha256:${"a".repeat(64)}`, sourcePath: null } as never,
  ])("rejects malformed source metric provenance: $sourcePath", async (evidence) => {
    const project = projectWithCompute("project-1", "3600");
    const metric = project.periods[0]?.buckets[0]?.metrics[0];
    if (!metric) throw new Error("fixture metric missing");
    metric.evidence = evidence;
    const source: ProjectConsumptionSource = {
      getProjectPage: async () => ({ projects: [project], nextCursor: null }),
    };

    await expect(
      createTestConsumptionService(source).projectReport(baseQuery),
    ).rejects.toMatchObject({ name: "ConsumptionSourceIntegrityError" });
  });

  it("rejects invalid provenance before persisting or completing its collection run", async () => {
    const store = createInMemoryEvidenceFactStore();
    const project = projectWithCompute("project-1", "3600");
    const metric = project.periods[0]?.buckets[0]?.metrics[0];
    if (!metric) throw new Error("fixture metric missing");
    metric.evidence.sourcePath = "metrics/compute_unit_seconds";
    const source: ProjectConsumptionSource = {
      getProjectPage: async () => ({ projects: [project], nextCursor: null }),
    };

    await expect(
      createConsumptionService(source, {
        now: () => new Date("2026-08-08T12:30:00Z"),
        createRunId: () => "run_invalid-provenance",
        factStore: store,
        sourceAccount: "account-test",
      }).projectReport(baseQuery),
    ).rejects.toMatchObject({ name: "ConsumptionSourceIntegrityError" });
    expect(await store.getRunPage("run_invalid-provenance", 1)).toBeUndefined();
    expect(await store.getCollectionRun("run_invalid-provenance")).toMatchObject({
      status: "failed",
    });
  });

  it("rejects metric provenance that does not match the containing page", async () => {
    const project = projectWithCompute("project-1", "3600");
    const metric = project.periods[0]?.buckets[0]?.metrics[0];
    if (!metric) throw new Error("fixture metric missing");
    metric.evidence = {
      evidenceId: "evidence:metric",
      payloadHash: `sha256:${"a".repeat(64)}`,
      sourcePath: "/projects/0/periods/0/consumption/0/metrics/0",
    } as typeof metric.evidence;
    const source: ProjectConsumptionSource = {
      getProjectPage: async () => ({
        projects: [project],
        nextCursor: null,
        evidence: {
          evidenceId: "evidence:page",
          payloadHash: `sha256:${"b".repeat(64)}`,
        },
      }),
    };

    await expect(
      createTestConsumptionService(source).projectReport(baseQuery),
    ).rejects.toMatchObject({ name: "ConsumptionSourceIntegrityError" });
  });

  it("rejects duplicate source buckets instead of double-counting them", async () => {
    const project = projectWithCompute("project-1", "3600");
    const bucket = project.periods[0]?.buckets[0];
    if (!bucket) throw new Error("fixture bucket missing");
    project.periods[0]?.buckets.push({
      ...bucket,
      metrics: bucket.metrics.map((metric) => ({ ...metric })),
    });
    const source: ProjectConsumptionSource = {
      getProjectPage: async () => ({ projects: [project], nextCursor: null }),
    };

    await expect(
      createTestConsumptionService(source).projectReport(baseQuery),
    ).rejects.toMatchObject({ name: "ConsumptionSourceIntegrityError" });
  });

  it("rejects duplicate source periods", async () => {
    const project = projectWithCompute("project-1", "3600");
    const period = project.periods[0];
    if (!period) throw new Error("fixture period missing");
    project.periods.push({ ...period, buckets: [] });
    const source: ProjectConsumptionSource = {
      getProjectPage: async () => ({ projects: [project], nextCursor: null }),
    };

    await expect(
      createTestConsumptionService(source).projectReport(baseQuery),
    ).rejects.toMatchObject({ name: "ConsumptionSourceIntegrityError" });
  });
  it("rejects an invalid timestamp before calling the source", async () => {
    let sourceCalled = false;
    const source: ProjectConsumptionSource = {
      getProjectPage: async () => {
        sourceCalled = true;
        return { projects: [], nextCursor: null };
      },
    };

    await expect(
      createTestConsumptionService(source).projectReport({
        ...baseQuery,
        from: "not-a-timestamp",
      }),
    ).rejects.toMatchObject({
      name: "ConsumptionQueryError",
      code: "INVALID_TIMESTAMP",
      field: "from",
    });
    expect(sourceCalled).toBe(false);
  });

  it.each(["2026-02-29T00:00:00Z", "2026-04-31T00:00:00Z", "2026-01-01T24:00:00Z"])(
    "rejects the impossible RFC 3339 timestamp %s",
    async (from) => {
      const source: ProjectConsumptionSource = {
        getProjectPage: async () => ({ projects: [], nextCursor: null }),
      };

      await expect(
        createTestConsumptionService(source).projectReport({ ...baseQuery, from }),
      ).rejects.toMatchObject({ name: "ConsumptionQueryError", code: "INVALID_TIMESTAMP" });
    },
  );

  it("accepts a valid RFC 3339 offset timestamp", async () => {
    const source: ProjectConsumptionSource = {
      getProjectPage: async () => ({ projects: [], nextCursor: null }),
    };

    const report = await createConsumptionService(source, {
      now: () => new Date("2026-08-08T12:30:00Z"),
    }).projectReport({
      ...baseQuery,
      from: "2026-08-07T02:00:00+02:00",
      to: "2026-08-08T02:00:00+02:00",
    });

    expect(report.coverage.status).toBe("complete");
  });

  it("rejects a range whose end is not after its start", async () => {
    const source: ProjectConsumptionSource = {
      getProjectPage: async () => ({ projects: [], nextCursor: null }),
    };

    await expect(
      createTestConsumptionService(source).projectReport({
        ...baseQuery,
        from: "2026-08-08T00:00:00Z",
        to: "2026-08-08T00:00:00Z",
      }),
    ).rejects.toMatchObject({ name: "ConsumptionQueryError", code: "INVALID_RANGE" });
  });

  it.each([
    ["hourly", "2026-08-01T11:29:59Z"],
    ["daily", "2026-06-08T23:59:59Z"],
    ["monthly", "2025-07-31T23:59:59Z"],
  ] as const)("rejects %s history outside its lookback", async (granularity, from) => {
    let sourceCalled = false;
    const source: ProjectConsumptionSource = {
      getProjectPage: async () => {
        sourceCalled = true;
        return { projects: [], nextCursor: null };
      },
    };

    await expect(
      createConsumptionService(source, {
        now: () => new Date("2026-08-08T12:00:00Z"),
      }).projectReport({
        ...baseQuery,
        granularity,
        from,
        to: "2026-08-08T12:00:00Z",
      }),
    ).rejects.toMatchObject({
      name: "ConsumptionQueryError",
      code: "RANGE_OUTSIDE_GRANULARITY",
    });
    expect(sourceCalled).toBe(false);
  });

  it("accepts the daily boundary and a future instant in the current rounded bucket", async () => {
    let sourceCalled = false;
    const source: ProjectConsumptionSource = {
      getProjectPage: async () => {
        sourceCalled = true;
        return { projects: [], nextCursor: null };
      },
    };

    await createConsumptionService(source, {
      now: () => new Date("2026-08-08T12:30:00Z"),
    }).projectReport({
      ...baseQuery,
      from: "2026-06-09T00:00:00Z",
      to: "2026-08-08T23:59:59Z",
    });

    expect(sourceCalled).toBe(true);
  });

  it("preserves reported integers and distinguishes an omitted metric projected as zero", async () => {
    const page: ProjectConsumptionPage = {
      projects: [
        {
          projectId: "project-1",
          periods: [
            {
              id: "period-1",
              plan: "scale",
              start: "2026-08-01T00:00:00Z",
              buckets: [
                {
                  start: "2026-08-07T00:00:00Z",
                  end: "2026-08-08T00:00:00Z",
                  metrics: [sourceMetric("compute_unit_seconds", "9007199254740993")],
                },
              ],
            },
          ],
        },
      ],
      nextCursor: null,
    };
    const source: ProjectConsumptionSource = {
      getProjectPage: async () => page,
    };
    const service = createTestConsumptionService(source);

    const report = await service.projectReport({
      organizationId: "org-1",
      from: "2026-08-07T00:00:00Z",
      to: "2026-08-08T00:00:00Z",
      granularity: "daily",
      metrics: ["compute_unit_seconds", "root_branch_bytes_month"],
    });

    expect(report).toEqual({
      schemaVersion: 1,
      generatedAt: "2026-08-08T12:30:00.000Z",
      asOf: "2026-08-08T00:00:00.000Z",
      coverage: {
        status: "complete",
        pageCount: 1,
        entityCount: 1,
        qualityFlags: ["SOURCE_ZERO_OMITTED"],
      },
      query: {
        organizationId: "org-1",
        from: "2026-08-07T00:00:00Z",
        to: "2026-08-08T00:00:00Z",
        granularity: "daily",
        metrics: ["compute_unit_seconds", "root_branch_bytes_month"],
      },
      effectiveRange: {
        from: "2026-08-07T00:00:00.000Z",
        to: "2026-08-08T00:00:00.000Z",
        granularity: "daily",
      },
      projects: [
        {
          projectId: "project-1",
          periods: [
            {
              id: "period-1",
              plan: "scale",
              start: "2026-08-01T00:00:00Z",
              buckets: [
                {
                  start: "2026-08-07T00:00:00Z",
                  end: "2026-08-08T00:00:00Z",
                  metrics: [
                    {
                      name: "compute_unit_seconds",
                      value: "9007199254740993",
                      rawUnit: "cu_second",
                      presence: "reported",
                      evidence: sourceMetric("compute_unit_seconds", "").evidence,
                    },
                    {
                      name: "root_branch_bytes_month",
                      value: "0",
                      rawUnit: "byte_month",
                      presence: "projected_zero",
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it("follows cursors and reports complete coverage only after the terminal page", async () => {
    const cursors: Array<string | null> = [];
    const source: ProjectConsumptionSource = {
      getProjectPage: async (_query, cursor) => {
        cursors.push(cursor);
        return cursor === null
          ? {
              projects: [projectWithCompute("project-1", "3600")],
              nextCursor: "project-1",
            }
          : {
              projects: [projectWithCompute("project-2", "7200")],
              nextCursor: null,
            };
      },
    };

    const report = await createTestConsumptionService(source).projectReport(baseQuery);

    expect(cursors).toEqual([null, "project-1"]);
    expect(report.coverage).toEqual({
      status: "complete",
      pageCount: 2,
      entityCount: 2,
      qualityFlags: [],
    });
    expect(report.projects.map((project) => project.projectId)).toEqual(["project-1", "project-2"]);
  });

  it("stops a repeated cursor and marks the retained report partial", async () => {
    let calls = 0;
    const source: ProjectConsumptionSource = {
      getProjectPage: async () => {
        calls += 1;
        if (calls > 2) {
          throw new Error("service requested a page after the cursor repeated");
        }
        return {
          projects: [projectWithCompute(`project-${calls}`, String(calls * 3600))],
          nextCursor: "stuck-cursor",
        };
      },
    };

    const report = await createTestConsumptionService(source).projectReport(baseQuery);

    expect(calls).toBe(2);
    expect(report.coverage).toEqual({
      status: "partial",
      pageCount: 2,
      entityCount: 2,
      qualityFlags: ["CURSOR_REPEATED"],
    });
    expect(report.projects.map((project) => project.projectId)).toEqual(["project-1", "project-2"]);
  });

  it("does not call an organization report complete when an empty page has a cursor", async () => {
    let calls = 0;
    const source: ProjectConsumptionSource = {
      getProjectPage: async () => {
        calls += 1;
        return calls === 1
          ? { projects: [projectWithCompute("project-1", "3600")], nextCursor: "next" }
          : { projects: [], nextCursor: "unexpected-continuation" };
      },
    };

    const report = await createTestConsumptionService(source).projectReport(baseQuery);

    expect(calls).toBe(2);
    expect(report.coverage).toEqual({
      status: "partial",
      pageCount: 2,
      entityCount: 1,
      qualityFlags: ["EMPTY_PAGE_WITH_CURSOR"],
    });
  });

  it("preserves an unknown response metric for forward compatibility", async () => {
    const project = projectWithCompute("project-1", "3600");
    project.periods[0]?.buckets[0]?.metrics.push(sourceMetric("future_metric", "42"));
    const source: ProjectConsumptionSource = {
      getProjectPage: async () => ({ projects: [project], nextCursor: null }),
    };

    const report = await createTestConsumptionService(source).projectReport(baseQuery);

    expect(report.projects[0]?.periods[0]?.buckets[0]?.metrics).toEqual([
      {
        name: "compute_unit_seconds",
        value: "3600",
        rawUnit: "cu_second",
        presence: "reported",
        evidence: sourceMetric("compute_unit_seconds", "").evidence,
      },
      {
        name: "future_metric",
        value: "42",
        rawUnit: "unknown",
        presence: "reported",
        evidence: sourceMetric("future_metric", "").evidence,
      },
    ]);
    expect(report.coverage.qualityFlags).toEqual(["SOURCE_METRIC_UNKNOWN"]);
  });

  it("rejects an unknown requested metric before calling the source", async () => {
    let sourceCalled = false;
    const source: ProjectConsumptionSource = {
      getProjectPage: async () => {
        sourceCalled = true;
        return { projects: [], nextCursor: null };
      },
    };

    await expect(
      createTestConsumptionService(source).projectReport({
        ...baseQuery,
        metrics: ["future_metric"],
      }),
    ).rejects.toMatchObject({ name: "ConsumptionQueryError", code: "INVALID_METRIC" });
    expect(sourceCalled).toBe(false);
  });

  it("rejects duplicate requested metrics before they can be double-counted", async () => {
    const source: ProjectConsumptionSource = {
      getProjectPage: async () => ({ projects: [], nextCursor: null }),
    };

    await expect(
      createTestConsumptionService(source).projectReport({
        ...baseQuery,
        metrics: ["compute_unit_seconds", "compute_unit_seconds"],
      }),
    ).rejects.toMatchObject({ name: "ConsumptionQueryError", code: "DUPLICATE_METRIC" });
  });

  it("stops a non-adjacent cursor cycle", async () => {
    const nextCursors = ["cursor-a", "cursor-b", "cursor-a"];
    let calls = 0;
    const source: ProjectConsumptionSource = {
      getProjectPage: async () => {
        const nextCursor = nextCursors[calls];
        calls += 1;
        if (nextCursor === undefined) {
          throw new Error("service requested a page after detecting the cursor cycle");
        }
        return {
          projects: [projectWithCompute(`project-${calls}`, "3600")],
          nextCursor,
        };
      },
    };

    const report = await createTestConsumptionService(source).projectReport(baseQuery);

    expect(calls).toBe(3);
    expect(report.coverage.status).toBe("partial");
    expect(report.coverage.qualityFlags).toEqual(["CURSOR_REPEATED"]);
  });

  it("retains collected pages when a later source request fails", async () => {
    let calls = 0;
    const source: ProjectConsumptionSource = {
      getProjectPage: async () => {
        calls += 1;
        if (calls === 2) {
          throw new NeonApiError(
            429,
            JSON.stringify({ code: "RATE_LIMITED", message: "upstream unavailable" }),
            "request-1",
            3,
            true,
            1000,
          );
        }
        return {
          projects: [projectWithCompute("project-1", "3600")],
          nextCursor: "next",
        };
      },
    };

    const report = await createTestConsumptionService(source).projectReport(baseQuery);

    expect(report.projects.map((project) => project.projectId)).toEqual(["project-1"]);
    expect(report.coverage).toEqual({
      status: "partial",
      pageCount: 1,
      entityCount: 1,
      qualityFlags: ["SOURCE_REQUEST_FAILED"],
      errors: ["Neon API request failed with HTTP 429: upstream unavailable"],
      errorDetails: [
        {
          code: "RATE_LIMITED",
          message: "Neon API request failed with HTTP 429: upstream unavailable",
          requestId: "request-1",
          attempts: 3,
          retryable: true,
          retryAfterMs: 1000,
          status: 429,
        },
      ],
    });
  });

  it("does not downgrade a later integrity failure to partial coverage", async () => {
    let calls = 0;
    const integrityFailure = Object.assign(new Error("evidence storage unavailable"), {
      integrityFailure: true,
    });
    const source: ProjectConsumptionSource = {
      getProjectPage: async () => {
        calls += 1;
        if (calls === 2) throw integrityFailure;
        return {
          projects: [projectWithCompute("project-1", "3600")],
          nextCursor: "next",
        };
      },
    };

    await expect(createTestConsumptionService(source).projectReport(baseQuery)).rejects.toBe(
      integrityFailure,
    );
  });

  it("does not downgrade later cancellation to partial coverage", async () => {
    let calls = 0;
    const cancellation = Object.assign(new Error("cancelled"), { kind: "cancelled" });
    const source: ProjectConsumptionSource = {
      getProjectPage: async () => {
        calls += 1;
        if (calls === 2) throw cancellation;
        return {
          projects: [projectWithCompute("project-1", "3600")],
          nextCursor: "next",
        };
      },
    };

    await expect(createTestConsumptionService(source).projectReport(baseQuery)).rejects.toBe(
      cancellation,
    );
  });

  it("retains page evidence references in the report", async () => {
    const payloadHash = `sha256:${"1".repeat(64)}`;
    const project = projectWithCompute("project-1", "3600");
    Object.assign(project.periods[0]?.buckets[0]?.metrics[0]?.evidence ?? {}, {
      evidenceId: "evidence:1",
      payloadHash,
    });
    const source: ProjectConsumptionSource = {
      getProjectPage: async () => ({
        projects: [project],
        nextCursor: null,
        evidence: { evidenceId: "evidence:1", payloadHash },
      }),
    };

    const report = await createTestConsumptionService(source).projectReport(baseQuery);

    expect(report.evidence).toEqual([{ evidenceId: "evidence:1", payloadHash }]);
  });

  it("retains metric evidence while projected zeros remain explicitly inferred", async () => {
    const project = projectWithCompute("project-1", "3600");
    project.periods[0]?.buckets[0]?.metrics[0] &&
      Object.assign(project.periods[0].buckets[0].metrics[0], {
        evidence: {
          evidenceId: "evidence:1",
          payloadHash: `sha256:${"1".repeat(64)}`,
          sourcePath: "/projects/0/periods/0/consumption/0/metrics/0",
        },
      });
    const source: ProjectConsumptionSource = {
      getProjectPage: async () => ({
        projects: [project],
        nextCursor: null,
        evidence: {
          evidenceId: "evidence:1",
          payloadHash: `sha256:${"1".repeat(64)}`,
        },
      }),
    };

    const report = await createTestConsumptionService(source).projectReport({
      ...baseQuery,
      metrics: ["compute_unit_seconds", "root_branch_bytes_month"],
    });

    expect(report.projects[0]?.periods[0]?.buckets[0]?.metrics).toEqual([
      expect.objectContaining({
        name: "compute_unit_seconds",
        presence: "reported",
        evidence: expect.objectContaining({ sourcePath: expect.stringContaining("/metrics/0") }),
      }),
      expect.not.objectContaining({ evidence: expect.anything() }),
    ]);
  });

  it("deduplicates a project repeated across pages and marks coverage partial", async () => {
    let calls = 0;
    const project = projectWithCompute("project-1", "3600");
    const source: ProjectConsumptionSource = {
      getProjectPage: async () => {
        calls += 1;
        return {
          projects: [project],
          nextCursor: calls === 1 ? "next" : null,
        };
      },
    };

    const report = await createTestConsumptionService(source).projectReport(baseQuery);

    expect(report.projects).toHaveLength(1);
    expect(report.coverage.status).toBe("partial");
    expect(report.coverage.qualityFlags).toEqual(["ENTITY_DUPLICATED"]);
  });

  it("stops at the configured page budget with partial coverage", async () => {
    let calls = 0;
    const source: ProjectConsumptionSource = {
      getProjectPage: async () => {
        calls += 1;
        return {
          projects: [projectWithCompute(`project-${calls}`, "3600")],
          nextCursor: `cursor-${calls}`,
        };
      },
    };

    const report = await createConsumptionService(source, {
      now: () => new Date("2026-08-08T12:30:00Z"),
      maxPages: 2,
    }).projectReport(baseQuery);

    expect(calls).toBe(2);
    expect(report.coverage).toMatchObject({
      status: "partial",
      pageCount: 2,
      qualityFlags: ["PAGE_LIMIT_REACHED"],
    });
  });

  it("commits reported facts before requesting the next page", async () => {
    const store = createInMemoryEvidenceFactStore();
    for (const digit of ["1", "2"]) {
      await store.writeEvidence(
        {
          evidenceId: `evidence:${digit}`,
          sourceAccount: "account-1",
          sourceContract: "consumption-history-v2-projects",
          requestedAt: "2026-08-08T00:00:00Z",
          completedAt: "2026-08-08T00:00:01Z",
          request: {
            method: "GET",
            path: "/consumption_history/v2/projects",
            query: "",
            cursorIn: null,
            fingerprint: `sha256:${digit}`,
          },
          response: {
            status: 200,
            cursorOut: null,
            payloadHash: `sha256:${digit.repeat(64)}`,
          },
          attempt: 1,
        },
        new AbortController().signal,
      );
    }
    let calls = 0;
    const source: ProjectConsumptionSource = {
      getProjectPage: async () => {
        calls += 1;
        if (calls === 2) expect((await store.getRunPage("run_test", 1))?.facts).toHaveLength(1);
        const project = projectWithCompute(`project-${calls}`, String(calls));
        const metric = project.periods[0]?.buckets[0]?.metrics[0];
        if (!metric) throw new Error("fixture metric missing");
        Object.assign(metric, {
          evidence: {
            evidenceId: `evidence:${calls}`,
            payloadHash: `sha256:${String(calls).repeat(64)}`,
            sourcePath: `/projects/0/periods/0/consumption/0/metrics/0`,
          },
        });
        return {
          projects: [project],
          nextCursor: calls === 1 ? "next" : null,
          evidence: {
            evidenceId: `evidence:${calls}`,
            payloadHash: `sha256:${String(calls).repeat(64)}`,
          },
        };
      },
    };

    const report = await createConsumptionService(source, {
      now: () => new Date("2026-08-08T12:30:00Z"),
      createRunId: () => "run_test",
      factStore: store,
      sourceAccount: "account-test",
    }).projectReport(baseQuery);

    expect(report).not.toHaveProperty("runId");
    expect((await store.getRunPage("run_test", 2))?.facts).toHaveLength(1);
    expect(await store.getCollectionRun("run_test")).toMatchObject({
      status: "complete",
      pageCount: 2,
    });
  });

  it("records a failed collection run", async () => {
    const store = createInMemoryEvidenceFactStore();
    const source: ProjectConsumptionSource = {
      getProjectPage: async () => {
        throw new Error("source failed");
      },
    };

    await expect(
      createConsumptionService(source, {
        now: () => new Date("2026-08-08T12:30:00Z"),
        createRunId: () => "run_failed",
        factStore: store,
        sourceAccount: "account-test",
      }).projectReport(baseQuery),
    ).rejects.toThrow("source failed");
    expect(await store.getCollectionRun("run_failed")).toMatchObject({
      status: "failed",
      pageCount: 0,
    });
  });

  it("resumes a cancelled run and returns prior and continued projects", async () => {
    const store = createInMemoryEvidenceFactStore();
    const controller = new AbortController();
    const interrupted: ProjectConsumptionSource = {
      getProjectPage: async () => {
        controller.abort("interrupted");
        return {
          projects: [{ projectId: "project-1", periods: [] }],
          nextCursor: "next",
        };
      },
    };
    await expect(
      createConsumptionService(interrupted, {
        now: () => new Date("2026-08-08T12:30:00Z"),
        createRunId: () => "run_resume-project",
        factStore: store,
        sourceAccount: "account-test",
      }).projectReport(baseQuery, { signal: controller.signal }),
    ).rejects.toMatchObject({ kind: "cancelled" });
    expect(await store.getCollectionRun("run_resume-project")).toMatchObject({
      status: "running",
      pageCount: 1,
    });

    const cursors: Array<string | null> = [];
    const resumed = await createConsumptionService(
      {
        getProjectPage: async (_query, cursor) => {
          cursors.push(cursor);
          return { projects: [{ projectId: "project-2", periods: [] }], nextCursor: null };
        },
      },
      {
        now: () => new Date("2026-08-08T12:31:00Z"),
        factStore: store,
        sourceAccount: "account-test",
        resumeRunId: "run_resume-project",
      },
    ).projectReport(baseQuery);

    expect(cursors).toEqual(["next"]);
    expect(resumed.projects.map((project) => project.projectId)).toEqual([
      "project-1",
      "project-2",
    ]);
    expect((await store.getCollectionRun("run_resume-project"))?.status).toBe("complete");
  });

  it("resumes a committed terminal project page without calling the source", async () => {
    const store = createInMemoryEvidenceFactStore();
    const controller = new AbortController();
    await expect(
      createConsumptionService(
        {
          getProjectPage: async () => {
            controller.abort("interrupted after response");
            return {
              projects: [{ projectId: "project-1", periods: [] }],
              nextCursor: null,
            };
          },
        },
        {
          now: () => new Date("2026-08-08T12:30:00Z"),
          createRunId: () => "run_terminal-project",
          factStore: store,
          sourceAccount: "account-test",
        },
      ).projectReport(baseQuery, { signal: controller.signal }),
    ).rejects.toMatchObject({ kind: "cancelled" });

    const report = await createConsumptionService(
      {
        getProjectPage: async () => {
          throw new Error("source must not be called");
        },
      },
      {
        now: () => new Date("2026-08-08T12:31:00Z"),
        factStore: store,
        sourceAccount: "account-test",
        resumeRunId: "run_terminal-project",
      },
    ).projectReport(baseQuery);

    expect(report.projects.map((project) => project.projectId)).toEqual(["project-1"]);
    expect(report.coverage.status).toBe("complete");
  });
});

const baseQuery = {
  organizationId: "org-1",
  from: "2026-08-07T00:00:00Z",
  to: "2026-08-08T00:00:00Z",
  granularity: "daily" as const,
  metrics: ["compute_unit_seconds"],
};

function projectWithCompute(projectId: string, value: string) {
  return {
    projectId,
    periods: [
      {
        id: "period-1",
        plan: "scale",
        start: "2026-08-01T00:00:00Z",
        buckets: [
          {
            start: "2026-08-07T00:00:00Z",
            end: "2026-08-08T00:00:00Z",
            metrics: [sourceMetric("compute_unit_seconds", value)],
          },
        ],
      },
    ],
  };
}

function sourceMetric(name: string, value: string) {
  return {
    name,
    value,
    evidence: { payloadHash: `sha256:${"a".repeat(64)}`, sourcePath: `/metrics/${name}` },
  };
}

function createTestConsumptionService(source: ProjectConsumptionSource) {
  return createConsumptionService(source, {
    now: () => new Date("2026-08-08T12:30:00Z"),
  });
}
