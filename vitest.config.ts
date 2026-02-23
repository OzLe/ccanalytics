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
      exclude: ["src/types/**/*.ts"],
    },
  },
});
