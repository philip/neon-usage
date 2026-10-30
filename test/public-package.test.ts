import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const contractValues = [
  "MEASURED_USAGE_KIND",
  "MEASURED_USAGE_SCHEMA_VERSION",
  "MeasuredUsageContractError",
  "branchConsumptionMetrics",
  "deriveBillingValue",
  "metricDefinitions",
  "parseMeasuredBillingUsage",
  "projectConsumptionMetrics",
].sort();
const clientValues = [
  "DEFAULT_CLIENT_LIMITS",
  "MAX_CLIENT_LIMITS",
  "NeonUsageError",
  "createNeonUsageClient",
  "createSlidingWindowRequestCoordinator",
];
const contractTypes = [
  "BillableBranchMonthComponent",
  "BillableBranchMonthComponentIdentity",
  "BillableBranchMonthComponents",
  "ExactRational",
  "HistoryBranchMetricName",
  "HistoryProjectMetricName",
  "KnownMetricName",
  "MeasuredBillingUsage",
  "MeasuredPresence",
  "MeasuredSnapshotCoverage",
  "MeasuredUsageContractErrorCode",
  "MeasuredUsageCoverage",
  "MeasuredUsageMetric",
  "MeasuredUsageMetricSelection",
  "MeasuredUsageScope",
  "MeasuredUsageSource",
  "PointInTimeStorage",
  "RawUnit",
  "SnapshotProjectMetricName",
  "UnresolvedComparisonField",
];
const clientTypes = [
  "AllowanceScope",
  "CapabilityReport",
  "CapabilityState",
  "CollectMeasuredUsageInput",
  "CollectedMeasuredUsage",
  "EffectiveRange",
  "EvidenceRef",
  "Granularity",
  "HistoryProbeResult",
  "MeasuredUsageHistoryQuery",
  "MoneyAmount",
  "NeonOrganization",
  "NeonUsageClient",
  "NeonUsageClientConfig",
  "NeonUsageClientLimits",
  "NeonUsageErrorCode",
  "NeonUsageOperationOptions",
  "PricingApproximation",
  "PricingEstimate",
  "PricingEstimateLine",
  "PricingLineStatus",
  "ProjectReportQuery",
  "RateCard",
  "RateCardAllowance",
  "RateCardPlan",
  "RequestCoordinator",
  "SlidingWindowCoordinatorOptions",
];

function runPackageModule(source: string): string {
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: packageDirectory,
    encoding: "utf8",
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

function declarationExportNames(declaration: string): string[] {
  const explicitExport = /export (?:type )?\{([^}]+)\} from "[^"]+";/g;
  expect(declaration.replace(explicitExport, "").trim()).toBe("");
  return [...declaration.matchAll(explicitExport)].flatMap(
    (match) =>
      match[1]
        ?.split(",")
        .map((name) => name.trim())
        .filter(Boolean) ?? [],
  );
}

describe("emitted public package", () => {
  it("rejects an inline private type added to an emitted declaration", () => {
    const declaration = readFileSync(join(packageDirectory, "dist/index.d.ts"), "utf8");
    const mutated = `${declaration}\nexport type AccidentalPrivate = import("./evidence-fact-store.js").EvidenceFactStore;\n`;
    expect(() => declarationExportNames(mutated)).toThrow();
  });

  it("exports exactly the supported runtime API through both public package paths", () => {
    const exports = JSON.parse(
      runPackageModule(`
        const sdk = await import("neon-usage");
        const contracts = await import("neon-usage/contracts");
        console.log(JSON.stringify({ root: Object.keys(sdk), contracts: Object.keys(contracts) }));
      `),
    );
    expect(exports.root.sort()).toEqual([...contractValues, ...clientValues].sort());
    expect(exports.contracts.sort()).toEqual(contractValues);
  });

  it("exports measured schema v2 through both paths and a working coordinator", () => {
    runPackageModule(`
      import assert from "node:assert/strict";
      const sdk = await import("neon-usage");
      const contracts = await import("neon-usage/contracts");
      assert.equal(sdk.MEASURED_USAGE_SCHEMA_VERSION, 2);
      assert.equal(contracts.MEASURED_USAGE_SCHEMA_VERSION, 2);
      await sdk.createSlidingWindowRequestCoordinator({ limit: 1, intervalMs: 60_000 }).acquire();
    `);
  });

  it("rejects private subpaths through Node package resolution and import", () => {
    runPackageModule(`
      import assert from "node:assert/strict";
      const subpaths = [
        "hosted", "internal", "internal-history", "sqlite-fact-store", "in-memory-fact-store",
        "neon-api-source", "adapter-support", "report-presenter", "cli", "default-dependencies",
        "src/index.ts", "src/client.js", "dist/index.js", "dist/sqlite-fact-store.js", "package.json",
      ];
      for (const subpath of subpaths) {
        const specifier = "neon-usage/" + subpath;
        assert.throws(() => import.meta.resolve(specifier), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
        await assert.rejects(import(specifier), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
      }
    `);
  });

  it("loads contracts without Node builtins, SDK, adapters, transport, or stores", () => {
    runPackageModule(`
      import assert from "node:assert/strict";
      import { isBuiltin, registerHooks } from "node:module";
      const allowed = ["contracts.js", "measured-usage-contract.js", "metric-definitions.js", "metric-catalog.js"];
      const distribution = new URL("./dist/", import.meta.url).href;
      registerHooks({
        resolve(specifier, context, nextResolve) {
          assert.ok(!isBuiltin(specifier), "contracts imported " + specifier);
          const resolved = nextResolve(specifier, context);
          if (resolved.url.startsWith(distribution)) {
            assert.ok(allowed.includes(resolved.url.split("/").at(-1)), "contracts imported " + resolved.url);
          }
          return resolved;
        },
      });
      globalThis.fetch = () => { throw new Error("contracts must not fetch"); };
      const contracts = await import("neon-usage/contracts");
      assert.deepEqual(contracts.deriveBillingValue("compute_unit_seconds", "3600").exact,
        { numerator: "1", denominator: "1" });
      assert.throws(() => contracts.parseMeasuredBillingUsage({}), contracts.MeasuredUsageContractError);
    `);
  });

  it("exports the complete named public types and rejects private declaration imports", () => {
    const directory = mkdtempSync(join(tmpdir(), "neon-usage-public-types-"));
    try {
      mkdirSync(join(directory, "node_modules"));
      symlinkSync(packageDirectory, join(directory, "node_modules/neon-usage"), "dir");
      const consumer = join(directory, "consumer.mts");
      writeFileSync(
        consumer,
        `
          import { ${[...contractValues, ...clientValues].join(", ")} } from "neon-usage";
          import type { ${[...contractTypes, ...clientTypes].join(", ")} } from "neon-usage";
          import * as contracts from "neon-usage/contracts";
          import type { ${contractTypes.map((name) => `${name} as Contract${name}`).join(", ")} } from "neon-usage/contracts";
          type PublicTypes = [${[...contractTypes, ...clientTypes].join(", ")}];
          type ContractTypes = [${contractTypes.map((name) => `Contract${name}`).join(", ")}];
          const config: NeonUsageClientConfig = { accessToken: "token" };
          const client: NeonUsageClient = createNeonUsageClient(config);
          const result: Promise<CollectedMeasuredUsage> = client.collectMeasuredUsage({ organizationId: "org-1" });
          const parsed: MeasuredBillingUsage = contracts.parseMeasuredBillingUsage({});
          const coordinatorOptions: SlidingWindowCoordinatorOptions = { limit: 1, intervalMs: 60_000 };
          const coordinator: RequestCoordinator = createSlidingWindowRequestCoordinator(coordinatorOptions);
          const admission: Promise<void> = coordinator.acquire();
          // @ts-expect-error source account identity belongs to the SDK
          const accountConfig: NeonUsageClientConfig = { accessToken: "token", sourceAccount: "private" };
          // @ts-expect-error producer identity belongs to the package
          const producerConfig: NeonUsageClientConfig = { accessToken: "token", producerVersion: "caller" };
          // @ts-expect-error private application composition is not public
          import { createOrganizationHistoryService } from "neon-usage";
          // @ts-expect-error stores are private
          import type { EvidenceFactStore } from "neon-usage";
          // @ts-expect-error operation context is private
          import type { OperationContext } from "neon-usage";
          // @ts-expect-error CLI dependency composition is private
          import type { ReportDependencies } from "neon-usage";
          // @ts-expect-error SDK cannot be loaded through contracts
          import { createNeonUsageClient as contractClient } from "neon-usage/contracts";
          // @ts-expect-error hosted migration API is unpublished and private
          import { createHostedUsageClient } from "neon-usage/hosted";
          // @ts-expect-error package subpaths cannot bypass the export map
          import { createNeonApiSource } from "neon-usage/dist/neon-api-source.js";
        `,
      );
      const result = spawnSync(
        process.execPath,
        [
          join(packageDirectory, "node_modules/typescript/bin/tsc"),
          "--noEmit",
          "--strict",
          "--exactOptionalPropertyTypes",
          "--target",
          "ES2023",
          "--module",
          "NodeNext",
          "--moduleResolution",
          "NodeNext",
          "--types",
          "node",
          "--typeRoots",
          join(packageDirectory, "node_modules/@types"),
          consumer,
        ],
        { cwd: directory, encoding: "utf8" },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      for (const [entry, expected] of [
        ["index", [...contractValues, ...clientValues, ...contractTypes, ...clientTypes]],
        ["contracts", [...contractValues, ...contractTypes]],
      ] as const) {
        const declaration = readFileSync(join(packageDirectory, "dist", `${entry}.d.ts`), "utf8");
        const names = declarationExportNames(declaration);
        expect(names.sort()).toEqual([...expected].sort());
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
