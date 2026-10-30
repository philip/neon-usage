import { describe, expect, expectTypeOf, it } from "vitest";
import {
  CHART_GROUPS as dashboardChartGroups,
  METRICS as dashboardMetrics,
  metricInfo,
  toDisplayValue,
} from "../dashboard/src/lib/metrics.js";
import { deriveBillingValue, metricCatalog } from "../src/metric-catalog.js";
import {
  branchConsumptionMetrics,
  type HistoryBranchMetricName,
  type HistoryProjectMetricName,
  metricDefinitions,
  projectConsumptionMetrics,
  type SnapshotProjectMetricName,
} from "../src/metric-definitions.js";
import { CHART_GROUPS, METRICS } from "../src/metric-presentation.js";

describe("endpoint-aware metric definitions", () => {
  it.each([
    "",
    "-1",
    "+1",
    "0x10",
    "0b10",
    "1e3",
    "1.0",
    " 1",
    "1 ",
    "1\n",
    "1\r",
    "01",
    "00",
    "9".repeat(129),
    1,
    null,
  ])("rejects noncanonical or oversized direct conversion input %j", (value) => {
    expect(() => deriveBillingValue("compute_unit_seconds", value as string)).toThrow(RangeError);
  });

  it.each(["0", "1", "9".repeat(128)])("accepts the bounded canonical quantity %s", (value) => {
    const derived = deriveBillingValue("written_data_bytes", value);
    expect(BigInt(derived.exact.numerator) * 1_000_000_000n).toBe(
      BigInt(value) * BigInt(derived.exact.denominator),
    );
  });

  it("derives metric name types from endpoint support", () => {
    expectTypeOf<
      Extract<HistoryProjectMetricName, "active_time_seconds" | "written_data_bytes">
    >().toEqualTypeOf<never>();
    expectTypeOf<
      Extract<HistoryBranchMetricName, "snapshot_storage_bytes_month" | "extra_branches_month">
    >().toEqualTypeOf<never>();
    expectTypeOf<SnapshotProjectMetricName>().toEqualTypeOf<
      | "compute_unit_seconds"
      | "public_network_transfer_bytes"
      | "active_time_seconds"
      | "written_data_bytes"
    >();
  });

  it("keeps snapshot-only metrics out of history requests", () => {
    expect(metricDefinitions.active_time_seconds.endpoints).toEqual(["snapshot_project"]);
    expect(metricDefinitions.written_data_bytes.endpoints).toEqual(["snapshot_project"]);
    expect(projectConsumptionMetrics).not.toContain("active_time_seconds");
    expect(projectConsumptionMetrics).not.toContain("written_data_bytes");
    expect(branchConsumptionMetrics.every((name) => projectConsumptionMetrics.includes(name))).toBe(
      true,
    );
  });

  it("preserves the explicit history request defaults", () => {
    expect(projectConsumptionMetrics).toEqual([
      "compute_unit_seconds",
      "root_branch_bytes_month",
      "child_branch_bytes_month",
      "instant_restore_bytes_month",
      "snapshot_storage_bytes_month",
      "public_network_transfer_bytes",
      "private_network_transfer_bytes",
      "extra_branches_month",
      "functions_active_capacity_microseconds",
      "functions_waiting_capacity_microseconds",
      "functions_invocations",
      "functions_egress_bytes",
    ]);
    expect(branchConsumptionMetrics).toEqual([
      "compute_unit_seconds",
      "root_branch_bytes_month",
      "child_branch_bytes_month",
      "instant_restore_bytes_month",
      "public_network_transfer_bytes",
      "private_network_transfer_bytes",
    ]);
    expect(new Set(projectConsumptionMetrics).size).toBe(projectConsumptionMetrics.length);
    expect(new Set(branchConsumptionMetrics).size).toBe(branchConsumptionMetrics.length);
    for (const name of projectConsumptionMetrics) {
      expect(metricDefinitions[name].endpoints).toContain("history_project");
    }
    for (const name of branchConsumptionMetrics) {
      expect(metricDefinitions[name].endpoints).toContain("history_branch");
    }
  });

  it("freezes definitions and their endpoint lists", () => {
    expect(Object.isFrozen(metricDefinitions)).toBe(true);
    expect(Object.isFrozen(projectConsumptionMetrics)).toBe(true);
    expect(Object.isFrozen(branchConsumptionMetrics)).toBe(true);
    for (const definition of Object.values(metricDefinitions)) {
      expect(Object.isFrozen(definition)).toBe(true);
      expect(Object.isFrozen(definition.endpoints)).toBe(true);
    }
    expect(metricCatalog).toBe(metricDefinitions);
  });

  it.each([
    ["compute_unit_seconds", "cu_second", 3600n, "cu_hour"],
    ["public_network_transfer_bytes", "byte", 1_000_000_000n, "gb"],
    ["private_network_transfer_bytes", "byte", 1_000_000_000n, "gb"],
    ["extra_branches_month", "branch_hour", 744n, "branch_month_before_allowance"],
    ["active_time_seconds", "second", 3600n, "active_hour"],
    ["written_data_bytes", "byte", 1_000_000_000n, "gb"],
    [
      "functions_active_capacity_microseconds",
      "capacity_microsecond",
      3_600_000_000n,
      "capacity_hour",
    ],
    [
      "functions_waiting_capacity_microseconds",
      "capacity_microsecond",
      3_600_000_000n,
      "capacity_hour",
    ],
    ["functions_invocations", "invocation", 1_000_000n, "million_invocations"],
    ["functions_egress_bytes", "byte", 1_000_000_000n, "gb"],
  ] as const)("preserves exact conversion for %s", (name, rawUnit, denominator, unit) => {
    expect(metricDefinitions[name]).toMatchObject({ rawUnit, denominator, derivedUnit: unit });
    expect(deriveBillingValue(name, (denominator * 3n).toString())).toEqual({
      exact: { numerator: "3", denominator: "1" },
      decimalApproximation: "3",
      decimalPrecision: 40,
      rounding: "half_up",
      unit,
    });
  });

  it("keeps arbitrary-precision fractions and hostile unknown names safe", () => {
    expect(deriveBillingValue("compute_unit_seconds", "1")).toMatchObject({
      exact: { numerator: "1", denominator: "3600" },
      decimalApproximation: "0.0002777777777777777777777777777777777777778",
    });
    expect(deriveBillingValue("written_data_bytes", "9007199254740993").exact).toEqual({
      numerator: "9007199254740993",
      denominator: "1000000000",
    });
    expect(() => deriveBillingValue("constructor", "1")).toThrow(RangeError);
  });
});

describe("shared metric presentation", () => {
  it.each(["constructor", "toString", "unknown_metric"])(
    "preserves the fallback label and raw quantity for unknown metric %s",
    (name) => {
      expect(metricInfo(name)).toEqual({ label: name, unit: "", divisor: 1 });
      expect(toDisplayValue(name, "3600")).toBe(3600);
    },
  );

  it("uses the shared presentation data in the dashboard", () => {
    expect(dashboardMetrics).toBe(METRICS);
    expect(dashboardChartGroups).toBe(CHART_GROUPS);
    for (const [name, definition] of Object.entries(metricDefinitions)) {
      expect(METRICS[name]?.divisor).toBe(
        name === "functions_invocations" ? 1 : Number(definition.denominator),
      );
    }
    expect(metricInfo("root_branch_bytes_month")).toEqual({
      label: "Root storage",
      unit: "GB-mo",
      divisor: 1e9,
    });
    expect(toDisplayValue("root_branch_bytes_month", "3360000000")).toBe(3.36);
    expect(toDisplayValue("functions_invocations", "42")).toBe(42);
    expect(metricInfo("functions_invocations")).toEqual({
      label: "Function invocations",
      unit: "invocations",
      divisor: 1,
    });
    expect(metricInfo("functions_egress_bytes").label).toBe(
      "Functions egress (uses public transfer allowance)",
    );
    expect(CHART_GROUPS.map((group) => group.id)).toEqual([
      "storage",
      "compute",
      "transfer",
      "functions-compute",
      "functions-invocations",
      "functions-egress",
    ]);
  });
});

// Golden contract for the storage-unit interpretation.
//
// Reconciled against a real Neon invoice (2026-08-10): the v2 `*_bytes_month`
// fields arrive already divided by 744 (byte-months, matching their names), so
// GB-months = value / 1e9 with NO extra /744. This deliberately deviates from
// Neon's public usage-calculations example, which labels these v2 fields as
// byte-hours (/744/1e9) — that example is inaccurate for the v2 consumption
// endpoint (the legacy `data_storage_bytes_hour` field IS byte-hours).
//
// If this test ever pressures you toward a 744 factor, re-verify against a real
// invoice before changing the conversion — a blind change is a 744x billing error.
describe("storage metric conversion (v2 *_bytes_month are byte-months)", () => {
  const storageMetrics = [
    "root_branch_bytes_month",
    "child_branch_bytes_month",
    "instant_restore_bytes_month",
    "snapshot_storage_bytes_month",
  ] as const;

  it("divides byte-months by 1e9 only (no 744 factor)", () => {
    for (const name of storageMetrics) {
      expect(metricCatalog[name].denominator).toBe(1_000_000_000n);
      expect(metricCatalog[name].rawUnit).toBe("byte_month");
      expect(metricCatalog[name].derivedUnit).toBe("gb_month");
    }
  });

  it("converts a byte-months value to GB-months (golden example)", () => {
    // 3.36 GB-months is 3_360_000_000 byte-months; the byte-hours reading would
    // instead need 2_500_000_000_000, a 744x-scale value.
    const derived = deriveBillingValue("root_branch_bytes_month", "3360000000");
    expect(derived.unit).toBe("gb_month");
    expect(derived.decimalApproximation).toBe("3.36");
  });
});
