import { type KnownMetricName, metricDefinitions } from "./metric-definitions.js";

export type MetricInfo = Readonly<{ label: string; unit: string; divisor: number }>;

const labels = {
  compute_unit_seconds: { label: "Compute", unit: "CU-hrs" },
  root_branch_bytes_month: { label: "Root storage", unit: "GB-mo" },
  child_branch_bytes_month: { label: "Branch storage", unit: "GB-mo" },
  instant_restore_bytes_month: { label: "Instant restore", unit: "GB-mo" },
  snapshot_storage_bytes_month: { label: "Snapshots", unit: "GB-mo" },
  public_network_transfer_bytes: { label: "Public transfer", unit: "GB" },
  private_network_transfer_bytes: { label: "Private transfer", unit: "GB" },
  extra_branches_month: { label: "Extra branches", unit: "branch-mo" },
  active_time_seconds: { label: "Active", unit: "hrs" },
  written_data_bytes: { label: "Written", unit: "GB" },
} satisfies Record<KnownMetricName, { label: string; unit: string }>;

// Display values approximate the exact billing fractions only for presentation.
export const METRICS: Readonly<Record<string, MetricInfo>> = Object.freeze(
  Object.fromEntries(
    (Object.keys(metricDefinitions) as KnownMetricName[]).map((name) => [
      name,
      Object.freeze({ ...labels[name], divisor: Number(metricDefinitions[name].denominator) }),
    ]),
  ),
);

export const CHART_GROUPS = Object.freeze([
  Object.freeze({
    id: "storage",
    title: "Storage",
    unit: "GB-mo",
    metrics: Object.freeze([
      "root_branch_bytes_month",
      "child_branch_bytes_month",
      "instant_restore_bytes_month",
      "snapshot_storage_bytes_month",
    ]),
  }),
  Object.freeze({
    id: "compute",
    title: "Compute",
    unit: "CU-hrs",
    metrics: Object.freeze(["compute_unit_seconds"]),
  }),
  Object.freeze({
    id: "transfer",
    title: "Network transfer",
    unit: "GB",
    metrics: Object.freeze(["public_network_transfer_bytes", "private_network_transfer_bytes"]),
  }),
]);
