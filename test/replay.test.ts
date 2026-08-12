import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createConsumptionService } from "../src/index.js";
import { serializeMachineJson } from "../src/machine-json.js";
import { createNeonApiSource } from "../src/neon-api-source.js";

describe("synthetic source replay", () => {
  it("produces byte-stable machine JSON", async () => {
    const payload = await readFile(
      new URL("./fixtures/replay/project-history.synthetic.json", import.meta.url),
    );
    const expected = await readFile(
      new URL("./fixtures/replay/project-history.synthetic.expected.txt", import.meta.url),
      "utf8",
    );
    const source = createNeonApiSource({
      apiKey: "synthetic-secret",
      fetch: async () => new Response(payload),
    });
    const service = createConsumptionService(source, {
      now: () => new Date("2026-08-08T12:30:00Z"),
    });
    const query = {
      organizationId: "org-1",
      from: "2026-08-07T00:00:00Z",
      to: "2026-08-08T00:00:00Z",
      granularity: "daily" as const,
      metrics: ["compute_unit_seconds", "root_branch_bytes_month"],
    };

    const first = serializeMachineJson(await service.projectReport(query));
    const second = serializeMachineJson(await service.projectReport(query));

    expect(first).toBe(second);
    expect(first).toBe(expected);
  });
});
