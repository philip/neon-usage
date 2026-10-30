import { describe, expect, it } from "vitest";
import type { CurrentSnapshotError } from "../src/current-snapshot-service.js";
import { measuredSnapshotErrors } from "../src/measured-snapshot-errors.js";

describe("measuredSnapshotErrors", () => {
  it.each([
    ["PROJECT_NOT_IN_INVENTORY", "Requested project is not in the organization inventory"],
    ["PROJECT_INVENTORY_UNAVAILABLE", "Project details were unavailable during project inventory"],
    [
      "PROJECT_INVENTORY_TRUNCATED",
      "Project inventory pagination repeated a cursor; the inventory may be incomplete",
    ],
  ])("preserves %s using only a fixed package-owned message", (code, message) => {
    expect(
      measuredSnapshotErrors([
        {
          projectId: "project-1",
          source: "project_list",
          message: "secret provider text",
          detail: { code, message: "secret provider text", requestId: "secret" },
        },
      ]),
    ).toEqual([
      { projectId: "project-1", source: "project_list", message, detail: { code, message } },
    ]);
  });

  it.each([
    { source: "branch_sizes", code: "PROJECT_NOT_IN_INVENTORY" },
    { source: "project_list", code: "constructor" },
    { source: "project_list", code: "PROJECT_NOT_IN_INVENTORY", status: 403 },
    { source: "project_list", code: "COLLECTION_LIMIT_REACHED" },
    { source: "branch_sizes", code: "COLLECTION_LIMIT_REACHED", status: 403 },
  ] as const)(
    "sanitizes provider diagnostics outside the statusless inventory allowlist: %j",
    ({ source, code, ...status }) => {
      const errors: CurrentSnapshotError[] = [
        {
          projectId: "project-1",
          source,
          message: "secret",
          detail: { code, message: "secret", ...status },
        },
      ];
      const [result] = measuredSnapshotErrors(errors);
      expect(result?.detail?.code).toBe(
        "status" in status ? "AUTHORIZATION_FAILED" : "PROVIDER_UNAVAILABLE",
      );
      expect(JSON.stringify(result)).not.toContain("secret");
    },
  );
});
