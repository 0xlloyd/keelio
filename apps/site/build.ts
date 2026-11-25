// Builds the public page into one file, index.html, from the repo's files and
// the last test report. Run with `pnpm run site:build`.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readContent } from "./content.js";
import { renderPage } from "./page.js";

export interface BuildOptions {
  /** The repo checkout to read from. */
  root: string;
  /** Emptied, then given index.html. */
  outDir: string;
  /** Vitest's JSON report of a full `pnpm run test`. */
  reportPath: string;
}

/** Writes `<outDir>/index.html` and returns its path. */
export function buildSite({ root, outDir, reportPath }: BuildOptions): string {
  const html = renderPage(readContent(root, reportPath));
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const page = join(outDir, "index.html");
  writeFileSync(page, html);
  return page;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  try {
    const page = buildSite({
      root,
      outDir: join(root, "apps", "site", "dist"),
      reportPath: join(root, ".cache", "test-results.json"),
    });
    console.log(`site:build: wrote ${page}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
