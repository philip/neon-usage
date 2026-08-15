import { describe, expect, it } from "vitest";
import { formatCliError } from "../src/cli-error-format.js";

const plain = { color: false, width: 80 };

describe("formatCliError", () => {
  it("labels the headline and blocks the detail and fix", () => {
    const output = formatCliError(
      {
        headline: "Neon login expired",
        detail: "The stored login expired.",
        fix: "Run `neon auth`.",
      },
      plain,
    );
    expect(output).toBe(
      [
        "Error  Neon login expired",
        "",
        "  The stored login expired.",
        "",
        "  To fix: Run `neon auth`.",
      ].join("\n"),
    );
  });

  it("emits only the headline line when there is no detail or fix", () => {
    expect(formatCliError({ headline: "Something failed" }, plain)).toBe("Error  Something failed");
  });

  it("renders just the label for an empty headline, with no dangling spaces", () => {
    expect(formatCliError({ headline: "" }, plain)).toBe("Error");
  });

  it("wraps a long headline and hangs continuation under its text", () => {
    const headline = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima";
    const lines = formatCliError({ headline }, { color: false, width: 40 }).split("\n");
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]?.startsWith("Error  ")).toBe(true);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(40);
    // Continuation aligns under the headline text: "Error" + two spaces = 7.
    for (const line of lines.slice(1)) expect(line.startsWith(" ".repeat(7))).toBe(true);
  });

  it("wraps long text to the width with a hanging indent", () => {
    const detail = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima";
    const output = formatCliError({ headline: "H", detail }, { color: false, width: 40 });
    const detailLines = output.split("\n").slice(2);
    expect(detailLines.length).toBeGreaterThan(1);
    for (const line of detailLines) {
      expect(line.startsWith("  ")).toBe(true);
      expect(line.length).toBeLessThanOrEqual(40);
    }
  });

  it("clamps the width to a readable floor of 40 columns", () => {
    const detail = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima";
    // A tiny width is raised to 40, so no wrapped line falls below that floor's width.
    const narrow = formatCliError({ headline: "H", detail }, { color: false, width: 10 });
    expect(narrow).toBe(formatCliError({ headline: "H", detail }, { color: false, width: 40 }));
  });

  it("keeps an over-long token (a path) whole rather than splitting it", () => {
    const path = "/Users/someone/.config/neon/credentials.json";
    const output = formatCliError({ headline: "H", detail: path }, { color: false, width: 20 });
    expect(output).toContain(`  ${path}`);
  });

  it("adds ANSI color to the label only when color is enabled", () => {
    const colored = formatCliError({ headline: "H" }, { color: true, width: 80 });
    expect(colored).toContain("[1;31mError[0m");
    expect(formatCliError({ headline: "H" }, plain)).not.toContain("");
  });
});
