import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CollectedMeasuredUsage,
  createSlidingWindowRequestCoordinator,
  MEASURED_USAGE_SCHEMA_VERSION,
  type NeonUsageClientConfig,
  type RequestCoordinator,
  type SlidingWindowCoordinatorOptions,
} from "neon-usage";
import type { MeasuredBillingUsage } from "neon-usage/contracts";

const sdk = await import("neon-usage");
const contracts = await import("neon-usage/contracts");
const directory = fileURLToPath(new URL("..", import.meta.url));
const { version } = JSON.parse(readFileSync(join(directory, "verification.json"), "utf8")) as {
  version: string;
};
for (const specifier of ["neon-usage", "neon-usage/contracts"]) {
  assert.ok(
    realpathSync(fileURLToPath(import.meta.resolve(specifier))).startsWith(
      join(directory, "node_modules/neon-usage/"),
    ),
  );
}
for (const path of [
  "hosted",
  "internal-history",
  "client",
  "cli",
  "neon-api-source",
  "sqlite-fact-store",
  "in-memory-fact-store",
  "neon-cli-context",
  "dashboard-server",
  "src/index.ts",
  "dist/index.js",
  "package.json",
]) {
  assert.throws(() => import.meta.resolve(`neon-usage/${path}`), {
    code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
  });
  await assert.rejects(import(`neon-usage/${path}`), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
}

const today = new Date();
today.setUTCHours(0, 0, 0, 0);
const to = today.toISOString();
const from = new Date(today.getTime() - 86_400_000).toISOString();
const coordinatorOptions: SlidingWindowCoordinatorOptions = { limit: 180, intervalMs: 60_000 };
const requestCoordinator: RequestCoordinator =
  createSlidingWindowRequestCoordinator(coordinatorOptions);
await requestCoordinator.acquire();
assert.equal(MEASURED_USAGE_SCHEMA_VERSION, 2);
assert.equal(contracts.MEASURED_USAGE_SCHEMA_VERSION, 2);
let requests = 0;
const config: NeonUsageClientConfig = {
  accessToken: "packed-fixture-token",
  requestCoordinator,
  now: () => new Date(),
  fetch: async (input, init) => {
    requests++;
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer packed-fixture-token");
    const url = new URL(String(input));
    if (url.pathname.endsWith("/organizations/org-fixture"))
      return Response.json({ id: "org-fixture", plan: "launch" });
    if (url.pathname.endsWith("/consumption_history/v2/projects"))
      return Response.json({
        projects: [
          {
            project_id: "project-fixture",
            periods: [
              {
                period_id: "period-fixture",
                period_plan: "launch",
                period_start: from,
                period_end: to,
                consumption: [
                  {
                    timeframe_start: from,
                    timeframe_end: to,
                    metrics: [{ metric_name: "compute_unit_seconds", value: "3600" }],
                  },
                ],
              },
            ],
          },
        ],
        pagination: { cursor: null },
      });
    throw new Error(`Unexpected fixture transport request: ${url.pathname}`);
  },
};
const client = sdk.createNeonUsageClient(config);
try {
  const result: CollectedMeasuredUsage = await client.collectMeasuredUsage({
    organizationId: "org-fixture",
    source: "history",
    query: { from, to, granularity: "daily", metrics: ["compute_unit_seconds"] },
  });
  const measured: MeasuredBillingUsage = contracts.parseMeasuredBillingUsage(
    JSON.parse(JSON.stringify(result.measuredUsage)),
  );
  assert.equal(measured.producerVersion, version);
  assert.equal(result.measuredUsage.schemaVersion, 2);
  assert.equal(measured.schemaVersion, 2);
  assert.equal(measured.coverage.authoritative, true);
  assert.ok(requests > 0);
} finally {
  client.close();
}
assert.deepEqual(contracts.deriveBillingValue("compute_unit_seconds", "3600").exact, {
  numerator: "1",
  denominator: "1",
});
assert.throws(() => contracts.parseMeasuredBillingUsage({}), contracts.MeasuredUsageContractError);

const { packedCliTarget, runPackedCli } = (await import(
  new URL("./cli.ts", import.meta.url).href
)) as typeof import("./cli.js");
const binary = packedCliTarget(directory);
const cli = (args: string[]) => runPackedCli(binary, args, directory);
const versionResult = cli(["--version"]);
assert.equal(versionResult.status, 0, versionResult.stderr);
assert.equal(versionResult.stdout.trim(), version);
const exported = cli([
  "export",
  "--demo",
  "--org-id",
  "org-demo-42813975",
  "--source",
  "history",
  "--from",
  from,
  "--to",
  to,
  "--granularity",
  "daily",
  "--format",
  "measured-usage-json",
]);
assert.equal(exported.error, undefined);
assert.equal(exported.status, 0, exported.stderr);
const { parseCliExport } = (await import(
  new URL("./documentation.ts", import.meta.url).href
)) as typeof import("./documentation.js");
const cliUsage: MeasuredBillingUsage = parseCliExport(exported.stdout);
assert.equal(cliUsage.producerVersion, version);
assert.equal(cliUsage.schemaVersion, 2);
assert.equal(cliUsage.scope.kind, "organization_aggregate");
assert.equal(cliUsage.metricSelection.mode, "default");
console.log(
  JSON.stringify({
    root: import.meta.resolve("neon-usage"),
    contracts: import.meta.resolve("neon-usage/contracts"),
    producerVersion: version,
    sdk: "passed",
    cli: "passed",
  }),
);
