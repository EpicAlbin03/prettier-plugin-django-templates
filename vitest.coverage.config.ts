import { defineConfig } from "vitest/config";

// Vite+ 0.3.3 uses Vitest 4.1.11
export default defineConfig({
  test: {
    include: ["test/**/*.ts"],
    exclude: ["test/**/*.bench.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "html", "json", "json-summary"],
      thresholds: {
        statements: 98,
        branches: 96,
        functions: 100,
        lines: 98,
      },
    },
  },
});
