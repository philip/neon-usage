import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// The hot-reloading dashboard dev loop, run by `npm run dev:dashboard`. Two
// long-lived processes:
//
//   api: the read-only server on a fixed port, DEMO data, token OFF. The port
//        is fixed so the Vite proxy can target it; the token is off because
//        the proxied page carries no launch fragment. Neither weakens anything
//        real: the loop only ever serves synthetic data. Test real data with
//        the ordinary secured command instead: `neon-usage dashboard` (random
//        token + ephemeral port), after building the page.
//   web: the Vite dev server: hot-reloads the page and proxies /api to the api
//        process (see dashboard/vite.config.ts).
//
// No orchestration dependency: this file is the orchestrator. The command
// contract below is pinned by test/dev-dashboard.test.ts; the teardown is
// verified by hand (Ctrl+C leaves no orphaned servers).

export type DevCommand = { name: string; command: string };

/** The command contract for the dev loop; pure, so tests can pin it. */
export function devDashboardCommands(): DevCommand[] {
  return [
    { name: "api", command: "tsx src/bin.ts dashboard --demo --port 4321 --no-open --no-token" },
    { name: "web", command: "npm --prefix dashboard run dev" },
  ];
}

/**
 * The process exit code for a child that ended with `code`/`signal`. A SIGINT
 * (Ctrl+C) or SIGTERM (our own teardown) is an expected quit and maps to 0, so
 * a normal stop does not raise npm's failure box; any other signal or a nonzero
 * code propagates as a failure.
 */
export function exitCodeForChild(code: number | null, signal: NodeJS.Signals | null): number {
  if (signal === "SIGINT" || signal === "SIGTERM") return 0;
  return code ?? (signal ? 1 : 0);
}

function main(): void {
  const children: ChildProcess[] = [];
  let shuttingDown = false;

  // First exit (a crash or Ctrl+C reaching a child) tears down the pair, so a
  // dead api never leaves an orphan Vite server behind; this is concurrently's -k.
  const stopAll = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of children) child.kill(signal);
  };

  for (const { name, command } of devDashboardCommands()) {
    // shell:true resolves the node_modules/.bin entries (tsx, npm) that npm put
    // on PATH, and keeps this cross-platform without hand-rolling .cmd lookup.
    const child = spawn(command, { shell: true, stdio: "inherit" });
    child.on("error", (error) => {
      // A spawn failure (e.g. a missing binary) emits "error" and no "exit",
      // so fail loudly and tear the pair down rather than run half a loop.
      process.stderr.write(`[${name}] failed to start: ${String(error)}\n`);
      if (process.exitCode === undefined) process.exitCode = 1;
      stopAll("SIGTERM");
    });
    child.on("exit", (code, signal) => {
      if (!shuttingDown) {
        process.stderr.write(`[${name}] exited (${signal ?? code ?? 0}); stopping the other.\n`);
      }
      // Keep the first non-clean exit; a later child killed by our teardown
      // (SIGTERM) then reports 0 and must not overwrite it.
      const resolved = exitCodeForChild(code, signal);
      if (process.exitCode === undefined && resolved !== 0) process.exitCode = resolved;
      stopAll("SIGTERM");
    });
    children.push(child);
  }

  process.on("SIGINT", () => stopAll("SIGINT"));
  process.on("SIGTERM", () => stopAll("SIGTERM"));
}

// Run only when executed directly, never when a test imports the pure helper.
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
