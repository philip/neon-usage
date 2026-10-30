import { describe, expect, it, vi } from "vitest";
import {
  MEASURED_USAGE_KIND,
  MEASURED_USAGE_SCHEMA_VERSION,
  MeasuredUsageContractError,
  parseMeasuredBillingUsage,
} from "../src/contracts.js";
import { deriveBillingValue } from "../src/metric-catalog.js";
import { metricDefinitions, projectConsumptionMetrics } from "../src/metric-definitions.js";

// biome-ignore lint/suspicious/noExplicitAny: mutation fixtures deliberately allow invalid contract shapes.
type MutableInput = Record<string, any>;

const period = { from: "2026-08-01T00:00:00Z", to: "2026-08-27T00:00:00Z" };
const formulas = {
  cu_hour: "compute_unit_seconds / 3600",
  active_hour: "active_time_seconds / 3600",
  gb_month: "bytes_month / 1e9",
  gb: "bytes / 1e9",
  branch_month_before_allowance: "branch_hours / 744",
};

function metric(name = "compute_unit_seconds", value = "3600") {
  const derived = deriveBillingValue(name, value);
  return {
    name,
    raw: { value, unit: name === "extra_branches_month" ? "branch_hour" : "cu_second" },
    derived: {
      exact: derived.exact,
      decimalApproximation: derived.decimalApproximation,
      unit: derived.unit,
    },
    presence: "reported",
  };
}

function validMeasuredUsage(): MutableInput {
  return {
    kind: MEASURED_USAGE_KIND,
    schemaVersion: MEASURED_USAGE_SCHEMA_VERSION,
    producerVersion: "0.5.0-test",
    generatedAt: "2026-08-27T12:00:00Z",
    asOf: period.to,
    period: { ...period, granularity: "daily" },
    scope: { kind: "organization_aggregate", organizationId: "org-1" },
    source: { contract: "consumption-history-v2", authoritative: true },
    metricSelection: { mode: "explicit", requested: ["compute_unit_seconds"] },
    coverage: { status: "complete", authoritative: true, qualityFlags: [], omittedMetrics: [] },
    metrics: [metric()],
    projects: [
      { projectId: "p", period: { ...period, granularity: "daily" }, metrics: [metric()] },
    ],
    billableBranchMonthComponents: {
      status: "unavailable",
      reasons: ["No pricing estimate supplied"],
      expectedIdentities: [],
      items: [],
    },
    unresolved: ["peakCu", "avgCu", "activeHours"].map((field) => ({
      field,
      reason: "Supply separately",
    })),
    formulas: { ...formulas },
    warnings: [],
    evidence: [{ evidenceId: "page-1", payloadHash: "hash-1" }],
  };
}

describe("history quality and authority", () => {
  it("parses measured schema v2 and rejects legacy v1", () => {
    expect(MEASURED_USAGE_SCHEMA_VERSION).toBe(2);
    const value = validMeasuredUsage();
    expect(parseMeasuredBillingUsage(value).schemaVersion).toBe(2);
    value.schemaVersion = 1;
    rejects(value, "UNSUPPORTED_VERSION");
  });

  it.each([
    "CURSOR_REPEATED",
    "EMPTY_PAGE_WITH_CURSOR",
    "SOURCE_REQUEST_FAILED",
    "ENTITY_DUPLICATED",
    "PAGE_LIMIT_REACHED",
    "TIME_LIMIT_REACHED",
    "ITEM_LIMIT_REACHED",
    "FACT_LIMIT_REACHED",
    "BYTE_LIMIT_REACHED",
  ])("rejects authoritative complete history carrying %s", (flag) => {
    const value = validMeasuredUsage();
    value.coverage.qualityFlags = [flag];
    expect(() => parseMeasuredBillingUsage(value)).toThrow(MeasuredUsageContractError);
    value.coverage.status = "partial";
    value.coverage.authoritative = false;
    value.metrics = null;
    expect(() => parseMeasuredBillingUsage(value)).not.toThrow();
  });

  it.each([
    "BETA_SOURCE",
    "BRANCH_HISTORY_COVERAGE_UNVERIFIED",
    "SOURCE_ZERO_OMITTED",
    "SOURCE_METRIC_UNKNOWN",
  ])("allows informational history flag %s", (flag) => {
    const value = validMeasuredUsage();
    value.coverage.qualityFlags = [flag];
    expect(() => parseMeasuredBillingUsage(value)).not.toThrow();
  });
});

function validSnapshot(): MutableInput {
  const value = validMeasuredUsage();
  value.source = { contract: "current-period-snapshot", authoritative: false };
  value.scope = { kind: "projects", organizationId: "org-1", projectIds: ["p", "q"] };
  value.metricSelection = { mode: "snapshot", requested: ["compute_unit_seconds"] };
  value.metrics = null;
  value.period = { ...period };
  value.projects[0].period = { ...period };
  value.coverage = {
    status: "partial",
    authoritative: false,
    qualityFlags: [],
    omittedMetrics: [],
    requestedProjectIds: ["p", "q"],
    returnedProjectIds: ["p"],
    missingProjectIds: ["q"],
    errors: [{ projectId: "q", source: "project_snapshot", message: "Unavailable" }],
  };
  value.pointInTimeStorage = {
    complete: false,
    totalLogicalSizeBytes: null,
    projects: [
      { projectId: "p", totalLogicalSizeBytes: "10" },
      { projectId: "q", totalLogicalSizeBytes: null },
    ],
  };
  return value;
}

function validComponents(): MutableInput {
  const value = validMeasuredUsage();
  value.metricSelection.requested = ["extra_branches_month"];
  value.metrics = [metric("extra_branches_month", "744")];
  value.projects[0].metrics = [metric("extra_branches_month", "744")];
  const allowanceWindow = { start: period.from, end: "2026-09-01T00:00:00Z" };
  value.billableBranchMonthComponents = {
    status: "complete",
    reasons: [],
    expectedIdentities: [{ projectId: "p", sourcePeriodId: "source-1", allowanceWindow }],
    items: [
      {
        projectId: "p",
        billingPeriod: { sourcePeriodId: "source-1", plan: "scale", start: period.from },
        allowanceWindow,
        raw: { value: "744", unit: "branch_hour" },
        allowanceApplied: {
          exact: { numerator: "1", denominator: "150" },
          unit: "branch_hour",
          scope: "per_project",
        },
        billable: { exact: { numerator: "111599", denominator: "111600" }, unit: "branch_month" },
        rateCardRevision: "2026-08",
        approximations: ["ALLOWANCE_WINDOW_APPROXIMATION"],
        certainty: "approximate",
      },
    ],
  };
  return value;
}

function rejects(value: unknown, code = "INCONSISTENT_VALUE") {
  expect(() => parseMeasuredBillingUsage(value)).toThrowError(expect.objectContaining({ code }));
}

describe("parseMeasuredBillingUsage", () => {
  it("accepts 10000 history projects with every supported metric, pricing identities, and page evidence", () => {
    const value = validComponents();
    const count = 10_000;
    const names = [...projectConsumptionMetrics].sort();
    const metrics = names.map((name) => {
      const raw = name === "extra_branches_month" ? "744" : "0";
      return { ...metric(name, raw), raw: { value: raw, unit: metricDefinitions[name].rawUnit } };
    });
    const component = value.billableBranchMonthComponents.items[0];
    const identity = value.billableBranchMonthComponents.expectedIdentities[0];
    value.metricSelection.requested = names;
    value.projects = Array.from({ length: count }, (_, index) => ({
      projectId: `p-${index}`,
      period: value.period,
      metrics,
    }));
    value.metrics = metrics.map((item) => {
      const raw = (BigInt(item.raw.value) * BigInt(count)).toString();
      return { ...metric(item.name, raw), raw: { value: raw, unit: item.raw.unit } };
    });
    value.billableBranchMonthComponents.items = value.projects.map(
      (project: { projectId: string }) => ({ ...component, projectId: project.projectId }),
    );
    value.billableBranchMonthComponents.expectedIdentities = value.projects.map(
      (project: { projectId: string }) => ({ ...identity, projectId: project.projectId }),
    );
    value.evidence = Array.from({ length: count }, (_, index) => ({
      evidenceId: `page-${index}`,
      payloadHash: `hash-${index}`,
    }));
    expect(parseMeasuredBillingUsage(value).projects).toHaveLength(count);
  }, 20_000);

  it.each([
    [
      "projects",
      (v: MutableInput) => {
        v.projects = Array(10_001);
      },
    ],
    [
      "nested metrics",
      (v: MutableInput) => {
        v.projects[0].metrics = Array(101);
      },
    ],
    [
      "snapshot errors",
      (v: MutableInput) => {
        v.coverage.errors = Array(10_001);
      },
    ],
    [
      "component approximations",
      (v: MutableInput) => {
        v.billableBranchMonthComponents.items = [{ approximations: Array(1001) }];
      },
    ],
    [
      "sparse bounded projects",
      (v: MutableInput) => {
        v.projects = Array(10_000);
      },
    ],
    [
      "formulas",
      (v: MutableInput) => {
        v.formulas = Object.fromEntries(
          Array.from({ length: 1001 }, (_, index) => [`f-${index}`, "formula"]),
        );
      },
    ],
    [
      "global entries",
      (v: MutableInput) => {
        v.billableBranchMonthComponents.items = Array(1000).fill({
          approximations: Array(1000).fill("flag"),
        });
      },
    ],
    [
      "inherited formula keys",
      (v: MutableInput) => {
        v.formulas = Object.assign(
          Object.create(
            Object.fromEntries(
              Array.from({ length: 1001 }, (_, index) => [`inherited-${index}`, "formula"]),
            ),
          ),
          v.formulas,
        );
      },
    ],
  ] as const)("rejects oversized or sparse %s before Zod reads scalar fields", (_name, mutate) => {
    const value = validSnapshot();
    mutate(value);
    const read = vi.fn(() => "0.5.0-test");
    Object.defineProperty(value, "producerVersion", { get: read });
    rejects(value, "INVALID_SHAPE");
    expect(read).not.toHaveBeenCalled();
  });

  it.each(["projects", "nested metrics"])("does not read elements of oversized %s", (field) => {
    const value = validMeasuredUsage();
    const read = vi.fn(() => {
      throw new Error("must not read oversized array");
    });
    const oversized = Array(field === "projects" ? 10_001 : 101);
    Object.defineProperty(oversized, 0, { get: read });
    if (field === "projects") value.projects = oversized;
    else value.projects[0].metrics = oversized;
    rejects(value, "INVALID_SHAPE");
    expect(read).not.toHaveBeenCalled();
  });

  it("checks the formula count before reading values", () => {
    const value = validMeasuredUsage();
    const read = vi.fn(() => {
      throw new Error("must not read oversized formulas");
    });
    value.formulas = Object.fromEntries(
      Array.from({ length: 1001 }, (_, index) => [`f-${index}`, "formula"]),
    );
    Object.defineProperty(value.formulas, "f-0", { get: read });
    rejects(value, "INVALID_SHAPE");
    expect(read).not.toHaveBeenCalled();
  });

  it("captures bounded arrays once before schema parsing", () => {
    const value = validMeasuredUsage();
    const projects = value.projects;
    let reads = 0;
    const read = vi.fn(() => (++reads === 1 ? projects : Array(1_000_000)));
    Object.defineProperty(value, "projects", { get: read });
    expect(parseMeasuredBillingUsage(value).projects).toHaveLength(1);
    expect(read).toHaveBeenCalledOnce();
  });

  it.each([
    "kind",
    "generatedAt",
    "nested raw",
    "revoked input",
    "revoked nested",
    "revoked rejection",
  ])("normalizes exceptions from %s to a contract error", (field) => {
    const value = validMeasuredUsage();
    const hostile = () => {
      throw new Error("secret getter failure");
    };
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    if (field === "revoked input") return rejects(revoked.proxy, "INVALID_SHAPE");
    if (field === "revoked rejection") {
      Object.defineProperty(value, "kind", {
        get: () => {
          throw revoked.proxy;
        },
      });
      return rejects(value, "INVALID_SHAPE");
    }
    if (field === "revoked nested") value.projects[0] = revoked.proxy;
    else if (field === "nested raw")
      Object.defineProperty(value.projects[0].metrics[0], "raw", { get: hostile });
    else Object.defineProperty(value, field, { get: hostile });
    rejects(value, "INVALID_SHAPE");
  });

  it.each(["complete", "partial"] as const)(
    "requires history granularity with %s coverage",
    (status) => {
      const value = validMeasuredUsage();
      value.coverage.status = status;
      if (status === "partial") {
        value.coverage.authoritative = false;
        value.metrics = null;
      }
      delete value.period.granularity;
      for (const project of value.projects) delete project.period.granularity;
      rejects(value, "INVALID_SHAPE");
    },
  );

  it("requires point-in-time storage for snapshots even when coverage is partial", () => {
    const value = validSnapshot();
    delete value.pointInTimeStorage;
    rejects(value, "INVALID_SHAPE");
  });

  it.each(["raw", "denominator"])(
    "rejects trailing whitespace in %s integer quantities",
    (field) => {
      const value = validMeasuredUsage();
      if (field === "raw") value.metrics[0].raw.value += "\n";
      else value.metrics[0].derived.exact.denominator += "\n";
      rejects(value, "INVALID_SHAPE");
    },
  );

  it.each([validMeasuredUsage, validSnapshot, validComponents])(
    "accepts valid bounded documents",
    (fixture) => {
      const value = fixture();
      expect(parseMeasuredBillingUsage(value)).toEqual(value);
    },
  );

  it("ignores unknown object fields without defaulting required fields", () => {
    const value = validMeasuredUsage();
    value.future = { nested: true };
    value.projects[0].future = true;
    expect(parseMeasuredBillingUsage(value)).not.toHaveProperty("future");
    delete value.coverage.omittedMetrics;
    rejects(value, "INVALID_SHAPE");
  });

  it("exposes a distinct contract error", () => {
    try {
      parseMeasuredBillingUsage(null);
    } catch (error) {
      expect(error).toBeInstanceOf(MeasuredUsageContractError);
      expect(error).toMatchObject({ code: "INVALID_SHAPE" });
    }
  });

  it.each([
    ["kind", "other", "UNSUPPORTED_KIND"],
    ["schemaVersion", 999, "UNSUPPORTED_VERSION"],
    ["schemaVersion", Number.MAX_SAFE_INTEGER + 1, "UNSUPPORTED_VERSION"],
  ])("rejects unsupported %s", (key, invalid, code) => {
    const value = validMeasuredUsage();
    value[key] = invalid;
    rejects(value, code as string);
  });

  const mutations: Array<[string, (value: MutableInput) => void, string?]> = [
    [
      "invalid timestamp",
      (v) => {
        v.generatedAt = "2026-02-30T00:00:00Z";
      },
      "INVALID_SHAPE",
    ],
    [
      "reversed period",
      (v) => {
        v.period.to = "2026-07-01T00:00:00Z";
      },
    ],
    [
      "wrong raw unit",
      (v) => {
        v.projects[0].metrics[0].raw.unit = "byte";
      },
    ],
    [
      "missing conversion",
      (v) => {
        delete v.projects[0].metrics[0].derived;
      },
    ],
    [
      "zero denominator",
      (v) => {
        v.metrics[0].derived.exact.denominator = "0";
      },
      "INVALID_SHAPE",
    ],
    [
      "unsafe numeric raw",
      (v) => {
        v.metrics[0].raw.value = Number.MAX_SAFE_INTEGER + 1;
      },
      "INVALID_SHAPE",
    ],
    [
      "malformed integer",
      (v) => {
        v.metrics[0].raw.value = "1e3";
      },
      "INVALID_SHAPE",
    ],
    [
      "negative raw",
      (v) => {
        v.metrics[0].raw.value = "-1";
      },
      "INVALID_SHAPE",
    ],
    [
      "wrong conversion",
      (v) => {
        v.metrics[0].derived.exact.numerator = "2";
      },
    ],
    [
      "wrong approximation",
      (v) => {
        v.metrics[0].derived.decimalApproximation = "2";
      },
    ],
    [
      "wrong derived unit",
      (v) => {
        v.metrics[0].derived.unit = "gb";
      },
    ],
    [
      "nonzero projected zero",
      (v) => {
        v.projects[0].metrics[0].presence = "projected_zero";
      },
    ],
    [
      "duplicate project",
      (v) => {
        v.projects.push(v.projects[0]);
      },
    ],
    [
      "duplicate metric",
      (v) => {
        v.projects[0].metrics.push(v.projects[0].metrics[0]);
      },
    ],
    [
      "wrong aggregate sum",
      (v) => {
        v.projects[0].metrics[0] = metric("compute_unit_seconds", "7200");
      },
    ],
    [
      "wrong aggregate presence",
      (v) => {
        v.metrics = [metric("compute_unit_seconds", "0")];
        v.projects[0].metrics = [metric("compute_unit_seconds", "0")];
        v.projects[0].metrics[0].presence = "projected_zero";
      },
    ],
    [
      "missing aggregate metric",
      (v) => {
        v.metrics = [];
      },
    ],
    [
      "unauthorized aggregate",
      (v) => {
        v.coverage.authoritative = false;
      },
    ],
    [
      "invalid source authority",
      (v) => {
        v.source.authoritative = false;
      },
      "INVALID_SHAPE",
    ],
    [
      "history scope mismatch",
      (v) => {
        v.scope = { kind: "projects", organizationId: "org-1", projectIds: ["p"] };
      },
    ],
    [
      "history project period mismatch",
      (v) => {
        v.projects[0].period.to = "2026-08-26T00:00:00Z";
      },
    ],
    [
      "snapshot-only selection",
      (v) => {
        v.metricSelection.requested = ["active_time_seconds"];
      },
    ],
    [
      "unsorted selection",
      (v) => {
        v.metricSelection.requested = ["root_branch_bytes_month", "compute_unit_seconds"];
      },
    ],
    [
      "duplicate selection",
      (v) => {
        v.metricSelection.requested.push("compute_unit_seconds");
      },
    ],
    [
      "unselected metric",
      (v) => {
        v.metricSelection.requested = ["extra_branches_month"];
      },
    ],
    [
      "wrong formula",
      (v) => {
        v.formulas.cu_hour = "compute_unit_seconds / 1";
      },
    ],
    [
      "missing frozen formula",
      (v) => {
        delete v.formulas.gb;
      },
    ],
    [
      "unknown flag without omissions",
      (v) => {
        v.coverage.qualityFlags = ["UNKNOWN_METRIC"];
      },
    ],
    [
      "omissions without unknown flag",
      (v) => {
        v.coverage.omittedMetrics = ["future_metric"];
      },
    ],
    [
      "unsorted omissions",
      (v) => {
        v.coverage.qualityFlags = ["UNKNOWN_METRIC"];
        v.coverage.omittedMetrics = ["z", "a"];
      },
    ],
    [
      "duplicate omissions",
      (v) => {
        v.coverage.qualityFlags = ["UNKNOWN_METRIC"];
        v.coverage.omittedMetrics = ["a", "a"];
      },
    ],
    [
      "unknown normalized metric",
      (v) => {
        v.metrics[0].name = "future_metric";
      },
    ],
    [
      "malformed evidence",
      (v) => {
        v.evidence = [{ evidenceId: "e" }];
      },
      "INVALID_SHAPE",
    ],
    [
      "malformed warnings",
      (v) => {
        v.warnings = [1];
      },
      "INVALID_SHAPE",
    ],
    [
      "missing unresolved input",
      (v) => {
        v.unresolved.pop();
      },
    ],
  ];
  it.each(mutations)("rejects %s", (_name, mutate, code) => {
    const value = validMeasuredUsage();
    mutate(value);
    rejects(value, code);
  });

  it("accepts unknown metric omissions and bounded additional formulas", () => {
    const value = validMeasuredUsage();
    value.coverage.qualityFlags = ["UNKNOWN_METRIC"];
    value.coverage.omittedMetrics = ["future_metric"];
    value.formulas.future_unit = "future_metric / 100";
    expect(parseMeasuredBillingUsage(value)).toEqual(value);
  });

  it("accepts partial and unavailable component coverage without claiming completeness", () => {
    const value = validComponents();
    const coverage = value.billableBranchMonthComponents;
    coverage.expectedIdentities.push({
      ...coverage.expectedIdentities[0],
      sourcePeriodId: "source-2",
    });
    coverage.status = "partial";
    coverage.reasons = ["One pricing line has no billable quantity"];
    expect(parseMeasuredBillingUsage(value)).toEqual(value);
    coverage.status = "unavailable";
    coverage.items = [];
    expect(parseMeasuredBillingUsage(value)).toEqual(value);
  });

  it("accepts exact zero presence and complete snapshot storage sums", () => {
    const history = validMeasuredUsage();
    history.metrics = [metric("compute_unit_seconds", "0")];
    history.projects[0].metrics = [metric("compute_unit_seconds", "0")];
    history.metrics[0].presence = "projected_zero";
    history.projects[0].metrics[0].presence = "projected_zero";
    expect(parseMeasuredBillingUsage(history)).toEqual(history);
    const snapshot = validSnapshot();
    snapshot.projects.push({ ...snapshot.projects[0], projectId: "q" });
    snapshot.coverage.status = "complete";
    snapshot.coverage.returnedProjectIds = ["p", "q"];
    snapshot.coverage.missingProjectIds = [];
    snapshot.coverage.errors = [];
    snapshot.pointInTimeStorage = {
      complete: true,
      totalLogicalSizeBytes: "30",
      projects: [
        { projectId: "p", totalLogicalSizeBytes: "10" },
        { projectId: "q", totalLogicalSizeBytes: "20" },
      ],
    };
    expect(parseMeasuredBillingUsage(snapshot)).toEqual(snapshot);
    snapshot.pointInTimeStorage.totalLogicalSizeBytes = "31";
    rejects(snapshot);
  });

  it("keeps exact quantities above the JavaScript safe integer range", () => {
    const value = validMeasuredUsage();
    const raw = "9".repeat(128);
    value.metrics = [metric("compute_unit_seconds", raw)];
    value.projects[0].metrics = [metric("compute_unit_seconds", raw)];
    expect(parseMeasuredBillingUsage(value).metrics?.[0]?.raw.value).toBe(raw);
  });

  it("rejects reversed submillisecond periods before Date can truncate them", () => {
    const value = validMeasuredUsage();
    value.period = {
      from: "2026-08-01T00:00:00.0009Z",
      to: "2026-08-01T00:00:00.0001Z",
      granularity: "daily",
    };
    value.projects[0].period = { ...value.period };
    rejects(value, "INVALID_SHAPE");
  });

  it.each(["1", "12", "123"])("accepts supported fractional precision .%s", (fraction) => {
    const value = validMeasuredUsage();
    value.generatedAt = `2026-08-27T12:00:00.${fraction}Z`;
    expect(parseMeasuredBillingUsage(value)).toEqual(value);
  });

  it("bounds partial component quantities by each project's measured branch hours", () => {
    const value = validComponents();
    const coverage = value.billableBranchMonthComponents;
    coverage.status = "partial";
    coverage.reasons = ["Missing second project pricing"];
    coverage.expectedIdentities.push({
      ...coverage.expectedIdentities[0],
      projectId: "q",
      sourcePeriodId: "source-2",
    });
    value.projects[0].metrics = [metric("extra_branches_month", "743")];
    value.projects.push({
      projectId: "q",
      period: { ...value.period },
      metrics: [metric("extra_branches_month", "1")],
    });
    rejects(value);
  });

  it("accepts partial component quantities below measured branch hours", () => {
    const value = validComponents();
    value.billableBranchMonthComponents.status = "partial";
    value.billableBranchMonthComponents.reasons = ["Missing second source period pricing"];
    value.billableBranchMonthComponents.expectedIdentities.push({
      ...value.billableBranchMonthComponents.expectedIdentities[0],
      sourcePeriodId: "source-2",
    });
    value.projects[0].metrics = [metric("extra_branches_month", "1488")];
    value.metrics = [metric("extra_branches_month", "1488")];
    expect(parseMeasuredBillingUsage(value)).toEqual(value);
  });

  it("requires components to belong to a selected branch metric", () => {
    const value = validComponents();
    value.metricSelection.requested = ["compute_unit_seconds"];
    value.projects[0].metrics = [metric()];
    value.metrics = [metric()];
    const item = value.billableBranchMonthComponents.items[0];
    item.raw.value = "0";
    item.allowanceApplied.exact = { numerator: "0", denominator: "1" };
    item.billable.exact = { numerator: "0", denominator: "1" };
    rejects(value);
  });

  it("requires expected component windows to overlap the measured query", () => {
    const value = validComponents();
    value.billableBranchMonthComponents.status = "unavailable";
    value.billableBranchMonthComponents.items = [];
    value.billableBranchMonthComponents.reasons = ["Missing pricing"];
    value.billableBranchMonthComponents.expectedIdentities[0].allowanceWindow = {
      start: "2026-07-01T00:00:00Z",
      end: "2026-08-01T00:00:00Z",
    };
    rejects(value);
  });

  it("checks required snapshot array bounds before allocating exact quantities", () => {
    const value = validSnapshot();
    value.coverage.errors = Array(10_001).fill(value.coverage.errors[0]);
    const exact = vi.spyOn(globalThis, "BigInt");
    try {
      rejects(value, "INVALID_SHAPE");
      expect(exact).not.toHaveBeenCalled();
    } finally {
      exact.mockRestore();
    }
  });

  it.each([
    [
      "identifier over 256 characters",
      (v: MutableInput) => {
        v.producerVersion = "x".repeat(257);
      },
    ],
    [
      "quantity over 128 digits",
      (v: MutableInput) => {
        v.metrics[0].raw.value = "1".repeat(129);
      },
    ],
    [
      "rational over 128 digits",
      (v: MutableInput) => {
        v.metrics[0].derived.exact.denominator = "1".repeat(129);
      },
    ],
    [
      "decimal over 256 characters",
      (v: MutableInput) => {
        v.metrics[0].derived.decimalApproximation = "1".repeat(257);
      },
    ],
    [
      "decimal exponent over 256",
      (v: MutableInput) => {
        v.metrics[0].derived.decimalApproximation = "1e257";
      },
    ],
    [
      "text over 4096 characters",
      (v: MutableInput) => {
        v.warnings = ["x".repeat(4097)];
      },
    ],
    [
      "over 100 metrics",
      (v: MutableInput) => {
        v.metrics = Array(101).fill(v.metrics[0]);
      },
    ],
    [
      "over 1000 omissions",
      (v: MutableInput) => {
        v.coverage.omittedMetrics = Array(1001).fill("unknown");
      },
    ],
    [
      "over 10000 projects",
      (v: MutableInput) => {
        v.projects = Array(10001).fill(v.projects[0]);
      },
    ],
  ])("bounds %s before exact arithmetic", (_name, mutate) => {
    const value = validMeasuredUsage();
    mutate(value);
    rejects(value, "INVALID_SHAPE");
  });

  it.each([
    [
      "widened envelope",
      (v: MutableInput) => {
        v.period.from = "2026-07-31T00:00:00Z";
      },
    ],
    [
      "missing returned IDs",
      (v: MutableInput) => {
        delete v.coverage.returnedProjectIds;
      },
      "INVALID_SHAPE",
    ],
    [
      "wrong missing IDs",
      (v: MutableInput) => {
        v.coverage.missingProjectIds = [];
      },
    ],
    [
      "returned project outside scope",
      (v: MutableInput) => {
        v.projects[0].projectId = "other";
      },
    ],
    [
      "storage outside scope",
      (v: MutableInput) => {
        v.pointInTimeStorage.projects[0].projectId = "other";
      },
    ],
    [
      "storage missing requested project",
      (v: MutableInput) => {
        v.pointInTimeStorage.projects.pop();
      },
    ],
    [
      "partial storage total",
      (v: MutableInput) => {
        v.pointInTimeStorage.complete = true;
        v.pointInTimeStorage.totalLogicalSizeBytes = "10";
      },
    ],
    [
      "error outside scope",
      (v: MutableInput) => {
        v.coverage.errors[0].projectId = "other";
      },
    ],
    [
      "history-only selection",
      (v: MutableInput) => {
        v.metricSelection.requested = ["extra_branches_month"];
      },
    ],
  ])("rejects snapshot %s", (_name, mutate, code = undefined) => {
    const value = validSnapshot();
    mutate(value);
    rejects(value, code);
  });

  it("requires the generated-at period for an empty snapshot", () => {
    const value = validSnapshot();
    value.projects = [];
    value.coverage.returnedProjectIds = [];
    value.coverage.missingProjectIds = ["p", "q"];
    value.pointInTimeStorage.projects[0].totalLogicalSizeBytes = null;
    rejects(value);
    value.period = { from: value.generatedAt, to: value.generatedAt };
    expect(parseMeasuredBillingUsage(value)).toEqual(value);
  });

  it.each([
    [
      "zero component raw with 744 measured branch hours",
      (v: MutableInput) => {
        const item = v.billableBranchMonthComponents.items[0];
        item.raw.value = "0";
        item.allowanceApplied.exact = { numerator: "0", denominator: "1" };
        item.billable.exact = { numerator: "0", denominator: "1" };
      },
    ],
    [
      "duplicate identity",
      (v: MutableInput) => {
        v.billableBranchMonthComponents.items.push(v.billableBranchMonthComponents.items[0]);
      },
    ],
    [
      "wrong raw reconciliation",
      (v: MutableInput) => {
        v.projects[0].metrics = [metric("extra_branches_month", "1488")];
        v.metrics = [metric("extra_branches_month", "1488")];
      },
    ],
    [
      "allowance exceeds raw",
      (v: MutableInput) => {
        v.billableBranchMonthComponents.items[0].allowanceApplied.exact = {
          numerator: "745",
          denominator: "1",
        };
      },
    ],
    [
      "incorrect billable fraction",
      (v: MutableInput) => {
        v.billableBranchMonthComponents.items[0].billable.exact.numerator = "1";
      },
    ],
    [
      "certainty loses approximation",
      (v: MutableInput) => {
        v.billableBranchMonthComponents.items[0].certainty = "exact";
      },
    ],
    [
      "project ownership",
      (v: MutableInput) => {
        v.billableBranchMonthComponents.items[0].projectId = "other";
      },
    ],
    [
      "uncovered expected identity",
      (v: MutableInput) => {
        v.billableBranchMonthComponents.expectedIdentities.push({
          projectId: "p",
          sourcePeriodId: "source-2",
          allowanceWindow: v.billableBranchMonthComponents.items[0].allowanceWindow,
        });
      },
    ],
    [
      "partial without missing identity",
      (v: MutableInput) => {
        v.billableBranchMonthComponents.status = "partial";
        v.billableBranchMonthComponents.reasons = ["Missing pricing"];
      },
    ],
    [
      "unavailable with items",
      (v: MutableInput) => {
        v.billableBranchMonthComponents.status = "unavailable";
        v.billableBranchMonthComponents.reasons = ["Missing pricing"];
      },
    ],
    [
      "noncalendar allowance",
      (v: MutableInput) => {
        v.billableBranchMonthComponents.items[0].allowanceWindow.end = period.to;
      },
    ],
  ])("rejects component %s", (_name, mutate) => {
    const value = validComponents();
    mutate(value);
    rejects(value);
  });
});
