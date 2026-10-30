import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { packedCliTarget, runPackedCli } from "../package-fixtures/consumer/src/cli.js";
import {
  assertCleanVerifierLaunch,
  cleanChildEnvironment,
} from "../package-fixtures/consumer/src/environment.js";
import { releasePublish, validateRegistryHistory } from "../scripts/release-publish.js";
import {
  assertBrowserModule,
  assertInside,
  assertOutsideCheckout,
  bundleBrowser,
  inspectTarball,
  npmCliTarget,
  npmExecutable,
  readTarEntries,
  repository,
  runCommand,
  sha256,
  validateTarEntries,
  verifyPackage,
} from "../scripts/verify-package.js";
import { verifyReadmeExamples } from "../scripts/verify-readme-examples.js";

const names = [
  "package/package.json",
  "package/dist/index.js",
  "package/dist/index.d.ts",
  "package/dist/contracts.js",
  "package/dist/contracts.d.ts",
  "package/dist/bin.js",
  "package/dist/package-version.js",
  "package/dist/sqlite-fact-store.js",
  "package/dist/sqlite-fact-store.d.ts",
  "package/dist/dashboard/index.html",
  "package/dist/dashboard/assets/main.js",
  "package/dist/dashboard/assets/main.css",
];
const entries = () => names.map((name) => ({ name, type: "0" }));

// A real gzip/tar fixture, independent of npm and the implementation's parser.
function tarball(files: Record<string, string>) {
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(files)) {
    const data = Buffer.from(value);
    const header = Buffer.alloc(512);
    header.write(name);
    header.write("0000644\0", 100);
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    header.fill(32, 148, 156);
    header.write("0", 156);
    header.write("ustar\0", 257);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
    parts.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}

function candidate() {
  return tarball({
    ...Object.fromEntries(names.map((name) => [name, "export {};"])),
    "package/package.json": JSON.stringify({
      name: "neon-usage",
      version: "0.5.0",
      engines: { node: ">=24.0.0" },
      exports: {
        ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
        "./contracts": { types: "./dist/contracts.d.ts", default: "./dist/contracts.js" },
      },
      bin: { "neon-usage": "dist/bin.js" },
    }),
    "package/dist/package-version.js": 'export const packageVersion = "0.5.0";\n',
  });
}

describe("exact package inspection", () => {
  it("resolves Windows npm shims to JavaScript without a shell", () => {
    expect(npmExecutable("win32")).toBe("npm.cmd");
    expect(npmExecutable("linux")).toBe("npm");
    expect(npmCliTarget("C:\\Program Files\\nodejs\\npm.cmd", win32)).toBe(
      "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
    );
  });

  it("accepts other Windows drives and rejects descendants and path tricks", () => {
    for (const output of [
      "D:\\candidates",
      "C:\\candidates",
      "C:\\checkout-other",
      "C:\\checkout\\..\\candidate",
    ])
      expect(() => assertOutsideCheckout("C:\\checkout", output, win32)).not.toThrow();
    for (const output of [
      "C:\\checkout",
      "c:\\CHECKOUT\\candidate",
      "C:\\checkout\\x\\..\\candidate",
    ])
      expect(() => assertOutsideCheckout("C:\\checkout", output, win32)).toThrow(/outside/);
    expect(() => assertOutsideCheckout("/checkout", "/candidate")).not.toThrow();
    expect(() => assertOutsideCheckout("/checkout", "/checkout/candidate")).toThrow(/outside/);
  });

  it("runs the installed JavaScript bin target even when a Windows shim exists", () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "neon-usage-bin-target-")));
    try {
      const installed = join(directory, "node_modules/neon-usage");
      mkdirSync(join(installed, "dist"), { recursive: true });
      mkdirSync(join(directory, "node_modules/.bin"));
      writeFileSync(
        join(installed, "package.json"),
        JSON.stringify({ bin: { "neon-usage": "dist/bin.js" } }),
      );
      writeFileSync(join(installed, "dist/bin.js"), "console.log('actual JavaScript bin');");
      writeFileSync(
        join(directory, "node_modules/.bin/neon-usage.cmd"),
        "@ECHO OFF\r\nexit /b 99\r\n",
      );
      cpSync(join(repository, "package-fixtures/consumer/src"), join(directory, "src"), {
        recursive: true,
      });
      writeFileSync(
        join(directory, "verification.json"),
        JSON.stringify({ checkout: repository, consumer: directory }),
      );
      const target = packedCliTarget(directory);
      expect(target).toBe(join(installed, "dist/bin.js"));
      const result = runPackedCli(target, [], directory);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("actual JavaScript bin");
      for (const bin of ["../outside.js", "dist/bin.cmd"]) {
        writeFileSync(join(directory, "node_modules/outside.js"), "");
        writeFileSync(
          join(installed, "package.json"),
          JSON.stringify({ bin: { "neon-usage": bin } }),
        );
        expect(() => packedCliTarget(directory)).toThrow(/bin/);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("requires declarations, executable, version metadata, and built dashboard assets", () => {
    expect(() => validateTarEntries(entries())).not.toThrow();
    for (const required of names) {
      expect(() =>
        validateTarEntries(entries().filter((entry) => entry.name !== required)),
      ).toThrow();
    }
  });

  it("accepts a manifest containing every compiled source module, including SQLite", () => {
    const compiled = readdirSync(join(repository, "src"))
      .filter((name) => name.endsWith(".ts"))
      .flatMap((name) =>
        ["js", "d.ts"].map((extension) => ({
          name: `package/dist/${name.slice(0, -3)}.${extension}`,
          type: "0",
        })),
      );
    const compiledNames = new Set(compiled.map((entry) => entry.name));
    expect(() =>
      validateTarEntries([
        ...entries().filter((entry) => !compiledNames.has(entry.name)),
        ...compiled,
      ]),
    ).not.toThrow();
  });

  it.each([
    "package/src/index.ts",
    "package/dist/source.ts",
    "package/dist/source.js.map",
    "package/.DS_Store",
    "package/dist/.DS_Store",
    "package/.env.production",
    "package/dist/key.pem",
    "package/dist/data.sqlite",
    "package/dist/data.sqlite3",
    "package/dist/data.sqlite-wal",
    "package/dist/data.sqlite3-shm",
    "package/dist/data.db",
    "package/dist/data.db-journal",
    "package/dist/db.db-wal",
    "package/.aws/credentials",
    "package/test/a.js",
    "package/scripts/release.js",
    "package/node_modules/a.js",
    "package/dist/a.test.js",
    "package/dist/credentials.json",
    "package/dist/dashboard/assets/.env",
    "package/dist/dashboard/assets/data.sqlite",
    "package/../secret",
    "/package/dist/index.js",
    "package/dist/../../secret",
    "package/dist\\secret.js",
    "package/dist/client.js/../index.js",
  ])("rejects forbidden or unrelated entry %s", (name) => {
    expect(() => validateTarEntries([...entries(), { name, type: "0" }])).toThrow();
  });

  it("rejects links, duplicate entries, malformed headers, and altered metadata", () => {
    expect(() =>
      validateTarEntries([...entries(), { name: "package/dist/link.js", type: "2" }]),
    ).toThrow();
    expect(() =>
      validateTarEntries([...entries(), { name: "package/package.json", type: "0" }]),
    ).toThrow();
    expect(inspectTarball(candidate()).version).toBe("0.5.0");
    const alteredVersion = Object.fromEntries(
      readTarEntries(candidate()).map((entry) => [entry.name, entry.data?.toString("utf8") ?? ""]),
    );
    alteredVersion["package/dist/package-version.js"] = 'export const packageVersion = "9.0.0";\n';
    expect(() => inspectTarball(tarball(alteredVersion))).toThrow(/producer version/);
    expect(() => inspectTarball(gzipSync(Buffer.from("not tar")))).toThrow();
    expect(() => inspectTarball(tarball({ "package/package.json": "{}" }))).toThrow();
  });

  it("rejects checkout escapes and impure browser modules", () => {
    expect(() => assertInside("/tmp/consumer", "/tmp/consumer/node_modules/a.js")).not.toThrow();
    expect(() => assertInside("/tmp/consumer", "/tmp/consumer-other/a.js")).toThrow();
    for (const id of [
      "node:fs",
      "fs",
      "\0__vite-browser-external",
      "/tmp/app/node_modules/neon-usage/dist/client.js",
      "/tmp/app/node_modules/neon-usage/dist/neon-cli-context.js",
      "/repo/src/contracts.ts",
    ]) {
      expect(() => assertBrowserModule(id, "/tmp/app", "/repo")).toThrow();
    }
    expect(() =>
      assertBrowserModule(
        "/tmp/app/node_modules/neon-usage/dist/contracts.js",
        "/tmp/app",
        "/repo",
      ),
    ).not.toThrow();
  });
});

describe("release guard (mock commands only)", () => {
  function fixture() {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "neon-usage-release-test-")));
    const path = join(directory, "candidate.tgz");
    writeFileSync(path, candidate());
    const manifest = {
      schemaVersion: 1,
      name: "neon-usage",
      version: "0.5.0",
      commit: "a".repeat(40),
      tag: "v0.5.0",
      clean: true,
      tarball: "candidate.tgz",
      sha256: sha256(readFileSync(path)),
    };
    writeFileSync(`${path}.manifest.json`, JSON.stringify(manifest));
    const calls: string[][] = [];
    const run = (command: string, args: string[]) => {
      calls.push([command, ...args]);
      if (command === "git") {
        if (args[0] === "status") return "";
        if (args[0] === "describe") return "v0.5.0\n";
        return `${"a".repeat(40)}\n`;
      }
      if (args[0] === "view") return '["0.3.0"]';
      return "";
    };
    return { directory, path, manifest, calls, run };
  }

  it("publishes only the supplied verified path after every guard, without packing", () => {
    const f = fixture();
    try {
      releasePublish([f.path], { repository: f.directory, run: f.run, env: {} });
      expect(f.calls.at(-1)).toEqual(["npm", "publish", "--ignore-scripts", f.path]);
      expect(f.calls.some((call) => call.includes("pack") || call.includes("build"))).toBe(false);
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

  it.each([
    "arguments",
    "checksum",
    "version",
    "tag",
    "dirty",
    "published",
    "registry",
    "invalidRegistry",
    "unverified",
    "commit",
    "tagCommit",
    "changed",
    "ci",
  ])("fails closed on %s without publishing", (failure) => {
    const f = fixture();
    try {
      if (failure === "checksum") writeFileSync(f.path, "changed");
      if (failure === "version")
        writeFileSync(
          `${f.path}.manifest.json`,
          JSON.stringify({ ...f.manifest, version: "9.0.0" }),
        );
      if (failure === "unverified")
        writeFileSync(`${f.path}.manifest.json`, JSON.stringify({ ...f.manifest, clean: false }));
      const run = (command: string, args: string[]) => {
        if (failure === "tag" && args[0] === "describe") return "v9.0.0";
        if (failure === "commit" && args[0] === "rev-parse" && args[1] === "HEAD")
          return "b".repeat(40);
        if (failure === "tagCommit" && args[0] === "rev-parse" && args[1] !== "HEAD")
          return "b".repeat(40);
        if (failure === "invalidRegistry" && args[0] === "view") return "null";
        if (failure === "changed" && args[0] === "view")
          writeFileSync(f.path, "changed during registry query");
        if (failure === "dirty" && args[0] === "status") return " M src/client.ts";
        if (failure === "published" && args[0] === "view") return '["0.5.0"]';
        if (failure === "registry" && args[0] === "view") throw new Error("DNS unavailable");
        return f.run(command, args);
      };
      expect(() =>
        releasePublish(failure === "arguments" ? [f.path, "extra"] : [f.path], {
          repository: f.directory,
          run,
          env: failure === "ci" ? { CI: "true" } : {},
        }),
      ).toThrow();
      expect(f.calls.some((call) => call[1] === "publish")).toBe(false);
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

  it("accepts canonical stable and prerelease registry versions", () => {
    const versions = ["0.3.0", "0.4.0-alpha.1", "0.4.0-0", "1.0.0-beta.x"];
    expect(validateRegistryHistory(versions)).toEqual(versions);
  });

  it.each([
    [],
    [""],
    ["garbage"],
    ["v0.3.0"],
    ["0.03.0"],
    ["0.3"],
    [" 0.3.0"],
    ["0.3.0\n"],
    ["0.3.0\r\n"],
    ["0.3.0+build"],
    ["0.5.0+build"],
    ["0.3.0-rc.01"],
    ["0.3.0", "0.3.0"],
    ["0.3.0-01"],
    ["0.3.0+build", "0.3.0+other"],
    ["0.3.0", 7],
    ["9007199254740992.0.0"],
  ])("rejects malformed or ambiguous registry history %j without publishing", (...history) => {
    const f = fixture();
    try {
      expect(() =>
        releasePublish([f.path], {
          repository: f.directory,
          env: {},
          run: (command, args) =>
            args[0] === "view" ? JSON.stringify(history) : f.run(command, args),
        }),
      ).toThrow(/Registry history/);
      expect(f.calls.some((call) => call[1] === "publish")).toBe(false);
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  });
});

describe("candidate orchestration (injected commands, real temporary files)", () => {
  async function fixture(failure?: "check" | "bundle" | "changed" | "escape") {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "neon-usage-verifier-test-")));
    const checkout = join(directory, "checkout");
    const output = join(directory, "output");
    const nativeCompilerLibrary = join(
      checkout,
      "node_modules/@typescript",
      `typescript-${process.platform}-${process.arch}`,
      "lib",
    );
    mkdirSync(join(checkout, "package-fixtures/consumer"), { recursive: true });
    mkdirSync(join(checkout, "node_modules/typescript/lib"), { recursive: true });
    mkdirSync(nativeCompilerLibrary, { recursive: true });
    writeFileSync(join(nativeCompilerLibrary, "lib.es5.d.ts"), "interface Array<T> {}\n");
    writeFileSync(join(checkout, "package-fixtures/consumer/package.json"), '{"private":true}');
    cpSync(join(repository, "README.md"), join(checkout, "README.md"));
    mkdirSync(join(checkout, "docs"));
    cpSync(join(repository, "docs/sdk.md"), join(checkout, "docs/sdk.md"));
    mkdirSync(join(checkout, "package-fixtures/consumer/src"));
    cpSync(
      join(repository, "package-fixtures/consumer/src/documentation.ts"),
      join(checkout, "package-fixtures/consumer/src/documentation.ts"),
    );
    const calls: { command: string; args: string[]; cwd: string }[] = [];
    let installedTarball: string | undefined;
    const run = (command: string, args: string[], cwd: string) => {
      calls.push({ command, args, cwd });
      if (failure === "check" && args[1] === "check") throw new Error("source check failed");
      if (command === "git") {
        if (args[0] === "status") return "";
        if (args[0] === "describe") return "v0.5.0";
        return "a".repeat(40);
      }
      if (args[0] === "pack") {
        writeFileSync(join(output, "candidate.tgz"), candidate());
        return JSON.stringify([
          { filename: failure === "escape" ? "../candidate.tgz" : "candidate.tgz" },
        ]);
      }
      if (args[0] === "install") {
        installedTarball = args.at(-1);
        const installed = join(cwd, "node_modules/neon-usage");
        for (const entry of readTarEntries(candidate())) {
          const path = join(installed, entry.name.slice("package/".length));
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, entry.data ?? "");
        }
      }
      if (command === process.execPath && args.includes("--listFiles"))
        return [
          join(nativeCompilerLibrary, "lib.es5.d.ts"),
          ...["index", "contracts"].map((entry) =>
            join(cwd, "node_modules/neon-usage/dist", `${entry}.d.ts`),
          ),
        ].join("\n");
      return "";
    };
    const bundle = async () => {
      expect(() => readFileSync(join(output, "candidate.tgz.manifest.json"))).toThrow();
      if (failure === "bundle") throw new Error("browser audit failed");
      if (failure === "changed") writeFileSync(join(output, "candidate.tgz"), "changed");
    };
    return { directory, checkout, output, calls, run, bundle, installed: () => installedTarball };
  }

  it.each([
    "NODE_OPTIONS",
    "NODE_PATH",
    "npm_config_node_options",
    "npm_config_script_shell",
    "TS_NODE_PROJECT",
  ])("rejects contaminated verifier launch %s before producing any manifest", async (key) => {
    const f = await fixture();
    const previous = process.env[key];
    try {
      process.env[key] = "untrusted-loader-input";
      await expect(
        verifyPackage({
          launchArgs: [],
          output: f.output,
          repository: f.checkout,
          run: f.run,
          bundle: f.bundle,
        }),
      ).rejects.toThrow(/contaminated/i);
      expect(f.calls).toHaveLength(0);
      expect(existsSync(join(f.output, "candidate.tgz.manifest.json"))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

  it("checks before build, packs once, installs the same candidate, and certifies only after all checks", async () => {
    const f = await fixture();
    try {
      const result = await verifyPackage({
        launchArgs: [],
        output: f.output,
        repository: f.checkout,
        run: f.run,
        bundle: f.bundle,
      });
      expect(
        f.calls
          .filter((call) => call.command === "npm")
          .slice(0, 3)
          .map((call) => call.args),
      ).toEqual([
        ["run", "check"],
        ["run", "build"],
        ["run", "test:package"],
      ]);
      const pack = f.calls.filter((call) => call.args[0] === "pack");
      expect(pack).toHaveLength(1);
      expect(pack[0]?.args).toEqual([
        "pack",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        f.output,
      ]);
      expect(f.installed()).toBe(result.tarball);
      expect(readdirSync(f.output).sort()).toEqual([
        "candidate.tgz",
        "candidate.tgz.manifest.json",
      ]);
      expect(JSON.parse(readFileSync(`${result.tarball}.manifest.json`, "utf8"))).toEqual(
        result.manifest,
      );
      expect(result.manifest.sha256).toBe(sha256(readFileSync(result.tarball)));
      expect(() => realpathSync(result.consumer)).toThrow();
      expect(
        f.calls
          .filter((call) => call.command === process.execPath)
          .every((call) => call.cwd !== f.checkout),
      ).toBe(true);
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

  it.each(["crlf", "mixed", "readme-only", "fixture-only"])(
    "accepts normalized README examples with %s line endings",
    async (style) => {
      const f = await fixture();
      try {
        for (const [index, file] of [
          "README.md",
          "docs/sdk.md",
          "package-fixtures/consumer/src/documentation.ts",
        ].entries()) {
          if ((style === "readme-only" && index !== 0) || (style === "fixture-only" && index !== 2))
            continue;
          const path = join(f.checkout, file);
          let line = 0;
          writeFileSync(
            path,
            readFileSync(path, "utf8").replace(/\r?\n/g, () =>
              style !== "mixed" || ++line % 2 === 0 ? "\r\n" : "\n",
            ),
          );
        }
        expect(() => verifyReadmeExamples(f.checkout)).not.toThrow();
      } finally {
        rmSync(f.directory, { recursive: true, force: true });
      }
    },
  );

  it.each(["missing", "reordered"])(
    "rejects %s README markers after line-ending normalization",
    async (mutation) => {
      const f = await fixture();
      try {
        const file = mutation === "missing" ? "README.md" : "docs/sdk.md";
        const path = join(f.checkout, file);
        const document = readFileSync(path, "utf8");
        writeFileSync(
          path,
          (mutation === "missing"
            ? document.replace("<!-- README example: history -->", "")
            : document
                .replace("example: current", "example: swapped")
                .replace("example: coordinator", "example: current")
                .replace("example: swapped", "example: coordinator")
          ).replace(/\n/g, "\r\n"),
        );
        expect(() => verifyReadmeExamples(f.checkout)).toThrow(/markers/);
      } finally {
        rmSync(f.directory, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ["README.md", "collectHistory"],
    ["README.md", "parseCliExport"],
    ["docs/sdk.md", "collectCurrent"],
    ["docs/sdk.md", "listWithSharedCoordinator"],
    ...["collectHistory", "collectCurrent", "listWithSharedCoordinator", "parseCliExport"].map(
      (name) => ["package-fixtures/consumer/src/documentation.ts", name],
    ),
  ])(
    "rejects example drift in %s (%s) before verification commands or output creation",
    async (file, name) => {
      const f = await fixture();
      try {
        const path = join(f.checkout, file);
        writeFileSync(
          path,
          readFileSync(path, "utf8").replace(`function ${name}`, "function changedExample"),
        );
        await expect(
          verifyPackage({
            launchArgs: [],
            output: f.output,
            repository: f.checkout,
            run: f.run,
            bundle: f.bundle,
          }),
        ).rejects.toThrow(/Documentation example.*differs/);
        expect(f.calls).toHaveLength(0);
        expect(existsSync(f.output)).toBe(false);
      } finally {
        rmSync(f.directory, { recursive: true, force: true });
      }
    },
  );

  it.each(["check", "bundle", "changed", "escape"] as const)(
    "fails closed on %s and leaves no success manifest",
    async (failure) => {
      const f = await fixture(failure);
      try {
        await expect(
          verifyPackage({
            launchArgs: [],
            output: f.output,
            repository: f.checkout,
            run: f.run,
            bundle: f.bundle,
          }),
        ).rejects.toThrow();
        expect(readdirSync(f.output)).not.toContain("candidate.tgz.manifest.json");
        if (failure === "check")
          expect(f.calls.some((call) => call.args[0] === "pack")).toBe(false);
      } finally {
        rmSync(f.directory, { recursive: true, force: true });
      }
    },
  );

  it("rejects symlinked release input before running any command", () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "neon-usage-link-test-")));
    try {
      const original = join(directory, "original.tgz");
      const link = join(directory, "link.tgz");
      writeFileSync(original, candidate());
      symlinkSync(original, link);
      expect(() =>
        releasePublish([link], {
          env: {},
          run: () => {
            throw new Error("command must not execute");
          },
        }),
      ).toThrow(/regular file/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("real Vite browser audit with isolated actual contracts", () => {
  it("bundles and executes compiled contracts, and rejects a dependency symlink outside the consumer", async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "neon-usage-browser-test-")));
    try {
      cpSync(join(repository, "package-fixtures/consumer"), directory, { recursive: true });
      const installed = join(directory, "node_modules/neon-usage");
      mkdirSync(installed, { recursive: true });
      writeFileSync(
        join(installed, "package.json"),
        JSON.stringify({
          name: "neon-usage",
          type: "module",
          exports: { "./contracts": "./dist/contracts.js" },
        }),
      );
      runCommand(
        process.execPath,
        [
          join(repository, "node_modules/typescript/bin/tsc"),
          "--ignoreConfig",
          "--target",
          "ES2023",
          "--module",
          "NodeNext",
          "--moduleResolution",
          "NodeNext",
          "--strict",
          "--skipLibCheck",
          "--rootDir",
          join(repository, "src"),
          "--outDir",
          join(installed, "dist"),
          join(repository, "src/contracts.ts"),
        ],
        repository,
      );
      for (const dependency of ["decimal.js", "zod"])
        cpSync(
          join(repository, "node_modules", dependency),
          join(directory, "node_modules", dependency),
          { recursive: true, dereference: true },
        );
      writeFileSync(
        join(directory, "verification.json"),
        JSON.stringify({ checkout: repository, consumer: directory, version: "fixture" }),
      );
      await expect(bundleBrowser(directory, repository)).resolves.toBeUndefined();
      rmSync(join(directory, "node_modules/zod"), { recursive: true, force: true });
      symlinkSync(
        realpathSync(join(repository, "node_modules/zod")),
        join(directory, "node_modules/zod"),
        "dir",
      );
      await expect(bundleBrowser(directory, repository)).rejects.toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("build metadata and lifecycle command boundaries", () => {
  it("generates a literal from the package's current version without a hardcoded release version", () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "neon-usage-version-test-")));
    try {
      mkdirSync(join(directory, "scripts"));
      mkdirSync(join(directory, "dist"));
      cpSync(
        join(repository, "scripts/write-package-version.ts"),
        join(directory, "scripts/write-package-version.ts"),
      );
      writeFileSync(
        join(directory, "package.json"),
        JSON.stringify({ type: "module", version: "7.8.9-test" }),
      );
      writeFileSync(join(directory, "dist/bin.js"), "#!/usr/bin/env node\n");
      runCommand(process.execPath, ["scripts/write-package-version.ts"], directory);
      expect(readFileSync(join(directory, "dist/package-version.js"), "utf8")).toBe(
        'export const packageVersion = "7.8.9-test";\n',
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects direct publication and passes command arguments without a shell", () => {
    expect(() =>
      runCommand(process.execPath, ["scripts/reject-direct-publish.ts"], repository),
    ).toThrow(/release:publish/);
    const literal = "a path; $(must-not-execute) `neither-this`";
    expect(
      runCommand(
        process.execPath,
        ["-e", "process.stdout.write(process.argv[1])", literal],
        repository,
      ),
    ).toBe(literal);
  });
});

describe("CI and inherited process isolation", () => {
  it("rejects every dangerous Node option with dashed, underscored, or mixed names and equals or separate values", () => {
    const options = [
      "import",
      "require",
      "loader",
      "experimental-loader",
      "experimental-config-file",
      "experimental-default-config-file",
      "conditions",
      "experimental-default-type",
      "preserve-symlinks",
      "preserve-symlinks-main",
    ];
    for (const option of options) {
      const spellings = new Set([option, option.replaceAll("-", "_"), option.replace("-", "_")]);
      for (const spelling of spellings) {
        for (const args of [[`--${spelling}`, "fixture"], [`--${spelling}=fixture`]]) {
          expect(() => assertCleanVerifierLaunch({}, args), args.join(" ")).toThrow(
            /Contaminated verifier launch/,
          );
        }
      }
    }
    for (const args of [
      ["-r", "fixture"],
      ["-rfixture"],
      ["-r=fixture"],
      ["-C", "fixture"],
      ["-Cfixture"],
      ["-C=fixture"],
    ]) {
      expect(() => assertCleanVerifierLaunch({}, args), args.join(" ")).toThrow(
        /Contaminated verifier launch/,
      );
    }
    expect(() =>
      assertCleanVerifierLaunch({}, ["--no-warnings", "--stack-trace-limit=50"]),
    ).not.toThrow();
  });

  it("preserves toolchain paths, registry selection, cache, and trust while dropping credentials, loader, and workspace settings", () => {
    expect(
      cleanChildEnvironment({
        PATH: "/node24/bin",
        HOME: "/user",
        TMPDIR: "/temporary",
        LC_ALL: "C",
        CI: "true",
        NODE_AUTH_TOKEN: "fixture-token",
        NPM_TOKEN: "other-fixture-token",
        NODE_EXTRA_CA_CERTS: "/trusted-ca.pem",
        npm_config_registry: "https://registry.example.test",
        npm_config_cache: "/npm-cache",
        NODE_OPTIONS: "--import=untrusted",
        NODE_PATH: "/checkout",
        npm_config_node_options: "--require=untrusted",
        npm_config_script_shell: "/untrusted/shell",
        npm_config_workspace: "/checkout",
        INIT_CWD: "/checkout",
        TSX_TSCONFIG_PATH: "/checkout/tsconfig.json",
        LD_PRELOAD: "/untrusted/library",
      }),
    ).toEqual({
      PATH: "/node24/bin",
      HOME: "/user",
      TMPDIR: "/temporary",
      LC_ALL: "C",
      CI: "true",
      NODE_EXTRA_CA_CERTS: "/trusted-ca.pem",
      npm_config_registry: "https://registry.example.test",
      npm_config_cache: "/npm-cache",
    });
  });

  it.each([
    "NODE_OPTIONS",
    "NODE_PATH",
    "--import",
    "--experimental_loader",
    "--experimental_loader=",
  ])("rejects an actual contaminated verifier process (%s) without an output manifest", (mode) => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "neon-usage-launch-test-")));
    try {
      const preload = join(directory, "preload.mjs");
      writeFileSync(preload, "export {};\n");
      const output = join(directory, "output");
      const env = cleanChildEnvironment();
      const args: string[] = [];
      if (mode === "NODE_OPTIONS") env.NODE_OPTIONS = `--import=${preload}`;
      else if (mode === "NODE_PATH") env.NODE_PATH = repository;
      else if (mode.endsWith("=")) args.push(`${mode}${preload}`);
      else args.push(mode, preload);
      args.push(join(repository, "scripts/verify-package.ts"), "--output", output);
      const result = spawnSync(process.execPath, args, {
        cwd: directory,
        env,
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/Contaminated verifier launch/);
      expect(existsSync(output)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("checks on Node 24 with the same gate, lockfile install, read-only permissions, and retained exact artifacts", () => {
    const workflow = readFileSync(join(repository, ".github/workflows/verify-package.yml"), "utf8");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain('node-version: "24.14.0"');
    expect(workflow).toContain("npm ci --no-audit --no-fund");
    expect(workflow).toContain('npm run verify:package -- --output "$PACKAGE_OUTPUT"');
    expect(workflow).toMatch(/PACKAGE_OUTPUT: \$\{\{ runner\.temp \}\}\/neon-usage-package/);
    expect(workflow).toMatch(/\$\{\{ runner\.temp \}\}\/neon-usage-package\/\*/);
    expect(workflow).toContain("if-no-files-found: error");
    expect(workflow).not.toMatch(/release:publish|npm publish|secrets\./);
    for (const action of workflow.matchAll(/uses: ([^\s]+)/g))
      expect(action[1]).toMatch(/@[a-f0-9]{40}$/);
  });

  it("sanitizes the verifier runner and the actual packed CLI runner before Node starts", () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "neon-usage-loader-test-")));
    const keys = ["NODE_OPTIONS", "NODE_PATH", "npm_config_node_options", "TS_NODE_PROJECT"];
    const previous = keys.map((key) => process.env[key]);
    try {
      cpSync(join(repository, "package-fixtures/consumer"), directory, { recursive: true });
      writeFileSync(
        join(directory, "verification.json"),
        JSON.stringify({ checkout: repository, consumer: directory }),
      );
      const marker = join(directory, "preloaded");
      const preload = join(directory, "preload.cjs");
      writeFileSync(
        preload,
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "loaded");`,
      );
      const binary = join(directory, "binary.mjs");
      writeFileSync(
        binary,
        `console.log(JSON.stringify({ keys: ${JSON.stringify(keys)}.map(key => process.env[key] ?? null), path: process.env.PATH, home: process.env.HOME }));`,
      );
      process.env.NODE_OPTIONS = `--require=${preload}`;
      process.env.NODE_PATH = repository;
      process.env.npm_config_node_options = `--require=${preload}`;
      process.env.TS_NODE_PROJECT = join(repository, "tsconfig.json");
      const direct = JSON.parse(runCommand(process.execPath, [binary], directory));
      const cli = runPackedCli(binary, [], directory);
      expect(cli.status, cli.stderr).toBe(0);
      const packed = JSON.parse(cli.stdout);
      for (const result of [direct, packed]) {
        expect(result.keys).toEqual([null, null, null, null]);
        expect(result.path).toBe(process.env.PATH);
        expect(result.home).toBe(process.env.HOME);
      }
      expect(existsSync(marker)).toBe(false);
    } finally {
      keys.forEach((key, index) => {
        const value = previous[index];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
