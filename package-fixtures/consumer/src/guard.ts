import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const verification = JSON.parse(
  readFileSync(new URL("../verification.json", import.meta.url), "utf8"),
) as {
  checkout: string;
  consumer: string;
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (resolved.url.startsWith("file:")) {
      const path = realpathSync(fileURLToPath(resolved.url));
      const local = relative(verification.consumer, path);
      assert.ok(
        local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local),
        `Consumer escaped temp installation: ${path}`,
      );
      const checkout = relative(verification.checkout, path);
      assert.ok(
        checkout === ".." || checkout.startsWith(`..${sep}`) || isAbsolute(checkout),
        `Consumer resolved into repository: ${path}`,
      );
    }
    return resolved;
  },
});

// SDK transport is injected; demo and browser checks must not call the network.
globalThis.fetch = () => {
  throw new Error("Unexpected network request in packed consumer");
};
