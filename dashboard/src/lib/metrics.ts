import { METRICS, type MetricInfo } from "../../../src/metric-presentation.js";

export type { MetricInfo } from "../../../src/metric-presentation.js";
export { CHART_GROUPS, METRICS } from "../../../src/metric-presentation.js";

export function metricInfo(name: string): MetricInfo {
  return (
    (Object.hasOwn(METRICS, name) ? METRICS[name] : undefined) ?? {
      label: name,
      unit: "",
      divisor: 1,
    }
  );
}

const NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const TABLE_INTEGER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const TABLE_TENTHS = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const TABLE_HUNDREDTHS = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const COMPACT_TABLE_NUMBER = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function formatQuantity(value: number): string {
  return NUMBER.format(value);
}

export function formatCompactQuantity(value: number): string {
  const magnitude = Math.abs(value);
  if (magnitude >= 10_000) return COMPACT_TABLE_NUMBER.format(value);
  if (magnitude >= 1000) return TABLE_INTEGER.format(value);
  if (magnitude >= 100) return TABLE_TENTHS.format(value);
  return TABLE_HUNDREDTHS.format(value);
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
