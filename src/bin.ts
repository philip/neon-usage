#!/usr/bin/env node

// The executable entry point. Its only job is to run the CLI, so there is no
// "am I the main module?" detection to get wrong under a bin symlink (npx or a
// global install both invoke through node_modules/.bin). runCli lives in a
// plain module that can be imported without side effects.

import { runCli } from "./cli.js";
import { sanitizeErrorText } from "./errors.js";
import { withPlanHint } from "./index.js";

runCli(process.argv.slice(2)).catch((error: unknown) => {
  const raw = error instanceof Error ? error.message : String(error);
  // Top-level messages can include paths or profile names; strip terminal
  // control/bidi sequences at the final stderr boundary as defense in depth.
  const message = sanitizeErrorText(raw, 2000);
  const rawStatus =
    typeof error === "object" && error !== null && "status" in error
      ? (error as { status?: unknown }).status
      : undefined;
  const status = typeof rawStatus === "number" ? rawStatus : undefined;
  process.stderr.write(`${withPlanHint(message, status)}\n`);
  process.exitCode = 1;
});
