import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { CandidateManifest, CommandRunner } from "./verify-package.js";

// Native Node 24 executes these scripts without a build or a tsx installation.
const { inspectTarball, repository, runCommand, sha256 } = (await import(
  new URL("./verify-package.ts", import.meta.url).href
)) as typeof import("./verify-package.js");

export function validateRegistryHistory(value: unknown): string[] {
  // npm identities omit build metadata; accepting it would make vacancy ambiguous.
  const canonical =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
  if (!Array.isArray(value) || value.length === 0)
    throw new Error("Registry history must be a nonempty array of canonical npm versions");
  const identities = new Set<string>();
  for (const version of value) {
    const match =
      typeof version === "string" && version.length <= 256 ? canonical.exec(version) : null;
    if (
      !match ||
      match[0] !== version ||
      match.slice(1, 4).some((part) => !Number.isSafeInteger(Number(part))) ||
      match[4]
        ?.split(".")
        .some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))
    ) {
      throw new Error("Registry history contains a malformed or noncanonical npm version");
    }
    const identity = version;
    if (identities.has(identity))
      throw new Error("Registry history contains duplicate or ambiguous npm versions");
    identities.add(identity);
  }
  return value;
}

export function releasePublish(
  args: string[],
  options: {
    repository?: string;
    run?: CommandRunner;
    env?: NodeJS.ProcessEnv;
  } = {},
): void {
  if (args.length !== 1 || !args[0] || args[0].startsWith("-"))
    throw new Error("Usage: npm run release:publish -- TARBALL_PATH");
  const env = options.env ?? process.env;
  if (env.CI || env.GITHUB_ACTIONS || env.BUILDKITE || env.GITLAB_CI)
    throw new Error("Release publication is an explicit human command; CI is forbidden");
  const requested = resolve(args[0]);
  if (!lstatSync(requested).isFile())
    throw new Error("Candidate must be a regular file, not a symlink");
  const tarball = realpathSync(requested);
  const manifestPath = `${tarball}.manifest.json`;
  if (!lstatSync(manifestPath).isFile()) throw new Error("Manifest must be a regular file");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as CandidateManifest;
  const bytes = readFileSync(tarball);
  const { version } = inspectTarball(bytes);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.name !== "neon-usage" ||
    manifest.version !== version ||
    manifest.tag !== `v${version}` ||
    manifest.clean !== true ||
    manifest.tarball !== basename(tarball) ||
    !/^[a-f0-9]{40}$/.test(manifest.commit) ||
    !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
    manifest.sha256 !== sha256(bytes)
  )
    throw new Error("Candidate manifest, checksum, version, or clean release tag is invalid");
  const run = options.run ?? runCommand;
  const checkout = realpathSync(options.repository ?? repository);
  if (run("git", ["status", "--porcelain", "--untracked-files=all"], checkout).trim())
    throw new Error("Release requires a clean checkout");
  if (
    run("git", ["rev-parse", "HEAD"], checkout).trim() !== manifest.commit ||
    run("git", ["rev-parse", `${manifest.tag}^{commit}`], checkout).trim() !== manifest.commit ||
    run("git", ["describe", "--tags", "--exact-match", "HEAD"], checkout).trim() !== manifest.tag
  ) {
    throw new Error("Release requires the verified commit and matching version tag");
  }
  const versions = validateRegistryHistory(
    JSON.parse(run("npm", ["view", "neon-usage", "versions", "--json"], checkout)),
  );
  if (versions.includes(version)) throw new Error(`neon-usage@${version} is already published`);
  // Recheck immediately before npm consumes the exact path; never rebuild or repack.
  if (!lstatSync(tarball).isFile() || sha256(readFileSync(tarball)) !== manifest.sha256)
    throw new Error("Candidate changed before publication");
  run("npm", ["publish", "--ignore-scripts", tarball], checkout);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    releasePublish(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
