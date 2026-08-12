import { branchConsumptionMetrics, projectConsumptionMetrics } from "./metric-catalog.js";

const projectHistoryContract = Object.freeze({
  sourceContract: "consumption-history-v2-projects" as const,
  endpoint: "/consumption_history/v2/projects" as const,
  pageSize: 100,
  beta: false as const,
  metrics: projectConsumptionMetrics,
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
});

export const historyContracts = Object.freeze({
  project: projectHistoryContract,
  branch: branchHistoryContract,
});

export type HistoryContract = (typeof historyContracts)[keyof typeof historyContracts];
