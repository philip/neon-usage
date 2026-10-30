type MetricEndpoint = "history_project" | "history_branch" | "snapshot_project";

// The final assertion requires the actual end; '$' also accepts a trailing newline.
export const usageQuantityPattern = /^(?:0|[1-9]\d{0,127})(?![\s\S])/;

function definition<
  const Raw extends string,
  const Derived extends string,
  const Endpoints extends readonly MetricEndpoint[],
>(rawUnit: Raw, denominator: bigint, derivedUnit: Derived, formula: string, endpoints: Endpoints) {
  return Object.freeze({
    rawUnit,
    denominator,
    derivedUnit,
    formula,
    endpoints: Object.freeze(endpoints),
  });
}

export const metricDefinitions = Object.freeze({
  compute_unit_seconds: definition("cu_second", 3600n, "cu_hour", "compute_unit_seconds / 3600", [
    "history_project",
    "history_branch",
    "snapshot_project",
  ]),
  // Live-reconciled against an invoice 2026-08-10: v2 *_bytes_month values
  // are already byte-months, so an additional /744 would double-divide.
  root_branch_bytes_month: definition(
    "byte_month",
    1_000_000_000n,
    "gb_month",
    "root_branch_bytes_month / 1e9",
    ["history_project", "history_branch"],
  ),
  child_branch_bytes_month: definition(
    "byte_month",
    1_000_000_000n,
    "gb_month",
    "child_branch_bytes_month / 1e9",
    ["history_project", "history_branch"],
  ),
  instant_restore_bytes_month: definition(
    "byte_month",
    1_000_000_000n,
    "gb_month",
    "instant_restore_bytes_month / 1e9",
    ["history_project", "history_branch"],
  ),
  snapshot_storage_bytes_month: definition(
    "byte_month",
    1_000_000_000n,
    "gb_month",
    "snapshot_storage_bytes_month / 1e9",
    ["history_project"],
  ),
  public_network_transfer_bytes: definition(
    "byte",
    1_000_000_000n,
    "gb",
    "public_network_transfer_bytes / 1e9",
    ["history_project", "history_branch", "snapshot_project"],
  ),
  private_network_transfer_bytes: definition(
    "byte",
    1_000_000_000n,
    "gb",
    "private_network_transfer_bytes / 1e9",
    ["history_project", "history_branch"],
  ),
  extra_branches_month: definition(
    "branch_hour",
    744n,
    "branch_month_before_allowance",
    "extra_branches_month / 744",
    ["history_project"],
  ),
  functions_active_capacity_microseconds: definition(
    "capacity_microsecond",
    3_600_000_000n,
    "capacity_hour",
    "functions_active_capacity_microseconds / 3.6e9",
    ["history_project"],
  ),
  functions_waiting_capacity_microseconds: definition(
    "capacity_microsecond",
    3_600_000_000n,
    "capacity_hour",
    "functions_waiting_capacity_microseconds / 3.6e9",
    ["history_project"],
  ),
  functions_invocations: definition(
    "invocation",
    1_000_000n,
    "million_invocations",
    "functions_invocations / 1e6",
    ["history_project"],
  ),
  functions_egress_bytes: definition("byte", 1_000_000_000n, "gb", "functions_egress_bytes / 1e9", [
    "history_project",
  ]),
  active_time_seconds: definition("second", 3600n, "active_hour", "active_time_seconds / 3600", [
    "snapshot_project",
  ]),
  written_data_bytes: definition("byte", 1_000_000_000n, "gb", "written_data_bytes / 1e9", [
    "snapshot_project",
  ]),
});

export type KnownMetricName = keyof typeof metricDefinitions;
type NamesForEndpoint<Endpoint extends MetricEndpoint> = {
  [Name in KnownMetricName]: Endpoint extends (typeof metricDefinitions)[Name]["endpoints"][number]
    ? Name
    : never;
}[KnownMetricName];
export type HistoryProjectMetricName = NamesForEndpoint<"history_project">;
export type HistoryBranchMetricName = NamesForEndpoint<"history_branch">;
export type SnapshotProjectMetricName = NamesForEndpoint<"snapshot_project">;
export type RawUnit = (typeof metricDefinitions)[KnownMetricName]["rawUnit"] | "unknown";

export const projectConsumptionMetrics = Object.freeze([
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
] as const satisfies readonly HistoryProjectMetricName[]);

export const branchConsumptionMetrics = Object.freeze([
  "compute_unit_seconds",
  "root_branch_bytes_month",
  "child_branch_bytes_month",
  "instant_restore_bytes_month",
  "public_network_transfer_bytes",
  "private_network_transfer_bytes",
] as const satisfies readonly HistoryBranchMetricName[]);

// Frozen independently of catalog growth; additional formula entries are additive.
export const baseMetricFormulas: Readonly<Record<string, string>> = Object.freeze({
  cu_hour: "compute_unit_seconds / 3600",
  active_hour: "active_time_seconds / 3600",
  gb_month: "bytes_month / 1e9",
  gb: "bytes / 1e9",
  branch_month_before_allowance: "branch_hours / 744",
  capacity_hour: "capacity_microseconds / 3.6e9",
  million_invocations: "invocations / 1e6",
});
