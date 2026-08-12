// better-sqlite3 is an OPTIONAL dependency: the installed product degrades
// to the in-memory store without it, so the test suite must pass on an
// `npm ci --omit=optional` checkout too. Suites that exercise the real
// SQLite store probe here and skip when the module (or its native binding)
// is absent, mirroring the store's own load-then-construct probe.

import { createRequire } from "node:module";
// Type-only: erased at compile, so importing this module never loads the
// optional native dependency.
import type Database from "better-sqlite3";

export const sqliteModule: typeof Database | null = (() => {
  try {
    const loaded = createRequire(import.meta.url)("better-sqlite3") as typeof Database;
    new loaded(":memory:").close();
    return loaded;
  } catch {
    return null;
  }
})();

/** The loaded module for suites already gated on its presence. */
export function requireSqlite(): typeof Database {
  if (!sqliteModule) throw new Error("unreachable: this suite skips without better-sqlite3");
  return sqliteModule;
}
