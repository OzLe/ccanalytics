import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globals: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      thresholds: {
        lines: 80,
        branches: 70,
        functions: 90,
      },
      include: ["src/**/*.ts"],
      exclude: [
        "src/types/**/*.ts",
        "src/cli.ts",
        "src/commands/**/*.ts",
        "src/config/**/*.ts",
        "src/watcher/**/*.ts",
        "src/db/connection.ts",
        "src/db/schema.ts",
        "src/db/index.ts",
        "src/ingestion/batch-inserter.ts",
        "src/ingestion/file-discovery.ts",
        "src/ingestion/index.ts",
        "src/ingestion/ingestion-tracker.ts",
        "src/errors.ts",
        "src/queries/index.ts",
        "src/utils/logger.ts",
        "src/utils/paths.ts",
      ],
    },
  },
});
