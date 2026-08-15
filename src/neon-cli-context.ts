import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { parseEnv } from "node:util";
import { CliError } from "./errors.js";

export type NeonCliContextOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  apiKey?: string;
  profile?: string;
  contextFile?: string;
  configDir?: string;
};

export type ResolvedNeonCliContext = {
  apiKey?: string;
  organizationId?: string;
  projectId?: string;
  branch?: string;
};

export function resolveNeonCliContext(options: NeonCliContextOptions): ResolvedNeonCliContext {
  if (nonEmpty(options.apiKey) && nonEmpty(options.profile)) {
    throw new Error("Pass either --api-key or --profile, not both");
  }
  const localEnv = readLocalEnv(options.cwd);
  const env = { ...localEnv, ...(options.env ?? process.env) };
  const fileContext = readContext(options.cwd, options.contextFile);
  const explicitProfile = nonEmpty(options.profile);
  const envApiKey = nonEmpty(env.NEON_API_KEY);
  const envProfile = nonEmpty(env.NEON_PROFILE);
  const profile = explicitProfile ?? (envApiKey ? undefined : envProfile) ?? "DEFAULT";
  // A directly supplied key (flag or NEON_API_KEY) outranks NEON_PROFILE. When
  // both are set the profile is never consulted, so say so rather than ignore it
  // silently. A command-line --profile always wins, so it is never shadowed here.
  const directKey = nonEmpty(options.apiKey) ?? (explicitProfile ? undefined : envApiKey);
  if (!explicitProfile && envProfile && directKey) {
    process.stderr.write(
      "Warning: NEON_PROFILE is ignored because an API key is set (the API key takes precedence).\n",
    );
  }
  const apiKey =
    directKey ?? (profile ? readStoredCredential(profile, env, options.configDir) : undefined);
  const organizationId = nonEmpty(env.NEON_ORG_ID) ?? fileContext?.orgId;
  const projectId = nonEmpty(env.NEON_PROJECT_ID) ?? fileContext?.projectId;
  const branch = nonEmpty(env.NEON_BRANCH) ?? nonEmpty(env.NEON_BRANCH_ID) ?? fileContext?.branch;

  return {
    ...(apiKey ? { apiKey } : {}),
    ...(organizationId ? { organizationId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(branch ? { branch } : {}),
  };
}

/** Non-secret credential facts for `doctor`: where a credential came from (or
 * why none resolved), never its value. */
export type NeonCredentialDiagnosis = {
  state: "resolved" | "missing" | "error";
  /** flag = --api-key; env = process NEON_API_KEY; env-local = .env.local. */
  source?: "flag" | "env" | "env-local" | "profile";
  profile?: string;
  /** Known only for profile credentials; a directly supplied value could be
   * either an API key or a pasted OAuth token. */
  kind?: "api_key" | "oauth";
  credentialsPath?: string;
  oauthExpiresAt?: string;
  /** The failure or fix hint for missing/error states. */
  detail?: string;
};

export type NeonCliDiagnosis = {
  credential: NeonCredentialDiagnosis;
  context:
    | {
        organizationId: string | null;
        projectId: string | null;
        branch: string | null;
        /** The .neon file that supplied file-based context, if any. */
        path: string | null;
      }
    | { error: string };
};

/**
 * The non-throwing diagnosis behind `doctor`: the same precedence walk as
 * resolveNeonCliContext, reporting each section's outcome (including
 * resolution failures like an expired login) instead of aborting on it.
 * Credential VALUES never appear in the result.
 */
export function diagnoseNeonCliContext(options: NeonCliContextOptions): NeonCliDiagnosis {
  let localEnv: NodeJS.ProcessEnv = {};
  let credential: NeonCredentialDiagnosis;
  try {
    localEnv = readLocalEnv(options.cwd);
    const processEnv = options.env ?? process.env;
    const env = { ...localEnv, ...processEnv };
    const explicitProfile = nonEmpty(options.profile);
    const envApiKey = nonEmpty(env.NEON_API_KEY);
    const profile =
      explicitProfile ?? (envApiKey ? undefined : nonEmpty(env.NEON_PROFILE)) ?? "DEFAULT";
    if (nonEmpty(options.apiKey) && explicitProfile) {
      credential = { state: "error", detail: "Pass either --api-key or --profile, not both" };
    } else if (nonEmpty(options.apiKey)) {
      credential = { state: "resolved", source: "flag" };
    } else if (!explicitProfile && envApiKey) {
      // Same precedence as resolution: process env outranks .env.local.
      const fromProcess = nonEmpty(processEnv.NEON_API_KEY) !== undefined;
      credential = { state: "resolved", source: fromProcess ? "env" : "env-local" };
    } else {
      const detail = readStoredCredentialDetail(profile, env, options.configDir);
      credential = detail
        ? {
            state: "resolved",
            source: "profile",
            profile,
            kind: detail.kind,
            credentialsPath: detail.path,
            ...(detail.oauthExpiresAt ? { oauthExpiresAt: detail.oauthExpiresAt } : {}),
          }
        : {
            state: "missing",
            profile,
            detail:
              "no credential found; run `neon auth`, or mint a profile with `neon profile create <name> --mint` then `neon-usage --profile <name>`; a NEON_API_KEY in .env.local also works",
          };
    }
  } catch (error) {
    credential = {
      state: "error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  let context: NeonCliDiagnosis["context"];
  try {
    const env = { ...localEnv, ...(options.env ?? process.env) };
    const fileContext = readContext(options.cwd, options.contextFile);
    context = {
      organizationId: nonEmpty(env.NEON_ORG_ID) ?? fileContext?.orgId ?? null,
      projectId: nonEmpty(env.NEON_PROJECT_ID) ?? fileContext?.projectId ?? null,
      branch:
        nonEmpty(env.NEON_BRANCH) ?? nonEmpty(env.NEON_BRANCH_ID) ?? fileContext?.branch ?? null,
      path: fileContext?.path ?? null,
    };
  } catch (error) {
    context = { error: error instanceof Error ? error.message : String(error) };
  }
  return { credential, context };
}

// Keys .env.local may supply. Path-steering keys (HOME, XDG_CONFIG_HOME,
// NEON_CONFIG_DIR, ...) stay env-only so an untrusted working directory cannot
// redirect credential discovery to an arbitrary local file. NEON_PROFILE is
// allowed: it only names a profile, and credential resolution is confined to
// the config home (see readStoredCredential), so a stray .env.local can at
// worst select one of the user's own existing profiles — a convenience, not a
// redirection. An exported NEON_PROFILE still wins (process env overrides).
const localEnvKeys = new Set([
  "NEON_API_KEY",
  "NEON_PROFILE",
  "NEON_ORG_ID",
  "NEON_PROJECT_ID",
  "NEON_BRANCH",
  "NEON_BRANCH_ID",
]);

function readLocalEnv(cwd: string): NodeJS.ProcessEnv {
  const path = findUp(cwd, ".env.local");
  if (!path) return {};
  try {
    const parsed = parseEnv(readSmallTextFile(path));
    const selected = Object.fromEntries(
      Object.entries(parsed).filter(([key]) => localEnvKeys.has(key)),
    );
    // A group- or world-readable .env.local hands any local account the Neon
    // key it may hold; warn rather than fail, and only when it carries one.
    if (selected.NEON_API_KEY) warnIfGroupOrWorldReadable(path);
    return selected;
  } catch (error) {
    throw new Error(`Could not read ${path}`, { cause: error });
  }
}

function warnIfGroupOrWorldReadable(path: string): void {
  // POSIX permission bits only; on platforms without them (Windows) mode
  // is not meaningful, so this is best-effort.
  try {
    const mode = statSync(path).mode & 0o077;
    if (mode !== 0) {
      process.stderr.write(
        `Warning: ${path} is readable by other accounts (mode ${(mode | 0o600).toString(8)}); ` +
          "it may contain NEON_API_KEY. Consider: chmod 600 " +
          path +
          "\n",
      );
    }
  } catch {
    // Permission inspection is advisory; never block credential resolution on it.
  }
}

function readContext(cwd: string, explicitPath?: string) {
  const path = explicitPath ? resolve(cwd, explicitPath) : findContext(cwd);
  if (!path) return null;
  let value: unknown;
  try {
    value = JSON.parse(readSmallTextFile(path));
  } catch (error) {
    throw new Error(`Could not read Neon context from ${path}`, { cause: error });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Neon context at ${path} must contain a JSON object`);
  }
  const context = value as Record<string, unknown>;
  return {
    path,
    ...(nonEmpty(context.orgId) ? { orgId: nonEmpty(context.orgId) } : {}),
    ...(nonEmpty(context.projectId) ? { projectId: nonEmpty(context.projectId) } : {}),
    ...((nonEmpty(context.branch) ?? nonEmpty(context.branchId))
      ? { branch: nonEmpty(context.branch) ?? nonEmpty(context.branchId) }
      : {}),
  };
}

function findContext(cwd: string): string | undefined {
  const start = resolve(cwd);
  let current = start;
  const stop = resolve(homedir());
  while (true) {
    if (current === stop && current !== start) return undefined;
    const directoryContext = join(current, ".neon", "project.json");
    if (isFile(directoryContext)) return directoryContext;
    const fileContext = join(current, ".neon");
    if (isFile(fileContext)) return fileContext;
    if (existsSync(join(current, ".git")) || current === stop) return undefined;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function readStoredCredential(
  profile: string,
  env: NodeJS.ProcessEnv,
  explicitConfigDir?: string,
): string | undefined {
  return readStoredCredentialDetail(profile, env, explicitConfigDir)?.value;
}

/** A stored profile credential plus the non-secret facts `doctor` reports. */
type StoredCredentialDetail = {
  value: string;
  kind: "api_key" | "oauth";
  path: string;
  /** ISO expiry for an OAuth login that declares one (already validated as unexpired). */
  oauthExpiresAt?: string;
};

function readStoredCredentialDetail(
  profile: string,
  env: NodeJS.ProcessEnv,
  explicitConfigDir?: string,
): StoredCredentialDetail | undefined {
  const currentDir = resolveConfigDir(env, explicitConfigDir, "neon");
  const legacyDir = explicitConfigDir ? undefined : resolveConfigDir(env, undefined, "neonctl");
  // Credential pointers in profiles.json may not resolve outside this root. For
  // a real XDG layout it is the config home (the parent of `neon/`), so the Neon
  // CLI's own DEFAULT entry into the sibling legacy `neonctl/` dir is allowed
  // while an escape to an arbitrary file is not; an explicit --config-dir is its
  // own root.
  const confineRoot = explicitConfigDir ? resolve(explicitConfigDir) : dirname(currentDir);

  // DEFAULT is resolved through profiles.json like any profile, so it tracks
  // wherever the CLI points its default (neon/ today, neonctl/ in transition)
  // rather than hard-coding a path. A broken or absent entry is tolerated only
  // for DEFAULT, which then falls back to a bare credentials.json.
  let credentialsPath: string | undefined;
  try {
    credentialsPath = credentialFromProfiles(profile, currentDir, legacyDir, confineRoot);
  } catch (error) {
    if (profile !== "DEFAULT") throw error;
    credentialsPath = undefined;
  }
  if (profile === "DEFAULT" && (!credentialsPath || !existsSync(credentialsPath))) {
    credentialsPath = firstExisting([
      join(currentDir, "credentials.json"),
      ...(legacyDir ? [join(legacyDir, "credentials.json")] : []),
    ]);
  }

  if (!credentialsPath || !existsSync(credentialsPath)) return undefined;
  const credential = readJsonObject(credentialsPath);
  const apiKey = nonEmpty(credential.api_key);
  const accessToken = nonEmpty(credential.access_token);
  if (credential.type === "api_key") {
    if (apiKey) return { value: apiKey, kind: "api_key", path: credentialsPath };
    throw new CliError({
      headline: "Malformed Neon credentials file",
      detail: `${credentialsPath} declares an API key but contains no api_key value.`,
      fix: "Run `neon auth` to replace it, or put a NEON_API_KEY in .env.local.",
    });
  }
  if (credential.type === undefined || credential.type === "oauth") {
    // OAuth access tokens expire (~hourly). The Neon CLI refreshes them with the
    // refresh_token; this read-only tool does not, so a stale token would only
    // surface as an opaque HTTP 401. Detect it from expires_at and say so.
    const expiresAt = parseExpiry(credential.expires_at);
    if (expiresAt !== null && expiresAt <= Date.now()) {
      const when = `${new Date(expiresAt).toISOString().slice(0, 16).replace("T", " ")} UTC`;
      throw new CliError({
        headline: "Neon login expired",
        detail: `The stored login at ${credentialsPath} expired at ${when}.`,
        fix:
          "Run `neon auth` to refresh it, or mint a profile: `neon profile create <name> --mint` " +
          "then `neon-usage --profile <name>`. A NEON_API_KEY in .env.local also works and " +
          "does not expire.",
      });
    }
    return accessToken
      ? {
          value: accessToken,
          kind: "oauth",
          path: credentialsPath,
          ...(expiresAt !== null ? { oauthExpiresAt: new Date(expiresAt).toISOString() } : {}),
        }
      : undefined;
  }
  throw new CliError({
    headline: "Unsupported Neon credential type",
    detail: `${credentialsPath} declares an unsupported credential type.`,
    fix: "Run `neon auth` to replace it.",
  });
}

/**
 * The credentials file a profiles.json entry points at, confined to `confineRoot`,
 * or undefined when there is no usable entry. Throws for an unknown *named*
 * profile; DEFAULT is allowed to be absent so the caller can fall back to a bare
 * credentials.json.
 */
function credentialFromProfiles(
  profile: string,
  currentDir: string,
  legacyDir: string | undefined,
  confineRoot: string,
): string | undefined {
  const profilesPath = firstExisting([
    join(currentDir, "profiles.json"),
    ...(legacyDir ? [join(legacyDir, "profiles.json")] : []),
  ]);
  const entry = existsSync(profilesPath) ? profileEntry(profilesPath, profile) : undefined;
  if (!entry) {
    if (profile === "DEFAULT") return undefined;
    throw new Error(`Unknown Neon profile "${profile}"; run \`neon profile list\``);
  }
  const pointer = nonEmpty(entry.credentials);
  if (!pointer) {
    if (profile === "DEFAULT") return undefined;
    throw new Error(`Neon profile "${profile}" has no credentials path`);
  }
  const configRoot = dirname(profilesPath);
  const credentialsPath = isAbsolute(pointer) ? pointer : resolve(configRoot, pointer);
  // Confine by real path, not just the lexical string: a symlink inside the
  // config home could otherwise point the read anywhere on disk. Non-existent
  // trailing components resolve through their nearest existing ancestor, so a
  // root reached via a symlink (e.g. /tmp -> /private/tmp, a linked $HOME)
  // never causes a false "escapes" rejection for a merely-missing file.
  const realRoot = deepRealpath(confineRoot);
  const realCredentials = deepRealpath(credentialsPath);
  if (realCredentials !== realRoot && !realCredentials.startsWith(realRoot + sep)) {
    throw new Error(`Neon profile "${profile}" credentials path escapes ${confineRoot}`);
  }
  return credentialsPath;
}

/**
 * realpath that tolerates missing trailing components: the nearest existing
 * ancestor is resolved and the remaining segments are re-joined lexically.
 */
function deepRealpath(path: string): string {
  let current = path;
  const pending: string[] = [];
  while (true) {
    try {
      return pending.length === 0
        ? realpathSync(current)
        : join(realpathSync(current), ...pending.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return path; // filesystem root unresolvable
      pending.push(basename(current));
      current = parent;
    }
  }
}

/** The named entry inside a profiles.json's `profiles` object, or undefined. */
function profileEntry(profilesPath: string, profile: string): Record<string, unknown> | undefined {
  const profiles = readJsonObject(profilesPath);
  const entries = profiles.profiles;
  if (typeof entries !== "object" || entries === null || Array.isArray(entries)) {
    throw new Error(`${profilesPath} has no profiles object`);
  }
  const entry = (entries as Record<string, unknown>)[profile];
  if (entry === undefined) return undefined;
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new Error(`Neon profile "${profile}" is not an object in ${profilesPath}`);
  }
  return entry as Record<string, unknown>;
}

function resolveConfigDir(env: NodeJS.ProcessEnv, explicit: string | undefined, name: string) {
  const selected =
    nonEmpty(explicit) ?? nonEmpty(env.NEON_CONFIG_DIR) ?? nonEmpty(env.NEONCTL_CONFIG_DIR);
  if (selected) return resolve(selected);
  const configHome =
    nonEmpty(env.XDG_CONFIG_HOME) ?? join(nonEmpty(env.HOME) ?? homedir(), ".config");
  return join(configHome, name);
}

function readJsonObject(path: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(readSmallTextFile(path));
  } catch (error) {
    throw new Error(`Could not read ${path}`, { cause: error });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return value as Record<string, unknown>;
}

function findUp(cwd: string, relativePath: string): string | undefined {
  const start = resolve(cwd);
  let current = start;
  const stop = resolve(homedir());
  while (true) {
    if (current === stop && current !== start) return undefined;
    const candidate = join(current, relativePath);
    if (isFile(candidate)) return candidate;
    if (existsSync(join(current, ".git")) || current === stop) return undefined;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function firstExisting(paths: string[]): string {
  return paths.find((path) => existsSync(path)) ?? paths[0] ?? "";
}

/**
 * Read a small local config file through a single descriptor: fstat the open fd
 * (not the path) so a regular-file and size check can't race the read, and cap
 * the size so a hostile working directory can't exhaust memory with a huge file.
 */
function readSmallTextFile(path: string, maxBytes = 1_000_000): string {
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${path} is not a regular file`);
    if (stat.size > maxBytes) {
      throw new Error(`${path} is too large (${stat.size} bytes; limit ${maxBytes})`);
    }
    if (stat.size === 0) return "";
    const buffer = Buffer.allocUnsafe(stat.size);
    let read = 0;
    while (read < stat.size) {
      const bytes = readSync(fd, buffer, read, stat.size - read, read);
      if (bytes === 0) break;
      read += bytes;
    }
    return buffer.toString("utf8", 0, read);
  } finally {
    closeSync(fd);
  }
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Milliseconds-since-epoch for a credential's expires_at, or null if unreadable.
 * Accepts epoch milliseconds, epoch seconds, or an ISO-8601 string. */
function parseExpiry(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Seconds vs milliseconds: anything below ~year 2286 in ms is implausible as
    // a future expiry, so treat small numbers as seconds.
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}
