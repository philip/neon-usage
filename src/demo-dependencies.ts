// Demo composition root: a deterministic synthetic Neon source wired through
// the REAL services — the same collection, validation, projection, and
// estimation pipeline production uses, so every report has genuine shape and
// honest coverage. Nothing here reads a credential, touches the network, or
// opens a store; the fictional organization exists only in this module.
//
// Used by `neon-usage dashboard --demo`: try the dashboard without a Neon
// account, or capture screenshots with zero real account data on screen.

import { createHash } from "node:crypto";
import type { ReportDependencies } from "./adapter-support.js";
import { createCapabilityService } from "./capability-service.js";
import type { ProjectReportQuery } from "./consumption-query.js";
import type {
  BranchSizeCollection,
  CurrentSnapshotSource,
  EvidenceRef,
  ProjectConsumptionPage,
  ProjectCurrentSnapshot,
  SourcePeriod,
} from "./consumption-source.js";
import type { ControlsSource, ProjectQuotaSnapshotReading } from "./controls-service.js";
import { createControlsService, createQuotaUtilizationService } from "./controls-service.js";
import { createCurrentSnapshotService } from "./current-snapshot-service.js";
import { createConsumptionService } from "./history-report.js";
import { estimateProjectCosts } from "./pricing-estimate.js";
import { neonDocumentationRateCard } from "./rate-card.js";
import { createUsageOverviewService } from "./usage-overview-service.js";

const ORGANIZATION = {
  id: "org-demo-42813975",
  name: "Acme Cloud",
  handle: "acme-cloud",
  plan: "launch",
};

type DemoProject = {
  id: string;
  name: string;
  /** Per-day baselines the deterministic jitter modulates. */
  cuSecondsPerDay: number;
  logicalGb: number;
  egressBytesPerDay: number;
  branchHoursPerDay: number;
};

const DEMO_PROJECTS: DemoProject[] = [
  {
    id: "api-production-11837462",
    name: "api-production",
    cuSecondsPerDay: 82_000,
    logicalGb: 14,
    // ~56.5 GB/day: ≈621 GB by mid-month, deliberately past the Launch
    // plan's 500 GB transfer allowance so the Est. price view shows real
    // overage netting on egress.
    egressBytesPerDay: 5.58e10,
    branchHoursPerDay: 22,
  },
  {
    id: "web-frontend-55118210",
    name: "web-frontend",
    cuSecondsPerDay: 31_000,
    logicalGb: 6,
    egressBytesPerDay: 0.7e9,
    branchHoursPerDay: 8,
  },
  {
    id: "analytics-90315377",
    name: "analytics",
    cuSecondsPerDay: 55_000,
    logicalGb: 22,
    egressBytesPerDay: 0.3e9,
    branchHoursPerDay: 4,
  },
  {
    id: "staging-27604154",
    name: "staging",
    cuSecondsPerDay: 9_000,
    logicalGb: 3,
    egressBytesPerDay: 0.1e9,
    branchHoursPerDay: 30,
  },
  {
    id: "ml-pipeline-68821903",
    name: "ml-pipeline",
    cuSecondsPerDay: 18_000,
    logicalGb: 9,
    egressBytesPerDay: 0.05e9,
    branchHoursPerDay: 0,
  },
];

function firstDemoProject(): DemoProject {
  const first = DEMO_PROJECTS[0];
  if (!first) throw new Error("demo projects must not be empty");
  return first;
}

const DAY_MS = 86_400_000;

/** Deterministic 0.65-1.35 modulation so charts look organic but stable.
 * Seeded by the ABSOLUTE bucket start, so a given date carries the same
 * value in every window that contains it (last=7d vs month=current). */
function jitter(seed: string): number {
  let hash = 2166136261;
  for (const character of seed) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  }
  return 0.65 + ((hash >>> 8) % 1000) * 0.0007;
}

/** Demo mode serves exactly one fictional organization; any other ID is a
 * caller error, never silently answered with Acme Cloud data. */
function assertDemoOrganization(organizationId: string): void {
  if (organizationId !== ORGANIZATION.id) {
    throw new Error(
      `demo mode serves only the fictional organization ${ORGANIZATION.id} (requested ${organizationId})`,
    );
  }
}

function bucketBounds(query: ProjectReportQuery): Array<[string, string]> {
  const bounds: Array<[string, string]> = [];
  const cursor = new Date(query.from);
  const end = new Date(query.to).getTime();
  while (cursor.getTime() < end) {
    const start = cursor.toISOString();
    if (query.granularity === "hourly") cursor.setUTCHours(cursor.getUTCHours() + 1);
    else if (query.granularity === "monthly") cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    else cursor.setUTCDate(cursor.getUTCDate() + 1);
    bounds.push([start, new Date(Math.min(cursor.getTime(), end)).toISOString()]);
  }
  return bounds;
}

type BarePeriod = {
  id: string;
  plan: string;
  start: string;
  buckets: Array<{ start: string; end: string; metrics: Array<{ name: string; value: string }> }>;
};

function demoPeriods(project: DemoProject, query: ProjectReportQuery): BarePeriod[] {
  const perDay: Record<string, number> = {
    compute_unit_seconds: project.cuSecondsPerDay,
    root_branch_bytes_month: (project.logicalGb * 1e9) / 31,
    child_branch_bytes_month: (project.logicalGb * 1e8) / 31,
    // Small but nonzero, so the storage composition shows every component
    // and the projection never has to flag projected zeros. Private transfer
    // is an explicit reported zero: private networking is not a Launch-plan
    // feature, and the zero keeps it honestly reported (no projected-zero
    // flag) while the table's nonzero filter hides the empty column.
    instant_restore_bytes_month: (project.logicalGb * 6e7) / 31,
    snapshot_storage_bytes_month: (project.logicalGb * 1.4e8) / 31,
    public_network_transfer_bytes: project.egressBytesPerDay,
    private_network_transfer_bytes: 0,
    extra_branches_month: project.branchHoursPerDay,
  };
  // One period per calendar month, like real monthly billing: a
  // multi-month query must not pool every bucket into one period.
  const byMonth = new Map<string, BarePeriod>();
  for (const [start, end] of bucketBounds(query)) {
    const monthKey = start.slice(0, 7);
    const period = byMonth.get(monthKey) ?? {
      id: `period-${monthKey}`,
      plan: ORGANIZATION.plan,
      start: `${monthKey}-01T00:00:00.000Z`,
      buckets: [],
    };
    byMonth.set(monthKey, period);
    const scale = (new Date(end).getTime() - new Date(start).getTime()) / DAY_MS;
    period.buckets.push({
      start,
      end,
      metrics: query.metrics
        .filter((metric) => metric in perDay)
        .map((metric) => ({
          name: metric,
          value: String(
            Math.round((perDay[metric] ?? 0) * scale * jitter(`${project.id}:${metric}:${start}`)),
          ),
        })),
    });
  }
  return [...byMonth.values()];
}

/** Evidence whose hash verifies the CONTENT it accompanies: the digest is of
 * the bare payload (canonical JSON, evidence fields excluded), so the
 * provenance claim — payloadHash identifies the represented response — holds
 * for synthetic pages exactly as it does for real ones. */
function contentEvidence(label: string, payload: unknown): EvidenceRef {
  return {
    evidenceId: `evidence:demo:${label}`,
    payloadHash: `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`,
  };
}

export function demoProjectPage(query: ProjectReportQuery): ProjectConsumptionPage {
  assertDemoOrganization(query.organizationId);
  const requested = query.projectIds
    ? DEMO_PROJECTS.filter((project) => query.projectIds?.includes(project.id))
    : DEMO_PROJECTS;
  // The bare payload IS the represented response; its digest becomes the
  // page's payloadHash. The evidence ID still covers the full request shape
  // so distinguishable requests never share an identity.
  const payload = requested.map((project) => ({
    projectId: project.id,
    periods: demoPeriods(project, query),
  }));
  const label = [
    query.from,
    query.to,
    query.granularity,
    (query.projectIds ?? ["all"]).join("+"),
    query.metrics.join("+"),
  ].join(":");
  const evidence = contentEvidence(label, payload);
  return {
    projects: payload.map((project) => ({
      projectId: project.projectId,
      periods: project.periods.map((period) => ({
        ...period,
        buckets: period.buckets.map((bucket) => ({
          ...bucket,
          metrics: bucket.metrics.map((metric) => ({
            ...metric,
            evidence: {
              evidenceId: evidence.evidenceId,
              payloadHash: evidence.payloadHash,
              sourcePath: `/projects/${project.projectId}/metrics/${metric.name}`,
            },
          })),
        })),
      })),
    })),
    nextCursor: null,
    requestId: "req-demo",
    evidence,
  };
}

function demoSnapshot(project: DemoProject, generatedAt: Date): ProjectCurrentSnapshot {
  const periodStart = new Date(generatedAt);
  periodStart.setUTCDate(1);
  periodStart.setUTCHours(0, 0, 0, 0);
  const periodEnd = new Date(periodStart);
  periodEnd.setUTCMonth(periodEnd.getUTCMonth() + 1);
  const daysElapsed = Math.max(
    1,
    Math.floor((generatedAt.getTime() - periodStart.getTime()) / DAY_MS),
  );
  const bare = {
    projectId: project.id,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    activeTimeSeconds: String(Math.round(project.cuSecondsPerDay * daysElapsed * 1.3)),
    computeTimeSeconds: String(project.cuSecondsPerDay * daysElapsed),
    writtenDataBytes: String(Math.round(project.logicalGb * 2.1e8)),
    dataTransferBytes: String(Math.round(project.egressBytesPerDay * daysElapsed)),
    dataStorageByteHours: "0",
  };
  const evidence = contentEvidence(`snapshot:${project.id}`, bare);
  const fact = (field: string) => ({
    evidenceId: evidence.evidenceId,
    payloadHash: evidence.payloadHash,
    sourcePath: `/projects/${project.id}/${field}`,
  });
  return {
    ...bare,
    evidence,
    metricEvidence: {
      activeTimeSeconds: fact("active_time_seconds"),
      computeTimeSeconds: fact("compute_time_seconds"),
      writtenDataBytes: fact("written_data_bytes"),
      dataTransferBytes: fact("data_transfer_bytes"),
      dataStorageByteHours: fact("data_storage_bytes_hour"),
    },
  };
}

function demoBranchSizes(project: DemoProject): BranchSizeCollection {
  const bare = [
    {
      branchId: `br-main-${project.id.slice(-8)}`,
      name: "main",
      logicalSizeBytes: String(Math.round(project.logicalGb * 0.8 * 1e9)),
    },
    {
      branchId: `br-dev-${project.id.slice(-8)}`,
      name: "dev",
      logicalSizeBytes: String(Math.round(project.logicalGb * 0.2 * 1e9)),
    },
  ];
  const evidence = contentEvidence(`branches:${project.id}`, bare);
  const fact = (branch: string) => ({
    evidenceId: evidence.evidenceId,
    payloadHash: evidence.payloadHash,
    sourcePath: `/projects/${project.id}/branches/${branch}`,
  });
  return {
    branches: bare.map((branch) => ({ ...branch, evidence: fact(branch.name) })),
    evidence: [evidence],
  };
}

function demoQuota(project: DemoProject): ProjectQuotaSnapshotReading["quota"] {
  // Two projects carry quotas so utilization shows real percentages; the
  // rest are unlimited (null), matching common fleets.
  const limited = project.name === "api-production" || project.name === "staging";
  return {
    projectId: project.id,
    consumptionPeriodEnd: null,
    quota: {
      activeTimeSeconds: limited ? String(project.cuSecondsPerDay * 60) : null,
      computeTimeSeconds: limited ? String(project.cuSecondsPerDay * 45) : null,
      writtenDataBytes: null,
      dataTransferBytes: limited ? String(Math.round(project.egressBytesPerDay * 40)) : null,
      logicalSizeBytes: limited ? String(50e9) : null,
    },
    enforcement: "suspend_computes_until_period_end",
    logicalSizeEnforcement: "suspend_affected_branch_persistent",
  };
}

/**
 * ReportDependencies over the synthetic source. `now` is injectable for
 * deterministic tests; the CLI passes the real clock.
 */
export function createDemoDependencies(
  options: {
    now?: () => Date;
    /** The CLI's --max-* dials; honored so demo behaves as documented (a
     * ceiling hit yields an honest partial with the specific limit flag). */
    collectionBudget?: {
      maxDurationMs?: number;
      maxItems?: number;
      maxFacts?: number;
      maxBytes?: number;
    };
  } = {},
): ReportDependencies {
  const now = options.now ?? (() => new Date());
  const project = (projectId: string): DemoProject => {
    const found = DEMO_PROJECTS.find((candidate) => candidate.id === projectId);
    if (!found) throw new Error(`Demo project ${projectId} does not exist`);
    return found;
  };

  const consumptionSource = {
    getProjectPage: async (query: ProjectReportQuery) => demoProjectPage(query),
  };
  const directorySource = {
    listOrganizations: async () => [ORGANIZATION],
    listProjectDirectory: async () => ({
      projects: DEMO_PROJECTS.map(({ id, name }) => ({ id, name })),
      unavailableProjectIds: [],
    }),
  };
  const snapshotSource: CurrentSnapshotSource = {
    listProjects: async () => ({
      projectIds: DEMO_PROJECTS.map(({ id }) => id),
      unavailableProjectIds: [],
    }),
    getProjectSnapshot: async (projectId) => demoSnapshot(project(projectId), now()),
    listBranchSizes: async (projectId) => demoBranchSizes(project(projectId)),
  };
  const controlsSource: ControlsSource = {
    getSpendingNotification: async () => ({
      status: "configured",
      spendingLimitCents: "50000",
      semantics: "alert_only",
    }),
    getProjectQuota: async (projectId) => demoQuota(project(projectId)),
  };

  const serviceOptions = { now, ...options.collectionBudget };
  const consumption = createConsumptionService(consumptionSource, serviceOptions);
  const overview = createUsageOverviewService(
    { ...consumptionSource, ...directorySource },
    serviceOptions,
  );
  const snapshots = createCurrentSnapshotService(snapshotSource, serviceOptions);
  const controls = createControlsService(controlsSource, serviceOptions);
  const utilization = createQuotaUtilizationService(
    {
      getSpendingNotification: controlsSource.getSpendingNotification,
      getProjectQuotaSnapshot: async (projectId) => ({
        quota: demoQuota(project(projectId)),
        snapshot: demoSnapshot(project(projectId), now()),
      }),
      listBranchSizes: snapshotSource.listBranchSizes,
    },
    serviceOptions,
  );
  const capabilities = createCapabilityService({
    getOrganization: async () => ({ id: ORGANIZATION.id, plan: ORGANIZATION.plan }),
    probeProjectHistory: async () => "available",
  });

  return {
    projectReport: (query, _control, context) => consumption.projectReport(query, context),
    organizationSummary: (query, _control, context) =>
      consumption.organizationSummary(query, context),
    branchReport: async () => {
      throw new Error("branch-report is not available in demo mode");
    },
    usageOverview: (query, _control, context) => overview.overview(query, context),
    estimate: async (query, _control, context) =>
      // Same policy as the real composition root: past windows estimate at
      // today's documented rates, labeled RATE_CARD_DATE_EXTRAPOLATION.
      estimateProjectCosts(
        await consumption.projectReport(query, context),
        neonDocumentationRateCard,
        { extrapolateRateCardDates: true },
      ),
    // getProjectPage guards the history/estimate paths via the query's
    // organizationId; the per-organization entry points below guard directly.
    currentReport: (organizationId, projectIds, context) => {
      assertDemoOrganization(organizationId);
      return snapshots.organizationReport(
        organizationId,
        context,
        projectIds ? { projectIds } : undefined,
      );
    },
    controls: (organizationId, projectIds, context) => {
      assertDemoOrganization(organizationId);
      return controls.organizationControls(organizationId, projectIds, context);
    },
    quotaUtilization: (organizationId, projectIds, context) => {
      assertDemoOrganization(organizationId);
      return utilization.organizationUtilization(organizationId, projectIds, context);
    },
    capabilities: (organizationId, context) => {
      assertDemoOrganization(organizationId);
      return capabilities.inspect(organizationId, context);
    },
    organizations: async () => [ORGANIZATION],
    projects: async (organizationId) => {
      assertDemoOrganization(organizationId);
      return {
        projects: DEMO_PROJECTS.map(({ id, name }) => ({ id, name })),
        unavailableProjectIds: [],
      };
    },
    storedProjectNames: async () => new Map(DEMO_PROJECTS.map(({ id, name }) => [id, name])),
    defaultOrganizationId: ORGANIZATION.id,
    defaultProjectId: firstDemoProject().id,
    context: {
      organizationId: ORGANIZATION.id,
      projectId: firstDemoProject().id,
      branch: "main",
      credential: "demo",
    },
  };
}
