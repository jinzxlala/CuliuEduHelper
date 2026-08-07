import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    hookTimeout: 60_000,
    include: ["src/**/*.integration.test.ts"],
    testTimeout: 30_000,
  },
});
