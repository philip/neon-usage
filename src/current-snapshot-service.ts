import pLimit from "p-limit";
import type {
  BranchSizeSnapshot,
  CurrentSnapshotSource,
  EvidenceRef,
  ProjectCurrentSnapshot,
} from "./consumption-source.js";
import {
  ConsumptionSourceIntegrityError,
  type SourceErrorDetail,
  toSourceErrorDetail,
} from "./errors.js";
import type { OperationContext } from "./operation-context.js";
import { isCancellationFailure, throwIfAborted } from "./operation-context.js";
import { canonicalEvidenceReferences, isIntegrityFailure } from "./report-support.js";

export type CurrentSnapshotError = {
  /** Null for organization-level inventory failures that no single project owns. */
  projectId: string | null;
  source: "project_list" | "project_snapshot" | "branch_sizes";
  message: string;
  detail?: SourceErrorDetail;
};

export type CurrentPeriodSnapshotReport = {
  schemaVersion: 1;
  kind: "current_period_snapshot";
  historical: false;
  generatedAt: string;
  organizationId: string;
  coverage: {
    status: "complete" | "partial";
    projectsRequested: number;
    projectsReturned: number;
    errors: CurrentSnapshotError[];
  };
  evidence?: EvidenceRef[];
  projects: Array<{
    projectId: string;
    period: { start: string; end: string };
    metrics: {
      activeTimeSeconds: string;
      computeTimeSeconds: string;
      writtenDataBytes: string;
      dataTransferBytes: string;
      dataStorageByteHours: string;
    };
    evidence?: EvidenceRef;
    metricEvidence: ProjectCurrentSnapshot["metricEvidence"];
    branchStorage:
      | {
          status: "available";
          /** Null when at least one branch size is unknown. */
          totalLogicalSizeBytes: string | null;
          branches: BranchSizeSnapshot[];
          evidence?: EvidenceRef[];
        }
      | { status: "unavailable"; totalLogicalSizeBytes: null; branches: [] };
  }>;
};

export interface CurrentSnapshotService {
  organizationReport(
    organizationId: string,
    context?: OperationContext,
    scope?: {
      /**
       * Snapshot only these projects. The inventory walk still runs (it is
       * the cheap part); the per-project snapshot and branch-size fan-out —
       * one request each — is what scoping bounds. Requested projects
       * missing from the inventory are reported as coverage errors.
       */
      projectIds?: string[];
    },
  ): Promise<CurrentPeriodSnapshotReport>;
}

export function createCurrentSnapshotService(
  source: CurrentSnapshotSource,
  options: { concurrency?: number; maxProjects?: number; now?: () => Date } = {},
): CurrentSnapshotService {
  const concurrency = options.concurrency ?? 5;
  const maxProjects = options.maxProjects ?? 100;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 100) {
    throw new RangeError("concurrency must be an integer between 1 and 100");
  }
  if (!Number.isInteger(maxProjects) || maxProjects < 1 || maxProjects > 10_000) {
    throw new RangeError("maxProjects must be an integer between 1 and 10000");
  }
  const limit = pLimit(concurrency);
  return {
    async organizationReport(
      organizationId: string,
      context?: OperationContext,
      scope?: { projectIds?: string[] },
    ) {
      throwIfAborted(context);
      const requested = scope?.projectIds ? [...new Set(scope.projectIds)] : null;
      if (requested && requested.length === 0) {
        throw new Error("Current snapshot projectIds scope must name at least one project");
      }
      const inventory = await source.listProjects(organizationId, context);
      throwIfAborted(context);
      const requestedSet = requested ? new Set(requested) : null;
      const walkProjectIds = requestedSet
        ? inventory.projectIds.filter((projectId) => requestedSet.has(projectId))
        : inventory.projectIds;
      const unavailableProjectIds = requestedSet
        ? inventory.unavailableProjectIds.filter((projectId) => requestedSet.has(projectId))
        : inventory.unavailableProjectIds;
      const projectsKnown = requested
        ? requested.length
        : inventory.projectIds.length + inventory.unavailableProjectIds.length;
      if (projectsKnown > maxProjects) {
        throw new Error(
          `Current snapshot report found ${projectsKnown} projects; maximum is ${maxProjects}`,
        );
      }
      const errors: CurrentSnapshotError[] = unavailableProjectIds.map((projectId) => ({
        projectId,
        source: "project_list",
        message: "Project details were unavailable during project inventory",
        detail: {
          code: "PROJECT_INVENTORY_UNAVAILABLE",
          message: "Project details were unavailable during project inventory",
        },
      }));
      if (requestedSet) {
        const known = new Set([...inventory.projectIds, ...inventory.unavailableProjectIds]);
        for (const projectId of requested ?? []) {
          if (known.has(projectId)) continue;
          errors.push({
            projectId,
            source: "project_list",
            message: "Requested project is not in the organization inventory",
            detail: {
              code: "PROJECT_NOT_IN_INVENTORY",
              message: "Requested project is not in the organization inventory",
            },
          });
        }
      }
      if (inventory.qualityFlags?.includes("CURSOR_REPEATED")) {
        errors.push({
          projectId: null,
          source: "project_list",
          message:
            "Project inventory pagination repeated a cursor; the inventory may be incomplete",
          detail: {
            code: "PROJECT_INVENTORY_TRUNCATED",
            message:
              "Project inventory pagination repeated a cursor; the inventory may be incomplete",
          },
        });
      }
      const projectResults = await Promise.all(
        walkProjectIds.map((projectId) =>
          limit(async () => {
            throwIfAborted(context);
            let snapshot: ProjectCurrentSnapshot;
            try {
              snapshot = await source.getProjectSnapshot(projectId, context);
              if (snapshot.projectId !== projectId) {
                throw new ConsumptionSourceIntegrityError(
                  `Project snapshot returned ${snapshot.projectId} for requested project ${projectId}`,
                );
              }
            } catch (error) {
              throwIfAborted(context);
              if (isIntegrityFailure(error) || isCancellationFailure(error)) throw error;
              const detail = toSourceErrorDetail(error);
              errors.push({
                projectId,
                source: "project_snapshot",
                message: detail.message,
                detail,
              });
              return null;
            }
            let branchStorage:
              | {
                  status: "available";
                  totalLogicalSizeBytes: string | null;
                  branches: BranchSizeSnapshot[];
                  evidence?: EvidenceRef[];
                }
              | { status: "unavailable"; totalLogicalSizeBytes: null; branches: [] };
            try {
              throwIfAborted(context);
              const branchCollection = await source.listBranchSizes(projectId, context);
              const branches = branchCollection.branches;
              // A total over partially unknown sizes would understate storage;
              // it is only available when every branch reports a size.
              const allKnown = branches.every((branch) => branch.logicalSizeBytes !== null);
              branchStorage = {
                status: "available",
                totalLogicalSizeBytes: allKnown
                  ? branches
                      .reduce((total, branch) => total + BigInt(branch.logicalSizeBytes ?? "0"), 0n)
                      .toString()
                  : null,
                branches,
                ...(branchCollection.evidence ? { evidence: branchCollection.evidence } : {}),
              };
            } catch (error) {
              throwIfAborted(context);
              if (isIntegrityFailure(error) || isCancellationFailure(error)) throw error;
              const detail = toSourceErrorDetail(error);
              errors.push({
                projectId,
                source: "branch_sizes",
                message: detail.message,
                detail,
              });
              branchStorage = { status: "unavailable", totalLogicalSizeBytes: null, branches: [] };
            }

            return {
              projectId,
              period: { start: snapshot.periodStart, end: snapshot.periodEnd },
              metrics: {
                activeTimeSeconds: snapshot.activeTimeSeconds,
                computeTimeSeconds: snapshot.computeTimeSeconds,
                writtenDataBytes: snapshot.writtenDataBytes,
                dataTransferBytes: snapshot.dataTransferBytes,
                dataStorageByteHours: snapshot.dataStorageByteHours,
              },
              ...(snapshot.evidence ? { evidence: snapshot.evidence } : {}),
              metricEvidence: snapshot.metricEvidence,
              branchStorage,
            };
          }),
        ),
      );
      const projects = projectResults.filter((project) => project !== null);
      const orderedProjectIds = [
        ...new Set([...walkProjectIds, ...unavailableProjectIds, ...(requested ?? [])]),
      ];
      const projectOrder = new Map(
        orderedProjectIds.map((projectId, index) => [projectId, index] as const),
      );
      const sourceOrder = { project_list: 0, project_snapshot: 1, branch_sizes: 2 } as const;
      const errorOrder = (error: CurrentSnapshotError): number =>
        error.projectId === null
          ? -1
          : (projectOrder.get(error.projectId) ?? Number.MAX_SAFE_INTEGER);
      errors.sort(
        (left, right) =>
          errorOrder(left) - errorOrder(right) ||
          sourceOrder[left.source] - sourceOrder[right.source],
      );
      const evidence = [
        ...(inventory.evidence ?? []),
        ...projects.flatMap((project) => [
          ...(project.evidence ? [project.evidence] : []),
          ...(project.branchStorage.status === "available"
            ? (project.branchStorage.evidence ?? [])
            : []),
          ...project.branchStorage.branches.flatMap((branch) =>
            branch.evidence?.evidenceId
              ? [
                  {
                    evidenceId: branch.evidence.evidenceId,
                    payloadHash: branch.evidence.payloadHash,
                  },
                ]
              : [],
          ),
        ]),
      ];
      const uniqueEvidence = canonicalEvidenceReferences(evidence);

      return {
        schemaVersion: 1 as const,
        kind: "current_period_snapshot" as const,
        historical: false as const,
        generatedAt: (options.now?.() ?? new Date()).toISOString(),
        organizationId,
        coverage: {
          status: errors.length === 0 ? ("complete" as const) : ("partial" as const),
          projectsRequested: projectsKnown,
          projectsReturned: projects.length,
          errors,
        },
        ...(uniqueEvidence.length > 0 ? { evidence: uniqueEvidence } : {}),
        projects,
      };
    },
  };
}
