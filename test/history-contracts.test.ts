import { describe, expect, it } from "vitest";
import { historyContracts } from "../src/history-contracts.js";

describe("versioned history contracts", () => {
  it("keeps stable project and beta branch policy contract-local", () => {
    expect(historyContracts.project).toMatchObject({
      sourceContract: "consumption-history-v2-projects",
      endpoint: "/consumption_history/v2/projects",
      pageSize: 100,
      beta: false,
    });
    expect(historyContracts.branch).toMatchObject({
      sourceContract: "consumption-history-v2-branches",
      endpoint: "/consumption_history/v2/branches",
      pageSize: 1000,
      beta: true,
      historicalCoverage: "unverified",
    });
  });

  it("keeps contract-specific metrics distinct", () => {
    expect(historyContracts.project.metrics).toContain("snapshot_storage_bytes_month");
    expect(historyContracts.branch.metrics).not.toContain("snapshot_storage_bytes_month");
  });

  it("cannot be mutated at runtime", () => {
    expect(Object.isFrozen(historyContracts)).toBe(true);
    expect(Object.isFrozen(historyContracts.project)).toBe(true);
    expect(Object.isFrozen(historyContracts.branch)).toBe(true);
    expect(Object.isFrozen(historyContracts.branch.qualityFlags)).toBe(true);
  });
});
