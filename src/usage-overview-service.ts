import type { Granularity, ProjectReportQuery } from "./consumption-query.js";
import type {
  OrganizationDirectorySource,
  ProjectConsumptionPage,
  ProjectConsumptionSource,
} from "./consumption-source.js";
import type { SourceErrorDetail } from "./errors.js";
import {
  createConsumptionService,
  type HistoryServiceOptions,
  type OrganizationConsumptionSummary,
} from "./history-report.js";
import { deriveBillingValue } from "./metric-catalog.js";
import type { OperationContext } from "./operation-context.js";
import { isCancellationFailure, throwIfAborted } from "./operation-context.js";
import { isIntegrityFailure } from "./report-support.js";

export type UsageOverview = {
  schemaVersion: 1;
  kind: "usage_overview";
  generatedAt: string;
  asOf: string;
  organization: { id: string; name: string | null; plan: string | null };
  effectiveRange: { from: string; to: string; granularity: Granularity };
  coverage: {
    status: "complete" | "partial";
    pageCount: number;
    entityCount: number;
    qualityFlags: string[];
    requestIds?: string[];
    errors?: string[];
    errorDetails?: SourceErrorDetail[];
  };
  /** Present when leading buckets were served from the local store. */
  servedFromStore?: { from: string; to: string; collectedAt: string };
  totals: OrganizationConsumptionSummary["metrics"];
  activeProjects: Array<{
    projectId: string;
    name: string | null;
    metrics: Array<{
      name: string;
      rawValue: string;
      rawUnit: string;
      displayValue: string;
      displayUnit: string;
    }>;
  }>;
  observedProjectCount: number;
  unavailableProjectIds: string[];
  enrichmentWarnings: string[];
};

export interface UsageOverviewService {
  overview(query: ProjectReportQuery, context?: OperationContext): Promise<UsageOverview>;
}

export function createUsageOverviewService(
  source: ProjectConsumptionSource & OrganizationDirectorySource,
  options: HistoryServiceOptions<ProjectConsumptionPage> = {},
): UsageOverviewService {
  const consumption = createConsumptionService(source, options);
  return {
    async overview(query: ProjectReportQuery, context?: OperationContext): Promise<UsageOverview> {
      const summary = await consumption.organizationSummary(query, context);
      const [directoryResult, organizationsResult] = await Promise.allSettled([
        source.listProjectDirectory(query.organizationId, context),
        source.listOrganizations(context),
      ]);
      throwIfAborted(context);
      for (const result of [directoryResult, organizationsResult]) {
        if (
          result.status === "rejected" &&
          (isIntegrityFailure(result.reason) || isCancellationFailure(result.reason))
        ) {
          throw result.reason;
        }
      }
      const directory =
        directoryResult.status === "fulfilled"
          ? directoryResult.value
          : { projects: [], unavailableProjectIds: [] };
      const organizations =
        organizationsResult.status === "fulfilled" ? organizationsResult.value : [];
      const enrichmentWarnings = [
        ...(directoryResult.status === "rejected" ? ["PROJECT_NAMES_UNAVAILABLE"] : []),
        ...(directoryResult.status === "fulfilled" &&
        directoryResult.value.qualityFlags?.includes("CURSOR_REPEATED")
          ? ["PROJECT_DIRECTORY_TRUNCATED"]
          : []),
        ...(organizationsResult.status === "rejected" ? ["ORGANIZATION_METADATA_UNAVAILABLE"] : []),
      ];
      const projectNames = new Map(directory.projects.map((project) => [project.id, project.name]));
      const activeProjects: UsageOverview["activeProjects"] = [];
      for (const project of summary.attribution.projects) {
        const totals = new Map<string, { value: bigint; unit: string }>();
        for (const period of project.periods) {
          for (const bucket of period.buckets) {
            for (const metric of bucket.metrics) {
              if (metric.value === null || !query.metrics.includes(metric.name)) continue;
              const previous = totals.get(metric.name);
              totals.set(metric.name, {
                value: (previous?.value ?? 0n) + BigInt(metric.value),
                unit: metric.rawUnit,
              });
            }
          }
        }
        const metrics = [...totals]
          .filter(([, metric]) => metric.value !== 0n)
          .map(([name, metric]) => {
            const rawValue = metric.value.toString();
            const derived = deriveBillingValue(name, rawValue);
            return {
              name,
              rawValue,
              rawUnit: metric.unit,
              displayValue: derived.decimalApproximation,
              displayUnit: derived.unit,
            };
          });
        if (metrics.length > 0) {
          activeProjects.push({
            projectId: project.projectId,
            name: projectNames.get(project.projectId) ?? null,
            metrics,
          });
        }
      }
      const organization = organizations.find((item) => item.id === query.organizationId);
      return {
        schemaVersion: 1,
        kind: "usage_overview",
        generatedAt: summary.generatedAt,
        asOf: summary.asOf,
        organization: organization
          ? { id: organization.id, name: organization.name, plan: organization.plan }
          : { id: query.organizationId, name: null, plan: null },
        effectiveRange: summary.effectiveRange,
        coverage: summary.coverage,
        ...(summary.servedFromStore ? { servedFromStore: summary.servedFromStore } : {}),
        totals: summary.metrics,
        activeProjects,
        observedProjectCount: summary.attribution.projects.length,
        unavailableProjectIds: directory.unavailableProjectIds,
        enrichmentWarnings,
      };
    },
  };
}
