import pLimit from "p-limit";
import type { CurrentSnapshotSource, ProjectCurrentSnapshot } from "./consumption-source.js";
import { type SourceErrorDetail, toSourceErrorDetail } from "./errors.js";
import type { OperationContext } from "./operation-context.js";
import { isCancellationFailure, throwIfAborted } from "./operation-context.js";
import { isIntegrityFailure } from "./report-support.js";

/**
 * Read-only inspection of Neon's native controls. Spending notifications are
 * alert-only thresholds (projects keep running and charges continue); project
 * quotas are hard cumulative limits that suspend computes for the rest of the
 * billing period. They are separate domain concepts and never merge.
 */

export type SpendingNotificationReading =
  | { status: "configured"; spendingLimitCents: string; semantics: "alert_only" }
  | { status: "not_configured"; semantics: "alert_only" }
  | { status: "unavailable"; detail: SourceErrorDetail };

/**
 * True when the spending notification could not be inspected for a reason other
 * than the plan not supporting it. HTTP 422 is the Free/Launch "no spending
 * limits" answer — a plan fact, not a gap. Anything else (auth, transport, 5xx)
 * is a real hole in the controls view, so coverage must not read "complete".
 */
function spendingNotificationGap(reading: SpendingNotificationReading): boolean {
  return reading.status === "unavailable" && reading.detail.status !== 422;
}

/**
 * Zero or absent means unlimited. Per Neon's consumption-limits docs
 * (https://neon.com/docs/guides/consumption-limits#corresponding-quotas):
 * activeTimeSeconds, computeTimeSeconds, writtenDataBytes, and dataTransferBytes
 * are cumulative per billing period — exhausting one suspends the project's
 * computes until the period ends (the `enforcement` field). logicalSizeBytes is
 * different: a persistent per-branch size ceiling that suspends only the
 * offending branch and does not reset monthly.
 */
export type ProjectQuotaReading = {
  projectId: string;
  consumptionPeriodEnd: string | null;
  quota: {
    activeTimeSeconds: string | null;
    computeTimeSeconds: string | null;
    writtenDataBytes: string | null;
    dataTransferBytes: string | null;
    logicalSizeBytes: string | null;
  };
  /** Enforcement of the four cumulative quotas above. */
  enforcement: "suspend_computes_until_period_end";
  /** Enforcement of logicalSizeBytes: branch-scoped, persistent (no monthly
   * reset), suspends only the affected branch. */
  logicalSizeEnforcement: "suspend_affected_branch_persistent";
};

export interface ControlsSource {
  getSpendingNotification(
    organizationId: string,
    context?: OperationContext,
  ): Promise<SpendingNotificationReading>;
  getProjectQuota(projectId: string, context?: OperationContext): Promise<ProjectQuotaReading>;
}

export type ControlsInspection = {
  schemaVersion: 1;
  kind: "controls_inspection";
  readOnly: true;
  generatedAt: string;
  organizationId: string;
  spendingNotification: SpendingNotificationReading;
  coverage: {
    status: "complete" | "partial";
    projectsRequested: number;
    projectsReturned: number;
    errors: Array<{ projectId: string; message: string; detail?: SourceErrorDetail }>;
  };
  projects: ProjectQuotaReading[];
};

export interface ControlsService {
  organizationControls(
    organizationId: string,
    projectIds: string[],
    context?: OperationContext,
  ): Promise<ControlsInspection>;
}

export function createControlsService(
  source: ControlsSource,
  options: { concurrency?: number; maxProjects?: number; now?: () => Date } = {},
): ControlsService {
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
    async organizationControls(organizationId, projectIds, context) {
      throwIfAborted(context);
      // An empty organization yields an empty report; only excess is refused.
      const requested = [...new Set(projectIds)];
      if (requested.length > maxProjects) {
        throw new RangeError(`controls must request at most ${maxProjects} unique projects`);
      }
      const spendingNotification = await source.getSpendingNotification(organizationId, context);
      const errors: ControlsInspection["coverage"]["errors"] = [];
      const readings = await Promise.all(
        requested.map((projectId) =>
          limit(async () => {
            throwIfAborted(context);
            try {
              return await source.getProjectQuota(projectId, context);
            } catch (error) {
              throwIfAborted(context);
              if (isIntegrityFailure(error) || isCancellationFailure(error)) throw error;
              const detail = toSourceErrorDetail(error);
              errors.push({ projectId, message: detail.message, detail });
              return null;
            }
          }),
        ),
      );
      const projects = readings.filter((reading) => reading !== null);
      return {
        schemaVersion: 1,
        kind: "controls_inspection",
        readOnly: true,
        generatedAt: (options.now?.() ?? new Date()).toISOString(),
        organizationId,
        spendingNotification,
        coverage: {
          status:
            errors.length === 0 && !spendingNotificationGap(spendingNotification)
              ? "complete"
              : "partial",
          projectsRequested: requested.length,
          projectsReturned: projects.length,
          errors,
        },
        projects,
      };
    },
  };
}

export type QuotaUtilizationMetric = {
  used: string;
  limit: string | null;
  /** Percentage of the limit consumed, two decimals; null when unlimited. */
  percentUsed: string | null;
  /** True when `used` is only a lower bound because a contributing value was
   * unknown (e.g. a branch reported without a computed logical_size); the real
   * usage — and percentUsed — could be higher. */
  usedIsLowerBound?: boolean;
};

export type ProjectQuotaUtilization = {
  projectId: string;
  periodEnd: string | null;
  metrics: {
    activeTimeSeconds: QuotaUtilizationMetric;
    computeTimeSeconds: QuotaUtilizationMetric;
    writtenDataBytes: QuotaUtilizationMetric;
    dataTransferBytes: QuotaUtilizationMetric;
    /** logical_size_bytes is a per-branch ceiling; used is the largest branch. */
    largestBranchLogicalSizeBytes: QuotaUtilizationMetric;
  };
};

export type QuotaUtilizationReport = {
  schemaVersion: 1;
  kind: "quota_utilization";
  readOnly: true;
  generatedAt: string;
  organizationId: string;
  spendingNotification: SpendingNotificationReading;
  coverage: ControlsInspection["coverage"];
  projects: ProjectQuotaUtilization[];
};

function utilizationMetric(
  used: bigint,
  limit: string | null,
  usedIsLowerBound = false,
): QuotaUtilizationMetric {
  const lowerBound = usedIsLowerBound ? { usedIsLowerBound: true as const } : {};
  if (limit === null)
    return { used: used.toString(), limit: null, percentUsed: null, ...lowerBound };
  const limitValue = BigInt(limit);
  const basisPoints = limitValue === 0n ? 0n : (used * 10000n) / limitValue;
  // Format the two decimals from the bigint directly; Number(basisPoints) would
  // lose precision on extreme (40-digit) counters.
  const whole = basisPoints / 100n;
  const cents = (basisPoints % 100n).toString().padStart(2, "0");
  return { used: used.toString(), limit, percentUsed: `${whole}.${cents}`, ...lowerBound };
}

export interface QuotaUtilizationService {
  organizationUtilization(
    organizationId: string,
    projectIds: string[],
    context?: OperationContext,
  ): Promise<QuotaUtilizationReport>;
}

/** Quota limits and current-period usage read from a single project-record fetch. */
export type ProjectQuotaSnapshotReading = {
  quota: ProjectQuotaReading;
  snapshot: ProjectCurrentSnapshot;
};

export interface ProjectRecordSource {
  getProjectQuotaSnapshot(
    projectId: string,
    context?: OperationContext,
  ): Promise<ProjectQuotaSnapshotReading>;
}

/**
 * The source surface the utilization report needs: the org spending threshold,
 * a combined quota+usage read per project (one HTTP call, not two), and branch
 * sizes for the logical-size ceiling.
 */
export type QuotaUtilizationSource = Pick<ControlsSource, "getSpendingNotification"> &
  ProjectRecordSource &
  Pick<CurrentSnapshotSource, "listBranchSizes">;

/**
 * Joins configured quota limits with current-period usage of the same metric
 * family. Quotas and usage snapshots come from the same project record
 * family, so "62% of compute quota used" is a like-for-like comparison;
 * logical size compares the per-branch ceiling against the largest branch.
 */
export function createQuotaUtilizationService(
  source: QuotaUtilizationSource,
  options: { concurrency?: number; maxProjects?: number; now?: () => Date } = {},
): QuotaUtilizationService {
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
    async organizationUtilization(organizationId, projectIds, context) {
      throwIfAborted(context);
      // An empty organization yields an empty report; only excess is refused.
      const requested = [...new Set(projectIds)];
      if (requested.length > maxProjects) {
        throw new RangeError(
          `quota utilization must request at most ${maxProjects} unique projects`,
        );
      }
      const spendingNotification = await source.getSpendingNotification(organizationId, context);
      const errors: QuotaUtilizationReport["coverage"]["errors"] = [];
      const projects = (
        await Promise.all(
          requested.map((projectId) =>
            limit(async (): Promise<ProjectQuotaUtilization | null> => {
              throwIfAborted(context);
              try {
                // One project-record fetch (quota + usage), plus branch sizes.
                const [{ quota, snapshot }, branches] = await Promise.all([
                  source.getProjectQuotaSnapshot(projectId, context),
                  source.listBranchSizes(projectId, context),
                ]);
                const largestBranch = branches.branches.reduce(
                  (largest, branch) =>
                    branch.logicalSizeBytes !== null && BigInt(branch.logicalSizeBytes) > largest
                      ? BigInt(branch.logicalSizeBytes)
                      : largest,
                  0n,
                );
                // If any branch omits its logical_size — or none were reported
                // at all (every project has at least a root branch) — the true
                // largest branch could exceed the known maximum; the percentage
                // is only a lower bound and must not read as safe headroom.
                const branchSizeUnknown =
                  branches.branches.length === 0 ||
                  branches.branches.some((branch) => branch.logicalSizeBytes === null);
                return {
                  projectId,
                  periodEnd: quota.consumptionPeriodEnd,
                  metrics: {
                    activeTimeSeconds: utilizationMetric(
                      BigInt(snapshot.activeTimeSeconds),
                      quota.quota.activeTimeSeconds,
                    ),
                    computeTimeSeconds: utilizationMetric(
                      BigInt(snapshot.computeTimeSeconds),
                      quota.quota.computeTimeSeconds,
                    ),
                    writtenDataBytes: utilizationMetric(
                      BigInt(snapshot.writtenDataBytes),
                      quota.quota.writtenDataBytes,
                    ),
                    dataTransferBytes: utilizationMetric(
                      BigInt(snapshot.dataTransferBytes),
                      quota.quota.dataTransferBytes,
                    ),
                    largestBranchLogicalSizeBytes: utilizationMetric(
                      largestBranch,
                      quota.quota.logicalSizeBytes,
                      branchSizeUnknown,
                    ),
                  },
                };
              } catch (error) {
                throwIfAborted(context);
                if (isIntegrityFailure(error) || isCancellationFailure(error)) throw error;
                const detail = toSourceErrorDetail(error);
                errors.push({ projectId, message: detail.message, detail });
                return null;
              }
            }),
          ),
        )
      ).filter((project) => project !== null);
      return {
        schemaVersion: 1,
        kind: "quota_utilization",
        readOnly: true,
        generatedAt: (options.now?.() ?? new Date()).toISOString(),
        organizationId,
        spendingNotification,
        coverage: {
          status:
            errors.length === 0 && !spendingNotificationGap(spendingNotification)
              ? "complete"
              : "partial",
          projectsRequested: requested.length,
          projectsReturned: projects.length,
          errors,
        },
        projects,
      };
    },
  };
}
