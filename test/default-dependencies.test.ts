import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";
import { createNeonDependencies } from "../src/default-dependencies.js";
import { createInMemoryEvidenceFactStore } from "../src/in-memory-fact-store.js";
import * as sqliteStores from "../src/sqlite-fact-store.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("default current-report composition", () => {
  it.each(["currentReport", "currentExport"] as const)(
    "preserves %s caller cancellation and releases its timers",
    async (method) => {
      vi.useFakeTimers();
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const fetch = vi.fn<typeof globalThis.fetch>(async () => {
        entered();
        return new Promise(() => {});
      });
      vi.stubGlobal("fetch", fetch);
      const store = createInMemoryEvidenceFactStore();
      vi.spyOn(sqliteStores, "createSqliteEvidenceFactStore").mockReturnValue(store);
      const dependencies = createNeonDependencies({
        apiKey: "fixture-token",
        storePath: join(tmpdir(), "unused-snapshot-store.sqlite"),
        openedStores: [],
      });
      const controller = new AbortController();
      try {
        const pending = dependencies[method]?.("org-1", undefined, { signal: controller.signal });
        const rejected = expect(pending).rejects.toMatchObject({ kind: "cancelled" });
        await started;
        controller.abort();
        await rejected;
        await vi.advanceTimersByTimeAsync(0);
        expect(fetch).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        controller.abort();
        store.close();
      }
    },
  );

  it.each([
    ["current-report", "--max-items", "1"],
    ["export", "--max-items", "1"],
    ["current-report", "--max-bytes", "400"],
    ["export", "--max-bytes", "400"],
    ["current-report", "--max-duration", "1"],
    ["export", "--max-duration", "1"],
  ])("bounds production CLI %s with %s %s", async (command, flag, limit) => {
    const directory = mkdtempSync(join(tmpdir(), "neon-usage-cli-budget-"));
    writeFileSync(join(directory, "context.json"), "{}");
    const store = createInMemoryEvidenceFactStore();
    vi.spyOn(sqliteStores, "createSqliteEvidenceFactStore").mockReturnValue(store);
    const previousExitCode = process.exitCode;
    let stdout = "";
    vi.spyOn(process.stdout, "write").mockImplementation((value) => {
      stdout += String(value);
      return true;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) => {
        if (flag === "--max-duration") await new Promise((resolve) => setTimeout(resolve, 25_000));
        const pathname = new URL(String(input)).pathname;
        if (pathname.endsWith("/projects"))
          return Response.json({ projects: [{ id: "project-1", name: "One" }] });
        if (pathname.endsWith("/branches"))
          return Response.json({
            branches: [{ id: "branch-1", name: "x".repeat(100), logical_size: "1024" }],
          });
        return Response.json({
          project: {
            id: "project-1",
            consumption_period_start: "2026-08-01T00:00:00Z",
            consumption_period_end: "2026-09-01T00:00:00Z",
            active_time_seconds: "3600",
            compute_time_seconds: "7200",
            written_data_bytes: "1",
            data_transfer_bytes: "2",
            data_storage_bytes_hour: "0",
          },
        });
      }),
    );
    if (flag === "--max-duration") vi.useFakeTimers();
    try {
      const pending = runCli(
        [
          "--api-key",
          "fixture-token",
          "--store",
          join(directory, "store.sqlite"),
          "--config-dir",
          directory,
          "--context-file",
          join(directory, "context.json"),
          flag,
          limit,
          command,
          "--org-id",
          "org-1",
          "--project-ids",
          "all",
          ...(command === "export" ? ["--source", "current"] : []),
        ],
        undefined,
        { now: () => new Date("2026-08-27T12:00:00Z"), isTTY: false },
      ).then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error }),
      );
      if (flag === "--max-duration") {
        await vi.advanceTimersByTimeAsync(80_000);
        expect(await pending).toMatchObject({ error: { kind: "time_limit" } });
        expect(stdout).toBe("");
      } else {
        expect(await pending).toEqual({ error: undefined });
        expect(JSON.parse(stdout).coverage.status).toBe("partial");
        expect(process.exitCode).toBe(2);
      }
    } finally {
      process.exitCode = previousExitCode;
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not open a new store even when current branch names are available", async () => {
    const directory = mkdtempSync(join(tmpdir(), "neon-usage-current-"));
    const storePath = join(directory, "store.sqlite");
    const store = createInMemoryEvidenceFactStore();
    const sqlite = vi.spyOn(sqliteStores, "createSqliteEvidenceFactStore").mockReturnValue(store);
    const openedStores: Array<typeof store> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/projects"))
          return Response.json({ projects: [{ id: "project-1", name: "One" }] });
        if (path.endsWith("/branches"))
          return Response.json({
            branches: [{ id: "branch-1", name: "main", logical_size: "1024" }],
          });
        if (path.endsWith("/projects/project-1"))
          return Response.json({
            project: {
              id: "project-1",
              consumption_period_start: "2026-08-01T00:00:00Z",
              consumption_period_end: "2026-09-01T00:00:00Z",
              active_time_seconds: "3600",
              compute_time_seconds: "7200",
              written_data_bytes: "1",
              data_transfer_bytes: "2",
              data_storage_bytes_hour: "0",
            },
          });
        throw new Error(`Unexpected fixture URL: ${path}`);
      }),
    );
    try {
      const dependencies = createNeonDependencies({
        apiKey: "fixture-token",
        storePath,
        openedStores,
      });
      const report = await dependencies.currentReport("org-1", ["project-1"]);
      expect(report).toMatchObject({
        coverage: { status: "complete" },
        projects: [{ branchStorage: { branches: [{ name: "main" }] } }],
      });
      expect(report).not.toHaveProperty("evidence");
      expect(sqlite).not.toHaveBeenCalled();
      expect(openedStores).toEqual([]);
      expect(existsSync(storePath)).toBe(false);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
