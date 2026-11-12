import { defineConfig } from "vitest/config";

// Unit tests need no network and no Docker. The Testcontainers tests live in tests/integration and run with
// "npm run test:integration" (vitest.integration.config.ts).
// One worker, one file at a time: the suite stays light on the CPU of a development laptop.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/integration/**", "node_modules/**"],
    maxWorkers: 1,
    fileParallelism: false,
    reporters: ["default", "junit"],
    outputFile: { junit: "reports/junit.xml" },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Excluded: the composition root, the two command-line tools (thin wrappers that need a database), interface-only
      // files and the adapters that need real infrastructure (they are covered by the integration tests or by the real
      // broker, which .github/workflows/integration.yml runs). The pure message handlers of the NATS adapter are measured.
      exclude: [
        "src/main.ts",
        "src/replay.ts",
        "src/backfill.ts",
        "src/parked.ts",
        "src/usecases/ports.ts",
        "src/usecases/use-cases.ts",
        "src/adapters/postgres/**",
        "src/adapters/nats/jetstream-consumer.ts",
      ],
      reporter: ["text", "lcov", "json-summary"],
      reportsDirectory: "coverage",
      thresholds: { lines: 80, functions: 80, statements: 80 },
    },
  },
});
