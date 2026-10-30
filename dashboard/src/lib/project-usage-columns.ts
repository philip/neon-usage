import { projectConsumptionMetrics } from "../../../src/metric-definitions.js";
import { formatCompactQuantity, metricInfo } from "./metrics.js";

const CURRENCY = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

const PROJECT_METRIC_LABELS: Readonly<Record<string, string>> = {
  root_branch_bytes_month: "Root",
  child_branch_bytes_month: "Branch",
  instant_restore_bytes_month: "Restore",
  snapshot_storage_bytes_month: "Snapshots",
  functions_active_capacity_microseconds: "Active",
  functions_waiting_capacity_microseconds: "Waiting",
  functions_invocations: "Invocations",
  functions_egress_bytes: "Egress",
};

const PROJECT_METRIC_GROUPS: Readonly<Record<string, string>> = {
  root_branch_bytes_month: "Storage",
  child_branch_bytes_month: "Storage",
  instant_restore_bytes_month: "Storage",
  snapshot_storage_bytes_month: "Storage",
  public_network_transfer_bytes: "Network",
  private_network_transfer_bytes: "Network",
  functions_active_capacity_microseconds: "Functions",
  functions_waiting_capacity_microseconds: "Functions",
  functions_invocations: "Functions",
  functions_egress_bytes: "Functions",
};

const PROJECT_METRIC_UNITS: Readonly<Record<string, string>> = {
  functions_active_capacity_microseconds: "cap-hrs",
  functions_waiting_capacity_microseconds: "cap-hrs",
  functions_invocations: "count",
};

const PROJECT_METRIC_ORDER = new Map(
  projectConsumptionMetrics.map((name, index) => [name as string, index]),
);

/** Builds every used metric column; the table handles overflow. */
export function projectUsageColumns(metricNames: Iterable<string>, priceMode: boolean) {
  return [...metricNames]
    .toSorted(
      (left, right) =>
        (PROJECT_METRIC_ORDER.get(left) ?? Number.MAX_SAFE_INTEGER) -
        (PROJECT_METRIC_ORDER.get(right) ?? Number.MAX_SAFE_INTEGER),
    )
    .map((name) => {
      const info = metricInfo(name);

      return {
        id: name,
        label: PROJECT_METRIC_LABELS[name] ?? info.label,
        description: info.label,
        group: PROJECT_METRIC_GROUPS[name],
        unit: priceMode ? "USD" : (PROJECT_METRIC_UNITS[name] ?? info.unit),
        format: priceMode ? (value: number) => CURRENCY.format(value) : formatCompactQuantity,
      };
    });
}
