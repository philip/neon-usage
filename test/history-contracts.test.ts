import { describe, expect, it, vi } from "vitest";
import { validateHistoryQuery } from "../src/consumption-query.js";
import { historyContracts } from "../src/history-contracts.js";

const query = {
  organizationId: "org-1",
  from: "2026-08-01T00:00:00Z",
  to: "2026-08-02T00:00:00Z",
  granularity: "daily" as const,
  metrics: ["compute_unit_seconds"],
};
const now = new Date("2026-08-03T00:00:00Z");

describe("versioned history contracts", () => {
  it.each([
    ["project", "active_time_seconds"],
    ["branch", "snapshot_storage_bytes_month"],
  ] as const)(
    "classifies unsolicited %s-unsupported %s metrics as unknown",
    async (endpoint, name) => {
      const { projectHistoryPeriods } = await import("../src/history-projection.js");
      const projection = projectHistoryPeriods(
        [
          {
            id: "period-1",
            plan: "launch",
            start: query.from,
            buckets: [
              {
                start: query.from,
                end: query.to,
                metrics: [
                  {
                    name,
                    value: "1",
                    evidence: { payloadHash: `sha256:${"a".repeat(64)}`, sourcePath: "/metric" },
                  },
                ],
              },
            ],
          },
        ],
        ["compute_unit_seconds"],
        historyContracts[endpoint].supportedMetrics,
      );
      expect(projection.unknownMetric).toBe(true);
      expect(
        projection.periods[0]?.buckets[0]?.metrics.find((metric) => metric.name === name),
      ).toMatchObject({ rawUnit: "unknown", presence: "reported" });
    },
  );

  it("keeps stable project and beta branch policy contract-local", () => {
    expect(historyContracts.project).toMatchObject({
      sourceContract: "consumption-history-v2-projects",
      endpoint: "/consumption_history/v2/projects",
      pageSize: 100,
      beta: false,
    });
    expect(historyContracts.branch).toMatchObject({
      sourceContract: "consumption-history-v2-branches",
      endpoint: "/consumption_history/v2/branches",
      pageSize: 1000,
      beta: true,
      historicalCoverage: "unverified",
    });
  });

  it("keeps contract-specific metrics distinct", () => {
    for (const metric of [
      "snapshot_storage_bytes_month",
      "functions_active_capacity_microseconds",
      "functions_waiting_capacity_microseconds",
      "functions_invocations",
      "functions_egress_bytes",
    ] as const) {
      expect(historyContracts.project.metrics).toContain(metric);
      expect(historyContracts.branch.metrics).not.toContain(metric);
      expect(historyContracts.project.supportedMetrics).toContain(metric);
      expect(historyContracts.branch.supportedMetrics).not.toContain(metric);
    }
  });

  it.each(["active_time_seconds", "written_data_bytes", "constructor"])(
    "rejects %s in history queries",
    (metric) => {
      for (const contract of Object.values(historyContracts)) {
        expect(() =>
          validateHistoryQuery(
            { ...query, metrics: [metric] },
            now,
            new Set<string>(contract.supportedMetrics),
          ),
        ).toThrow(expect.objectContaining({ code: "INVALID_METRIC" }));
      }
    },
  );

  it("accepts a supported nondefault metric in a synthetic catalog and projects its raw unit", async () => {
    const fixture = Object.freeze({
      fixture_metric: Object.freeze({
        rawUnit: "second",
        denominator: 60n,
        derivedUnit: "minute",
        endpoints: Object.freeze(["history_project"] as const),
        formula: "fixture_metric / 60",
      }),
    });
    vi.resetModules();
    vi.doMock("../src/metric-definitions.js", async () => {
      const actual = await vi.importActual<typeof import("../src/metric-definitions.js")>(
        "../src/metric-definitions.js",
      );
      return {
        ...actual,
        metricDefinitions: Object.freeze({ ...actual.metricDefinitions, ...fixture }),
      };
    });
    try {
      const [
        { historyContracts: fixtureContracts },
        { rawUnits },
        { projectHistoryPeriods },
        { createOrganizationHistoryService },
        { buildMeasuredUsageExport },
        { parseMeasuredBillingUsage },
      ] = await Promise.all([
        import("../src/history-contracts.js"),
        import("../src/metric-catalog.js"),
        import("../src/history-projection.js"),
        import("../src/history-report.js"),
        import("../src/measured-usage-export.js"),
        import("../src/measured-usage-contract.js"),
      ]);
      expect(fixture.fixture_metric.endpoints).toContain("history_project");
      expect(fixtureContracts.project.metrics).not.toContain("fixture_metric" as never);
      expect(fixtureContracts.project.supportedMetrics).toContain("fixture_metric");
      expect(fixtureContracts.branch.supportedMetrics).not.toContain("fixture_metric");
      expect(() =>
        validateHistoryQuery(
          { ...query, metrics: ["fixture_metric"] },
          now,
          new Set<string>(fixtureContracts.project.supportedMetrics),
        ),
      ).not.toThrow();
      expect(rawUnits.fixture_metric).toBe("second");
      const projected = projectHistoryPeriods(
        [
          {
            id: "period-1",
            plan: "launch",
            start: query.from,
            buckets: [{ start: query.from, end: query.to, metrics: [] }],
          },
        ],
        ["fixture_metric"],
      );
      expect(projected.periods[0]?.buckets[0]?.metrics).toEqual([
        { name: "fixture_metric", value: "0", rawUnit: "second", presence: "projected_zero" },
      ]);
      expect(projected.unknownMetric).toBe(false);
      expect(rawUnits.constructor).toBeUndefined();
      const summary = await createOrganizationHistoryService(
        {
          getProjectPage: async () => ({
            projects: [
              {
                projectId: "project-1",
                periods: [
                  {
                    id: "period-1",
                    plan: "launch",
                    start: query.from,
                    buckets: [
                      {
                        start: query.from,
                        end: query.to,
                        metrics: [
                          {
                            name: "fixture_metric",
                            value: "120",
                            evidence: {
                              payloadHash: `sha256:${"a".repeat(64)}`,
                              sourcePath: "/metric",
                            },
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
            nextCursor: null,
          }),
        },
        { now: () => now },
      ).organizationSummary({ ...query, metrics: ["fixture_metric"] });
      const exported = buildMeasuredUsageExport({
        producerVersion: "test",
        history: summary,
        now: () => now,
      });
      expect(exported.formulas.minute).toBe("fixture_metric / 60");
      expect(exported.metrics?.[0]?.derived).toMatchObject({
        exact: { numerator: "2", denominator: "1" },
        unit: "minute",
      });
      expect(parseMeasuredBillingUsage(exported)).toEqual(exported);
    } finally {
      vi.doUnmock("../src/metric-definitions.js");
      vi.resetModules();
    }
  });

  it("cannot be mutated at runtime", () => {
    expect(Object.isFrozen(historyContracts)).toBe(true);
    expect(Object.isFrozen(historyContracts.project)).toBe(true);
    expect(Object.isFrozen(historyContracts.branch)).toBe(true);
    expect(Object.isFrozen(historyContracts.branch.qualityFlags)).toBe(true);
    expect(Object.isFrozen(historyContracts.project.supportedMetrics)).toBe(true);
    expect(Object.isFrozen(historyContracts.branch.supportedMetrics)).toBe(true);
  });
});
