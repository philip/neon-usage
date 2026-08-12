import { describe, expect, it } from "vitest";
import type { ProjectConsumptionReport } from "../src/index.js";
import { renderHistoryTable } from "../src/report-presenter.js";

function report(projectIds: string[] | undefined, observed: string[]): ProjectConsumptionReport {
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-13T00:00:00.000Z",
    asOf: "2026-08-13T00:00:00.000Z",
    coverage: {
      status: "complete",
      pageCount: 1,
      entityCount: observed.length,
      qualityFlags: [],
    },
    query: {
      organizationId: "org-1",
      from: "2026-08-12T00:00:00Z",
      to: "2026-08-13T00:00:00Z",
      granularity: "daily",
      metrics: ["compute_unit_seconds"],
      ...(projectIds ? { projectIds } : {}),
    },
    effectiveRange: {
      from: "2026-08-12T00:00:00.000Z",
      to: "2026-08-13T00:00:00.000Z",
      granularity: "daily",
    },
    projects: observed.map((projectId) => ({
      projectId,
      periods: [
        {
          id: "period-1",
          plan: "launch",
          start: "2026-08-01T00:00:00Z",
          buckets: [
            {
              start: "2026-08-12T00:00:00Z",
              end: "2026-08-13T00:00:00Z",
              metrics: [
                {
                  name: "compute_unit_seconds",
                  value: "3600",
                  rawUnit: "cu_second",
                  presence: "reported" as const,
                },
              ],
            },
          ],
        },
      ],
    })) as never,
  };
}

describe("renderHistoryTable scope header", () => {
  it("names the exact project(s) the buckets were summed over", () => {
    // The linked-project default MUST be visible: rows are cross-project
    // sums, so the header is the only place the scope can be read.
    expect(renderHistoryTable(report(["hidden-wind-1"], ["hidden-wind-1"]))).toContain(
      "Neon project history · org-1 · hidden-wind-1",
    );
    expect(renderHistoryTable(report(["p-b", "p-a"], ["p-a", "p-b"]))).toContain("· p-b, p-a");
  });

  it("labels whole-organization and large explicit scopes by count", () => {
    expect(renderHistoryTable(report(undefined, ["p-1", "p-2"]))).toContain(
      "· whole organization · 2 project(s) observed",
    );
    expect(renderHistoryTable(report(["p-1", "p-2", "p-3", "p-4"], ["p-1"]))).toContain(
      "· 4 requested projects · 1 observed",
    );
  });
});
