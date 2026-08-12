import { describe, expect, it } from "vitest";
import { deriveBillingValue, metricCatalog } from "../src/metric-catalog.js";

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
