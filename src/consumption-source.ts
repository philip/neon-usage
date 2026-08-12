import type { BranchReportQuery, ProjectReportQuery } from "./consumption-query.js";
import type { OperationContext } from "./operation-context.js";

export type EvidenceRef = {
  evidenceId: string;
  payloadHash: string;
};

export type FactEvidenceRef = {
  evidenceId?: string;
  payloadHash: string;
  sourcePath: string;
};

export type SourceMetric = {
  name: string;
  value: string;
  evidence: FactEvidenceRef;
};

export type SourceBucket = {
  start: string;
  end: string;
  metrics: SourceMetric[];
};

export type SourcePeriod = {
  id: string;
  plan: string;
  start: string;
  end?: string;
  buckets: SourceBucket[];
};

export type SourceProjectConsumption = {
  projectId: string;
  periods: SourcePeriod[];
};

export type SourceBranchConsumption = {
  projectId: string;
  branchId: string;
  periods: SourcePeriod[];
};

export type ProjectConsumptionPage = {
  projects: SourceProjectConsumption[];
  nextCursor: string | null;
  /** Exact response-body bytes observed by the built-in transport. */
  responseBytes?: number;
  requestId?: string;
  evidence?: EvidenceRef;
};

export type BranchConsumptionPage = {
  branches: SourceBranchConsumption[];
  nextCursor: string | null;
  /** Exact response-body bytes observed by the built-in transport. */
  responseBytes?: number;
  requestId?: string;
  evidence?: EvidenceRef;
};

export interface ProjectConsumptionSource {
  getProjectPage(
    query: ProjectReportQuery,
    cursor: string | null,
    context?: OperationContext,
  ): Promise<ProjectConsumptionPage>;
}

export interface BranchConsumptionSource {
  getBranchPage(
    query: BranchReportQuery,
    cursor: string | null,
    context?: OperationContext,
  ): Promise<BranchConsumptionPage>;
}

export type HistoryProbeResult = "available" | "forbidden" | "temporarily_unavailable";

export interface OrganizationSource {
  getOrganization(
    organizationId: string,
    context?: OperationContext,
  ): Promise<{ id: string; plan: string }>;
  probeProjectHistory(
    organizationId: string,
    context?: OperationContext,
  ): Promise<HistoryProbeResult>;
}

export type NeonOrganization = {
  id: string;
  name: string;
  handle: string;
  plan: string;
};

export type DirectoryQualityFlag = "CURSOR_REPEATED";

export interface OrganizationDirectorySource {
  listOrganizations(context?: OperationContext): Promise<NeonOrganization[]>;
  listProjectDirectory(
    organizationId: string,
    context?: OperationContext,
  ): Promise<{
    projects: Array<{ id: string; name: string }>;
    unavailableProjectIds: string[];
    qualityFlags?: DirectoryQualityFlag[];
    evidence?: EvidenceRef[];
  }>;
}

export type ProjectCurrentSnapshot = {
  projectId: string;
  periodStart: string;
  periodEnd: string;
  activeTimeSeconds: string;
  computeTimeSeconds: string;
  writtenDataBytes: string;
  dataTransferBytes: string;
  /**
   * Legacy field observed unpopulated (always "0") as of 2026-08-10; kept
   * because it is the wire truth, but branch logical sizes are the live
   * storage signal for current-period views.
   */
  dataStorageByteHours: string;
  evidence?: EvidenceRef;
  metricEvidence: Record<
    | "activeTimeSeconds"
    | "computeTimeSeconds"
    | "writtenDataBytes"
    | "dataTransferBytes"
    | "dataStorageByteHours",
    FactEvidenceRef
  >;
};

export type BranchSizeSnapshot = {
  branchId: string;
  /** Observed display name; enrichment only — the ID is the key. */
  name?: string;
  /**
   * Null when the provider reports the branch without a computed logical
   * size (live-validated: fresh branches omit logical_size). An explicit
   * unknown, not an error.
   */
  logicalSizeBytes: string | null;
  evidence: FactEvidenceRef;
};

export type BranchSizeCollection = {
  branches: BranchSizeSnapshot[];
  evidence?: EvidenceRef[];
};

export interface CurrentSnapshotSource {
  listProjects(
    organizationId: string,
    context?: OperationContext,
  ): Promise<{
    projectIds: string[];
    unavailableProjectIds: string[];
    qualityFlags?: DirectoryQualityFlag[];
    evidence?: EvidenceRef[];
  }>;
  getProjectSnapshot(
    projectId: string,
    context?: OperationContext,
  ): Promise<ProjectCurrentSnapshot>;
  listBranchSizes(projectId: string, context?: OperationContext): Promise<BranchSizeCollection>;
}
