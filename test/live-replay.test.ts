import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  createConsumptionService,
  createCurrentSnapshotService,
  createNeonApiSource,
  serializeMachineJson,
} from "../src/index.js";

// Sanitized captures of real Neon API responses (2026-08-09) for one Free,
// one Launch, and one Scale organization. These lock the machine-JSON bytes
// each plan family produces from genuine wire shapes.

const now = () => new Date("2026-08-09T12:00:00Z");
const metrics = [
  "compute_unit_seconds",
  "root_branch_bytes_month",
  "child_branch_bytes_month",
  "instant_restore_bytes_month",
  "snapshot_storage_bytes_month",
  "public_network_transfer_bytes",
  "private_network_transfer_bytes",
  "extra_branches_month",
];
const range = {
  from: "2026-08-02T00:00:00Z",
  to: "2026-08-09T00:00:00Z",
  granularity: "daily" as const,
  metrics,
};

async function fixtureSource(name: string) {
  const fixture = JSON.parse(
    await readFile(new URL(`./fixtures/replay/live/${name}.json`, import.meta.url), "utf8"),
  ) as { responses: Array<{ url: string; body: string }> };
  return createNeonApiSource({
    apiKey: "fixture-secret",
    fetch: (async (input: unknown) => {
      const match = fixture.responses.find((response) => response.url === String(input));
      if (!match) throw new Error(`no fixture response for ${String(input)}`);
      return new Response(match.body, { status: 200 });
    }) as typeof fetch,
  });
}

async function expected(name: string): Promise<string> {
  return readFile(new URL(`./fixtures/replay/live/${name}.expected.txt`, import.meta.url), "utf8");
}

describe("sanitized live-capture replay", () => {
  it("produces byte-stable Launch project history", async () => {
    const service = createConsumptionService(await fixtureSource("launch-history"), { now });
    const report = await service.projectReport({ organizationId: "org-launch-fixture", ...range });
    expect(report.coverage.status).toBe("complete");
    expect(serializeMachineJson(report)).toBe(await expected("launch-history"));
  });

  it("produces byte-stable Scale project history for filtered projects", async () => {
    const service = createConsumptionService(await fixtureSource("scale-history"), { now });
    const report = await service.projectReport({
      organizationId: "org-scale-fixture",
      projectIds: ["scale-project-1", "scale-project-2"],
      ...range,
    });
    expect(report.coverage.status).toBe("complete");
    expect(serializeMachineJson(report)).toBe(await expected("scale-history"));
  });

  it("produces a byte-stable, complete Free current-period snapshot", async () => {
    const service = createCurrentSnapshotService(await fixtureSource("free-snapshot"), { now });
    const report = await service.organizationReport("org-free-fixture");
    expect(report.coverage.status).toBe("complete");
    expect(report.projects[0]?.branchStorage.status).toBe("available");
    expect(serializeMachineJson(report)).toBe(await expected("free-snapshot"));
  });
});
