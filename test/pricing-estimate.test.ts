import { describe, expect, it } from "vitest";
import { renderEstimateTable, renderPriceTable } from "../src/estimate-presenter.js";
import type { ProjectConsumptionReport } from "../src/history-report.js";
import { estimateProjectCosts } from "../src/pricing-estimate.js";
import { neonDocumentationRateCard } from "../src/rate-card.js";

const now = () => new Date("2026-08-09T12:00:00Z");

// The real card takes effect 2026-08-08, mid-way through the fixture window
// (2026-08-02 → 2026-08-09). Pricing-math tests use a card that fully covers
// the window so they exercise rates and allowances, not date extrapolation;
// the straddle behavior itself is tested explicitly below.
const coveringRateCard = { ...neonDocumentationRateCard, effectiveFrom: "2026-08-01" };

type ProjectUsage = {
  projectId: string;
  plan: string;
  metrics: Record<string, string>;
  periodId?: string;
};

function report(
  projects: ProjectUsage[],
  overrides: { status?: "complete" | "partial"; metrics?: string[] } = {},
): ProjectConsumptionReport {
  const metricNames = overrides.metrics ?? [
    ...new Set(projects.flatMap((project) => Object.keys(project.metrics))),
  ];
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-09T12:00:00.000Z",
    asOf: "2026-08-09T00:00:00.000Z",
    coverage: {
      status: overrides.status ?? "complete",
      pageCount: 1,
      entityCount: projects.length,
      qualityFlags: [],
    },
    query: {
      organizationId: "org-1",
      from: "2026-08-02T00:00:00Z",
      to: "2026-08-09T00:00:00Z",
      granularity: "daily",
      metrics: metricNames,
    },
    effectiveRange: {
      from: "2026-08-02T00:00:00.000Z",
      to: "2026-08-09T00:00:00.000Z",
      granularity: "daily",
    },
    projects: projects.map((project) => ({
      projectId: project.projectId,
      periods: [
        {
          id: project.periodId ?? `period-${project.projectId}`,
          plan: project.plan,
          start: "2026-08-01T00:00:00Z",
          buckets: [
            {
              start: "2026-08-02T00:00:00Z",
              end: "2026-08-03T00:00:00Z",
              metrics: Object.entries(project.metrics).map(([name, value]) => ({
                name,
                value,
                rawUnit: "cu_second",
                presence: "reported" as const,
              })),
            },
          ],
        },
      ],
    })),
  };
}

describe("estimateProjectCosts", () => {
  it("prices Scale usage exactly and labels the result an estimate", () => {
    const estimate = estimateProjectCosts(
      report([
        {
          projectId: "project-1",
          plan: "scale",
          // 10 CU-hours and 600 GB public transfer.
          metrics: {
            compute_unit_seconds: "36000",
            public_network_transfer_bytes: "600000000000",
          },
        },
      ]),
      coveringRateCard,
      { now },
    );

    expect(estimate.disposition).toBe("estimate");
    expect(estimate.status).toBe("estimated");
    expect(estimate.rateCard.revision).toBe("neon-docs-2026-08-08");
    const compute = estimate.lines.find((line) => line.metric === "compute_unit_seconds");
    expect(compute).toMatchObject({
      status: "estimated",
      billable: { value: "10", unit: "cu_hour" },
      ratePerUnit: "0.222",
      amount: { decimalApproximation: "2.22" },
    });
    const transfer = estimate.lines.find((line) => line.metric === "public_network_transfer_bytes");
    expect(transfer).toMatchObject({
      status: "estimated",
      allowanceApplied: { rawQuantity: "500000000000", scope: "per_project" },
      billable: { value: "100", unit: "gb" },
      amount: { decimalApproximation: "10" },
      approximations: ["ALLOWANCE_WINDOW_APPROXIMATION"],
    });
    expect(estimate.totalAmount?.decimalApproximation).toBe("12.22");
    expect(estimate.exclusions).toContain("taxes");
  });

  it("applies the public-transfer allowance per project, not per organization", () => {
    const estimate = estimateProjectCosts(
      report([
        {
          projectId: "project-under",
          plan: "scale",
          metrics: { public_network_transfer_bytes: "400000000000" },
        },
        {
          projectId: "project-over",
          plan: "scale",
          metrics: { public_network_transfer_bytes: "600000000000" },
        },
      ]),
      coveringRateCard,
      { now },
    );

    // 400 GB is fully covered; 600 GB pays for 100 GB. One organization-wide
    // 500 GB allowance would instead have charged for 500 GB.
    expect(estimate.totalAmount?.decimalApproximation).toBe("10");
  });

  it("does not reset a monthly transfer allowance across source periods", () => {
    const base = report([]);
    const metric = (value: string) => ({
      name: "public_network_transfer_bytes",
      value,
      rawUnit: "byte",
      presence: "reported" as const,
    });
    const split: ProjectConsumptionReport = {
      ...base,
      coverage: { ...base.coverage, entityCount: 1 },
      query: { ...base.query, metrics: ["public_network_transfer_bytes"] },
      projects: [
        {
          projectId: "project-1",
          periods: [
            {
              id: "period-a",
              plan: "scale",
              start: "2026-08-01T00:00:00Z",
              end: "2026-08-05T00:00:00Z",
              buckets: [
                {
                  start: "2026-08-02T00:00:00Z",
                  end: "2026-08-03T00:00:00Z",
                  metrics: [metric("400000000000")],
                },
              ],
            },
            {
              id: "period-b",
              plan: "scale",
              start: "2026-08-05T00:00:00Z",
              buckets: [
                {
                  start: "2026-08-06T00:00:00Z",
                  end: "2026-08-07T00:00:00Z",
                  metrics: [metric("400000000000")],
                },
              ],
            },
          ],
        },
      ],
    };

    const estimate = estimateProjectCosts(split, coveringRateCard, { now });
    expect(estimate.lines.map((line) => line.allowanceApplied?.rawQuantity)).toEqual([
      "400000000000",
      "100000000000",
    ]);
    expect(estimate.totalAmount?.decimalApproximation).toBe("30");
  });

  it("estimates Free usage as not billed and zero", () => {
    const estimate = estimateProjectCosts(
      report([
        {
          projectId: "free-project",
          plan: "free",
          metrics: { compute_unit_seconds: "360000" },
        },
      ]),
      coveringRateCard,
      { now },
    );

    expect(estimate.lines[0]).toMatchObject({
      status: "not_billed",
      amount: { decimalApproximation: "0" },
    });
    expect(estimate.totalAmount?.decimalApproximation).toBe("0");
  });

  it("nets the Free organization-wide transfer allowance informationally", () => {
    const estimate = estimateProjectCosts(
      report([
        {
          projectId: "free-a",
          plan: "free",
          metrics: { public_network_transfer_bytes: "3000000000" },
        },
        {
          projectId: "free-b",
          plan: "free",
          metrics: { public_network_transfer_bytes: "4000000000" },
        },
      ]),
      coveringRateCard,
      { now },
    );

    // One shared 5 GB organization pool: the first project nets 3 GB, the
    // second only the remaining 2 GB. Amounts stay zero (Free is not billed).
    expect(
      estimate.lines.map((line) => ({
        project: line.projectId,
        applied: line.allowanceApplied,
        amount: line.amount?.decimalApproximation,
      })),
    ).toEqual([
      {
        project: "free-a",
        applied: {
          rawQuantity: "3000000000",
          exact: { numerator: "3000000000", denominator: "1" },
          scope: "per_organization",
        },
        amount: "0",
      },
      {
        project: "free-b",
        applied: {
          rawQuantity: "2000000000",
          exact: { numerator: "2000000000", denominator: "1" },
          scope: "per_organization",
        },
        amount: "0",
      },
    ]);
    expect(estimate.totalAmount?.decimalApproximation).toBe("0");
  });

  it("marks unknown plans unavailable instead of guessing", () => {
    const estimate = estimateProjectCosts(
      report([
        {
          projectId: "project-1",
          plan: "business_legacy",
          metrics: { compute_unit_seconds: "36000" },
        },
      ]),
      coveringRateCard,
      { now },
    );

    expect(estimate.lines[0]).toMatchObject({
      status: "unavailable",
      unavailableReason: "UNKNOWN_PLAN",
    });
    // An unpriceable line makes the whole estimate unavailable, not "estimated"
    // with null totals — so the CLI exits non-zero and the dashboard doesn't
    // render the line as $0.
    expect(estimate.status).toBe("unavailable_unpriced_lines");
    expect(estimate.totalsByMetric).toBeNull();
    expect(estimate.totalAmount).toBeNull();
  });

  it("prices Agent and Enterprise as best-effort defaults instead of refusing", () => {
    for (const [plan, computeRate] of [
      ["agent", "0.106"],
      ["enterprise", "0.222"],
    ] as const) {
      const estimate = estimateProjectCosts(
        report([{ projectId: "p", plan, metrics: { compute_unit_seconds: "36000" } }]),
        coveringRateCard,
        { now },
      );
      expect(estimate.status).toBe("estimated");
      expect(estimate.lines[0]).toMatchObject({ status: "estimated", ratePerUnit: computeRate });
      expect(estimate.totalAmount).not.toBeNull();
    }
  });

  it("marks an unpublished rate unavailable unless usage is zero", () => {
    const estimate = estimateProjectCosts(
      report([
        {
          projectId: "project-1",
          plan: "launch",
          metrics: {
            private_network_transfer_bytes: "1000000000",
            snapshot_storage_bytes_month: "0",
          },
        },
      ]),
      coveringRateCard,
      { now },
    );

    const priced = new Map(estimate.lines.map((line) => [line.metric, line]));
    expect(priced.get("private_network_transfer_bytes")).toMatchObject({
      status: "unavailable",
      unavailableReason: "RATE_NOT_PUBLISHED",
    });
    expect(priced.get("snapshot_storage_bytes_month")).toMatchObject({
      status: "estimated",
      amount: { decimalApproximation: "0" },
    });
    expect(estimate.totalAmount).toBeNull();
  });

  it("prices a mid-range plan change per billing period", () => {
    const base = report([]);
    const changed: ProjectConsumptionReport = {
      ...base,
      coverage: { ...base.coverage, entityCount: 1 },
      query: { ...base.query, metrics: ["compute_unit_seconds"] },
      projects: [
        {
          projectId: "project-1",
          periods: [
            {
              id: "period-launch",
              plan: "launch",
              start: "2026-08-01T00:00:00Z",
              end: "2026-08-05T00:00:00Z",
              buckets: [
                {
                  start: "2026-08-02T00:00:00Z",
                  end: "2026-08-03T00:00:00Z",
                  metrics: [
                    {
                      name: "compute_unit_seconds",
                      value: "36000",
                      rawUnit: "cu_second",
                      presence: "reported",
                    },
                  ],
                },
              ],
            },
            {
              id: "period-scale",
              plan: "scale",
              start: "2026-08-05T00:00:00Z",
              buckets: [
                {
                  start: "2026-08-06T00:00:00Z",
                  end: "2026-08-07T00:00:00Z",
                  metrics: [
                    {
                      name: "compute_unit_seconds",
                      value: "36000",
                      rawUnit: "cu_second",
                      presence: "reported",
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const estimate = estimateProjectCosts(changed, coveringRateCard, { now });

    const amounts = estimate.lines.map((line) => ({
      period: line.billingPeriod.sourcePeriodId,
      amount: line.amount?.decimalApproximation,
    }));
    expect(amounts).toEqual([
      { period: "period-launch", amount: "1.06" },
      { period: "period-scale", amount: "2.22" },
    ]);
    expect(estimate.totalAmount?.decimalApproximation).toBe("3.28");
  });

  it("nets the included child-branch hours and flags coarse granularity", () => {
    const estimate = estimateProjectCosts(
      report([
        {
          projectId: "project-1",
          plan: "launch",
          // One 24-hour bucket x 9 included child branches = 216 allowance
          // hours; 960 raw branch-hours leaves 744 = one branch-month.
          metrics: { extra_branches_month: "960" },
        },
      ]),
      coveringRateCard,
      { now },
    );

    expect(estimate.lines[0]).toMatchObject({
      status: "estimated",
      allowanceApplied: { rawQuantity: "216", scope: "per_project" },
      billable: { value: "1", unit: "branch_month_before_allowance" },
      ratePerUnit: "1.50",
      // Coarser-than-hourly buckets smooth intra-bucket spikes, so daily output
      // carries the granularity approximation.
      approximations: ["GRANULARITY_APPROXIMATION"],
      amount: { decimalApproximation: "1.5" },
    });
  });

  it("applies the branch allowance per bucket, never pooling across buckets", () => {
    // Launch (9 included children), two hourly buckets: 0 and 18 branch-hours.
    // Per Neon's documented per-bucket rule: max(0,0-9)+max(0,18-9) = 9
    // billable branch-hours. Pooling (18 - 9*2 = 0) would understate the bill.
    const base = report([
      { projectId: "project-1", plan: "launch", metrics: { extra_branches_month: "0" } },
    ]);
    const usage = {
      ...base,
      query: { ...base.query, granularity: "hourly" as const },
      effectiveRange: { ...base.effectiveRange, granularity: "hourly" as const },
      projects: [
        {
          projectId: "project-1",
          periods: [
            {
              id: "period-project-1",
              plan: "launch",
              start: "2026-08-01T00:00:00Z",
              buckets: [
                {
                  start: "2026-08-02T00:00:00Z",
                  end: "2026-08-02T01:00:00Z",
                  metrics: [
                    {
                      name: "extra_branches_month",
                      value: "0",
                      rawUnit: "branch_hour",
                      presence: "reported" as const,
                    },
                  ],
                },
                {
                  start: "2026-08-02T01:00:00Z",
                  end: "2026-08-02T02:00:00Z",
                  metrics: [
                    {
                      name: "extra_branches_month",
                      value: "18",
                      rawUnit: "branch_hour",
                      presence: "reported" as const,
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const estimate = estimateProjectCosts(usage, coveringRateCard, { now });
    expect(estimate.lines[0]).toMatchObject({
      status: "estimated",
      raw: { value: "18" },
      // 18 raw minus 9 billable = 9 applied allowance; billable 9/744 month.
      allowanceApplied: { rawQuantity: "9", scope: "per_project" },
      approximations: [],
    });
    // 9/744 branch-months, at the estimator's 40-digit exact precision.
    expect(estimate.lines[0]?.billable?.value.startsWith("0.01209677419354838709")).toBe(true);
  });

  it("nets a partial-hour bucket's exact fractional allowance", () => {
    // Launch, one half-hour bucket (a plan-change cell split) with 9
    // branch-hours: the allowance is 9 included x 0.5 h = 4.5, so 4.5 billable
    // with no intermediate whole-hour rounding. Flooring the duration to whole
    // hours would have billed all 9.
    const base = report([
      { projectId: "project-1", plan: "launch", metrics: { extra_branches_month: "0" } },
    ]);
    const usage = {
      ...base,
      query: { ...base.query, granularity: "hourly" as const },
      effectiveRange: { ...base.effectiveRange, granularity: "hourly" as const },
      projects: [
        {
          projectId: "project-1",
          periods: [
            {
              id: "period-project-1",
              plan: "launch",
              start: "2026-08-01T00:00:00Z",
              buckets: [
                {
                  start: "2026-08-02T00:30:00Z",
                  end: "2026-08-02T01:00:00Z",
                  metrics: [
                    {
                      name: "extra_branches_month",
                      value: "9",
                      rawUnit: "branch_hour",
                      presence: "reported" as const,
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const estimate = estimateProjectCosts(usage, coveringRateCard, { now });
    expect(estimate.lines[0]).toMatchObject({
      raw: { value: "9" },
      allowanceApplied: {
        rawQuantity: "4.5",
        exact: { numerator: "9", denominator: "2" },
        scope: "per_project",
      },
      billable: {
        exact: { numerator: "3", denominator: "496" },
        unit: "branch_month_before_allowance",
      },
    });
  });

  it("carries source evidence and request IDs through to the estimate", () => {
    const base = report([
      { projectId: "project-1", plan: "scale", metrics: { compute_unit_seconds: "3600" } },
    ]);
    const withProvenance: ProjectConsumptionReport = {
      ...base,
      coverage: { ...base.coverage, requestIds: ["req-1"] },
      evidence: [{ evidenceId: "evidence:a", payloadHash: `sha256:${"a".repeat(64)}` }],
    };

    const estimate = estimateProjectCosts(withProvenance, coveringRateCard, { now });
    expect(estimate.evidence).toEqual([
      { evidenceId: "evidence:a", payloadHash: `sha256:${"a".repeat(64)}` },
    ]);
    expect(estimate.requestIds).toEqual(["req-1"]);
  });

  it("nets branch allowance per billing period, not per query window", () => {
    const base = report([]);
    const bucket = (day: string, value: string) => ({
      start: `2026-08-0${day}T00:00:00Z`,
      end: `2026-08-0${Number(day) + 1}T00:00:00Z`,
      metrics: [
        {
          name: "extra_branches_month",
          value,
          rawUnit: "branch_hour",
          presence: "reported" as const,
        },
      ],
    });
    const twoPeriods: ProjectConsumptionReport = {
      ...base,
      coverage: { ...base.coverage, entityCount: 1 },
      query: { ...base.query, metrics: ["extra_branches_month"] },
      projects: [
        {
          projectId: "project-1",
          periods: [
            {
              id: "period-a",
              plan: "launch",
              start: "2026-08-01T00:00:00Z",
              end: "2026-08-05T00:00:00Z",
              buckets: [bucket("2", "960")],
            },
            {
              id: "period-b",
              plan: "launch",
              start: "2026-08-05T00:00:00Z",
              buckets: [bucket("6", "960")],
            },
          ],
        },
      ],
    };

    const estimate = estimateProjectCosts(twoPeriods, coveringRateCard, { now });
    // Each period nets only its own 24h x 9 = 216 allowance hours, leaving
    // one billable branch-month each; a window-wide allowance would have
    // wrongly zeroed both periods out.
    expect(
      estimate.lines.map((line) => ({
        period: line.billingPeriod.sourcePeriodId,
        applied: line.allowanceApplied?.rawQuantity,
        amount: line.amount?.decimalApproximation,
      })),
    ).toEqual([
      { period: "period-a", applied: "216", amount: "1.5" },
      { period: "period-b", applied: "216", amount: "1.5" },
    ]);
    expect(estimate.totalAmount?.decimalApproximation).toBe("3");
  });

  it("refuses to estimate from partial coverage", () => {
    const estimate = estimateProjectCosts(
      report([{ projectId: "project-1", plan: "scale", metrics: { compute_unit_seconds: "1" } }], {
        status: "partial",
      }),
      coveringRateCard,
      { now },
    );

    expect(estimate.status).toBe("unavailable_partial_coverage");
    expect(estimate.lines).toEqual([]);
    expect(estimate.totalAmount).toBeNull();
  });

  it("refuses a rate card whose dates do not cover the range", () => {
    const estimate = estimateProjectCosts(
      report([{ projectId: "project-1", plan: "scale", metrics: { compute_unit_seconds: "1" } }]),
      { ...neonDocumentationRateCard, effectiveFrom: "2026-09-01", plans: [] },
      { now },
    );

    expect(estimate.status).toBe("unavailable_rate_card_dates");
  });

  it("extrapolates uncovered dates only on request, labeling every line", () => {
    const estimate = estimateProjectCosts(
      report([
        { projectId: "project-1", plan: "scale", metrics: { compute_unit_seconds: "36000" } },
      ]),
      { ...neonDocumentationRateCard, effectiveFrom: "2026-09-01" },
      { now, extrapolateRateCardDates: true },
    );

    expect(estimate.status).toBe("estimated");
    expect(estimate.lines.length).toBeGreaterThan(0);
    for (const line of estimate.lines) {
      expect(line.approximations).toContain("RATE_CARD_DATE_EXTRAPOLATION");
    }
    expect(estimate.totalAmount).not.toBeNull();
  });

  it("does not label covered ranges as extrapolated when the option is on", () => {
    const estimate = estimateProjectCosts(
      report([
        { projectId: "project-1", plan: "scale", metrics: { compute_unit_seconds: "36000" } },
      ]),
      coveringRateCard,
      { now, extrapolateRateCardDates: true },
    );

    expect(estimate.status).toBe("estimated");
    for (const line of estimate.lines) {
      expect(line.approximations).not.toContain("RATE_CARD_DATE_EXTRAPOLATION");
    }
  });

  it("treats a window straddling the card's start as needing extrapolation", () => {
    // The real card takes effect 2026-08-08; the fixture window (2026-08-02 →
    // 2026-08-09) straddles it, so its earlier days are outside the card.
    const usage = report([
      { projectId: "project-1", plan: "scale", metrics: { compute_unit_seconds: "36000" } },
    ]);

    // Off (the default): refuse rather than silently price pre-card days.
    expect(estimateProjectCosts(usage, neonDocumentationRateCard, { now }).status).toBe(
      "unavailable_rate_card_dates",
    );

    // On: estimate, but label every line so the extrapolation is disclosed.
    const labeled = estimateProjectCosts(usage, neonDocumentationRateCard, {
      now,
      extrapolateRateCardDates: true,
    });
    expect(labeled.status).toBe("estimated");
    for (const line of labeled.lines) {
      expect(line.approximations).toContain("RATE_CARD_DATE_EXTRAPOLATION");
    }
  });

  it("renders a human table with totals, caveats, and no invoice framing", () => {
    const estimate = estimateProjectCosts(
      report([
        {
          projectId: "project-1",
          plan: "scale",
          metrics: {
            compute_unit_seconds: "36000",
            public_network_transfer_bytes: "600000000000",
          },
        },
      ]),
      coveringRateCard,
      { now },
    );

    const table = renderEstimateTable(estimate);
    expect(table).toContain("not an invoice");
    expect(table).toContain("neon-docs-2026-08-08");
    expect(table).toContain("Compute");
    expect(table).toMatch(/TOTAL\s+\$12\.22/);
    expect(table).toContain("Excludes: credits, taxes");
  });

  it("renders unavailability with its reasons instead of numbers", () => {
    const estimate = estimateProjectCosts(
      report([
        { projectId: "project-1", plan: "business_legacy", metrics: { compute_unit_seconds: "1" } },
      ]),
      coveringRateCard,
      { now },
    );

    const table = renderEstimateTable(estimate);
    expect(table).not.toContain("TOTAL");
    expect(table).toContain("Estimate unavailable");
    expect(table).toContain("UNKNOWN_PLAN");
  });

  it("renders per-project dollars as the usage table's price twin", () => {
    const estimate = estimateProjectCosts(
      report([
        {
          projectId: "project-busy",
          plan: "scale",
          metrics: {
            compute_unit_seconds: "36000",
            public_network_transfer_bytes: "600000000000",
          },
        },
        { projectId: "project-idle", plan: "scale", metrics: { compute_unit_seconds: "0" } },
      ]),
      coveringRateCard,
      { now },
    );

    const table = renderPriceTable(estimate, new Map([["project-busy", "Busy App"]]));
    expect(table).toContain("not an invoice");
    expect(table).toMatch(
      /Busy App\s+project-busy\s+\$2\.22\s+\$0\.00\s+\$10\.00\s+\$0\.00\s+\$12\.22/,
    );
    expect(table).not.toContain("project-idle");
    expect(table).toMatch(/TOTAL\s+\$2\.22\s+\$0\.00\s+\$10\.00\s+\$0\.00\s+\$12\.22/);
  });
});
