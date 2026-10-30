import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const { verifyReadmeExamples } = (await import(
  new URL("./verify-readme-examples.ts", import.meta.url).href
)) as typeof import("./verify-readme-examples.js");

const { assertCleanVerifierLaunch, cleanChildEnvironment } = (await import(
  new URL("../package-fixtures/consumer/src/environment.ts", import.meta.url).href
)) as typeof import("../package-fixtures/consumer/src/environment.js");

export const repository = fileURLToPath(new URL("..", import.meta.url));
export type CommandRunner = (command: string, args: string[], cwd: string) => string;
export type CandidateManifest = {
  schemaVersion: 1;
  name: "neon-usage";
  version: string;
  commit: string;
  tag: string | null;
  clean: boolean;
  tarball: string;
  sha256: string;
};
export type TarEntry = { name: string; type: string; data?: Buffer };

export function npmExecutable(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "npm.cmd" : "npm";
}

export function npmCliTarget(
  shim: string,
  paths: Pick<typeof import("node:path"), "dirname" | "join"> = { dirname, join },
): string {
  return paths.join(paths.dirname(shim), "node_modules", "npm", "bin", "npm-cli.js");
}

export const runCommand: CommandRunner = (command, args, cwd) => {
  let executable = command === "npm" ? npmExecutable() : command;
  let arguments_ = args;
  if (process.platform === "win32" && executable === "npm.cmd") {
    const searchPath = Object.entries(process.env).find(
      ([key]) => key.toUpperCase() === "PATH",
    )?.[1];
    const shim = searchPath
      ?.split(delimiter)
      .map((directory) => join(directory, executable))
      .find(existsSync);
    if (!shim) throw new Error("Cannot resolve npm.cmd on PATH");
    // Windows cannot execute .cmd files without a shell; invoke npm's JavaScript entry instead.
    arguments_ = [npmCliTarget(shim), ...args];
    executable = process.execPath;
  }
  const result = spawnSync(executable, arguments_, {
    cwd,
    env: cleanChildEnvironment(),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 15 * 60 * 1000,
    shell: false,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${result.error?.message ?? result.stderr}\n${result.stdout}`,
    );
  }
  return result.stdout;
};

export function assertInside(directory: string, path: string): void {
  const suffix = relative(directory, path);
  if (suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw new Error(`Path escapes ${directory}: ${path}`);
  }
}

export function assertOutsideCheckout(
  checkout: string,
  output: string,
  paths: Pick<typeof import("node:path"), "relative" | "isAbsolute" | "sep"> = {
    relative,
    isAbsolute,
    sep,
  },
): void {
  const suffix = paths.relative(checkout, output);
  if (suffix !== ".." && !suffix.startsWith(`..${paths.sep}`) && !paths.isAbsolute(suffix)) {
    throw new Error("Package output must be outside the checkout");
  }
}

export const sha256 = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

const requiredFiles = [
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
];
const documents = new Set([
  "package.json",
  "README.md",
  "CHANGELOG.md",
  "SECURITY.md",
  "LICENSE",
  "NOTICE",
  "THIRD_PARTY_LICENSES",
]);

export function validateTarEntries(entries: TarEntry[]): void {
  const files = new Set<string>();
  const seen = new Set<string>();
  for (const { name, type } of entries) {
    const parts = name.replace(/\/$/, "").split("/");
    if (
      !name.startsWith("package/") ||
      name.includes("\\") ||
      Array.from(name).some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      parts.some((part) => !part || part === "." || part === "..") ||
      seen.has(name)
    )
      throw new Error(`Unsafe or duplicate tar entry: ${name}`);
    seen.add(name);
    const forbidden = parts.some(
      (part) =>
        part.startsWith(".") ||
        /\.(?:sqlite3?|db)(?:-(?:journal|wal|shm))?$/i.test(part) ||
        /(?:^|[.-])(?:test|spec|credentials?|secrets?|dev|fixtures?|benchmarks?|coverage)(?:[.-]|$)/i.test(
          part,
        ),
    );
    if (forbidden) throw new Error(`Forbidden packed entry: ${name}`);
    if (type === "5") {
      if (
        name !== "package/" &&
        name !== "package/dist/" &&
        !name.startsWith("package/dist/dashboard/")
      ) {
        throw new Error(`Unexpected tar directory: ${name}`);
      }
      continue;
    }
    if (type !== "0" && type !== "\0")
      throw new Error(`Tar links and special entries are forbidden: ${name}`);
    const path = parts.slice(1).join("/");
    const compiled = /^dist\/[a-z][a-z0-9-]*(?:\.d\.ts|\.js)$/.test(path);
    const asset =
      /^dist\/dashboard\/assets\/[a-zA-Z0-9_/-]+\.[a-zA-Z0-9]+(?:\.(?:js|css))?$/.test(path) &&
      /\.(?:js|css|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|eot)$/.test(path);
    if (!(documents.has(path) || compiled || path === "dist/dashboard/index.html" || asset)) {
      throw new Error(`Forbidden or unrelated packed file: ${name}`);
    }
    files.add(name);
  }
  for (const name of requiredFiles) {
    if (!files.has(name)) throw new Error(`Missing packed file: ${name}`);
  }
  for (const extension of ["js", "css"]) {
    if (
      ![...files].some(
        (name) =>
          name.startsWith("package/dist/dashboard/assets/") && name.endsWith(`.${extension}`),
      )
    ) {
      throw new Error(`Missing dashboard ${extension} asset`);
    }
  }
}

export function readTarEntries(tarball: Buffer): TarEntry[] {
  const tar = gunzipSync(tarball, { maxOutputLength: 128 * 1024 * 1024 });
  const entries: TarEntry[] = [];
  let offset = 0;
  const field = (header: Buffer, start: number, length: number) =>
    header
      .subarray(start, start + length)
      .toString("utf8")
      .replace(/\0.*$/s, "");
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (tar.length < offset + 1024 || tar.subarray(offset).some((byte) => byte !== 0))
        throw new Error("Invalid tar terminator");
      return entries;
    }
    if (field(header, 257, 6) !== "ustar") throw new Error("Unsupported tar header format");
    const sizeText = field(header, 124, 12).trim();
    const checksumText = field(header, 148, 8).trim();
    if (!/^[0-7]+$/.test(sizeText) || !/^[0-7]+$/.test(checksumText))
      throw new Error("Invalid tar numeric field");
    const checksum = header.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0,
    );
    if (checksum !== Number.parseInt(checksumText, 8))
      throw new Error("Invalid tar header checksum");
    const size = Number.parseInt(sizeText, 8);
    const start = offset + 512;
    if (!Number.isSafeInteger(size) || start + size > tar.length)
      throw new Error("Truncated tar entry");
    const prefix = field(header, 345, 155);
    const name = `${prefix ? `${prefix}/` : ""}${field(header, 0, 100)}`;
    entries.push({
      name,
      type: header.toString("utf8", 156, 157),
      data: tar.subarray(start, start + size),
    });
    offset = start + Math.ceil(size / 512) * 512;
    if (tar.subarray(start + size, offset).some((byte) => byte !== 0))
      throw new Error("Invalid tar entry padding");
  }
  throw new Error("Missing tar terminator");
}

export function inspectTarball(tarball: Buffer): { version: string } {
  const entries = readTarEntries(tarball);
  validateTarEntries(entries);
  const text = (name: string) =>
    entries.find((entry) => entry.name === `package/${name}`)?.data?.toString("utf8");
  const pkg = JSON.parse(text("package.json") ?? "null");
  if (
    pkg?.name !== "neon-usage" ||
    typeof pkg.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version) ||
    pkg.engines?.node !== ">=24.0.0" ||
    pkg.bin?.["neon-usage"] !== "dist/bin.js" ||
    JSON.stringify(Object.keys(pkg.exports ?? {}).sort()) !==
      JSON.stringify([".", "./contracts"]) ||
    pkg.exports["."]?.types !== "./dist/index.d.ts" ||
    pkg.exports["."]?.default !== "./dist/index.js" ||
    pkg.exports["./contracts"]?.types !== "./dist/contracts.d.ts" ||
    pkg.exports["./contracts"]?.default !== "./dist/contracts.js"
  )
    throw new Error("Packed package metadata does not match the public package contract");
  if (
    text("dist/package-version.js") !==
    `export const packageVersion = ${JSON.stringify(pkg.version)};\n`
  ) {
    throw new Error("Packed producer version must be the build-generated package version literal");
  }
  return { version: pkg.version };
}

const builtins = new Set([...builtinModules, ...builtinModules.map((id) => `node:${id}`)]);
const purePackageModules = new Set([
  "contracts.js",
  "measured-usage-contract.js",
  "metric-definitions.js",
  "metric-catalog.js",
]);
export function assertBrowserModule(id: string, consumer: string, checkout: string): void {
  const path = id.split("?")[0] ?? id;
  if (builtins.has(path) || path.startsWith("node:") || /browser-external/.test(path)) {
    throw new Error(`Browser graph contains a Node builtin: ${id}`);
  }
  if (path.startsWith("\0")) throw new Error(`Unexpected virtual browser module: ${id}`);
  assertInside(consumer, path);
  const fromCheckout = relative(checkout, path);
  if (!fromCheckout.startsWith(`..${sep}`) && fromCheckout !== ".." && !isAbsolute(fromCheckout)) {
    throw new Error(`Browser resolved into repository: ${id}`);
  }
  const marker = `${sep}node_modules${sep}neon-usage${sep}dist${sep}`;
  if (path.includes(marker) && !purePackageModules.has(path.split(marker)[1] ?? "")) {
    throw new Error(`Browser graph contains a private SDK module: ${id}`);
  }
}

export async function bundleBrowser(consumer: string, checkout: string): Promise<void> {
  const require = createRequire(join(checkout, "package.json"));
  const viteUrl = pathToFileURL(require.resolve("vite")).href;
  const { build } = (await import(viteUrl)) as typeof import("vite");
  const result = await build({
    root: consumer,
    configFile: false,
    publicDir: false,
    logLevel: "warn",
    build: {
      write: false,
      target: "es2023",
      minify: false,
      lib: { entry: join(consumer, "src/browser.ts"), formats: ["es"], fileName: "contracts" },
    },
    plugins: [
      {
        name: "audit-packed-contracts",
        moduleParsed(info) {
          assertBrowserModule(info.id, consumer, checkout);
          assertBrowserModule(realpathSync(info.id), consumer, checkout);
        },
        generateBundle(_options, bundle) {
          for (const output of Object.values(bundle)) {
            if (output.type !== "chunk") continue;
            for (const id of Object.keys(output.modules))
              assertBrowserModule(id, consumer, checkout);
            if (
              output.imports.length ||
              output.dynamicImports.length ||
              /\brequire\s*\(\s*["']|\bprocess\.(?:env|cwd|versions|platform|argv|exit)|\bBuffer\.(?:from|alloc|isBuffer)|node:|__vite-browser-external/.test(
                output.code,
              )
            ) {
              throw new Error(
                "Browser bundle contains external imports or Node runtime references",
              );
            }
          }
        },
      },
    ],
  });
  const outputs = Array.isArray(result) ? result : [result];
  const chunks = outputs
    .flatMap((output) => ("output" in output ? output.output : []))
    .filter((output) => output.type === "chunk");
  const chunk = chunks[0];
  if (chunks.length !== 1 || !chunk)
    throw new Error("Expected one self-contained browser consumer bundle");
  const bundlePath = join(consumer, "browser-bundle.mjs");
  writeFileSync(bundlePath, chunk.code);
  runCommand(process.execPath, ["--import", "./src/guard.ts", bundlePath], consumer);
}

export async function verifyPackage(options: {
  output: string;
  repository?: string;
  run?: CommandRunner;
  bundle?: typeof bundleBrowser;
  launchArgs?: string[];
}): Promise<{ tarball: string; manifest: CandidateManifest; consumer: string }> {
  assertCleanVerifierLaunch(process.env, options.launchArgs ?? process.execArgv);
  if (Number(process.versions.node.split(".")[0]) < 24)
    throw new Error("Package verification requires Node 24");
  const checkout = realpathSync(options.repository ?? repository);
  verifyReadmeExamples(checkout);
  const run = options.run ?? runCommand;
  const output = resolve(options.output);
  mkdirSync(output, { recursive: true });
  const destination = realpathSync(output);
  if (readdirSync(destination).length) throw new Error("Package output directory must be empty");
  assertOutsideCheckout(checkout, destination);
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "neon-usage-consumer-")));
  try {
    const initialCommit = run("git", ["rev-parse", "HEAD"], checkout).trim();
    const initiallyClean =
      run("git", ["status", "--porcelain", "--untracked-files=all"], checkout).trim() === "";
    console.log("Checking source, then building and testing public artifacts");
    run("npm", ["run", "check"], checkout);
    run("npm", ["run", "build"], checkout);
    run("npm", ["run", "test:package"], checkout);
    const packed = JSON.parse(
      run(
        "npm",
        ["pack", "--ignore-scripts", "--json", "--pack-destination", destination],
        checkout,
      ),
    );
    if (
      !Array.isArray(packed) ||
      packed.length !== 1 ||
      typeof packed[0]?.filename !== "string" ||
      basename(packed[0].filename) !== packed[0].filename
    )
      throw new Error("npm pack must produce exactly one candidate filename");
    const tarball = join(destination, packed[0].filename);
    if (!lstatSync(tarball).isFile() || readdirSync(destination).length !== 1)
      throw new Error("npm pack must produce one regular tarball");
    const bytes = readFileSync(tarball);
    const { version } = inspectTarball(bytes);
    const checksum = sha256(bytes);
    cpSync(join(checkout, "package-fixtures/consumer"), temporary, {
      recursive: true,
      dereference: false,
    });
    run(
      "npm",
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", tarball],
      temporary,
    );
    const installed = realpathSync(join(temporary, "node_modules/neon-usage"));
    assertInside(temporary, installed);
    if (installed === temporary) throw new Error("Missing isolated package installation");
    writeFileSync(
      join(temporary, "verification.json"),
      JSON.stringify({ checkout, consumer: temporary, version }),
    );
    console.log(`Packed package resolves inside clean consumer: ${installed}`);
    const declarations = run(
      process.execPath,
      [
        join(checkout, "node_modules/typescript/bin/tsc"),
        "--project",
        "tsconfig.json",
        "--listFiles",
      ],
      temporary,
    );
    const compilerLibraries = [
      join(checkout, "node_modules/typescript/lib"),
      join(
        checkout,
        "node_modules/@typescript",
        `typescript-${process.platform}-${process.arch}`,
        "lib",
      ),
    ]
      .filter(existsSync)
      .map((path) => realpathSync(path));
    const resolvedDeclarations = declarations
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((path) => realpathSync(path));
    for (const path of resolvedDeclarations) {
      if (compilerLibraries.includes(dirname(path)) && /^lib\..*\.d\.ts$/.test(basename(path)))
        continue;
      assertInside(temporary, path);
    }
    for (const entry of ["index", "contracts"]) {
      if (!resolvedDeclarations.includes(join(installed, "dist", `${entry}.d.ts`)))
        throw new Error(`TypeScript did not check packed ${entry} declarations`);
    }
    run(process.execPath, ["--import", "./src/guard.ts", "src/node.ts"], temporary);
    await (options.bundle ?? bundleBrowser)(temporary, checkout);
    if (
      !lstatSync(tarball).isFile() ||
      sha256(readFileSync(tarball)) !== checksum ||
      readdirSync(destination).length !== 1
    )
      throw new Error("Candidate changed during verification");
    let tag: string | null = null;
    try {
      tag = run("git", ["describe", "--tags", "--exact-match", "HEAD"], checkout).trim();
    } catch {
      /* Untagged candidates can be checked, but cannot be released. */
    }
    if (run("git", ["rev-parse", "HEAD"], checkout).trim() !== initialCommit)
      throw new Error("Checkout commit changed during verification");
    const manifest: CandidateManifest = {
      schemaVersion: 1,
      name: "neon-usage",
      version,
      commit: initialCommit,
      tag,
      clean:
        initiallyClean &&
        run("git", ["status", "--porcelain", "--untracked-files=all"], checkout).trim() === "",
      tarball: basename(tarball),
      sha256: checksum,
    };
    writeFileSync(`${tarball}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: "wx",
    });
    console.log(`Verified candidate: ${tarball}\nSHA-256: ${checksum}`);
    return { tarball, manifest, consumer: temporary };
  } finally {
    // Only this invocation's canonical mkdtemp directory is removed.
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--output" || !args[1]) {
    console.error("Usage: npm run verify:package -- --output /absolute/empty/output-directory");
    process.exitCode = 1;
  } else {
    verifyPackage({ output: args[1] }).catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
  }
}
