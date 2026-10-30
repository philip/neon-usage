import assert from "node:assert/strict";
import { describe, expect, it, vi } from "vitest";
import { NeonUsageError } from "../src/client-errors.js";
import { parseMeasuredBillingUsage } from "../src/contracts.js";
import type { CurrentPeriodSnapshotReport } from "../src/current-snapshot-service.js";
import {
  type OrganizationConsumptionSummary,
  projectReportFromSummary,
} from "../src/history-report.js";
import {
  buildMeasuredUsageExport,
  MEASURED_USAGE_KIND,
  MEASURED_USAGE_SCHEMA_VERSION,
} from "../src/measured-usage-export.js";
import { deriveBillingValue, rawUnits } from "../src/metric-catalog.js";
import { estimateProjectCosts } from "../src/pricing-estimate.js";
import { neonDocumentationRateCard } from "../src/rate-card.js";
import { branchComponentHistory } from "./fixtures/branch-component-history.js";

const now = () => new Date("2026-08-27T12:00:00Z");
const producerVersion = "0.4.0-test";

type MetricInput = { name: string; value: string; presence?: "reported" | "projected_zero" };

function projectResult(projectId: string, metrics: MetricInput[], plan = "scale") {
  return {
    projectId,
    periods: [
      {
        id: `period-${projectId}`,
        plan,
        start: "2026-08-01T00:00:00Z",
        buckets: [
          {
            start: "2026-08-01T00:00:00Z",
            end: "2026-08-02T00:00:00Z",
            metrics: metrics.map((metric) => ({
              name: metric.name,
              value: metric.value,
              rawUnit: rawUnits[metric.name] ?? "unknown",
              presence: metric.presence ?? ("reported" as const),
            })),
          },
        ],
      },
    ],
  };
}

function historySummary(overrides: {
  status?: "complete" | "partial";
  metricNames: string[];
  aggregate?: Record<string, string> | null;
  projects: Array<{ projectId: string; metrics: MetricInput[] }>;
}): OrganizationConsumptionSummary {
  const metrics =
    overrides.aggregate === null
      ? null
      : Object.entries(overrides.aggregate ?? {}).map(([name, value]) => {
          const derived = deriveBillingValue(name, value);
          return { name, raw: { value, unit: rawUnits[name] ?? "unknown" }, derived };
        });
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-27T12:00:00.000Z",
    asOf: "2026-08-27T00:00:00.000Z",
    scope: { kind: "organization_aggregate", organizationId: "org-1" },
    coverage: {
      status: overrides.status ?? "complete",
      pageCount: 1,
      entityCount: overrides.projects.length,
      qualityFlags: [],
    },
    query: {
      organizationId: "org-1",
      from: "2026-08-01T00:00:00Z",
      to: "2026-08-27T00:00:00Z",
      granularity: "daily",
      metrics: overrides.metricNames,
    },
    effectiveRange: {
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-27T00:00:00.000Z",
      granularity: "daily",
    },
    aggregation: "across_projects_periods_buckets_before_allowances",
    metrics,
    attribution: {
      projects: overrides.projects.map((project) =>
        projectResult(project.projectId, project.metrics),
      ),
    },
  };
}

describe("buildMeasuredUsageExport (history)", () => {
  it("preserves exact totals and complete components at the 100000-component boundary", () => {
    const history = branchComponentHistory(100_000);
    const estimate = estimateProjectCosts(history.projectReport, neonDocumentationRateCard, {
      extrapolateRateCardDates: true,
      now,
    });
    expect(estimate.lines).toHaveLength(100_000);
    expect(estimate.totalAmount?.exact).toEqual({ numerator: "150000", denominator: "1" });
    const measured = buildMeasuredUsageExport({
      producerVersion,
      history: history.summary,
      estimate,
      now,
    });
    expect(measured.coverage.authoritative).toBe(true);
    expect(measured.billableBranchMonthComponents.status).toBe("complete");
    expect(measured.billableBranchMonthComponents.items).toHaveLength(100_000);
    expect(measured.billableBranchMonthComponents.expectedIdentities).toHaveLength(100_000);
    expect(
      measured.billableBranchMonthComponents.items.every(
        (item) => item.billable.exact.numerator === "1" && item.billable.exact.denominator === "1",
      ),
    ).toBe(true);
  }, 30_000);

  it.each([100_001, 10_000 * 12])(
    "rejects %i branch components during pricing with a typed collection limit",
    (count) => {
      const history = branchComponentHistory(count);
      expect(() =>
        estimateProjectCosts(history.projectReport, neonDocumentationRateCard, {
          extrapolateRateCardDates: true,
          now,
        }),
      ).toThrowError(
        expect.objectContaining({ name: "NeonUsageError", code: "COLLECTION_LIMIT_REACHED" }),
      );
    },
    30_000,
  );

  it("rejects an oversized supplied estimate before reading branch identity fields", () => {
    const history = branchComponentHistory(1);
    const estimate = estimateProjectCosts(history.projectReport, neonDocumentationRateCard, {
      extrapolateRateCardDates: true,
      now,
    });
    const line = estimate.lines[0];
    assert(line);
    const read = vi.fn(() => {
      throw new Error("must not project an over-limit estimate");
    });
    Object.defineProperty(line, "projectId", { get: read });
    estimate.lines = Array(100_001).fill(line);
    expect(() =>
      buildMeasuredUsageExport({ producerVersion, history: history.summary, estimate, now }),
    ).toThrowError(NeonUsageError);
    expect(read).not.toHaveBeenCalled();
  });

  it("applies the component budget only when branch pricing is selected", () => {
    const history = branchComponentHistory(10_000 * 12);
    history.projectReport.query.metrics = ["compute_unit_seconds"];
    const estimate = estimateProjectCosts(history.projectReport, neonDocumentationRateCard, {
      extrapolateRateCardDates: true,
      now,
    });
    expect(estimate.status).toBe("estimated");
    expect(estimate.lines).toHaveLength(120_000);
    expect(estimate.lines.every((line) => line.metric === "compute_unit_seconds")).toBe(true);
    expect(estimate.totalAmount?.exact).toEqual({ numerator: "0", denominator: "1" });
  }, 30_000);

  it("projects an authoritative Launch/Scale summary losslessly", () => {
    const summary = historySummary({
      metricNames: ["compute_unit_seconds", "root_branch_bytes_month"],
      aggregate: { compute_unit_seconds: "36000", root_branch_bytes_month: "2000000000" },
      projects: [
        {
          projectId: "project-1",
          metrics: [
            { name: "compute_unit_seconds", value: "36000" },
            { name: "root_branch_bytes_month", value: "2000000000" },
          ],
        },
      ],
    });

    const measured = buildMeasuredUsageExport({ producerVersion, history: summary, now });

    expect(measured.kind).toBe(MEASURED_USAGE_KIND);
    expect(measured.schemaVersion).toBe(MEASURED_USAGE_SCHEMA_VERSION);
    expect(measured.producerVersion).toBe(producerVersion);
    expect(measured.source).toEqual({ contract: "consumption-history-v2", authoritative: true });
    expect(measured.coverage.authoritative).toBe(true);
    expect(measured.warnings).toEqual([]);
    const compute = measured.metrics?.find((metric) => metric.name === "compute_unit_seconds");
    expect(compute).toMatchObject({
      raw: { value: "36000", unit: "cu_second" },
      derived: { decimalApproximation: "10", unit: "cu_hour" },
      presence: "reported",
    });
    expect(measured.projects[0]?.projectId).toBe("project-1");
    expect(measured.projects[0]?.period).toEqual(measured.period);
    expect(measured.metricSelection).toEqual({
      mode: "explicit",
      requested: summary.query.metrics,
    });
    expect(parseMeasuredBillingUsage(measured)).toEqual(measured);
  });

  it("always leaves comparison sizing inputs unresolved", () => {
    const measured = buildMeasuredUsageExport({
      producerVersion,
      history: historySummary({
        metricNames: ["compute_unit_seconds"],
        aggregate: { compute_unit_seconds: "3600" },
        projects: [{ projectId: "p", metrics: [{ name: "compute_unit_seconds", value: "3600" }] }],
      }),
      now,
    });
    expect(measured.unresolved.map((field) => field.field)).toEqual([
      "peakCu",
      "avgCu",
      "activeHours",
    ]);
  });

  it("withholds authoritative aggregate metrics under partial coverage", () => {
    const measured = buildMeasuredUsageExport({
      producerVersion,
      history: historySummary({
        status: "partial",
        metricNames: ["compute_unit_seconds"],
        aggregate: null,
        projects: [{ projectId: "p", metrics: [{ name: "compute_unit_seconds", value: "3600" }] }],
      }),
      now,
    });
    expect(measured.metrics).toBeNull();
    expect(measured.coverage.authoritative).toBe(false);
    expect(measured.warnings.join(" ")).toMatch(/partial/i);
  });

  it("distinguishes projected zero from a reported value per project", () => {
    const summary = historySummary({
      metricNames: ["compute_unit_seconds", "public_network_transfer_bytes"],
      aggregate: {
        compute_unit_seconds: "3600",
        public_network_transfer_bytes: "0",
      },
      projects: [
        {
          projectId: "p",
          metrics: [
            { name: "compute_unit_seconds", value: "3600", presence: "reported" },
            { name: "public_network_transfer_bytes", value: "0", presence: "projected_zero" },
          ],
        },
      ],
    });
    const measured = buildMeasuredUsageExport({ producerVersion, history: summary, now });
    const project = measured.projects[0];
    expect(project?.metrics.find((m) => m.name === "compute_unit_seconds")?.presence).toBe(
      "reported",
    );
    expect(project?.metrics.find((m) => m.name === "public_network_transfer_bytes")?.presence).toBe(
      "projected_zero",
    );
    expect(
      measured.metrics?.find((m) => m.name === "public_network_transfer_bytes")?.presence,
    ).toBe("projected_zero");
    expect(parseMeasuredBillingUsage(measured)).toEqual(measured);
  });

  it("sums multiple projects and preserves integers above Number.MAX_SAFE_INTEGER", () => {
    // 90071992547409910000 bytes is ~1e4 times MAX_SAFE_INTEGER; a Number()
    // round-trip would corrupt it, so the export must keep the exact string.
    const huge = "90071992547409910000";
    const summary = historySummary({
      metricNames: ["public_network_transfer_bytes"],
      aggregate: { public_network_transfer_bytes: huge },
      projects: [
        {
          projectId: "a",
          metrics: [{ name: "public_network_transfer_bytes", value: "90071992547409900000" }],
        },
        {
          projectId: "b",
          metrics: [{ name: "public_network_transfer_bytes", value: "10000" }],
        },
      ],
    });
    const measured = buildMeasuredUsageExport({ producerVersion, history: summary, now });
    expect(measured.metrics?.[0]?.raw.value).toBe(huge);
    expect(measured.projects.find((p) => p.projectId === "a")?.metrics[0]?.raw.value).toBe(
      "90071992547409900000",
    );
    // Derived GB is exact: 90071992547409900000 / 1e9 = 90071992547.4099
    expect(measured.projects.find((p) => p.projectId === "a")?.metrics[0]?.derived?.exact).toEqual({
      numerator: "900719925474099",
      denominator: "10000",
    });
    expect(parseMeasuredBillingUsage(measured)).toEqual(measured);
  });

  it("names unknown source metrics while excluding them from normalized totals", () => {
    const history = historySummary({
      metricNames: ["compute_unit_seconds"],
      aggregate: { compute_unit_seconds: "3600" },
      projects: [
        {
          projectId: "p",
          metrics: [
            { name: "compute_unit_seconds", value: "3600" },
            { name: "future_z", value: "1" },
            { name: "future_a", value: "2" },
            { name: "future_z", value: "1" },
          ],
        },
      ],
    });
    const measured = buildMeasuredUsageExport({ producerVersion, history, now });
    expect(measured.coverage.omittedMetrics).toEqual(["future_a", "future_z"]);
    expect(measured.coverage.qualityFlags).toContain("UNKNOWN_METRIC");
    expect(measured.projects[0]?.metrics.map((metric) => metric.name)).toEqual([
      "compute_unit_seconds",
    ]);
    expect(parseMeasuredBillingUsage(measured)).toEqual(measured);
  });

  it("names a snapshot-only source metric omitted from history", () => {
    const history = historySummary({
      metricNames: ["compute_unit_seconds"],
      aggregate: { compute_unit_seconds: "3600" },
      projects: [
        {
          projectId: "p",
          metrics: [
            { name: "compute_unit_seconds", value: "3600" },
            { name: "active_time_seconds", value: "120" },
          ],
        },
      ],
    });
    const measured = buildMeasuredUsageExport({ producerVersion, history, now });
    expect(measured.coverage.omittedMetrics).toEqual(["active_time_seconds"]);
    expect(measured.coverage.qualityFlags).toContain("UNKNOWN_METRIC");
    expect(measured.projects[0]?.metrics.map((metric) => metric.name)).toEqual([
      "compute_unit_seconds",
    ]);
    expect(parseMeasuredBillingUsage(measured)).toEqual(measured);
  });

  function branchHistory() {
    const summary = historySummary({
      metricNames: ["extra_branches_month"],
      aggregate: { extra_branches_month: "1488" },
      projects: [{ projectId: "p", metrics: [{ name: "extra_branches_month", value: "1488" }] }],
    });
    const project = summary.attribution.projects[0];
    assert(project);
    project.periods = ["a", "b"].map((id, index) => ({
      id: `period-${id}`,
      plan: index ? "scale" : "launch",
      start: `2026-08-0${index + 1}T00:00:00Z`,
      ...(index ? {} : { end: "2026-08-02T00:00:00Z" }),
      buckets: [
        {
          start: `2026-08-0${index + 1}T00:00:00Z`,
          end: `2026-08-0${index + 2}T00:00:00Z`,
          metrics: [
            {
              name: "extra_branches_month",
              value: "744",
              rawUnit: "branch_hour",
              presence: "reported" as const,
            },
          ],
        },
      ],
    }));
    const estimate = estimateProjectCosts(
      {
        ...summary,
        projects: summary.attribution.projects,
      },
      neonDocumentationRateCard,
      { now, extrapolateRateCardDates: true },
    );
    return { summary, estimate };
  }

  it("copies each source-period branch component and preserves all uncertainty", () => {
    const { summary, estimate } = branchHistory();
    estimate.lines[0]?.approximations.push("ALLOWANCE_WINDOW_APPROXIMATION", "PLAN_RATES_ASSUMED");
    // An unrelated unpriced line must not hide the available branch provenance.
    estimate.status = "unavailable_unpriced_lines";
    const measured = buildMeasuredUsageExport({ producerVersion, history: summary, estimate, now });
    const components = measured.billableBranchMonthComponents;
    expect(components.status).toBe("complete");
    expect(components.reasons).toEqual([]);
    expect(components.expectedIdentities).toEqual(
      estimate.lines.map((line) => ({
        projectId: line.projectId,
        sourcePeriodId: line.billingPeriod.sourcePeriodId,
        allowanceWindow: line.allowanceWindow,
      })),
    );
    expect(components.items).toEqual(
      estimate.lines.map((line) => ({
        projectId: line.projectId,
        billingPeriod: line.billingPeriod,
        allowanceWindow: line.allowanceWindow,
        raw: line.raw,
        allowanceApplied: {
          exact: line.allowanceApplied?.exact,
          unit: "branch_hour",
          scope: "per_project",
        },
        billable: { exact: line.billable?.exact, unit: "branch_month" },
        rateCardRevision: estimate.rateCard.revision,
        approximations: line.approximations,
        certainty: "approximate",
      })),
    );
    expect(measured).not.toHaveProperty("billableBranchMonths");
    expect(parseMeasuredBillingUsage(measured)).toEqual(measured);
  });

  it.each([1, 2])(
    "retains expected identities when %i branch lines lack billable quantities",
    (missing) => {
      const { summary, estimate } = branchHistory();
      for (const line of estimate.lines.slice(0, missing)) {
        delete line.billable;
        line.status = "unavailable";
        line.unavailableReason = "UNKNOWN_PLAN";
      }
      const measured = buildMeasuredUsageExport({
        producerVersion,
        history: summary,
        estimate,
        now,
      });
      const components = measured.billableBranchMonthComponents;
      expect(components.status).toBe(missing === 1 ? "partial" : "unavailable");
      expect(components.expectedIdentities).toHaveLength(2);
      expect(components.items).toHaveLength(2 - missing);
      expect(components.reasons.join(" ")).toMatch(/billable|pricing/i);
      expect(parseMeasuredBillingUsage(measured)).toEqual(measured);
    },
  );

  it("does not collapse a source period spanning calendar allowance windows", () => {
    const { summary } = branchHistory();
    summary.effectiveRange.to = "2026-09-03T00:00:00.000Z";
    summary.query.to = summary.effectiveRange.to;
    summary.asOf = summary.effectiveRange.to;
    const project = summary.attribution.projects[0];
    assert(project);
    project.periods = [
      {
        id: "one-period",
        plan: "launch",
        start: "2026-08-01T00:00:00Z",
        buckets: ["08", "09"].map((month) => ({
          start: `2026-${month}-01T00:00:00Z`,
          end: `2026-${month}-02T00:00:00Z`,
          metrics: [
            {
              name: "extra_branches_month",
              value: "744",
              rawUnit: "branch_hour",
              presence: "reported" as const,
            },
          ],
        })),
      },
    ];
    const estimate = estimateProjectCosts(
      { ...summary, projects: summary.attribution.projects },
      neonDocumentationRateCard,
      {
        now,
        extrapolateRateCardDates: true,
      },
    );
    const measured = buildMeasuredUsageExport({ producerVersion, history: summary, estimate, now });
    expect(
      measured.billableBranchMonthComponents.items.map((item) => item.allowanceWindow.start),
    ).toEqual(["2026-08-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z"]);
    expect(measured.billableBranchMonthComponents.status).toBe("complete");
    expect(parseMeasuredBillingUsage(measured)).toEqual(measured);
  });

  it("copies fractional allowances exactly and declares unflagged components exact", () => {
    const { summary } = branchHistory();
    summary.query.granularity = "hourly";
    summary.effectiveRange.granularity = "hourly";
    const project = summary.attribution.projects[0];
    assert(project);
    for (const period of project.periods) {
      const bucket = period.buckets[0];
      assert(bucket);
      bucket.end = bucket.start.replace("T00:00:00Z", "T00:30:00Z");
    }
    const estimate = estimateProjectCosts(
      { ...summary, projects: summary.attribution.projects },
      {
        ...neonDocumentationRateCard,
        effectiveFrom: "2026-08-01",
      },
      { now },
    );
    const measured = buildMeasuredUsageExport({ producerVersion, history: summary, estimate, now });
    expect(measured.billableBranchMonthComponents.items[0]?.allowanceApplied.exact).toEqual({
      numerator: "9",
      denominator: "2",
    });
    expect(
      measured.billableBranchMonthComponents.items.every((item) => item.certainty === "exact"),
    ).toBe(true);
    expect(parseMeasuredBillingUsage(measured)).toEqual(measured);
  });

  it("uses exact zero when pricing applied no branch allowance", () => {
    const { summary, estimate } = branchHistory();
    for (const line of estimate.lines) {
      delete line.allowanceApplied;
      assert(line.billable);
      line.billable.exact = { numerator: "1", denominator: "1" };
    }
    const measured = buildMeasuredUsageExport({ producerVersion, history: summary, estimate, now });
    expect(measured.billableBranchMonthComponents.items[0]?.allowanceApplied.exact).toEqual({
      numerator: "0",
      denominator: "1",
    });
    expect(parseMeasuredBillingUsage(measured)).toEqual(measured);
  });

  it("rejects a complete component raw sum that differs from measured branch hours", () => {
    const { summary, estimate } = branchHistory();
    const line = estimate.lines[0];
    assert(line?.allowanceApplied && line.billable);
    line.raw.value = "0";
    line.allowanceApplied.exact = { numerator: "0", denominator: "1" };
    line.billable.exact = { numerator: "0", denominator: "1" };
    expect(() =>
      buildMeasuredUsageExport({ producerVersion, history: summary, estimate, now }),
    ).toThrowError(expect.objectContaining({ code: "INCONSISTENT_VALUE" }));
  });

  it("preserves selection origin without inferring it from selected metrics", () => {
    const { summary } = branchHistory();
    const measured = buildMeasuredUsageExport({
      producerVersion,
      history: summary,
      now,
      metricSelectionMode: "default",
    });
    expect(measured.metricSelection).toEqual({
      mode: "default",
      requested: ["extra_branches_month"],
    });
    expect(
      buildMeasuredUsageExport({ producerVersion, history: summary, now }).metricSelection.mode,
    ).toBe("explicit");
  });

  it("leaves branch components unavailable when no pricing report is supplied", () => {
    const { summary } = branchHistory();
    const measured = buildMeasuredUsageExport({ producerVersion, history: summary, now });
    expect(measured.billableBranchMonthComponents).toEqual({
      status: "unavailable",
      reasons: ["Source-period branch pricing components are unavailable"],
      expectedIdentities: [],
      items: [],
    });
  });

  it("withholds pricing when a legacy summary lacks source-period identities", () => {
    const { summary } = branchHistory();
    const period = summary.attribution.projects[0]?.periods[0];
    assert(period);
    period.id = "";
    expect(projectReportFromSummary(summary)).toBeUndefined();
    expect(
      buildMeasuredUsageExport({ producerVersion, history: summary, now })
        .billableBranchMonthComponents.status,
    ).toBe("unavailable");
  });

  it("throws when neither or both inputs are supplied", () => {
    expect(() => buildMeasuredUsageExport({ producerVersion })).toThrow();
    expect(() =>
      buildMeasuredUsageExport({
        producerVersion,
        history: historySummary({
          metricNames: ["compute_unit_seconds"],
          aggregate: { compute_unit_seconds: "0" },
          projects: [],
        }),
        snapshot: snapshotReport([]),
      }),
    ).toThrow();
  });
});

function snapshotReport(
  projects: Array<{
    projectId: string;
    period?: { start: string; end: string };
    metrics?: Partial<CurrentPeriodSnapshotReport["projects"][number]["metrics"]>;
    logicalSizeBytes?: string | null;
    storageAvailable?: boolean;
  }>,
  status: "complete" | "partial" = "complete",
  requestedProjectIds = projects.map((project) => project.projectId).sort(),
): CurrentPeriodSnapshotReport {
  return {
    schemaVersion: 1,
    kind: "current_period_snapshot",
    historical: false,
    generatedAt: "2026-08-27T12:00:00.000Z",
    organizationId: "org-1",
    requestedProjectIds,
    coverage: {
      status,
      projectsRequested: requestedProjectIds.length,
      projectsReturned: projects.length,
      errors: [],
    },
    projects: projects.map((project) => ({
      projectId: project.projectId,
      period: project.period ?? {
        start: "2026-08-01T00:00:00Z",
        end: "2026-08-27T00:00:00Z",
      },
      metrics: {
        activeTimeSeconds: project.metrics?.activeTimeSeconds ?? "3600",
        computeTimeSeconds: project.metrics?.computeTimeSeconds ?? "3600",
        writtenDataBytes: project.metrics?.writtenDataBytes ?? "1000000",
        dataTransferBytes: project.metrics?.dataTransferBytes ?? "2000000000",
        dataStorageByteHours: project.metrics?.dataStorageByteHours ?? "0",
      },
      metricEvidence: {} as never,
      branchStorage:
        project.storageAvailable === false
          ? { status: "unavailable", totalLogicalSizeBytes: null, branches: [] }
          : {
              status: "available",
              totalLogicalSizeBytes:
                project.logicalSizeBytes === undefined ? "500000000" : project.logicalSizeBytes,
              branches: [],
            },
    })),
  };
}

describe("buildMeasuredUsageExport (current snapshot)", () => {
  it("uses measured generatedAt for an empty snapshot period, preserving snapshot asOf", () => {
    const snapshot = snapshotReport([]);
    const measured = buildMeasuredUsageExport({
      producerVersion,
      snapshot,
      now: () => new Date("2026-08-27T12:01:00Z"),
    });
    expect(measured.period).toEqual({ from: measured.generatedAt, to: measured.generatedAt });
    expect(measured.asOf).toBe(snapshot.generatedAt);
    expect(measured.scope).toEqual({
      kind: "projects",
      organizationId: "org-1",
      projectIds: [],
    });
    expect(measured.pointInTimeStorage).toEqual({
      totalLogicalSizeBytes: "0",
      complete: true,
      projects: [],
    });
    expect(parseMeasuredBillingUsage(measured)).toEqual(measured);
  });

  it("preserves heterogeneous project periods and computes their exact envelope", () => {
    const snapshot = snapshotReport([
      { projectId: "b" },
      {
        projectId: "a",
        period: { start: "2026-08-01T00:30:00+01:00", end: "2026-08-30T00:00:00Z" },
      },
    ]);
    const measured = buildMeasuredUsageExport({ producerVersion, snapshot, now });

    expect(measured.period).toEqual({
      from: "2026-08-01T00:30:00+01:00",
      to: "2026-08-30T00:00:00Z",
    });
    expect(measured.projects.map((project) => project.period)).toEqual(
      snapshot.projects.map((project) => ({ from: project.period.start, to: project.period.end })),
    );
    expect(measured.coverage).toMatchObject({
      requestedProjectIds: ["a", "b"],
      returnedProjectIds: ["a", "b"],
      missingProjectIds: [],
    });
    expect(parseMeasuredBillingUsage(measured)).toEqual(measured);
  });

  it("refuses errors owned by a project outside the requested scope", () => {
    const snapshot = snapshotReport([{ projectId: "a" }], "partial");
    snapshot.coverage.errors = [
      { projectId: "missing", source: "project_snapshot", message: "Unavailable" },
    ];
    expect(() => buildMeasuredUsageExport({ producerVersion, snapshot, now })).toThrowError(
      expect.objectContaining({ code: "INCONSISTENT_VALUE" }),
    );
  });

  it.each(["projectsRequested", "projectsReturned"] as const)(
    "refuses inconsistent %s counts",
    (field) => {
      const snapshot = snapshotReport([{ projectId: "a" }], "partial");
      snapshot.coverage[field] = 2;
      expect(() => buildMeasuredUsageExport({ producerVersion, snapshot, now })).toThrowError(
        expect.objectContaining({ code: "INCONSISTENT_VALUE" }),
      );
    },
  );

  it("preserves missing projects in partial scope, coverage errors, and storage", () => {
    const snapshot = snapshotReport([{ projectId: "project-a" }], "partial", [
      "project-a",
      "project-b",
    ]);
    snapshot.coverage.errors = [
      {
        projectId: "project-b",
        source: "project_snapshot",
        message: "Unavailable",
        detail: { code: "HTTP_503", message: "Unavailable", status: 503, retryable: true },
      },
    ];
    const measured = buildMeasuredUsageExport({
      producerVersion,
      snapshot,
      now,
    });

    expect(measured.scope).toEqual({
      kind: "projects",
      organizationId: "org-1",
      projectIds: ["project-a", "project-b"],
    });
    expect(measured.coverage).toMatchObject({
      status: "partial",
      authoritative: false,
      requestedProjectIds: ["project-a", "project-b"],
      returnedProjectIds: ["project-a"],
      missingProjectIds: ["project-b"],
      errors: snapshot.coverage.errors,
    });
    expect(measured.projects.map((project) => project.projectId)).toEqual(["project-a"]);
    expect(measured.pointInTimeStorage).toEqual({
      complete: false,
      totalLogicalSizeBytes: null,
      projects: [
        { projectId: "project-a", totalLogicalSizeBytes: "500000000" },
        { projectId: "project-b", totalLogicalSizeBytes: null },
      ],
    });
    expect(parseMeasuredBillingUsage(measured)).toEqual(measured);
  });

  it("retains requested scope and null storage when no project snapshot succeeds", () => {
    const snapshot = snapshotReport([], "partial", ["a", "b"]);
    snapshot.coverage.errors = ["a", "b"].map((projectId) => ({
      projectId,
      source: "project_snapshot",
      message: "Unavailable",
    }));
    const measured = buildMeasuredUsageExport({
      producerVersion,
      snapshot,
      now: () => new Date("2026-08-27T12:01:00Z"),
    });

    expect(measured.period).toEqual({ from: measured.generatedAt, to: measured.generatedAt });
    expect(measured.coverage).toMatchObject({
      requestedProjectIds: ["a", "b"],
      returnedProjectIds: [],
      missingProjectIds: ["a", "b"],
      errors: snapshot.coverage.errors,
    });
    expect(measured.pointInTimeStorage).toEqual({
      complete: false,
      totalLogicalSizeBytes: null,
      projects: [
        { projectId: "a", totalLogicalSizeBytes: null },
        { projectId: "b", totalLogicalSizeBytes: null },
      ],
    });
    expect(parseMeasuredBillingUsage(measured)).toEqual(measured);
  });

  it("marks the Free snapshot non-authoritative and withholds aggregate metrics", () => {
    const measured = buildMeasuredUsageExport({
      producerVersion,
      snapshot: snapshotReport([{ projectId: "free-1" }]),
      now,
    });
    expect(measured.source).toEqual({ contract: "current-period-snapshot", authoritative: false });
    expect(measured.coverage.authoritative).toBe(false);
    expect(measured.metrics).toBeNull();
    expect(measured.warnings.join(" ")).toMatch(/not billing authoritative/i);
    expect(parseMeasuredBillingUsage(measured)).toEqual(measured);
  });

  it("maps snapshot counters to v2 metric names and explains compute and active hours", () => {
    const measured = buildMeasuredUsageExport({
      producerVersion,
      snapshot: snapshotReport([
        {
          projectId: "free-1",
          metrics: { computeTimeSeconds: "7200", dataTransferBytes: "1000000000" },
        },
      ]),
      now,
    });
    const metrics = measured.projects[0]?.metrics ?? [];
    expect(metrics.find((m) => m.name === "compute_unit_seconds")?.derived).toMatchObject({
      unit: "cu_hour",
      decimalApproximation: "2",
    });
    expect(metrics.find((m) => m.name === "active_time_seconds")?.derived).toMatchObject({
      unit: "active_hour",
      decimalApproximation: "1",
    });
    expect(measured.formulas.active_hour).toBe("active_time_seconds / 3600");
    expect(metrics.find((m) => m.name === "public_network_transfer_bytes")?.raw.value).toBe(
      "1000000000",
    );
    // The legacy dataStorageByteHours must never surface as a measured metric.
    expect(metrics.some((m) => m.name === "dataStorageByteHours")).toBe(false);
  });

  it("labels point-in-time logical storage separately and flags incompleteness", () => {
    const measured = buildMeasuredUsageExport({
      producerVersion,
      snapshot: snapshotReport([
        { projectId: "a", logicalSizeBytes: "500000000" },
        { projectId: "b", storageAvailable: false },
      ]),
      now,
    });
    expect(measured.pointInTimeStorage?.complete).toBe(false);
    expect(measured.pointInTimeStorage?.totalLogicalSizeBytes).toBeNull();
    expect(measured.pointInTimeStorage?.projects).toEqual([
      { projectId: "a", totalLogicalSizeBytes: "500000000" },
      { projectId: "b", totalLogicalSizeBytes: null },
    ]);
  });

  it("sums point-in-time logical storage when every branch size is known", () => {
    const measured = buildMeasuredUsageExport({
      producerVersion,
      snapshot: snapshotReport([
        { projectId: "a", logicalSizeBytes: "500000000" },
        { projectId: "b", logicalSizeBytes: "250000000" },
      ]),
      now,
    });
    expect(measured.pointInTimeStorage?.complete).toBe(true);
    expect(measured.pointInTimeStorage?.totalLogicalSizeBytes).toBe("750000000");
  });

  it("withholds storage totals when inventory is partial despite all known sizes", () => {
    const snapshot = snapshotReport([{ projectId: "a" }], "partial");
    snapshot.coverage.errors = [
      { projectId: null, source: "project_list", message: "Inventory truncated" },
    ];
    const measured = buildMeasuredUsageExport({ producerVersion, snapshot, now });

    expect(measured.pointInTimeStorage).toEqual({
      complete: false,
      totalLogicalSizeBytes: null,
      projects: [{ projectId: "a", totalLogicalSizeBytes: "500000000" }],
    });
    expect(measured.coverage).toMatchObject({ errors: snapshot.coverage.errors });
  });

  it("withholds storage totals for an unknown branch size under complete snapshot coverage", () => {
    const measured = buildMeasuredUsageExport({
      producerVersion,
      snapshot: snapshotReport([{ projectId: "a", logicalSizeBytes: null }]),
      now,
    });

    expect(measured.coverage.status).toBe("complete");
    expect(measured.pointInTimeStorage).toEqual({
      complete: false,
      totalLogicalSizeBytes: null,
      projects: [{ projectId: "a", totalLogicalSizeBytes: null }],
    });
  });
});
