import { createRequire } from "node:module";

// Source tests read package.json; the build replaces this module with a literal.
export const packageVersion = (
  createRequire(import.meta.url)("../package.json") as { version: string }
).version;
