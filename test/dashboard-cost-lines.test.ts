import { describe, expect, it } from "vitest";
import type { PricingEstimate } from "../dashboard/src/lib/api.js";
import { costLines } from "../dashboard/src/lib/cost-lines.js";

describe("dashboard cost lines", () => {
  it("uses billing units for invocations and preserves priced Functions egress", () => {
    const estimate = {
      lines: [
        {
          projectId: "p",
          billingPeriod: { plan: "launch", start: "2026-10-01T00:00:00Z" },
          allowanceWindow: {
            start: "2026-10-01T00:00:00Z",
            end: "2026-11-01T00:00:00Z",
          },
          metric: "functions_invocations",
          status: "estimated",
          raw: { value: "1500000", unit: "invocation" },
          allowanceApplied: { rawQuantity: "1000000", scope: "per_project" },
          billable: { value: "0.5", unit: "million_invocations" },
          ratePerUnit: "0.60",
          amount: { decimalApproximation: "0.3" },
        },
        {
          projectId: "p",
          billingPeriod: { plan: "launch", start: "2026-10-01T00:00:00Z" },
          allowanceWindow: {
            start: "2026-10-01T00:00:00Z",
            end: "2026-11-01T00:00:00Z",
          },
          metric: "functions_egress_bytes",
          status: "estimated",
          raw: { value: "200000000000", unit: "byte" },
          allowanceApplied: { rawQuantity: "100000000000", scope: "per_project" },
          billable: { value: "100", unit: "gb" },
          ratePerUnit: "0.10",
          amount: { decimalApproximation: "10" },
        },
      ],
    } as unknown as PricingEstimate;

    expect(costLines(estimate)).toEqual([
      {
        id: "functions_invocations",
        label: "Function invocations",
        quantity: 0.5,
        used: 1.5,
        included: 1,
        unit: "M invocations",
        rate: 0.6,
        cost: 0.3,
      },
      {
        id: "functions_egress_bytes",
        label: "Functions egress (uses public transfer allowance)",
        quantity: 100,
        used: 200,
        included: 100,
        unit: "GB",
        rate: 0.1,
        cost: 10,
      },
    ]);
  });
});
