import {
  branchConsumptionMetrics,
  type HistoryBranchMetricName,
  type HistoryProjectMetricName,
  type KnownMetricName,
  metricDefinitions,
  projectConsumptionMetrics,
} from "./metric-definitions.js";

const knownMetrics = Object.keys(metricDefinitions) as KnownMetricName[];

const projectHistoryContract = Object.freeze({
  sourceContract: "consumption-history-v2-projects" as const,
  endpoint: "/consumption_history/v2/projects" as const,
  pageSize: 100,
  beta: false as const,
  metrics: projectConsumptionMetrics,
  supportedMetrics: Object.freeze(
    knownMetrics.filter((name): name is HistoryProjectMetricName =>
      metricDefinitions[name].endpoints.some((endpoint) => endpoint === "history_project"),
    ),
  ),
});

const branchHistoryContract = Object.freeze({
  sourceContract: "consumption-history-v2-branches" as const,
  endpoint: "/consumption_history/v2/branches" as const,
  pageSize: 1000,
  beta: true as const,
  historicalCoverage: "unverified" as const,
  qualityFlags: Object.freeze([
    "BETA_SOURCE" as const,
    "BRANCH_HISTORY_COVERAGE_UNVERIFIED" as const,
  ]),
  metrics: branchConsumptionMetrics,
  supportedMetrics: Object.freeze(
    knownMetrics.filter((name): name is HistoryBranchMetricName =>
      metricDefinitions[name].endpoints.some((endpoint) => endpoint === "history_branch"),
    ),
  ),
});

export const historyContracts = Object.freeze({
  project: projectHistoryContract,
  branch: branchHistoryContract,
});

export type HistoryContract = (typeof historyContracts)[keyof typeof historyContracts];
