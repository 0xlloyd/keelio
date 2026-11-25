import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Runs only the check of the built page, after `pnpm run site:build`. It is
// not part of `pnpm run test`, so the page's test count does not count it.
export default defineConfig({
  test: {
    root: resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."),
    include: ["apps/site/dist.test.ts"],
  },
});
