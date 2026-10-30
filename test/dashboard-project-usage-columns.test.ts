import { describe, expect, it } from "vitest";
import { projectUsageColumns } from "../dashboard/src/lib/project-usage-columns.js";

describe("dashboard project usage columns", () => {
  it("preserves every used metric instead of truncating wide tables", () => {
    const names = Array.from({ length: 8 }, (_, index) => `metric_${index}`);

    expect(projectUsageColumns(names, false).map((column) => column.id)).toEqual(names);
  });

  it("uses compact Functions headers while preserving full tooltips", () => {
    const columns = projectUsageColumns(
      [
        "functions_active_capacity_microseconds",
        "functions_waiting_capacity_microseconds",
        "functions_invocations",
        "functions_egress_bytes",
      ],
      false,
    );

    expect(columns.map(({ label }) => label)).toEqual([
      "Active",
      "Waiting",
      "Invocations",
      "Egress",
    ]);
    expect(columns.map(({ description }) => description)).toEqual([
      "Functions active",
      "Functions waiting",
      "Function invocations",
      "Functions egress (uses public transfer allowance)",
    ]);
    expect(columns.map(({ group }) => group)).toEqual([
      "Functions",
      "Functions",
      "Functions",
      "Functions",
    ]);
  });

  it("groups four compact Storage headers while preserving full tooltips", () => {
    const columns = projectUsageColumns(
      [
        "root_branch_bytes_month",
        "child_branch_bytes_month",
        "instant_restore_bytes_month",
        "snapshot_storage_bytes_month",
      ],
      false,
    );

    expect(columns.map(({ label }) => label)).toEqual(["Root", "Branch", "Restore", "Snapshots"]);
    expect(columns.map(({ description }) => description)).toEqual([
      "Root storage",
      "Branch storage",
      "Instant restore",
      "Snapshots",
    ]);
    expect(columns.map(({ group }) => group)).toEqual(["Storage", "Storage", "Storage", "Storage"]);
  });

  it("groups network metrics and formats dense quantity values", () => {
    const columns = projectUsageColumns(
      ["public_network_transfer_bytes", "private_network_transfer_bytes"],
      false,
    );

    expect(columns.map(({ group }) => group)).toEqual(["Network", "Network"]);
    expect(columns[0]?.format?.(2788.47)).toBe("2,788");
    expect(columns[0]?.format?.(695.57)).toBe("695.6");
    expect(columns[0]?.format?.(1.341)).toBe("1.34");
    expect(columns[0]?.format?.(77_769)).toBe("77.8K");
  });

  it("keeps Functions metrics together in canonical project order", () => {
    const columns = projectUsageColumns(
      [
        "functions_egress_bytes",
        "root_branch_bytes_month",
        "functions_active_capacity_microseconds",
        "compute_unit_seconds",
        "functions_invocations",
      ],
      true,
    );

    expect(columns.map(({ id }) => id)).toEqual([
      "compute_unit_seconds",
      "root_branch_bytes_month",
      "functions_active_capacity_microseconds",
      "functions_invocations",
      "functions_egress_bytes",
    ]);
  });
});
