// Checks the real built page, apps/site/dist/index.html, against the repo and
// the test report it was built from. Run by `pnpm run site:test` after
// `pnpm run site:build`.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  brokenLinks,
  contrastProblems,
  forbiddenContent,
  sectionOrder,
  structureProblems,
} from "./checks.js";
import { TOKENS } from "./page.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = join(root, "apps", "site", "dist");
const html = readFileSync(join(dist, "index.html"), "utf8");

function figure(id: string): number {
  const match = new RegExp(`<span id="${id}">(\\d+)</span>`).exec(html);
  expect(match, `<span id="${id}">`).not.toBeNull();
  return Number(match![1]);
}

describe("apps/site/dist", () => {
  it("holds index.html and nothing else", () => {
    expect(readdirSync(dist)).toStrictEqual(["index.html"]);
  });

  it("shows the passed count of .cache/test-results.json", () => {
    const report = JSON.parse(
      readFileSync(join(root, ".cache", "test-results.json"), "utf8"),
    ) as { numPassedTests: number };
    expect(figure("test-count")).toBe(report.numPassedTests);
  });

  it("shows the number of keelio-vault rows in docs/errors.md", () => {
    const errors = readFileSync(join(root, "docs", "errors.md"), "utf8");
    const rows = errors.match(
      /^\| `keelio-vault`\s+\| `u(\d+)`\s*\| `([A-Z-]+)`/gm,
    );
    expect(figure("vault-error-count")).toBe(rows?.length);
  });

  it("passes every page check", () => {
    expect(forbiddenContent(html)).toStrictEqual([]);
    expect(brokenLinks(html, root)).toStrictEqual([]);
    expect(structureProblems(html)).toStrictEqual([]);
    expect(sectionOrder(html)).toStrictEqual([]);
    expect(contrastProblems(TOKENS)).toStrictEqual([]);
  });
});
