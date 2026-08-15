import { describe, expect, it } from "vitest";
import {
  assertCredentialResolved,
  browserOpenCommand,
  parseCollectionBudget,
  parsePort,
  parseRequestBudget,
  runCli,
  shouldOpenBrowser,
} from "../src/cli.js";
import { CliError } from "../src/errors.js";
import type { ProjectReportQuery, UsageOverview } from "../src/index.js";

describe("CLI project-report", () => {
  it("passes a normalized query to the application service and writes JSON", async () => {
    let receivedQuery: ProjectReportQuery | undefined;
    let stdout = "";
    const report = { schemaVersion: 1, coverage: { status: "complete" } };

    await runCli(
      [
        "project-report",
        "--org-id",
        "org-1",
        "--from",
        "2026-08-07T00:00:00Z",
        "--to",
        "2026-08-08T00:00:00Z",
        "--granularity",
        "daily",
        "--metrics",
        "compute_unit_seconds,root_branch_bytes_month",
      ],
      {
        projectReport: async (query) => {
          receivedQuery = query;
          return report;
        },
        branchReport: async () => ({ unused: true }),
        organizationSummary: async () => ({ unused: true }),
        capabilities: async () => ({ unused: true }),
        currentReport: async () => ({ unused: true }),
        write: (value) => {
          stdout += value;
        },
      },
    );

    expect(receivedQuery).toEqual({
      organizationId: "org-1",
      from: "2026-08-07T00:00:00Z",
      to: "2026-08-08T00:00:00Z",
      granularity: "daily",
      metrics: ["compute_unit_seconds", "root_branch_bytes_month"],
    });
    expect(JSON.parse(stdout)).toEqual(report);
  });

  it("passes resume as collection control without adding it to report JSON", async () => {
    let resumeRunId: string | undefined;
    let stdout = "";
    await runCli(["project-report", "--org-id", "org-1", "--resume", "run_existing"], {
      projectReport: async (_query, control) => {
        resumeRunId = control?.resumeRunId;
        return { schemaVersion: 1, coverage: { status: "complete" } };
      },
      branchReport: async () => ({ unused: true }),
      organizationSummary: async () => ({ unused: true }),
      capabilities: async () => ({ unused: true }),
      currentReport: async () => ({ unused: true }),
      write: (value) => {
        stdout += value;
      },
    });

    expect(resumeRunId).toBe("run_existing");
    expect(JSON.parse(stdout)).not.toHaveProperty("runId");
  });

  const collectDefaultQuery = async (now: Date): Promise<ProjectReportQuery | undefined> => {
    let receivedQuery: ProjectReportQuery | undefined;
    await runCli(
      ["project-report"],
      {
        projectReport: async (query) => {
          receivedQuery = query;
          return { coverage: { status: "complete" } };
        },
        branchReport: async () => ({ unused: true }),
        organizationSummary: async () => ({ unused: true }),
        capabilities: async () => ({ unused: true }),
        currentReport: async () => ({ unused: true }),
        defaultOrganizationId: "org-context",
        defaultProjectId: "project-context",
        write: () => {},
      },
      { now: () => now, isTTY: false },
    );
    return receivedQuery;
  };

  it("defaults project history to the current calendar month to date, daily", async () => {
    const receivedQuery = await collectDefaultQuery(new Date("2026-08-11T09:00:00Z"));

    expect(receivedQuery?.organizationId).toBe("org-context");
    expect(receivedQuery?.projectIds).toEqual(["project-context"]);
    expect(receivedQuery?.granularity).toBe("daily");
    expect(receivedQuery?.metrics).toEqual([
      "compute_unit_seconds",
      "root_branch_bytes_month",
      "child_branch_bytes_month",
      "instant_restore_bytes_month",
      "snapshot_storage_bytes_month",
      "public_network_transfer_bytes",
      "private_network_transfer_bytes",
      "extra_branches_month",
    ]);
    expect(receivedQuery?.from).toBe("2026-08-01T00:00:00.000Z");
    expect(receivedQuery?.to).toBe("2026-08-11T00:00:00.000Z");
  });

  it("falls back to the last 7 days on the first of the month", async () => {
    const receivedQuery = await collectDefaultQuery(new Date("2026-08-01T09:00:00Z"));
    expect(receivedQuery?.from).toBe("2026-07-25T00:00:00.000Z");
    expect(receivedQuery?.to).toBe("2026-08-01T00:00:00.000Z");
  });

  it("does not reuse a linked project when the organization is overridden", async () => {
    let receivedQuery: ProjectReportQuery | undefined;

    await runCli(["project-report", "--org-id", "org-other"], {
      projectReport: async (query) => {
        receivedQuery = query;
        return { coverage: { status: "complete" } };
      },
      branchReport: async () => ({ unused: true }),
      organizationSummary: async () => ({ unused: true }),
      capabilities: async () => ({ unused: true }),
      currentReport: async () => ({ unused: true }),
      defaultOrganizationId: "org-context",
      defaultProjectId: "project-context",
      write: () => {},
    });

    expect(receivedQuery?.organizationId).toBe("org-other");
    expect(receivedQuery?.projectIds).toBeUndefined();
  });

  it("supports concise relative history windows", async () => {
    let receivedQuery: ProjectReportQuery | undefined;
    await runCli(["project-report", "--granularity", "hourly", "--last", "1h"], {
      projectReport: async (query) => {
        receivedQuery = query;
        return { coverage: { status: "complete" } };
      },
      branchReport: async () => ({ unused: true }),
      organizationSummary: async () => ({ unused: true }),
      capabilities: async () => ({ unused: true }),
      currentReport: async () => ({ unused: true }),
      defaultOrganizationId: "org-context",
      write: () => {},
    });

    expect(receivedQuery?.granularity).toBe("hourly");
    expect(
      new Date(receivedQuery?.to ?? "").getTime() - new Date(receivedQuery?.from ?? "").getTime(),
    ).toBe(60 * 60 * 1000);
  });

  it("writes a cost estimate and signals non-estimated results", async () => {
    let stdout = "";
    let exitCode: number | undefined;
    await runCli(["estimate", "--last", "7d"], {
      projectReport: async () => ({ unused: true }),
      branchReport: async () => ({ unused: true }),
      organizationSummary: async () => ({ unused: true }),
      capabilities: async () => ({ unused: true }),
      currentReport: async () => ({ unused: true }),
      estimate: async () =>
        ({
          schemaVersion: 1,
          kind: "pricing_estimate",
          disposition: "estimate",
          status: "unavailable_partial_coverage",
          totalAmount: null,
        }) as never,
      defaultOrganizationId: "org-context",
      write: (value) => {
        stdout += value;
      },
      setExitCode: (value) => {
        exitCode = value;
      },
    });

    expect(stdout).toContain('"disposition": "estimate"');
    expect(exitCode).toBe(2);
  });

  it("rejects a relative window that exceeds the granularity lookback", async () => {
    await expect(
      runCli(["project-report", "--granularity", "hourly", "--last", "4w"], {
        projectReport: async () => {
          throw new Error("must not reach the source");
        },
        branchReport: async () => ({ unused: true }),
        organizationSummary: async () => ({ unused: true }),
        capabilities: async () => ({ unused: true }),
        currentReport: async () => ({ unused: true }),
        defaultOrganizationId: "org-context",
        write: () => {},
      }),
    ).rejects.toThrow("--last 4w exceeds the 168 hours lookback for this granularity");
  });

  it("rejects ambiguous absolute and relative ranges", async () => {
    await expect(
      runCli(["project-report", "--last", "7d", "--from", "2026-08-01T00:00:00Z"], {
        projectReport: async () => ({ unused: true }),
        branchReport: async () => ({ unused: true }),
        organizationSummary: async () => ({ unused: true }),
        capabilities: async () => ({ unused: true }),
        currentReport: async () => ({ unused: true }),
        defaultOrganizationId: "org-context",
        write: () => {},
      }),
    ).rejects.toThrow("--last cannot be combined with --from or --to");
  });

  it("requires absolute range boundaries as a pair", async () => {
    await expect(
      runCli(["project-report", "--from", "2026-08-01T00:00:00Z"], {
        projectReport: async () => ({ unused: true }),
        branchReport: async () => ({ unused: true }),
        organizationSummary: async () => ({ unused: true }),
        capabilities: async () => ({ unused: true }),
        currentReport: async () => ({ unused: true }),
        defaultOrganizationId: "org-context",
        write: () => {},
      }),
    ).rejects.toThrow("Pass --from and --to together, or use --last");
  });

  it("exposes plan capabilities without requiring a history range", async () => {
    let stdout = "";
    const capabilities = {
      organizationId: "org-1",
      declaredPlan: { raw: "free", family: "free" },
    };

    await runCli(["capabilities", "--org-id", "org-1"], {
      projectReport: async () => ({ unused: true }),
      branchReport: async () => ({ unused: true }),
      organizationSummary: async () => ({ unused: true }),
      capabilities: async () => capabilities,
      currentReport: async () => ({ unused: true }),
      write: (value) => {
        stdout += value;
      },
    });

    expect(JSON.parse(stdout)).toEqual(capabilities);
  });

  it("uses the default organization from Neon context", async () => {
    let organizationId = "";

    await runCli(["capabilities"], {
      projectReport: async () => ({ unused: true }),
      branchReport: async () => ({ unused: true }),
      organizationSummary: async () => ({ unused: true }),
      capabilities: async (value) => {
        organizationId = value;
        return { organizationId: value };
      },
      currentReport: async () => ({ unused: true }),
      defaultOrganizationId: "org-context",
      write: () => {},
    });

    expect(organizationId).toBe("org-context");
  });

  it("automatically selects the only visible organization", async () => {
    let organizationId = "";

    await runCli(["capabilities"], {
      projectReport: async () => ({ unused: true }),
      branchReport: async () => ({ unused: true }),
      organizationSummary: async () => ({ unused: true }),
      capabilities: async (value) => {
        organizationId = value;
        return { organizationId: value };
      },
      currentReport: async () => ({ unused: true }),
      organizations: async () => [{ id: "org-only", name: "Only", handle: "only", plan: "launch" }],
      write: () => {},
    });

    expect(organizationId).toBe("org-only");
  });

  it("lists organizations without requiring an organization selection", async () => {
    let stdout = "";
    const organizations = [
      { id: "org-1", name: "One", handle: "one", plan: "launch" },
      { id: "org-2", name: "Two", handle: "two", plan: "scale" },
    ];

    await runCli(["organizations"], {
      projectReport: async () => ({ unused: true }),
      branchReport: async () => ({ unused: true }),
      organizationSummary: async () => ({ unused: true }),
      capabilities: async () => ({ unused: true }),
      currentReport: async () => ({ unused: true }),
      organizations: async () => organizations,
      write: (value) => {
        stdout += value;
      },
    });

    expect(JSON.parse(stdout)).toEqual(organizations);
  });

  it("writes the concise usage overview", async () => {
    let stdout = "";
    let receivedQuery: ProjectReportQuery | undefined;
    const overview: UsageOverview = {
      schemaVersion: 1 as const,
      kind: "usage_overview" as const,
      generatedAt: "2026-08-09T12:00:00.000Z",
      asOf: "2026-08-09T00:00:00.000Z",
      organization: { id: "org-context", name: "Example", plan: "launch" },
      effectiveRange: {
        from: "2026-08-02T00:00:00.000Z",
        to: "2026-08-09T00:00:00.000Z",
        granularity: "daily",
      },
      coverage: { status: "complete", pageCount: 1, entityCount: 1, qualityFlags: [] },
      totals: [
        {
          name: "compute_unit_seconds",
          raw: { value: "3600", unit: "cu_second" },
          derived: {
            exact: { numerator: "1", denominator: "1" },
            decimalApproximation: "1",
            decimalPrecision: 40,
            rounding: "half_up",
            unit: "cu_hour",
          },
        },
      ],
      activeProjects: [
        {
          projectId: "project-1",
          name: "Active",
          metrics: [
            {
              name: "compute_unit_seconds",
              rawValue: "3600",
              rawUnit: "cu_second",
              displayValue: "1",
              displayUnit: "cu_hour",
            },
          ],
        },
      ],
      observedProjectCount: 2,
      unavailableProjectIds: [],
      enrichmentWarnings: [],
    };

    await runCli(["usage"], {
      projectReport: async () => ({ unused: true }),
      branchReport: async () => ({ unused: true }),
      organizationSummary: async () => ({ unused: true }),
      capabilities: async () => ({ unused: true }),
      currentReport: async () => ({ unused: true }),
      usageOverview: async (query) => {
        receivedQuery = query;
        return overview;
      },
      defaultOrganizationId: "org-context",
      write: (value) => {
        stdout += value;
      },
    });

    expect(receivedQuery?.organizationId).toBe("org-context");
    expect(receivedQuery?.metrics).toHaveLength(8);
    expect(JSON.parse(stdout)).toEqual(overview);
  });

  it("renders usage as a human-readable table", async () => {
    let stdout = "";
    await runCli(["usage", "--output", "table"], {
      projectReport: async () => ({ unused: true }),
      branchReport: async () => ({ unused: true }),
      organizationSummary: async () => ({ unused: true }),
      capabilities: async () => ({ unused: true }),
      currentReport: async () => ({ unused: true }),
      usageOverview: async () => ({
        schemaVersion: 1,
        kind: "usage_overview",
        generatedAt: "2026-08-09T12:00:00.000Z",
        asOf: "2026-08-09T00:00:00.000Z",
        organization: { id: "org-context", name: "Example", plan: "launch" },
        effectiveRange: {
          from: "2026-08-02T00:00:00.000Z",
          to: "2026-08-09T00:00:00.000Z",
          granularity: "daily",
        },
        coverage: { status: "complete", pageCount: 1, entityCount: 1, qualityFlags: [] },
        totals: [
          {
            name: "compute_unit_seconds",
            raw: { value: "3600", unit: "cu_second" },
            derived: {
              exact: { numerator: "1", denominator: "1" },
              decimalApproximation: "1",
              decimalPrecision: 40,
              rounding: "half_up",
              unit: "cu_hour",
            },
          },
        ],
        activeProjects: [
          {
            projectId: "project-1",
            name: "Active",
            metrics: [
              {
                name: "compute_unit_seconds",
                rawValue: "3600",
                rawUnit: "cu_second",
                displayValue: "1",
                displayUnit: "cu_hour",
              },
            ],
          },
        ],
        observedProjectCount: 2,
        unavailableProjectIds: [],
        enrichmentWarnings: [],
      }),
      defaultOrganizationId: "org-context",
      write: (value) => {
        stdout += value;
      },
    });

    expect(stdout).toContain("Neon usage · Example (org-context) · launch");
    expect(stdout).toMatch(/Active\s+project-1/);
    expect(stdout).toContain("TOTAL");
    expect(stdout).toContain("1.00 CU·h");
    // Presenters stay adapter-neutral: no CLI invocation syntax in tables.
    expect(stdout).not.toContain("neon-usage project-report");
  });

  it("does not render missing partial totals as zero", async () => {
    let stdout = "";
    await runCli(["usage", "--output", "table"], {
      projectReport: async () => ({ unused: true }),
      branchReport: async () => ({ unused: true }),
      organizationSummary: async () => ({ unused: true }),
      capabilities: async () => ({ unused: true }),
      currentReport: async () => ({ unused: true }),
      usageOverview: async () => ({
        schemaVersion: 1,
        kind: "usage_overview",
        generatedAt: "2026-08-09T12:00:00.000Z",
        asOf: "2026-08-09T00:00:00.000Z",
        organization: { id: "org-context", name: "Example", plan: "launch" },
        effectiveRange: {
          from: "2026-08-02T00:00:00.000Z",
          to: "2026-08-09T00:00:00.000Z",
          granularity: "daily",
        },
        coverage: {
          status: "partial",
          pageCount: 1,
          entityCount: 1,
          qualityFlags: ["SOURCE_REQUEST_FAILED"],
        },
        totals: null,
        activeProjects: [],
        observedProjectCount: 1,
        unavailableProjectIds: [],
        enrichmentWarnings: [],
      }),
      defaultOrganizationId: "org-context",
      write: (value) => {
        stdout += value;
      },
    });

    expect(stdout).toContain("TOTAL");
    expect(stdout).toContain("n/a");
    expect(stdout).toContain("totals are unavailable");
  });

  it("reports injected context without credentials", async () => {
    let stdout = "";

    await runCli(["context"], {
      projectReport: async () => ({ unused: true }),
      branchReport: async () => ({ unused: true }),
      organizationSummary: async () => ({ unused: true }),
      capabilities: async () => ({ unused: true }),
      currentReport: async () => ({ unused: true }),
      defaultOrganizationId: "org-context",
      write: (value) => {
        stdout += value;
      },
    });

    expect(JSON.parse(stdout)).toEqual({
      organizationId: "org-context",
      projectId: null,
      branch: null,
      credential: "injected",
    });
  });

  it("exposes organization summaries through the same query options", async () => {
    let stdout = "";
    const summary = { schemaVersion: 1, scope: { kind: "organization_aggregate" } };

    await runCli(
      [
        "organization-summary",
        "--org-id",
        "org-1",
        "--from",
        "2026-08-07T00:00:00Z",
        "--to",
        "2026-08-08T00:00:00Z",
        "--granularity",
        "daily",
        "--metrics",
        "compute_unit_seconds",
      ],
      {
        projectReport: async () => ({ unused: true }),
        branchReport: async () => ({ unused: true }),
        organizationSummary: async () => summary,
        capabilities: async () => ({ unused: true }),
        currentReport: async () => ({ unused: true }),
        write: (value) => {
          stdout += value;
        },
      },
    );

    expect(JSON.parse(stdout)).toEqual(summary);
  });

  it("sets exit code 2 while retaining a partial organization summary", async () => {
    let exitCode: number | undefined;
    const partial = { coverage: { status: "partial" }, metrics: null };

    await runCli(
      [
        "organization-summary",
        "--org-id",
        "org-1",
        "--from",
        "2026-08-07T00:00:00Z",
        "--to",
        "2026-08-08T00:00:00Z",
        "--granularity",
        "daily",
        "--metrics",
        "compute_unit_seconds",
      ],
      {
        projectReport: async () => ({ unused: true }),
        branchReport: async () => ({ unused: true }),
        organizationSummary: async () => partial,
        capabilities: async () => ({ unused: true }),
        currentReport: async () => ({ unused: true }),
        write: () => {},
        setExitCode: (value) => {
          exitCode = value;
        },
      },
    );

    expect(exitCode).toBe(2);
  });

  it("passes project and branch filters to branch history", async () => {
    let receivedProjectIds: string[] | undefined;
    let receivedBranchIds: string[] | undefined;

    await runCli(
      [
        "branch-report",
        "--org-id",
        "org-1",
        "--project-ids",
        "project-1,project-2",
        "--branch-ids",
        "branch-1",
        "--from",
        "2026-08-07T00:00:00Z",
        "--to",
        "2026-08-08T00:00:00Z",
        "--granularity",
        "daily",
        "--metrics",
        "compute_unit_seconds",
      ],
      {
        projectReport: async () => ({ unused: true }),
        branchReport: async (query) => {
          receivedProjectIds = query.projectIds;
          receivedBranchIds = query.branchIds;
          return { branches: [] };
        },
        organizationSummary: async () => ({ unused: true }),
        capabilities: async () => ({ unused: true }),
        currentReport: async () => ({ unused: true }),
        write: () => {},
      },
    );

    expect(receivedProjectIds).toEqual(["project-1", "project-2"]);
    expect(receivedBranchIds).toEqual(["branch-1"]);
  });

  it("sets exit code 2 for partial branch traversal", async () => {
    let exitCode: number | undefined;

    await runCli(
      [
        "branch-report",
        "--org-id",
        "org-1",
        "--project-ids",
        "project-1",
        "--from",
        "2026-08-07T00:00:00Z",
        "--to",
        "2026-08-08T00:00:00Z",
        "--granularity",
        "daily",
        "--metrics",
        "compute_unit_seconds",
      ],
      {
        projectReport: async () => ({ unused: true }),
        branchReport: async () => ({ coverage: { status: "partial" } }),
        organizationSummary: async () => ({ unused: true }),
        capabilities: async () => ({ unused: true }),
        currentReport: async () => ({ unused: true }),
        write: () => {},
        setExitCode: (value) => {
          exitCode = value;
        },
      },
    );

    expect(exitCode).toBe(2);
  });

  it.each(["project-report", "current-report"])(
    "sets exit code 2 for partial %s output",
    async (command) => {
      let exitCode: number | undefined;
      const args =
        command === "project-report"
          ? [
              command,
              "--org-id",
              "org-1",
              "--from",
              "2026-08-07T00:00:00Z",
              "--to",
              "2026-08-08T00:00:00Z",
              "--granularity",
              "daily",
              "--metrics",
              "compute_unit_seconds",
            ]
          : [command, "--org-id", "org-1"];

      await runCli(args, {
        projectReport: async () => ({ coverage: { status: "partial" } }),
        branchReport: async () => ({ unused: true }),
        organizationSummary: async () => ({ unused: true }),
        capabilities: async () => ({ unused: true }),
        currentReport: async () => ({ coverage: { status: "partial" } }),
        write: () => {},
        setExitCode: (value) => {
          exitCode = value;
        },
      });

      expect(exitCode).toBe(2);
    },
  );
});

describe("dashboard browser opening", () => {
  it("opens by default and when --open is explicit", () => {
    expect(shouldOpenBrowser({ open: true })).toBe(true);
    expect(shouldOpenBrowser({})).toBe(true);
  });

  it("stays closed when --no-open sets open to false", () => {
    expect(shouldOpenBrowser({ open: false })).toBe(false);
  });

  it("honors BROWSER=none as a headless escape hatch", () => {
    expect(shouldOpenBrowser({ open: true }, { BROWSER: "none" })).toBe(false);
    expect(shouldOpenBrowser({ open: true }, { BROWSER: "firefox" })).toBe(true);
  });

  it("maps each platform to its launcher without a shell", () => {
    const url = "http://127.0.0.1:4321";
    expect(browserOpenCommand("darwin", url)).toEqual(["open", [url]]);
    expect(browserOpenCommand("linux", url)).toEqual(["xdg-open", [url]]);
    // Windows needs the empty-title placeholder so `start` treats the URL as the target.
    expect(browserOpenCommand("win32", url)).toEqual(["cmd", ["/c", "start", "", url]]);
  });
});

describe("history commands default to the linked project", () => {
  const baseDeps = {
    projectReport: async () => ({ unused: true }),
    branchReport: async () => ({ unused: true }),
    organizationSummary: async () => ({ unused: true }),
    capabilities: async () => ({ unused: true }),
    currentReport: async () => ({ unused: true }),
  };

  it("branch-report defaults to the linked project instead of requiring --project-ids", async () => {
    let received: { projectIds?: string[] } | undefined;
    await runCli(["branch-report"], {
      ...baseDeps,
      branchReport: async (query) => {
        received = query;
        return { schemaVersion: 1, coverage: { status: "complete" } };
      },
      defaultOrganizationId: "org-context",
      defaultProjectId: "project-context",
      write: () => {},
    });
    expect(received?.projectIds).toEqual(["project-context"]);
  });

  it("branch-report errors clearly when no project is linked or given", async () => {
    await expect(
      runCli(["branch-report"], {
        ...baseDeps,
        branchReport: async () => {
          throw new Error("must not reach the source");
        },
        defaultOrganizationId: "org-context",
        write: () => {},
      }),
    ).rejects.toThrow(/No project to report on/);
  });

  it("current-report defaults to the linked project, and 'all' widens to the org", async () => {
    const seen: Array<string[] | undefined> = [];
    const deps = {
      ...baseDeps,
      currentReport: async (_org: string, projectIds?: string[]) => {
        seen.push(projectIds);
        return { schemaVersion: 1, coverage: { status: "complete" } };
      },
      defaultOrganizationId: "org-context",
      defaultProjectId: "project-context",
      write: () => {},
    };
    await runCli(["current-report"], deps);
    await runCli(["current-report", "--project-ids", "all"], deps);
    expect(seen[0]).toEqual(["project-context"]);
    expect(seen[1]).toBeUndefined();
  });
});

describe("parseRequestBudget", () => {
  it("accepts whole per-minute values within 1-600 and rejects the rest", () => {
    expect(parseRequestBudget(undefined)).toBeUndefined();
    expect(parseRequestBudget("45")).toEqual({ limit: 45, intervalMs: 60_000 });
    expect(parseRequestBudget("600")).toEqual({ limit: 600, intervalMs: 60_000 });
    for (const invalid of ["0", "601", "4.5", "abc", "-1", ""]) {
      expect(() => parseRequestBudget(invalid)).toThrow(/between 1 and 600/);
    }
  });
});

describe("assertCredentialResolved", () => {
  it("passes through when an API key resolved", () => {
    expect(() => assertCredentialResolved("a-key")).not.toThrow();
  });

  it("throws a CliError guiding mint plus profile selection when none resolved", () => {
    let thrown: unknown;
    try {
      assertCredentialResolved(undefined);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CliError);
    const error = thrown as CliError;
    expect(error.headline).toBe("No Neon credential found");
    // Minting alone leaves the user on the DEFAULT profile, so the fix must
    // name the selection step or the advice loops back to the same error.
    expect(error.fix).toContain("neon profile create <name> --mint");
    expect(error.fix).toContain("neon-usage --profile <name>");
    expect(error.fix).not.toContain("--api-key");
  });
});

describe("parsePort", () => {
  it("accepts an integer TCP port in 1-65535 and rejects the rest", () => {
    expect(parsePort("4321")).toBe(4321);
    expect(parsePort("1")).toBe(1);
    expect(parsePort("65535")).toBe(65535);
    for (const invalid of ["0", "65536", "4.5", "abc", "-1", ""]) {
      expect(() => parsePort(invalid)).toThrow(/between 1 and 65535/);
    }
  });
});

describe("parseCollectionBudget", () => {
  it("converts minutes and passes counts through, absent when no dial is set", () => {
    expect(parseCollectionBudget({})).toBeUndefined();
    expect(
      parseCollectionBudget({
        maxDuration: "5",
        maxItems: "200",
        maxFacts: "3000",
        maxBytes: "1000000",
      }),
    ).toEqual({ maxDurationMs: 300_000, maxItems: 200, maxFacts: 3000, maxBytes: 1_000_000 });
    expect(parseCollectionBudget({ maxItems: "50" })).toEqual({ maxItems: 50 });
  });

  it("rejects out-of-range dials with the flag name", () => {
    expect(() => parseCollectionBudget({ maxDuration: "61" })).toThrow(/--max-duration/);
    expect(() => parseCollectionBudget({ maxItems: "0" })).toThrow(/--max-items/);
    expect(() => parseCollectionBudget({ maxFacts: "1.5" })).toThrow(/--max-facts/);
    expect(() => parseCollectionBudget({ maxBytes: "1000000001" })).toThrow(/--max-bytes/);
  });
});

describe("CLI demo mode", () => {
  const captured = () => {
    let stdout = "";
    return {
      deps: {
        projectReport: async () => {
          throw new Error("demo must not use injected report dependencies");
        },
        branchReport: async () => ({}),
        organizationSummary: async () => ({}),
        capabilities: async () => ({}),
        currentReport: async () => ({}),
        write: (value: string) => {
          stdout += value;
        },
        // biome-ignore lint/suspicious/noExplicitAny: partial stub
      } as any,
      read: () => stdout,
    };
  };

  it("serves synthetic reports with the injected output sink", async () => {
    const sink = captured();
    await runCli(["usage", "--demo"], sink.deps, {
      now: () => new Date("2026-08-12T15:00:00Z"),
      isTTY: false,
    });
    const overview = JSON.parse(sink.read());
    expect(overview.organization).toMatchObject({ name: "Acme Cloud", plan: "launch" });
    expect(overview.coverage.status).toBe("complete");
  });

  it("renders demo tables for the linked-project default", async () => {
    const sink = captured();
    await runCli(["project-report", "--demo", "--output", "table"], sink.deps, {
      now: () => new Date("2026-08-12T15:00:00Z"),
      isTTY: false,
    });
    expect(sink.read()).toContain("org-demo-42813975 · api-production-11837462");
  });
});
