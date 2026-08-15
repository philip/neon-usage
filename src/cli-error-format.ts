import type { CliErrorParts } from "./errors.js";

// Presentation for a top-level CLI error: a labeled headline, then an indented
// detail block and an actionable "To fix" block. bin.ts sanitizes the parts
// before they reach here, so this module only shapes text; color codes it adds
// are intentional and applied after sanitization.

const RED_BOLD = "[1;31m";
const RESET = "[0m";
const INDENT = "  ";

export type CliErrorFormatOptions = {
  /** Emit ANSI color; callers pass false when stderr is not a TTY or NO_COLOR is set. */
  color: boolean;
  /** Terminal width to wrap to; clamped to a readable 40-100 columns. */
  width: number;
};

/** Render an error's parts as a multi-line block for stderr (no trailing newline). */
export function formatCliError(parts: CliErrorParts, options: CliErrorFormatOptions): string {
  const width = Math.max(40, Math.min(options.width || 80, 100));
  const label = options.color ? `${RED_BOLD}Error${RESET}` : "Error";
  // "Error" plus two spaces; the visible width is the same with or without the
  // color codes, so wrap the headline to what is left and hang continuation
  // lines under its text. Short CliError headlines stay on one line.
  const labelWidth = "Error".length + INDENT.length;
  const headlineLines = wrap(parts.headline, width - labelWidth);
  const lines = headlineLines.map((line, index) => {
    if (index !== 0) return `${" ".repeat(labelWidth)}${line}`;
    // An empty headline (a message that sanitized away) renders as just the
    // label, never "Error" followed by dangling spaces.
    return line ? `${label}${INDENT}${line}` : label;
  });
  const block = (text: string): void => {
    lines.push("", ...wrap(text, width - INDENT.length).map((line) => `${INDENT}${line}`));
  };
  if (parts.detail) block(parts.detail);
  if (parts.fix) block(`To fix: ${parts.fix}`);
  return lines.join("\n");
}

/**
 * Greedy word wrap to `width`. A single token longer than the width (a long
 * file path, say) is left whole on its own line rather than broken, since a
 * split path reads worse than an overhang.
 */
function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line === "") line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line !== "") out.push(line);
  return out.length > 0 ? out : [""];
}
