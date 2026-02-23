import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["cjs"],
  target: "node20",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
  // Bundle all local source; externalize node_modules
  noExternal: [],
  // Keep dependencies external so they're resolved from node_modules
  external: [
    "commander",
    "@duckdb/node-api",
    "chokidar",
    "picocolors",
    "nanospinner",
    "cli-table3",
  ],
});
