import { chmodSync, readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const { version } = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as {
  version: string;
};
writeFileSync(
  new URL("dist/package-version.js", root),
  `export const packageVersion = ${JSON.stringify(version)};\n`,
);
chmodSync(new URL("dist/bin.js", root), 0o755);
