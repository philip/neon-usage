// Keep tool discovery, network trust, temp paths, locale, and CI identity.
const childVariables = new Set([
  "PATH",
  "HOME",
  "USERPROFILE",
  "SYSTEMROOT",
  "COMSPEC",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LANGUAGE",
  "TZ",
  "TERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "CI",
  "GITHUB_ACTIONS",
  "BUILDKITE",
  "GITLAB_CI",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "NPM_CONFIG_REGISTRY",
  "NPM_CONFIG_CACHE",
]);

export function cleanChildEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key, value]) =>
        value !== undefined && (childVariables.has(key.toUpperCase()) || /^LC_[A-Z_]+$/i.test(key)),
    ),
  );
}

export function assertCleanVerifierLaunch(env: NodeJS.ProcessEnv, args: string[]): void {
  for (const [key, value] of Object.entries(env)) {
    const normalized = key.toUpperCase().replaceAll("-", "_");
    if (
      value &&
      (/^(?:NODE_OPTIONS|NODE_PATH|NODE_REPL_EXTERNAL_MODULE|NODE_PRESERVE_SYMLINKS(?:_MAIN)?|NODE_COMPILE_CACHE|NPM_CONFIG_(?:NODE_OPTIONS|SCRIPT_SHELL|ONLOAD_SCRIPT)|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_INSERT_LIBRARIES|DYLD_LIBRARY_PATH)$/.test(
        normalized,
      ) ||
        /^(?:TS_NODE_|TSX_)/.test(normalized))
    )
      throw new Error(`Contaminated verifier launch: unset ${key} and restart with plain Node`);
  }
  if (
    args.some((arg) => {
      const option = (arg.split("=", 1)[0] ?? arg).replaceAll("_", "-");
      return /^(?:--(?:import|require|loader|experimental-loader|experimental-config-file|experimental-default-config-file|conditions|experimental-default-type|preserve-symlinks(?:-main)?)$|-[rC])/.test(
        option,
      );
    })
  ) {
    throw new Error(
      "Contaminated verifier launch: inherited Node loaders or resolution flags are forbidden",
    );
  }
}
