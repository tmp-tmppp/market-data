import { defineConfig } from "vitest/config";

// Tests against a real PostgreSQL 18 started by Testcontainers (needs a running Docker daemon). One worker, one
// file at a time: each file starts its own container.
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    maxWorkers: 1,
    fileParallelism: false,
  },
});
