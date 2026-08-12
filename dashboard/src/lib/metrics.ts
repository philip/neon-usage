// Display names, units, and raw-to-display conversion for the v2 metric
// family. Divisors mirror src/metric-catalog.ts (the byte-month live
// reconciliation included); the page only approximates for plotting — exact
// values stay in the JSON reports.

export type MetricInfo = { label: string; unit: string; divisor: number };

export const METRICS: Record<string, MetricInfo> = {
  compute_unit_seconds: { label: "Compute", unit: "CU-hrs", divisor: 3600 },
  root_branch_bytes_month: { label: "Root storage", unit: "GB-mo", divisor: 1e9 },
  child_branch_bytes_month: { label: "Branch storage", unit: "GB-mo", divisor: 1e9 },
  instant_restore_bytes_month: { label: "Instant restore", unit: "GB-mo", divisor: 1e9 },
  snapshot_storage_bytes_month: { label: "Snapshots", unit: "GB-mo", divisor: 1e9 },
  public_network_transfer_bytes: { label: "Public transfer", unit: "GB", divisor: 1e9 },
  private_network_transfer_bytes: { label: "Private transfer", unit: "GB", divisor: 1e9 },
  extra_branches_month: { label: "Extra branches", unit: "branch-mo", divisor: 744 },
};

export const CHART_GROUPS = [
  {
    id: "storage",
    title: "Storage",
    unit: "GB-mo",
    metrics: [
      "root_branch_bytes_month",
      "child_branch_bytes_month",
      "instant_restore_bytes_month",
      "snapshot_storage_bytes_month",
    ],
  },
  { id: "compute", title: "Compute", unit: "CU-hrs", metrics: ["compute_unit_seconds"] },
  {
    id: "transfer",
    title: "Network transfer",
    unit: "GB",
    metrics: ["public_network_transfer_bytes", "private_network_transfer_bytes"],
  },
] as const;

export function metricInfo(name: string): MetricInfo {
  return METRICS[name] ?? { label: name, unit: "", divisor: 1 };
}

const NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

export function formatQuantity(value: number): string {
  return NUMBER.format(value);
}

/** Raw metric string -> display-unit number, for plotting only. */
export function toDisplayValue(name: string, rawValue: string): number {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return 0;
  return parsed / metricInfo(name).divisor;
}

const UTC_DAY = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const UTC_HOUR = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});
const UTC_MONTH = new Intl.DateTimeFormat("en-US", {
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

export function bucketLabel(startIso: string, granularity: string): string {
  const start = new Date(startIso);
  if (granularity === "hourly") return UTC_HOUR.format(start);
  if (granularity === "monthly") return UTC_MONTH.format(start);
  return UTC_DAY.format(start);
}

export function formatUtcInstant(iso: string): string {
  return `${iso
    .replace("T", " ")
    .replace(/\.\d+Z$/, "Z")
    .replace(/Z$/, " UTC")}`;
}

export function secondsToHours(value: string): number {
  return Number(value) / 3600;
}

export function bytesToGb(value: string): number {
  return Number(value) / 1e9;
}
