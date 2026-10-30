console.error(
  "Direct publication is disabled. Run npm run verify:package -- --output /absolute/empty/output-directory, then explicitly run npm run release:publish -- TARBALL_PATH. The guarded flow publishes that exact verified tarball.",
);
process.exitCode = 1;
