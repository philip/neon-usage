import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { Command, InvalidArgumentError, Option } from "commander";
// Adapter and composition modules are imported directly, not via the domain barrel.
import { defaultAssetsDirectory, startDashboardServer } from "./dashboard-server.js";
import { createNeonDependencies, defaultStorePath } from "./default-dependencies.js";
import { createDemoDependencies } from "./demo-dependencies.js";
import { createDoctorReport, renderDoctorReport } from "./doctor.js";
import {
  assertWithinHistoryFilter,
  type BranchReportQuery,
  branchConsumptionMetrics,
  CliError,
  type CollectionControl,
  type ControlsInspection,
  type CurrentPeriodSnapshotReport,
  commaSeparatedValues,
  contextReport,
  defaultHistoryProjectIds,
  type EvidenceFactStore,
  hasPartialCoverage,
  historyQueryFromOptions,
  liveProjectIds,
  type ProjectConsumptionReport,
  projectConsumptionMetrics,
  type QuotaUtilizationReport,
  type ReportDependencies,
  renderControlsTable,
  renderEstimateTable,
  renderHistoryTable,
  renderPriceTable,
  renderSnapshotTable,
  renderUsageTable,
  renderUtilizationTable,
  resolveControlsProjectIds,
  resolvedContext,
  resolveOrganizationId,
  serializeMachineJson,
} from "./index.js";
import { resolveNeonCliContext } from "./neon-cli-context.js";

type CliDependencies = ReportDependencies & {
  write(value: string): void;
  setExitCode?(value: number): void;
};

type CliRuntime = {
  now(): Date;
  isTTY: boolean;
  /** Injectable for tests; defaults to the real platform browser opener. */
  openUrl?(url: string): void;
};

/**
 * Parses the collection-budget dials into the composition-root config.
 * Ranges mirror the history-service validation, so a value accepted here is
 * never rejected downstream: minutes 1-60, items 1-10,000,000, facts
 * 1-100,000,000, bytes 1-1,000,000,000.
 */
export function parseCollectionBudget(options: {
  maxDuration?: string;
  maxItems?: string;
  maxFacts?: string;
  maxBytes?: string;
}):
  | { maxDurationMs?: number; maxItems?: number; maxFacts?: number; maxBytes?: number }
  | undefined {
  const parsed = {
    ...(options.maxDuration !== undefined
      ? { maxDurationMs: boundedInteger("--max-duration", options.maxDuration, 1, 60) * 60_000 }
      : {}),
    ...(options.maxItems !== undefined
      ? { maxItems: boundedInteger("--max-items", options.maxItems, 1, 10_000_000) }
      : {}),
    ...(options.maxFacts !== undefined
      ? { maxFacts: boundedInteger("--max-facts", options.maxFacts, 1, 100_000_000) }
      : {}),
    ...(options.maxBytes !== undefined
      ? { maxBytes: boundedInteger("--max-bytes", options.maxBytes, 1, 1_000_000_000) }
      : {}),
  };
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function boundedInteger(flag: string, value: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${flag} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

/** Commander argParser that validates eagerly so a bad dial fails on EVERY
 * command, not only the ones that build the real dependencies. */
function eagerValidated(validate: (value: string) => void): (value: string) => string {
  return (value) => {
    try {
      validate(value);
    } catch (error) {
      throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
    }
    return value;
  };
}

/** Parses --request-budget: whole requests per minute, bounded 1-600. */
export function parseRequestBudget(
  value: string | undefined,
): { limit: number; intervalMs: number } | undefined {
  if (value === undefined) return undefined;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 600) {
    throw new Error("--request-budget must be an integer between 1 and 600 requests per minute");
  }
  return { limit, intervalMs: 60_000 };
}

/** Parses --port: a TCP port to bind, 1-65535 (0 keeps the ephemeral default). */
export function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new InvalidArgumentError("--port must be an integer between 1 and 65535");
  }
  return port;
}

/**
 * Fails with an actionable error when credential resolution found no API key.
 * Extracted so the guidance (mint a profile, then select it) is unit-tested;
 * minting alone leaves the user on the DEFAULT profile, so the fix names the
 * `neon-usage --profile` step that actually points the tool at the new key.
 */
export function assertCredentialResolved(apiKey: string | undefined): asserts apiKey is string {
  if (apiKey) return;
  throw new CliError({
    headline: "No Neon credential found",
    fix:
      "Run `neon auth` to log in, or mint a profile: `neon profile create <name> --mint` " +
      "then `neon-usage --profile <name>`. A NEON_API_KEY in .env.local also works and " +
      "does not expire.",
  });
}

/**
 * Whether the dashboard should auto-open a browser: on unless `--no-open` was
 * passed (commander sets `open` to false) or `BROWSER=none` is set — the
 * create-react-app convention for headless/CI environments.
 */
export function shouldOpenBrowser(
  options: { open?: boolean },
  env: { BROWSER?: string } = {},
): boolean {
  return options.open !== false && env.BROWSER !== "none";
}

/** The default-browser launcher for a platform: `open`/`start`/`xdg-open`. */
export function browserOpenCommand(
  platform: NodeJS.Platform,
  url: string,
): [command: string, args: string[]] {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["cmd", ["/c", "start", "", url]];
  return ["xdg-open", [url]];
}

/**
 * Best-effort: launch the OS default browser at `url`. Detached and unref'd so
 * it never keeps the server process alive, and errors are swallowed — a headless
 * box simply keeps serving and the user opens the printed URL themselves.
 */
function openBrowser(url: string): void {
  const [command, args] = browserOpenCommand(process.platform, url);
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // A missing launcher (xdg-open on a bare server) is not an error worth surfacing.
  }
}

export async function runCli(
  args: string[],
  dependencies?: CliDependencies,
  runtime: CliRuntime = { now: () => new Date(), isTTY: process.stdout.isTTY ?? false },
): Promise<void> {
  const machineJson = (value: unknown) => serializeMachineJson(value, { maxBytes: 25_000_000 });
  const openedStores: EvidenceFactStore[] = [];
  const packageVersion = (createRequire(import.meta.url)("../package.json") as { version: string })
    .version;
  const program = new Command()
    .name("neon-usage")
    .version(packageVersion)
    .description("Inspect Neon consumption without changing Neon resources")
    .option("--api-key <key>", "Neon API key (defaults to env or Neon CLI credentials)")
    .option("--profile <name>", "Neon CLI credential profile")
    .option("--context-file <path>", "Neon context file (defaults to nearest .neon)")
    .option("--config-dir <path>", "Neon CLI configuration directory")
    .option(
      "--store <path>",
      "durable local collection store (default: a per-user data directory; NEON_USAGE_STORE overrides)",
    )
    .option(
      "--request-budget <perMinute>",
      "Neon API requests per minute, 1-600 (default 45; raising it risks provider rate limits)",
      eagerValidated((value) => parseRequestBudget(value)),
    )
    .option(
      "--max-duration <minutes>",
      "wall-clock ceiling per collection, 1-60 minutes (default 10; past it the report is partial)",
      eagerValidated((value) => boundedInteger("--max-duration", value, 1, 60)),
    )
    .option(
      "--max-items <count>",
      "entity ceiling per collection, 1-10000000 (default 10000)",
      eagerValidated((value) => boundedInteger("--max-items", value, 1, 10_000_000)),
    )
    .option(
      "--max-facts <count>",
      "fact ceiling per collection, 1-100000000 (default 1000000)",
      eagerValidated((value) => boundedInteger("--max-facts", value, 1, 100_000_000)),
    )
    .option(
      "--max-bytes <bytes>",
      "response-byte ceiling per collection, 1-1000000000 (default 100000000)",
      eagerValidated((value) => boundedInteger("--max-bytes", value, 1, 1_000_000_000)),
    )
    .showHelpAfterError();

  // Explain how defaults are discovered without printing the resolved values
  // (which are account-identifying); `context` prints what actually resolves.
  program.addHelpText(
    "after",
    [
      "",
      "How defaults resolve (run `neon-usage context` to see what they resolve to):",
      "  Credential    --api-key, --profile, NEON_API_KEY, NEON_PROFILE, then the Neon CLI login.",
      "                .env.local may set NEON_API_KEY / NEON_PROFILE. API keys do not expire; a",
      "                `neon auth` login does (~hourly) and is not refreshed here.",
      "  Organization  --org-id, else NEON_ORG_ID, else the nearest .neon, else the sole",
      "                organization the credential can see.",
      "  Project       project-report, branch-report, and current-report default to the project in",
      "                the nearest .neon; widen with --project-ids <ids>, or an explicit",
      "                --scope organization|live-projects (project-report, estimate).",
      "                estimate and organization-summary are whole-organization by default.",
      "                current-report and controls accept --project-ids all.",
    ].join("\n"),
  );

  // Demo wins over the real composition; injected dependencies (tests,
  // embedders) still supply the output sink so demo output stays capturable.
  const resolveDependencies = (demo?: boolean): CliDependencies => {
    if (!demo) {
      return dependencies ?? createDefaultDependencies(program.opts(), openedStores);
    }
    process.stderr.write(
      "DEMO MODE: every value is synthetic (fictional organization; no Neon account involved).\n",
    );
    const collectionBudget = parseCollectionBudget(program.opts());
    return {
      ...createDemoDependencies({
        now: runtime.now,
        ...(collectionBudget ? { collectionBudget } : {}),
      }),
      write: dependencies?.write ?? ((value: string) => process.stdout.write(value)),
      ...(dependencies?.setExitCode ? { setExitCode: dependencies.setExitCode } : {}),
    };
  };

  const projectReportCommand = program
    .command("project-report")
    .description("Collect invoice-aligned project history with explicit coverage status")
    .addOption(demoOption())
    .addOption(new Option("--output <format>", "output format").choices(["json", "table"]))
    .addOption(scopeOption())
    .option("--project-ids <ids>", "project IDs (defaults to the project in .neon)");
  addHistoryOptions(projectReportCommand, projectConsumptionMetrics).action(async (options) => {
    const query = historyQueryFromOptions(options, runtime.now());
    const activeDependencies = resolveDependencies(options.demo);
    query.organizationId = await resolveOrganizationId(query.organizationId, activeDependencies);
    // Explicit IDs win; explicit `--scope organization` means the WHOLE
    // organization (never the linked-project default — the label must match
    // the query); only an unscoped call falls back to the linked project.
    const projectIds =
      !options.projectIds && options.scope === "live-projects"
        ? assertWithinHistoryFilter(await liveProjectIds(query.organizationId, activeDependencies))
        : !options.projectIds && options.scope === "organization"
          ? undefined
          : defaultHistoryProjectIds(options, activeDependencies);
    if (projectIds) query.projectIds = projectIds;
    const report = await activeDependencies.projectReport(query, collectionControl(options));
    const output = options.output ?? (runtime.isTTY ? "table" : "json");
    if (output === "table") {
      const typed = asReport<ProjectConsumptionReport>(report, "project-report");
      let text = renderHistoryTable(typed);
      // Human-mode hints (never in the JSON contract): explain the linked-project
      // default, and catch a name passed where an ID was expected.
      if (options.projectIds && typed.projects.length === 0) {
        text +=
          "\nNo history for the requested project(s). --project-ids takes project IDs, not names — list them with `neon-usage projects`.\n";
      } else if (!options.projectIds && options.scope !== "live-projects" && projectIds?.length) {
        text +=
          "\nScoped to the linked project (from .neon). Use --scope organization for every project (invoice-aligned), --scope live-projects for existing projects only, or --project-ids <ids>.\n";
      } else if (options.scope === "live-projects") {
        // The live-scope undercount caveat must appear on every surface that
        // shows a live-scoped report (the dashboard already states it).
        text +=
          "\nLive-projects scope: excludes projects deleted during the window, so totals can undercount the invoice. Use --scope organization for invoice-aligned numbers.\n";
      }
      activeDependencies.write(text);
    } else {
      activeDependencies.write(machineJson(report));
    }
    if (hasPartialCoverage(report)) activeDependencies.setExitCode?.(2);
  });

  const branchReportCommand = program
    .command("branch-report")
    .description("Collect beta branch-attributed consumption (defaults to the project in .neon)")
    .option("--project-ids <ids>", "project IDs (defaults to the project in .neon)")
    .option("--branch-ids <ids>", "optional comma-separated branch IDs");
  addHistoryOptions(branchReportCommand, branchConsumptionMetrics, true, false).action(
    async (options) => {
      const activeDependencies = resolveDependencies(options.demo);
      const projectIds = defaultHistoryProjectIds(options, activeDependencies);
      if (!projectIds?.length) {
        throw new Error(
          "No project to report on: pass --project-ids <ids>, or link one with `neon link`.",
        );
      }
      const query: BranchReportQuery = {
        ...historyQueryFromOptions(options, runtime.now()),
        projectIds,
        ...(options.branchIds ? { branchIds: commaSeparatedValues(options.branchIds) } : {}),
      };
      query.organizationId = await resolveOrganizationId(query.organizationId, activeDependencies);
      const report = await activeDependencies.branchReport(query, collectionControl(options));
      activeDependencies.write(machineJson(report));
      if (hasPartialCoverage(report)) {
        activeDependencies.setExitCode?.(2);
      }
    },
  );

  const organizationSummaryCommand = program
    .command("organization-summary")
    .description("Aggregate complete project history into billing-unit organization totals")
    .addOption(demoOption());
  addHistoryOptions(organizationSummaryCommand, projectConsumptionMetrics).action(
    async (options) => {
      const query = historyQueryFromOptions(options, runtime.now());
      const activeDependencies = resolveDependencies(options.demo);
      query.organizationId = await resolveOrganizationId(query.organizationId, activeDependencies);
      const report = await activeDependencies.organizationSummary(
        query,
        collectionControl(options),
      );
      activeDependencies.write(machineJson(report));
      if (hasPartialCoverage(report)) {
        activeDependencies.setExitCode?.(2);
      }
    },
  );

  const estimateCommand = program
    .command("estimate")
    .description("Project complete history into a labeled cost estimate (never an invoice)")
    .addOption(demoOption())
    .addOption(new Option("--output <format>", "output format").choices(["json", "table"]))
    .addOption(scopeOption());
  addHistoryOptions(estimateCommand, projectConsumptionMetrics).action(async (options) => {
    const query = historyQueryFromOptions(options, runtime.now());
    const activeDependencies = resolveDependencies(options.demo);
    if (!activeDependencies.estimate) {
      throw new Error("Cost estimation is unavailable in the configured CLI adapter");
    }
    query.organizationId = await resolveOrganizationId(query.organizationId, activeDependencies);
    if (options.scope === "live-projects") {
      query.projectIds = await liveProjectIds(query.organizationId, activeDependencies);
    }
    const estimate = await activeDependencies.estimate(query, collectionControl(options));
    const output = options.output ?? (runtime.isTTY ? "table" : "json");
    activeDependencies.write(
      output === "table" ? renderEstimateTable(estimate) : machineJson(estimate),
    );
    if (estimate.status !== "estimated") activeDependencies.setExitCode?.(2);
  });

  program
    .command("controls")
    .description("Inspect native spending notifications and project quotas (read-only)")
    .addOption(demoOption())
    .option("--utilization", "join quota limits with current-period usage")
    .addOption(new Option("--output <format>", "output format").choices(["json", "table"]))
    .option("--org-id <id>", "Neon organization ID (defaults to NEON_ORG_ID or .neon)")
    .option(
      "--project-ids <ids>",
      "project IDs, or 'all' (defaults to the linked project, else all projects)",
    )
    .action(async (options) => {
      const activeDependencies = resolveDependencies(options.demo);
      if (!activeDependencies.controls) {
        throw new Error("Controls inspection is unavailable in the configured CLI adapter");
      }
      const organizationId = await resolveOrganizationId(options.orgId, activeDependencies);
      // Same default as project-report: the linked project when it belongs to
      // the selected organization; --project-ids all or explicit IDs otherwise.
      const projectIds = await resolveControlsProjectIds(
        options,
        organizationId,
        activeDependencies,
      );
      if (projectIds.length > 20) {
        process.stderr.write(
          `Inspecting quotas for ${projectIds.length} projects within the account request budget; this can take several minutes...\n`,
        );
      }
      const utilization = options.utilization === true;
      if (utilization && !activeDependencies.quotaUtilization) {
        throw new Error("Quota utilization is unavailable in the configured CLI adapter");
      }
      const result = utilization
        ? await activeDependencies.quotaUtilization?.(organizationId, projectIds)
        : await activeDependencies.controls(organizationId, projectIds);
      const output = options.output ?? (runtime.isTTY ? "table" : "json");
      activeDependencies.write(
        output === "table"
          ? utilization
            ? renderUtilizationTable(asReport<QuotaUtilizationReport>(result, "controls"))
            : renderControlsTable(asReport<ControlsInspection>(result, "controls"))
          : machineJson(result),
      );
      if (hasPartialCoverage(result)) activeDependencies.setExitCode?.(2);
    });

  program
    .command("capabilities")
    .description("Inspect declared plan capabilities and observed history availability")
    .addOption(demoOption())
    .option("--org-id <id>", "Neon organization ID (defaults to NEON_ORG_ID or .neon)")
    .action(async (options) => {
      const activeDependencies = resolveDependencies(options.demo);
      const result = await activeDependencies.capabilities(
        await resolveOrganizationId(options.orgId, activeDependencies),
      );
      activeDependencies.write(machineJson(result));
    });

  program
    .command("current-report")
    .description("Collect Free-compatible current-period project and branch snapshots")
    .addOption(demoOption())
    .addOption(new Option("--output <format>", "output format").choices(["json", "table"]))
    .option("--org-id <id>", "Neon organization ID (defaults to NEON_ORG_ID or .neon)")
    .option(
      "--project-ids <ids>",
      "project IDs, or 'all' for every project (defaults to the project in .neon; a project-record request plus a branch listing each)",
    )
    .action(async (options) => {
      const activeDependencies = resolveDependencies(options.demo);
      // Default to the linked project — one request instead of a per-project
      // fan-out over the whole org. 'all' (or no linked project) still widens.
      const projectIds =
        options.projectIds === "all"
          ? undefined
          : options.projectIds
            ? commaSeparatedValues(options.projectIds)
            : defaultHistoryProjectIds(options, activeDependencies);
      const result = await activeDependencies.currentReport(
        await resolveOrganizationId(options.orgId, activeDependencies),
        projectIds,
      );
      const output = options.output ?? (runtime.isTTY ? "table" : "json");
      if (output === "table") {
        const typed = asReport<CurrentPeriodSnapshotReport>(result, "current-report");
        let text = renderSnapshotTable(typed);
        if (!options.projectIds && projectIds?.length) {
          text +=
            "\nScoped to the linked project (from .neon). Use --project-ids all for the whole organization.\n";
        }
        activeDependencies.write(text);
      } else {
        activeDependencies.write(machineJson(result));
      }
      if (hasPartialCoverage(result)) activeDependencies.setExitCode?.(2);
    });

  program
    .command("organizations")
    .description("List organizations visible to the selected Neon credential")
    .addOption(demoOption())
    .action(async (options) => {
      const activeDependencies = resolveDependencies(options.demo);
      if (!activeDependencies.organizations) {
        throw new Error("Organization discovery is unavailable in the configured CLI adapter");
      }
      activeDependencies.write(machineJson(await activeDependencies.organizations()));
    });

  program
    .command("projects")
    .description("List project names and IDs for an organization")
    .addOption(demoOption())
    .option("--org-id <id>", "Neon organization ID (defaults to NEON_ORG_ID or .neon)")
    .action(async (options) => {
      const activeDependencies = resolveDependencies(options.demo);
      if (!activeDependencies.projects) {
        throw new Error("Project discovery is unavailable in the configured CLI adapter");
      }
      const organizationId = await resolveOrganizationId(options.orgId, activeDependencies);
      activeDependencies.write(machineJson(await activeDependencies.projects(organizationId)));
    });

  const usageCommand = program
    .command("usage")
    .description("Show concise organization totals and active projects by name")
    .addOption(demoOption())
    .addOption(new Option("--output <format>", "output format").choices(["json", "table"]))
    .addOption(
      new Option("--format <units>", "quantities or estimated prices")
        .choices(["gb", "price"])
        .default("gb"),
    );
  addHistoryOptions(usageCommand, projectConsumptionMetrics, false).action(async (options) => {
    const activeDependencies = resolveDependencies(options.demo);
    const query = historyQueryFromOptions(options, runtime.now());
    query.organizationId = await resolveOrganizationId(query.organizationId, activeDependencies);
    const output = options.output ?? (runtime.isTTY ? "table" : "json");
    if (options.format === "price") {
      if (!activeDependencies.estimate) {
        throw new Error("Cost estimation is unavailable in the configured CLI adapter");
      }
      const estimate = await activeDependencies.estimate(query, collectionControl(options));
      let projectNames: Map<string, string> | undefined;
      if (output === "table" && activeDependencies.projects) {
        try {
          const directory = await activeDependencies.projects(query.organizationId);
          projectNames = new Map(directory.projects.map((project) => [project.id, project.name]));
        } catch {
          // Live names unavailable; fall back to names snapshotted in the
          // store at earlier collection times, then to bare IDs.
          projectNames = await activeDependencies.storedProjectNames?.(
            (estimate.lines ?? []).map((line) => line.projectId),
          );
        }
      }
      activeDependencies.write(
        output === "table" ? renderPriceTable(estimate, projectNames) : machineJson(estimate),
      );
      if (estimate.status !== "estimated") activeDependencies.setExitCode?.(2);
      return;
    }
    if (!activeDependencies.usageOverview) {
      throw new Error("Usage overview is unavailable in the configured CLI adapter");
    }
    const overview = await activeDependencies.usageOverview(query, collectionControl(options));
    activeDependencies.write(
      output === "table" ? renderUsageTable(overview) : machineJson(overview),
    );
    if (hasPartialCoverage(overview)) activeDependencies.setExitCode?.(2);
  });

  program
    .command("dashboard")
    .description(
      "Serve the local dashboard over the same read-only services (loopback only: 127.0.0.1 and ::1)",
    )
    .option("--no-open", "do not open the dashboard in your browser")
    .addOption(
      new Option("--port <port>", "bind a fixed port instead of an ephemeral one").argParser(
        parsePort,
      ),
    )
    .addOption(
      // The startup token guards /api against other local processes, but the
      // page loaded from the Vite dev server carries no token fragment, so its
      // proxied /api calls would 401. This opt-out is for that loopback dev
      // proxy (and embedding); the Host/Origin checks still stand.
      new Option("--no-token", "disable the /api startup token (for the Vite dev proxy)"),
    )
    .addOption(demoOption())
    .action(async (options) => {
      const activeDependencies = resolveDependencies(options.demo);
      const server = await startDashboardServer(
        activeDependencies,
        {
          ...(options.port !== undefined ? { port: options.port } : {}),
          ...(options.token === false ? { apiToken: null } : {}),
        },
        { now: runtime.now },
      );
      const write = activeDependencies.write;
      // No built page means we serve the JSON route index at / (a supported
      // state), which reads as "broken" to anyone expecting the UI. Point them
      // at the build step or the HMR dev loop rather than let it puzzle. Skip
      // it under --no-token: that's the Vite dev proxy, which fronts this
      // server with its own hot-reloading page, so this server's missing build
      // is irrelevant and the "run dev:dashboard" hint would be circular.
      if (options.token !== false && defaultAssetsDirectory() === null) {
        write(
          "Note: the dashboard UI is not built, so / serves the JSON route index.\n" +
            "  Build it once:  npm --prefix dashboard run build\n" +
            "  Or hot-reload:  npm run dev:dashboard\n",
        );
      }
      // The page URL carries the startup capability; the API refuses requests
      // without it, so other local processes can't read this account's data.
      // When the browser auto-opens it receives the token invisibly, so the
      // printed line stays clean; without auto-open the tokened URL is the way in.
      const opening = shouldOpenBrowser(options, process.env);
      write(
        `Dashboard running at ${opening ? server.url : server.pageUrl}\nPress Ctrl+C to stop.\n`,
      );
      if (opening) (runtime.openUrl ?? openBrowser)(server.pageUrl);
      // The command owns the process until interrupted; stores stay open
      // because runCli only closes them after this action resolves.
      await new Promise<void>((resolve) => {
        const stop = () => {
          process.removeListener("SIGINT", stop);
          process.removeListener("SIGTERM", stop);
          void server.close().finally(resolve);
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
    });

  program
    .command("doctor")
    .description(
      "Diagnose local setup offline: credential source and expiry, context, store health, budget (no Neon API requests)",
    )
    .addOption(new Option("--output <format>", "output format").choices(["json", "table"]))
    .action((options) => {
      // Always diagnoses the real environment — injected dependencies supply
      // only the output sink (this command exists to inspect the machine).
      const parsedBudget = parseRequestBudget(program.opts().requestBudget);
      const parsedCollectionBudget = parseCollectionBudget(program.opts());
      const report = createDoctorReport({
        cwd: process.cwd(),
        env: process.env,
        now: runtime.now(),
        options: program.opts(),
        ...(parsedBudget ? { requestBudget: parsedBudget } : {}),
        ...(parsedCollectionBudget ? { collectionBudget: parsedCollectionBudget } : {}),
      });
      const output = options.output ?? (runtime.isTTY ? "table" : "json");
      (dependencies?.write ?? ((value: string) => process.stdout.write(value)))(
        output === "table" ? renderDoctorReport(report) : machineJson(report),
      );
    });

  program
    .command("context")
    .description("Show resolved Neon context without exposing credentials")
    .action(() => {
      const resolved = dependencies ? undefined : resolveDefaultContext(program.opts());
      const result = dependencies
        ? resolvedContext(dependencies)
        : {
            organizationId: resolved?.organizationId ?? null,
            projectId: resolved?.projectId ?? null,
            branch: resolved?.branch ?? null,
            credential: resolved?.apiKey ? ("configured" as const) : ("missing" as const),
          };
      (dependencies?.write ?? ((value: string) => process.stdout.write(value)))(
        machineJson(contextReport(result)),
      );
    });

  try {
    await program.parseAsync(args, { from: "user" });
  } finally {
    for (const store of openedStores.splice(0)) store.close();
  }
}

/** `--demo` on the commands where synthetic data makes sense; doctor and
 * context always diagnose the real environment and deliberately lack it. */
function demoOption(): Option {
  return new Option(
    "--demo",
    "run against deterministic synthetic data: no credential, no Neon API, nothing real",
  );
}

function scopeOption(): Option {
  // No commander default: an EXPLICIT `--scope organization` must be
  // distinguishable from an omitted flag — typed out, it overrides the
  // linked-project default and reports the whole organization.
  return new Option(
    "--scope <scope>",
    "organization is invoice-aligned (explicitly overrides the linked-project default); live-projects is faster but excludes projects deleted during the window",
  ).choices(["organization", "live-projects"]);
}

function addHistoryOptions(
  command: Command,
  defaultMetrics: readonly string[],
  includeMetrics = true,
  includeStoreServing = true,
): Command {
  const base = command
    .option("--org-id <id>", "Neon organization ID (defaults to NEON_ORG_ID or .neon)")
    .option("--from <timestamp>", "RFC 3339 interval start (defaults by granularity)")
    .option("--to <timestamp>", "RFC 3339 interval end (defaults by granularity)")
    .option(
      "--last <duration>",
      "relative window; units follow --granularity (h/d/w hourly, d/w daily, mo monthly), e.g. 7d",
    )
    .option(
      "--month <month>",
      "a calendar month (2026-07), or 'current'/'previous' (current month is to-date)",
    )
    .option("--run-id <run-id>", "use an explicit ID for a new collection run")
    .option("--resume <run-id>", "resume an interrupted collection run");
  // Serve-from-store controls only apply to commands that actually replay from
  // the store; branch-report always re-collects, so they'd be inert there.
  const withStore = includeStoreServing
    ? base
        .option("--fresh", "collect everything from the API, ignoring the local store")
        .option(
          "--store-tail <buckets>",
          "trailing buckets always re-collected when serving from the store (default 0 treats closed buckets as final; raise to catch a late correction)",
        )
    : base;
  const configured = withStore.addOption(
    new Option("--granularity <granularity>", "history bucket size")
      .choices(["hourly", "daily", "monthly"])
      .default("daily"),
  );
  return includeMetrics
    ? configured.option(
        "--metrics <names>",
        "comma-separated v2 metric names",
        defaultMetrics.join(","),
      )
    : configured;
}

/**
 * Narrows a report from the `unknown`-typed dependency seam before a table
 * presenter indexes into it. A custom ReportDependencies returning the wrong
 * shape fails here with a named error instead of crashing deep inside
 * rendering. JSON output does not need this — it serializes any value.
 */
function asReport<T>(value: unknown, command: string): T {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${command} returned an unexpected report shape for table rendering`);
  }
  return value as T;
}

function collectionControl(
  options: Record<string, string | boolean>,
): CollectionControl | undefined {
  if (options.resume && options.runId) {
    throw new Error("--resume cannot be combined with --run-id");
  }
  const control: CollectionControl = {};
  const value = options.resume ?? options.runId;
  if (value) {
    if (typeof value !== "string" || !/^run_[A-Za-z0-9-]{1,100}$/.test(value)) {
      throw new Error(
        `${options.resume ? "--resume" : "--run-id"} must be a valid collection run ID`,
      );
    }
    if (options.resume) control.resumeRunId = value as `run_${string}`;
    else control.runId = value as `run_${string}`;
  }
  if (options.fresh === true) {
    control.storeServing = { serve: false, tailBuckets: 0 };
  } else if (options.storeTail !== undefined) {
    const tail = Number(options.storeTail);
    if (!Number.isInteger(tail) || tail < 0 || tail > 1000) {
      throw new Error("--store-tail must be an integer between 0 and 1000");
    }
    control.storeServing = { serve: true, tailBuckets: tail };
  }
  return Object.keys(control).length > 0 ? control : undefined;
}

// Composition lives in default-dependencies.ts; this adapter only supplies
// the resolved credential/store/context and the CLI-specific output concerns.
function createDefaultDependencies(
  options: Record<string, string | undefined>,
  openedStores: EvidenceFactStore[],
): CliDependencies {
  const context = resolveDefaultContext(options);
  assertCredentialResolved(context.apiKey);
  // One durable store per user, not per working directory: --store wins, then
  // NEON_USAGE_STORE, then an OS-appropriate data directory.
  const requestBudget = parseRequestBudget(options.requestBudget);
  const collectionBudget = parseCollectionBudget(options);
  const dependencies = createNeonDependencies({
    apiKey: context.apiKey,
    storePath: options.store ?? defaultStorePath(process.env),
    ...(requestBudget ? { requestBudget } : {}),
    ...(collectionBudget ? { collectionBudget } : {}),
    context: {
      ...(context.organizationId ? { organizationId: context.organizationId } : {}),
      ...(context.projectId ? { projectId: context.projectId } : {}),
      ...(context.branch ? { branch: context.branch } : {}),
    },
    openedStores,
    onWarn: (message) => process.stderr.write(message),
    ...(process.env.NEON_USAGE_DEBUG
      ? { onDebug: (message: string) => process.stderr.write(message) }
      : {}),
  });
  return {
    ...dependencies,
    write: (value) => process.stdout.write(value),
    setExitCode: (value) => {
      process.exitCode = value;
    },
  };
}

function resolveDefaultContext(options: Record<string, string | undefined>) {
  return resolveNeonCliContext({
    cwd: process.cwd(),
    env: process.env,
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    ...(options.profile ? { profile: options.profile } : {}),
    ...(options.contextFile ? { contextFile: options.contextFile } : {}),
    ...(options.configDir ? { configDir: options.configDir } : {}),
  });
}

// The executable entry point lives in bin.ts, which imports runCli and runs it
// unconditionally. Keeping the run out of this module means importing it (tests,
// embedders) has no side effect, and there is no fragile "am I the main module?"
// heuristic to break under a bin symlink (npx / global install).
