import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "packages/**/*.test.ts"],
    // Each test file starts its own simnet, so files must not share a process.
    pool: "forks",
    // Writes the simnet deployment plan once, before the forks start.
    globalSetup: ["tests/global-setup.ts"],
    testTimeout: 30_000,
  },
});
