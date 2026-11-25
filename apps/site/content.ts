// Reads the facts the public page shows from the repo's own files. Each
// reader is a pure function over a file's text and throws, naming the file and
// the heading, when the part it needs is missing or empty, so a renamed
// heading stops the build instead of leaving a gap on the page.
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";

/** Everything the page shows that comes from the repo. */
export interface SiteContent {
  /** The first sentence of docs/frame.md. */
  what: string;
  /** The paragraph under `## The problem`, inline Markdown. */
  problem: string;
  /** The bullets under `## What v0 does not do`, inline Markdown. */
  limits: string[];
  /** `Milestone N: title` for each milestone of the roadmap. */
  milestones: string[];
  /** The MCP tool names from docs/mcp-tools.md. */
  mcpTools: string[];
  /** The number of keelio-vault error codes in docs/errors.md. */
  vaultErrors: number;
  /** The demo page's banner text. */
  demoBanner: string;
  /** The CLI demo's output from the README. */
  demoOutput: string;
  /** The text of apps/site/sample.ts. */
  sample: string;
  /** Tests that passed in the last full `pnpm run test`. */
  testCount: number;
}

function fail(file: string, what: string): never {
  throw new Error(`site:build: ${file}: ${what}`);
}

/** Splits text into lines and drops the ones inside fenced code blocks. */
function proseLines(text: string): string[] {
  let fenced = false;
  return text.split("\n").map((line) => {
    if (line.startsWith("```")) {
      fenced = !fenced;
      return "";
    }
    return fenced ? "" : line;
  });
}

function headingLevel(line: string): number {
  const match = /^(#{1,6}) /.exec(line);
  return match === null ? 0 : match[1]!.length;
}

/**
 * The raw lines under `heading`, up to the next heading of the same or a
 * higher level. `null` when the heading is not there.
 */
function sectionLines(text: string, heading: string): string[] | null {
  const lines = text.split("\n");
  const prose = proseLines(text);
  const start = prose.findIndex((line) => line.trimEnd() === heading);
  if (start === -1) return null;
  const level = headingLevel(heading);
  const end = prose.findIndex((line, i) => {
    const l = headingLevel(line);
    return i > start && l > 0 && l <= level;
  });
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

/** Paragraphs of plain text (not lists, headings or code) in `lines`. */
function paragraphs(lines: string[]): string[] {
  const result: string[] = [];
  let current: string[] = [];
  let fenced = false;
  const flush = () => {
    if (current.length > 0) result.push(current.join(" "));
    current = [];
  };
  for (const line of lines) {
    if (line.startsWith("```")) {
      fenced = !fenced;
      flush();
      continue;
    }
    const trimmed = line.trim();
    if (fenced || trimmed === "" || headingLevel(line) > 0) {
      flush();
      continue;
    }
    current.push(trimmed);
  }
  flush();
  return result;
}

/** The first sentence of the first paragraph under the document's title. */
export function firstSentence(frame: string): string {
  const lines = frame.split("\n");
  const title = lines.findIndex((line) => headingLevel(line) === 1);
  const body = sectionLines(frame, lines[title] ?? "") ?? [];
  const firstBlock: string[] = [];
  for (const line of body) {
    if (line.trim() === "") {
      if (firstBlock.length > 0) break;
      continue;
    }
    if (headingLevel(line) > 0) break;
    firstBlock.push(line.trim());
  }
  const paragraph = firstBlock.join(" ");
  const match = /^.+?[.!?](?=\s|$)/.exec(paragraph);
  if (title === -1 || match === null) {
    fail("docs/frame.md", "no first paragraph under the title");
  }
  return match[0];
}

/** The first paragraph under `heading`, its lines joined with spaces. */
export function sectionParagraph(
  text: string,
  heading: string,
  file: string,
): string {
  const lines = sectionLines(text, heading);
  const first = lines === null ? undefined : paragraphs(lines)[0];
  if (first === undefined) fail(file, `no paragraph under "${heading}"`);
  return first;
}

/** The top-level `- ` bullets under `heading`, wrapped lines joined. */
export function sectionBullets(
  text: string,
  heading: string,
  file: string,
): string[] {
  const bullets: string[] = [];
  for (const line of sectionLines(text, heading) ?? []) {
    if (line.startsWith("- ")) {
      bullets.push(line.slice(2).trim());
    } else if (/^\s+\S/.test(line) && bullets.length > 0) {
      bullets[bullets.length - 1] += ` ${line.trim()}`;
    } else if (line.trim() !== "" && bullets.length > 0) {
      break;
    }
  }
  if (bullets.length === 0) fail(file, `no bullets under "${heading}"`);
  return bullets;
}

/** `Milestone N: title` for each `### Milestone N: title (weeks …)`. */
export function milestones(roadmap: string): string[] {
  const found = [
    ...roadmap.matchAll(/^### Milestone (\d+): (.+?)\s*\(weeks [^)]*\)\s*$/gm),
  ].map((m) => `Milestone ${m[1]}: ${m[2]}`);
  if (found.length === 0) {
    fail("docs/roadmap.md", 'no "### Milestone N: <title> (weeks …)" headings');
  }
  return found;
}

/** The tool names of the ``## `keelio_…` `` headings, in order. */
export function mcpToolNames(doc: string): string[] {
  const found = [...doc.matchAll(/^## `(keelio_[a-z0-9_]+)`\s*$/gm)].map(
    (m) => m[1]!,
  );
  if (found.length === 0) {
    fail("docs/mcp-tools.md", 'no "## `keelio_…`" tool headings');
  }
  return found;
}

/** The number of `keelio-vault` rows in the error table of docs/errors.md. */
export function vaultErrorCount(errors: string): number {
  const rows = [
    ...errors.matchAll(/^\| `keelio-vault`\s+\| `u(\d+)`\s*\| `([A-Z-]+)`/gm),
  ];
  if (rows.length === 0) fail("docs/errors.md", "no `keelio-vault` rows");
  return rows.length;
}

/** The text of the demo's `<header class="banner"><p>`, whitespace collapsed. */
export function demoBanner(html: string): string {
  const match = /<header class="banner">\s*<p>([\s\S]*?)<\/p>/.exec(html);
  const text = match?.[1]?.replace(/\s+/g, " ").trim() ?? "";
  if (text === "") {
    fail("apps/demo/index.html", 'no text in <header class="banner"><p>');
  }
  return text;
}

/** The first ```` ```text ```` block under `## See it work` in the README. */
export function demoOutput(readme: string): string {
  const heading = "## See it work";
  const lines = sectionLines(readme, heading) ?? [];
  const start = lines.findIndex((line) => line.trimEnd() === "```text");
  const end = lines.findIndex((line, i) => i > start && line.startsWith("```"));
  const block = start === -1 || end === -1 ? [] : lines.slice(start + 1, end);
  if (block.length === 0 || block.join("").trim() === "") {
    fail("README.md", `no \`\`\`text block under "${heading}"`);
  }
  return block.join("\n");
}

/** Escapes the five HTML-special characters. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Turns the inline Markdown of the docs into HTML: escapes everything, then
 * `` `code` `` and `**bold**`. Links and raw HTML stay as escaped text.
 */
export function inlineMarkdown(markdown: string): string {
  return markdown
    .split(/(`[^`]+`)/)
    .map((part) =>
      part.startsWith("`") && part.endsWith("`") && part.length > 1
        ? `<code>${escapeHtml(part.slice(1, -1))}</code>`
        : escapeHtml(part).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>"),
    )
    .join("");
}

interface VitestReport {
  success: boolean;
  numPassedTests: number;
  numFailedTests: number;
  testResults: { name: string }[];
}

function isReport(value: unknown): value is VitestReport {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.success === "boolean" &&
    typeof r.numPassedTests === "number" &&
    typeof r.numFailedTests === "number" &&
    Array.isArray(r.testResults) &&
    r.testResults.every(
      (t: unknown) =>
        typeof t === "object" &&
        t !== null &&
        typeof (t as Record<string, unknown>).name === "string",
    )
  );
}

/**
 * The number of tests that passed, from Vitest's JSON report. Refuses a run
 * that failed and a partial run: the report's files must be exactly
 * `testFiles` (absolute paths of every suite file).
 */
export function testCount(report: unknown, testFiles: string[]): number {
  if (!isReport(report)) {
    throw new Error("site:build: the test report is not a Vitest JSON report");
  }
  if (!report.success || report.numFailedTests > 0) {
    throw new Error(
      `site:build: the last test run failed (${report.numFailedTests} failed tests); fix the suite and run pnpm run test`,
    );
  }
  const ran = new Set(report.testResults.map((t) => t.name));
  const expected = new Set(testFiles);
  const missing = testFiles.filter((f) => !ran.has(f));
  const extra = [...ran].filter((f) => !expected.has(f));
  if (missing.length > 0 || extra.length > 0) {
    const some = (files: string[]) =>
      files.length > 3
        ? `${files.slice(0, 3).join(", ")} and ${files.length - 3} more`
        : files.join(", ");
    const parts = [
      missing.length > 0 ? `not run: ${some(missing)}` : "",
      extra.length > 0 ? `not in the suite: ${some(extra)}` : "",
    ].filter((p) => p !== "");
    throw new Error(
      `site:build: the test report is from a partial run (${parts.join("; ")}); run the whole suite with pnpm run test`,
    );
  }
  return report.numPassedTests;
}

/** Every `*.test.ts` under `dir`, skipping node_modules. */
function testFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules") return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return testFilesUnder(path);
    return entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

/** The suite's test files: `*.test.ts` under tests/ and packages/. */
export function suiteTestFiles(root: string): string[] {
  const real = realpathSync(root);
  return [join(real, "tests"), join(real, "packages")]
    .flatMap(testFilesUnder)
    .sort();
}

/** Reads every source file under `root` and the test report. */
export function readContent(root: string, reportPath: string): SiteContent {
  const read = (path: string) => readFileSync(join(root, path), "utf8");
  let reportText: string;
  try {
    reportText = readFileSync(reportPath, "utf8");
  } catch {
    throw new Error(
      `site:build: no test report at ${relative(root, reportPath) || reportPath}; run pnpm run test first`,
    );
  }
  let report: unknown;
  try {
    report = JSON.parse(reportText);
  } catch {
    throw new Error("site:build: the test report is not valid JSON");
  }
  const frame = read("docs/frame.md");
  return {
    what: firstSentence(frame),
    problem: sectionParagraph(frame, "## The problem", "docs/frame.md"),
    limits: sectionBullets(frame, "## What v0 does not do", "docs/frame.md"),
    milestones: milestones(read("docs/roadmap.md")),
    mcpTools: mcpToolNames(read("docs/mcp-tools.md")),
    vaultErrors: vaultErrorCount(read("docs/errors.md")),
    demoBanner: demoBanner(read("apps/demo/index.html")),
    demoOutput: demoOutput(read("README.md")),
    sample: read("apps/site/sample.ts"),
    testCount: testCount(report, suiteTestFiles(root)),
  };
}
