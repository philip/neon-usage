#!/usr/bin/env node

// The executable entry point. Its only job is to run the CLI, so there is no
// "am I the main module?" detection to get wrong under a bin symlink (npx or a
// global install both invoke through node_modules/.bin). runCli lives in a
// plain module that can be imported without side effects.

import { runCli } from "./cli.js";
import { formatCliError } from "./cli-error-format.js";
import { CliError, type CliErrorParts, sanitizeErrorText } from "./errors.js";
import { withPlanHint } from "./index.js";

runCli(process.argv.slice(2)).catch((error: unknown) => {
  const rawStatus =
    typeof error === "object" && error !== null && "status" in error
      ? (error as { status?: unknown }).status
      : undefined;
  const status = typeof rawStatus === "number" ? rawStatus : undefined;
  // Top-level messages can include paths or profile names; strip terminal
  // control/bidi sequences at the final stderr boundary as defense in depth.
  // A CliError carries its own headline/detail/fix; anything else renders its
  // message as the headline, still gaining the label and wrapping.
  const parts: CliErrorParts =
    error instanceof CliError
      ? {
          headline: sanitizeErrorText(error.headline, 200),
          ...(error.detail ? { detail: sanitizeErrorText(error.detail, 1000) } : {}),
          ...(error.fix ? { fix: sanitizeErrorText(error.fix, 500) } : {}),
        }
      : {
          // Truncate the raw message first, then append the (short, trusted)
          // plan hint, so a very long message can never slice the hint off.
          headline: withPlanHint(
            sanitizeErrorText(error instanceof Error ? error.message : String(error), 2000),
            status,
          ),
        };
  // Color only on a real terminal, and never when NO_COLOR is set to a
  // non-empty value (the no-color.org convention; an empty value is ignored).
  const color = Boolean(process.stderr.isTTY) && !process.env.NO_COLOR;
  process.stderr.write(
    `${formatCliError(parts, { color, width: process.stderr.columns ?? 80 })}\n`,
  );
  process.exitCode = 1;
});
