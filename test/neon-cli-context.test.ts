import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveNeonCliContext } from "../src/neon-cli-context.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Neon CLI context", () => {
  it("loads API credentials from .env.local and organization context from .neon", () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, ".env.local"), "NEON_API_KEY=local-key\n", { mode: 0o600 });
    writeFileSync(
      join(directory, ".neon"),
      JSON.stringify({ orgId: "org-local", projectId: "project-local", branch: "main" }),
    );

    expect(resolveNeonCliContext({ cwd: directory, env: {} })).toEqual({
      apiKey: "local-key",
      organizationId: "org-local",
      projectId: "project-local",
      branch: "main",
    });
  });

  it("warns when a key-bearing .env.local is readable by other accounts", () => {
    const directory = temporaryDirectory();
    const path = join(directory, ".env.local");
    writeFileSync(path, "NEON_API_KEY=local-key\n", { mode: 0o600 });
    chmodSync(path, 0o644);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      resolveNeonCliContext({ cwd: directory, env: {} });
      const warned = stderr.mock.calls.some((call) =>
        String(call[0]).includes("readable by other"),
      );
      expect(warned).toBe(true);
    } finally {
      stderr.mockRestore();
    }
  });

  it("does not warn for an owner-only .env.local", () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, ".env.local"), "NEON_API_KEY=local-key\n", { mode: 0o600 });
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      resolveNeonCliContext({ cwd: directory, env: {} });
      expect(
        stderr.mock.calls.every((call) => !String(call[0]).includes("readable by other")),
      ).toBe(true);
    } finally {
      stderr.mockRestore();
    }
  });

  it("gives exported environment values precedence over local files", () => {
    const directory = temporaryDirectory();
    writeFileSync(
      join(directory, ".env.local"),
      "NEON_API_KEY=local-key\nNEON_ORG_ID=org-local\n",
      { mode: 0o600 },
    );

    expect(
      resolveNeonCliContext({
        cwd: directory,
        env: { NEON_API_KEY: "exported-key", NEON_ORG_ID: "org-exported" },
      }),
    ).toMatchObject({ apiKey: "exported-key", organizationId: "org-exported" });
  });

  it("reads the default credential written by Neon CLI", () => {
    const directory = temporaryDirectory();
    const configDirectory = join(directory, "config");
    mkdirSync(configDirectory);
    writeFileSync(
      join(configDirectory, "credentials.json"),
      JSON.stringify({ type: "api_key", api_key: "stored-key" }),
    );

    expect(
      resolveNeonCliContext({ cwd: directory, env: {}, configDir: configDirectory }),
    ).toMatchObject({ apiKey: "stored-key" });
  });

  it("lets an explicit profile override an exported API key", () => {
    const directory = temporaryDirectory();
    const configDirectory = join(directory, "config");
    mkdirSync(configDirectory);
    writeFileSync(
      join(configDirectory, "profiles.json"),
      JSON.stringify({ version: 1, profiles: { work: { credentials: "work.json" } } }),
    );
    writeFileSync(join(configDirectory, "work.json"), JSON.stringify({ access_token: "work-key" }));

    expect(
      resolveNeonCliContext({
        cwd: directory,
        env: { NEON_API_KEY: "exported-key" },
        profile: "work",
        configDir: configDirectory,
      }),
    ).toMatchObject({ apiKey: "work-key" });
  });

  it("resolves DEFAULT through profiles.json, following a legacy sibling pointer", () => {
    // The Neon CLI, after an upgrade, keeps DEFAULT pointing at the old neonctl
    // credential; resolution must follow that pointer, not hard-code a path.
    const home = temporaryDirectory();
    const neonDir = join(home, "neon");
    const legacyDir = join(home, "neonctl");
    mkdirSync(neonDir);
    mkdirSync(legacyDir);
    writeFileSync(
      join(neonDir, "profiles.json"),
      JSON.stringify({
        version: 1,
        profiles: { DEFAULT: { credentials: "../neonctl/credentials.json" } },
      }),
    );
    writeFileSync(
      join(legacyDir, "credentials.json"),
      JSON.stringify({ type: "oauth", access_token: "legacy-oauth" }),
    );

    expect(resolveNeonCliContext({ cwd: home, env: { XDG_CONFIG_HOME: home } })).toMatchObject({
      apiKey: "legacy-oauth",
    });
  });

  it("follows a DEFAULT that points at the new neon/ credential, not the legacy file", () => {
    const home = temporaryDirectory();
    const neonDir = join(home, "neon");
    const legacyDir = join(home, "neonctl");
    mkdirSync(neonDir);
    mkdirSync(legacyDir);
    writeFileSync(
      join(neonDir, "profiles.json"),
      JSON.stringify({ version: 1, profiles: { DEFAULT: { credentials: "credentials.json" } } }),
    );
    writeFileSync(
      join(neonDir, "credentials.json"),
      JSON.stringify({ type: "api_key", api_key: "new-default" }),
    );
    writeFileSync(
      join(legacyDir, "credentials.json"),
      JSON.stringify({ type: "oauth", access_token: "old-legacy" }),
    );

    expect(resolveNeonCliContext({ cwd: home, env: { XDG_CONFIG_HOME: home } })).toMatchObject({
      apiKey: "new-default",
    });
  });

  it("rejects a profiles.json pointer that escapes the config home", () => {
    const home = temporaryDirectory();
    const neonDir = join(home, "neon");
    mkdirSync(neonDir);
    writeFileSync(
      join(neonDir, "profiles.json"),
      JSON.stringify({ version: 1, profiles: { work: { credentials: "../../outside.json" } } }),
    );

    expect(() =>
      resolveNeonCliContext({ cwd: home, env: { XDG_CONFIG_HOME: home }, profile: "work" }),
    ).toThrow("escapes");
  });

  it("selects a Neon profile named in .env.local", () => {
    const directory = temporaryDirectory();
    const configDirectory = join(directory, "config");
    mkdirSync(configDirectory);
    writeFileSync(
      join(configDirectory, "profiles.json"),
      JSON.stringify({ version: 1, profiles: { work: { credentials: "work.json" } } }),
    );
    writeFileSync(join(configDirectory, "work.json"), JSON.stringify({ access_token: "work-key" }));
    writeFileSync(join(directory, ".env.local"), "NEON_PROFILE=work\n", { mode: 0o600 });

    expect(
      resolveNeonCliContext({ cwd: directory, env: {}, configDir: configDirectory }),
    ).toMatchObject({ apiKey: "work-key" });
  });

  it("lets an exported NEON_PROFILE override one from .env.local", () => {
    const directory = temporaryDirectory();
    const configDirectory = join(directory, "config");
    mkdirSync(configDirectory);
    writeFileSync(
      join(configDirectory, "profiles.json"),
      JSON.stringify({
        version: 1,
        profiles: { work: { credentials: "work.json" }, home: { credentials: "home.json" } },
      }),
    );
    writeFileSync(join(configDirectory, "work.json"), JSON.stringify({ access_token: "work-key" }));
    writeFileSync(join(configDirectory, "home.json"), JSON.stringify({ access_token: "home-key" }));
    writeFileSync(join(directory, ".env.local"), "NEON_PROFILE=work\n", { mode: 0o600 });

    expect(
      resolveNeonCliContext({
        cwd: directory,
        env: { NEON_PROFILE: "home" },
        configDir: configDirectory,
      }),
    ).toMatchObject({ apiKey: "home-key" });
  });

  it("warns that NEON_PROFILE is ignored when an API key is also set", () => {
    const directory = temporaryDirectory();
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const resolved = resolveNeonCliContext({
        cwd: directory,
        env: { NEON_API_KEY: "exported-key", NEON_PROFILE: "work" },
      });
      expect(resolved).toMatchObject({ apiKey: "exported-key" });
      const warned = stderr.mock.calls.some((call) =>
        String(call[0]).includes("NEON_PROFILE is ignored"),
      );
      expect(warned).toBe(true);
    } finally {
      stderr.mockRestore();
    }
  });

  it("does not warn when only one of NEON_API_KEY or NEON_PROFILE is set", () => {
    const directory = temporaryDirectory();
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      resolveNeonCliContext({ cwd: directory, env: { NEON_API_KEY: "exported-key" } });
      expect(
        stderr.mock.calls.every((call) => !String(call[0]).includes("NEON_PROFILE is ignored")),
      ).toBe(true);
    } finally {
      stderr.mockRestore();
    }
  });

  it("honors stored credential type instead of preferring stale fields", () => {
    const directory = temporaryDirectory();
    const configDirectory = join(directory, "config");
    mkdirSync(configDirectory);
    writeFileSync(
      join(configDirectory, "credentials.json"),
      JSON.stringify({ type: "oauth", access_token: "oauth-token", api_key: "stale-key" }),
    );

    expect(
      resolveNeonCliContext({ cwd: directory, env: {}, configDir: configDirectory }),
    ).toMatchObject({ apiKey: "oauth-token" });
  });

  it("rejects an expired stored OAuth login with an actionable message", () => {
    const directory = temporaryDirectory();
    const configDirectory = join(directory, "config");
    mkdirSync(configDirectory);
    writeFileSync(
      join(configDirectory, "credentials.json"),
      JSON.stringify({ type: "oauth", access_token: "stale", expires_at: Date.now() - 60_000 }),
    );

    expect(() =>
      resolveNeonCliContext({ cwd: directory, env: {}, configDir: configDirectory }),
    ).toThrow(/expired.*neon auth.*NEON_API_KEY/s);
  });

  it("accepts a stored OAuth login that has not expired", () => {
    const directory = temporaryDirectory();
    const configDirectory = join(directory, "config");
    mkdirSync(configDirectory);
    writeFileSync(
      join(configDirectory, "credentials.json"),
      JSON.stringify({ type: "oauth", access_token: "fresh", expires_at: Date.now() + 3_600_000 }),
    );

    expect(
      resolveNeonCliContext({ cwd: directory, env: {}, configDir: configDirectory }),
    ).toMatchObject({ apiKey: "fresh" });
  });

  it("uses a stored OAuth login with no expires_at (lets the API arbitrate)", () => {
    const directory = temporaryDirectory();
    const configDirectory = join(directory, "config");
    mkdirSync(configDirectory);
    writeFileSync(
      join(configDirectory, "credentials.json"),
      JSON.stringify({ type: "oauth", access_token: "no-expiry" }),
    );

    expect(
      resolveNeonCliContext({ cwd: directory, env: {}, configDir: configDirectory }),
    ).toMatchObject({ apiKey: "no-expiry" });
  });

  it("rejects unknown stored credential types", () => {
    const directory = temporaryDirectory();
    const configDirectory = join(directory, "config");
    mkdirSync(configDirectory);
    writeFileSync(
      join(configDirectory, "credentials.json"),
      JSON.stringify({ type: "future", api_key: "wrong-key" }),
    );

    expect(() =>
      resolveNeonCliContext({ cwd: directory, env: {}, configDir: configDirectory }),
    ).toThrow("declares an unsupported credential type");
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "neon-usage-"));
  temporaryDirectories.push(directory);
  return directory;
}
