// The composition root: wires a Neon API key and a store path into the
// ReportDependencies both delivery adapters consume. It is deliberately
// adapter-neutral — no CLI options, no HTTP, no process side effects beyond
// the store it opens — so the CLI, the dashboard command, and any embedder
// build the same real dependencies the same way. Adapter-specific concerns
// (stderr warnings, exit codes, stdout writing) stay in the adapter and are
// injected through the config below.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type CollectionControl,
  createBranchConsumptionService,
  createCapabilityService,
  createConsumptionService,
  createControlsService,
  createCurrentSnapshotService,
  createInMemoryEvidenceFactStore,
  createNeonApiSource,
  createQuotaUtilizationService,
  createSlidingWindowRequestCoordinator,
  createSqliteEvidenceFactStore,
  createUsageOverviewService,
  DEFAULT_STORE_TAIL_BUCKETS,
  type EvidenceFactStore,
  estimateProjectCosts,
  type HistoryBudget,
  mergeProjectConsumptionReports,
  neonDocumentationRateCard,
  type ProjectConsumptionReport,
  type ReportDependencies,
  SqliteModuleUnavailableError,
} from "./index.js";

/**
 * The default store lives in a per-user data directory, following each OS's
 * convention: macOS `~/Library/Application Support`, Windows `%LOCALAPPDATA%`,
 * and otherwise `$XDG_STATE_HOME` (then `~/.local/state`). NEON_USAGE_STORE
 * overrides. The store is the durable evidence trail, not a disposable cache,
 * so it goes in state/data rather than a cache directory.
 */
export function defaultStorePath(env: NodeJS.ProcessEnv): string {
  const override = env.NEON_USAGE_STORE?.trim();
  if (override) return override;
  const home = env.HOME?.trim() || homedir();
  if (process.platform === "win32") {
    const base = env.LOCALAPPDATA?.trim() || env.APPDATA?.trim() || join(home, "AppData", "Local");
    return join(base, "neon-usage", "store.sqlite");
  }
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "neon-usage", "store.sqlite");
  }
  const base = env.XDG_STATE_HOME?.trim() || join(home, ".local", "state");
  return join(base, "neon-usage", "store.sqlite");
}

export type CollectionBudgetConfig = {
  /** Wall-clock ceiling per operation; defaults to 10 minutes. */
  maxDurationMs?: number;
  /** Entity ceiling per operation; defaults to 10,000. */
  maxItems?: number;
  /** Fact ceiling per operation; defaults to 1,000,000. */
  maxFacts?: number;
  /** Response-byte ceiling per operation; defaults to 100 MB. */
  maxBytes?: number;
};

export type NeonDependenciesConfig = {
  /** The resolved Neon credential (API key or OAuth access token). */
  apiKey: string;
  /** Where the durable store lives; see defaultStorePath. */
  storePath: string;
  /** Aggregate collection ceilings; a run past one stops and labels the
   * report partial with the specific limit flag. */
  collectionBudget?: CollectionBudgetConfig;
  /** Resolved organization/project/branch context, if any. */
  context?: { organizationId?: string; projectId?: string; branch?: string };
  /** Account request budget; defaults to 45 requests/minute. */
  requestBudget?: { limit: number; intervalMs: number };
  /** Stores opened during the run are pushed here so the caller can close them. */
  openedStores: EvidenceFactStore[];
  /** Surfaces the one-time "no local persistence" warning to the adapter. */
  onWarn?: (message: string) => void;
  /** Emits best-effort enrichment failures (name recording) for debugging. */
  onDebug?: (message: string) => void;
};

/**
 * Builds the real Neon-backed ReportDependencies: collecting and reading
 * sources over the Neon API, a durable SQLite store (falling back to an
 * in-memory store when the native module is unavailable), and the services
 * that turn them into reports. Serve-from-store, chunked estimation, and
 * observed-name enrichment are wired here once for every adapter.
 */
export function createNeonDependencies(config: NeonDependenciesConfig): ReportDependencies {
  const { apiKey, storePath, openedStores } = config;
  const sourceAccount = `credential:sha256:${createHash("sha256").update(apiKey).digest("hex")}`;

  // The local database exists to persist collection runs; commands that only
  // read the API must not create it as a side effect. better-sqlite3 is an
  // optional native dependency: when its binary is unavailable (unbuildable
  // platform, or an npm policy that blocked its install script) collection
  // still works this run against an in-memory store — persistence,
  // serve-from-store, and the durable evidence trail are the only casualties,
  // and the user is told once.
  let store: EvidenceFactStore | undefined;
  let warnedNoPersistence = false;
  const openStore = () => {
    if (!store) {
      try {
        store = createSqliteEvidenceFactStore(storePath);
      } catch (error) {
        // Degrade to in-memory ONLY when the native module is missing. A
        // symlink, permission, foreign-DB, migration, or corruption fault is an
        // integrity/security condition and must fail closed with its own error.
        if (!(error instanceof SqliteModuleUnavailableError)) throw error;
        if (!warnedNoPersistence) {
          warnedNoPersistence = true;
          config.onWarn?.(
            "Warning: the better-sqlite3 native module is unavailable, so this run uses an " +
              "in-memory store — nothing is persisted and serve-from-store is disabled. " +
              "To enable persistence, reinstall so better-sqlite3 can build its native binary " +
              `(${error.message.split("\n")[0]}).\n`,
          );
        }
        store = createInMemoryEvidenceFactStore();
      }
      openedStores.push(store);
    }
    return store;
  };

  const requestCoordinator = createSlidingWindowRequestCoordinator(
    config.requestBudget ?? { limit: 45, intervalMs: 60_000 },
  );
  const collectingSource = createNeonApiSource({
    apiKey,
    requestTimeoutMs: 120_000,
    requestCoordinator,
    evidence: {
      sourceAccount,
      retention: "hash_only",
      write: (record, signal) => openStore().writeEvidence(record, signal),
    },
  });
  const readingSource = createNeonApiSource({
    apiKey,
    requestTimeoutMs: 120_000,
    requestCoordinator,
  });
  const budgetDefaults = {
    maxDurationMs: config.collectionBudget?.maxDurationMs ?? 10 * 60_000,
    maxItems: config.collectionBudget?.maxItems ?? 10_000,
    maxFacts: config.collectionBudget?.maxFacts ?? 1_000_000,
    maxBytes: config.collectionBudget?.maxBytes ?? 100_000_000,
  };
  const collectionOptions = (control?: CollectionControl, budget?: HistoryBudget) => ({
    ...budgetDefaults,
    ...(budget ? { budget } : {}),
    factStore: openStore(),
    sourceAccount,
    // Serve-from-store is the default: already-collected buckets come from
    // the local store and only the gap plus the re-observation tail is
    // collected. --fresh disables it; --store-tail adjusts the tail.
    storeServing: control?.storeServing ?? {
      serve: true,
      tailBuckets: DEFAULT_STORE_TAIL_BUCKETS,
    },
    ...(control?.runId ? { createRunId: () => control.runId as `run_${string}` } : {}),
    ...(control?.resumeRunId ? { resumeRunId: control.resumeRunId } : {}),
  });

  // Names observed while collecting are snapshotted so historical reports can
  // show what a resource was called at collection time. Read-only commands
  // never create the store, but when one already exists they opportunistically
  // enrich it. A failure never affects report correctness, so it is swallowed
  // and only surfaced through onDebug — the same fault may threaten the store.
  const debugEnrichmentFailure = (error: unknown) => {
    config.onDebug?.(`resource-name recording failed: ${String(error)}\n`);
  };
  const recordIfStoreExists = (
    observations: Parameters<EvidenceFactStore["recordResourceNames"]>[0],
  ) => {
    if (observations.length === 0) return;
    if (!store && !existsSync(storePath)) return;
    void openStore().recordResourceNames(observations).catch(debugEnrichmentFailure);
  };
  const recordProjectNames = (projects: Array<{ id: string; name: string }>) => {
    const observedAt = new Date().toISOString();
    void openStore()
      .recordResourceNames(
        projects.map((project) => ({
          kind: "project" as const,
          resourceId: project.id,
          name: project.name,
          observedAt,
        })),
      )
      .catch(debugEnrichmentFailure);
  };
  const namedCollectingSource = {
    ...collectingSource,
    listProjectDirectory: async (
      organizationId: string,
      context?: Parameters<typeof collectingSource.listProjectDirectory>[1],
    ) => {
      const directory = await collectingSource.listProjectDirectory(organizationId, context);
      recordProjectNames(directory.projects);
      return directory;
    },
  };

  const capabilities = createCapabilityService(readingSource);
  // Real fleets run to hundreds of live projects; the service default of 100
  // would reject exactly the organizations that need these reports. Scoped
  // --project-ids bounds the fan-out when speed matters.
  const controls = createControlsService(readingSource, { maxProjects: 1000 });
  const utilization = createQuotaUtilizationService(readingSource, { maxProjects: 1000 });
  const currentSnapshots = createCurrentSnapshotService(readingSource, { maxProjects: 1000 });

  return {
    projectReport: (query, control, context) =>
      createConsumptionService(collectingSource, collectionOptions(control)).projectReport(
        query,
        context,
      ),
    branchReport: (query, control, context) =>
      createBranchConsumptionService(collectingSource, collectionOptions(control)).branchReport(
        query,
        context,
      ),
    organizationSummary: (query, control, context) =>
      createConsumptionService(collectingSource, collectionOptions(control)).organizationSummary(
        query,
        context,
      ),
    capabilities: (organizationId, context) => capabilities.inspect(organizationId, context),
    controls: (organizationId, projectIds, context) =>
      controls.organizationControls(organizationId, projectIds, context),
    quotaUtilization: (organizationId, projectIds, context) =>
      utilization.organizationUtilization(organizationId, projectIds, context),
    currentReport: async (organizationId, projectIds, context) => {
      const report = await currentSnapshots.organizationReport(
        organizationId,
        context,
        projectIds ? { projectIds } : undefined,
      );
      const observedAt = new Date().toISOString();
      recordIfStoreExists(
        report.projects.flatMap((project) =>
          project.branchStorage.branches.flatMap((branch) =>
            branch.name
              ? [
                  {
                    kind: "branch" as const,
                    resourceId: branch.branchId,
                    name: branch.name,
                    observedAt,
                  },
                ]
              : [],
          ),
        ),
      );
      return report;
    },
    organizations: (context) => readingSource.listOrganizations(context),
    projects: async (organizationId, context) => {
      const directory = await readingSource.listProjectDirectory(organizationId, context);
      const observedAt = new Date().toISOString();
      recordIfStoreExists(
        directory.projects.map((project) => ({
          kind: "project" as const,
          resourceId: project.id,
          name: project.name,
          observedAt,
        })),
      );
      return directory;
    },
    usageOverview: (query, control, context) =>
      createUsageOverviewService(namedCollectingSource, collectionOptions(control)).overview(
        query,
        context,
      ),
    estimate: async (query, control, context) => {
      const budget: HistoryBudget = {
        maxPages: 1000,
        ...budgetDefaults,
        startedAt: performance.now(),
        items: 0,
        facts: 0,
        bytes: 0,
        pages: 0,
      };
      // The source's project filter caps at 100 IDs; a larger scoped query
      // collects in chunks and estimates the honestly merged report once, so
      // per-organization allowances apply exactly once. Chunked runs use fresh
      // run IDs — an explicit --run-id/--resume cannot name several.
      // Dedupe before chunking: a repeated ID would land in two chunks and
      // trip the merge's overlapping-filter check for a merely redundant query.
      const projectIds = [...new Set(query.projectIds ?? [])];
      let report: ProjectConsumptionReport;
      if (projectIds.length > 100) {
        // A single explicit run/resume ID can't name several chunk runs; reject
        // only those. --fresh/--store-tail (storeServing) do propagate to each
        // chunk, so a large-fleet estimate can still be re-collected fresh.
        if (control?.runId || control?.resumeRunId) {
          throw new Error(
            "--run-id and --resume cannot drive a chunked (>100 project) estimate; query explicit --project-ids chunks instead",
          );
        }
        const chunkControl = control?.storeServing
          ? { storeServing: control.storeServing }
          : undefined;
        const reports: ProjectConsumptionReport[] = [];
        for (let index = 0; index < projectIds.length; index += 100) {
          const chunk = await createConsumptionService(
            collectingSource,
            collectionOptions(chunkControl, budget),
          ).projectReport(
            {
              ...query,
              projectIds: projectIds.slice(index, index + 100),
            },
            context,
          );
          reports.push(chunk);
          if (
            chunk.coverage.qualityFlags.some((flag) =>
              [
                "PAGE_LIMIT_REACHED",
                "TIME_LIMIT_REACHED",
                "ITEM_LIMIT_REACHED",
                "FACT_LIMIT_REACHED",
                "BYTE_LIMIT_REACHED",
              ].includes(flag),
            )
          ) {
            break;
          }
        }
        report = mergeProjectConsumptionReports(reports);
      } else {
        report = await createConsumptionService(
          collectingSource,
          collectionOptions(control, budget),
        ).projectReport(query, context);
      }
      // Past windows estimate at today's documented rates rather than refusing;
      // every such line carries RATE_CARD_DATE_EXTRAPOLATION.
      return estimateProjectCosts(report, neonDocumentationRateCard, {
        extrapolateRateCardDates: true,
      });
    },
    storedProjectNames: (projectIds) => openStore().getResourceNames(projectIds),
    ...(config.context?.organizationId
      ? { defaultOrganizationId: config.context.organizationId }
      : {}),
    ...(config.context?.projectId ? { defaultProjectId: config.context.projectId } : {}),
    context: {
      organizationId: config.context?.organizationId ?? null,
      projectId: config.context?.projectId ?? null,
      branch: config.context?.branch ?? null,
      credential: "configured",
    },
  };
}
