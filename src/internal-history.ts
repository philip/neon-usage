import type { CollectionControl, ReportDependencies } from "./adapter-support.js";
import type { ProjectReportQuery } from "./consumption-query.js";
import type {
  ConsumptionService,
  OrganizationConsumptionSummary,
  ProjectConsumptionReport,
} from "./history-report.js";
import type { OperationContext } from "./operation-context.js";

export type HistoryMetricSelectionMode = "default" | "explicit";

export type OrganizationHistoryResult = {
  summary: OrganizationConsumptionSummary;
  projectReport: ProjectConsumptionReport;
  metricSelectionMode: HistoryMetricSelectionMode;
};

export type OrganizationHistoryService = ConsumptionService & {
  organizationHistory(
    query: ProjectReportQuery,
    context?: OperationContext,
    metricSelectionMode?: HistoryMetricSelectionMode,
  ): Promise<OrganizationHistoryResult>;
};

export type InternalReportDependencies = ReportDependencies & {
  currentExport?: ReportDependencies["currentReport"];
  organizationHistory?(
    query: ProjectReportQuery,
    control?: CollectionControl,
    context?: OperationContext,
    metricSelectionMode?: HistoryMetricSelectionMode,
  ): Promise<OrganizationHistoryResult>;
};
