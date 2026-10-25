import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

// Extension tests spawn real processes (background bash jobs, nested `pi` stubs) and load
// pi's own runtime, so they are heavier than typical unit tests. Each test file gets a fresh
// module registry: extensions keep module-level state (job registries, cached shells) that
// must not leak between files.
export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/*/test/**/*.test.ts", "test/**/*.test.ts"],
    isolate: true,
    pool: "forks",
    maxWorkers: Math.max(1, Math.min(4, availableParallelism() - 1)),
    testTimeout: 30_000,
    hookTimeout: 30_000,
    teardownTimeout: 10_000,
  },
});
