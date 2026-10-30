import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

const { cleanChildEnvironment } = (await import(
  new URL("./environment.ts", import.meta.url).href
)) as typeof import("./environment.js");

export function packedCliTarget(cwd: string): string {
  const installed = realpathSync(join(cwd, "node_modules/neon-usage"));
  const pkg = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  const bin: unknown = pkg.bin?.["neon-usage"];
  if (typeof bin !== "string" || !bin.endsWith(".js"))
    throw new Error("Invalid packed JavaScript bin");
  const target = realpathSync(join(installed, bin));
  const suffix = relative(installed, target);
  if (suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix))
    throw new Error("Packed bin escapes installed package");
  return target;
}

export function runPackedCli(binary: string, args: string[], cwd: string) {
  return spawnSync(process.execPath, ["--import", join(cwd, "src/guard.ts"), binary, ...args], {
    cwd,
    env: cleanChildEnvironment(),
    encoding: "utf8",
    timeout: 30_000,
  });
}
