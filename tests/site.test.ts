// The public site in apps/site: its readers, its page and its checks.
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSite } from "../apps/site/build.js";
import {
  ANALYTICS_MARKERS,
  brokenLinks,
  CLAIM_PHRASES,
  contrastProblems,
  contrastRatio,
  forbiddenContent,
  sectionOrder,
  structureProblems,
  WALLET_MARKERS,
} from "../apps/site/checks.js";
import type { VaultState } from "../packages/sdk/src/index.js";
import {
  demoBanner,
  demoOutput,
  escapeHtml,
  firstSentence,
  inlineMarkdown,
  mcpToolNames,
  milestones,
  sectionBullets,
  sectionParagraph,
  suiteTestFiles,
  testCount,
  vaultErrorCount,
  type SiteContent,
} from "../apps/site/content.js";
import { renderPage, repoLink, REPO_URL, TOKENS } from "../apps/site/page.js";
import { canSwap } from "../apps/site/sample.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const SBTC = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.mock-sbtc";
const USD = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.mock-usd";
const DEX = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.mock-dex";
const AGENT = "ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG";

const state: VaultState = {
  vault: { agent: AGENT, paused: false },
  policy: {
    cooldownBlocks: 0n,
    expiresAt: 1_000n,
    caps: { [SBTC]: { maxPerTrade: 10_000_000n, maxPerDay: 30_000_000n } },
    allowedTokens: [SBTC, USD],
    allowedAdapters: [DEX],
  },
  usage: { dayTotals: {}, lastTradeHeight: null },
  balances: { [SBTC]: 100_000_000n },
  burnHeight: 10n,
  // $90,000 with 8 decimals, a minute old, 1% slippage at most.
  priceBounds: { maxSlippageBps: 100n, maxPriceAge: 3_600_000n },
  oracle: {
    sbtcToken: SBTC,
    priceScale: 10_000_000_000n,
    price: { value: 9_000_000_000_000n, timestamp: 1_700_000_000_000n },
  },
  nowMs: 1_700_000_060_000n,
};

// minOut at the dex rate, 900 USD base units a sat: above the oracle floor.
function intent(amountIn: bigint) {
  return {
    caller: AGENT,
    adapter: DEX,
    tokenIn: SBTC,
    tokenOut: USD,
    amountIn,
    minOut: amountIn * 900n,
  };
}

describe("the site's code sample, canSwap", () => {
  it("says ok for a swap inside the caps", () => {
    expect(canSwap(state, intent(10_000_000n))).toBe("ok");
  });

  it("names the rule and error code for a swap over the per-trade cap", () => {
    expect(canSwap(state, intent(10_000_001n))).toBe(
      "TRADE_CAP_EXCEEDED (u114): the amount is above the per-trade cap for token in",
    );
  });
});

describe("firstSentence", () => {
  it("returns the first sentence of the first paragraph under the title", () => {
    const frame =
      "# Title\n\nKeelio does one thing. It does it\nwell.\n\n## Next\n";
    expect(firstSentence(frame)).toBe("Keelio does one thing.");
  });

  it("joins a sentence that wraps over lines", () => {
    expect(firstSentence("# T\n\nOne long\nsentence here. Two.\n")).toBe(
      "One long sentence here.",
    );
  });

  it("refuses a frame with no paragraph under the title", () => {
    expect(() => firstSentence("# Title\n\n## The problem\n")).toThrow(
      /docs\/frame\.md.*first paragraph/,
    );
  });
});

describe("sectionParagraph", () => {
  it("returns the first paragraph under the heading, lines joined", () => {
    const text =
      "# T\n\n## The problem\n\nA hot\nwallet.\n\nMore.\n\n## Next\n";
    expect(sectionParagraph(text, "## The problem", "docs/frame.md")).toBe(
      "A hot wallet.",
    );
  });

  it("names the file and heading when the section is missing or empty", () => {
    expect(() =>
      sectionParagraph("# T\n\n## Other\n\nx\n", "## The problem", "f.md"),
    ).toThrow(/f\.md.*## The problem/);
    expect(() =>
      sectionParagraph("## The problem\n\n## Next\n", "## The problem", "f.md"),
    ).toThrow(/f\.md.*## The problem/);
  });
});

describe("sectionBullets", () => {
  it("returns each bullet with its wrapped lines joined", () => {
    const text = [
      "## What v0 does not do",
      "",
      "- No oracle. The agent supplies `min-out`; it",
      "  is enforced.",
      "- No strategies.",
      "",
      "## Rules",
      "",
      "- Not this one.",
    ].join("\n");
    expect(
      sectionBullets(text, "## What v0 does not do", "f.md"),
    ).toStrictEqual([
      "No oracle. The agent supplies `min-out`; it is enforced.",
      "No strategies.",
    ]);
  });

  it("names the file and heading when there are no bullets", () => {
    expect(() =>
      sectionBullets(
        "## What v0 does not do\n\nProse.\n",
        "## What v0 does not do",
        "f.md",
      ),
    ).toThrow(/f\.md.*## What v0 does not do/);
  });
});

describe("milestones", () => {
  it("returns each milestone heading as Milestone N: title", () => {
    const text = [
      "### Milestone 1: a vault (weeks 1 to 3)",
      "- bullet with $5,000",
      "### Milestone 2: one adapter (weeks 3 to 6)",
      "### Not a milestone",
    ].join("\n");
    expect(milestones(text)).toStrictEqual([
      "Milestone 1: a vault",
      "Milestone 2: one adapter",
    ]);
  });

  it("refuses a document with no milestone headings", () => {
    expect(() => milestones("## Budget\n")).toThrow(
      /docs\/roadmap\.md.*### Milestone/,
    );
  });
});

describe("mcpToolNames", () => {
  it("returns the keelio_ tool headings in order", () => {
    const text =
      "## `keelio_get_vault`\n\nx\n\n## `keelio_journal`\n\n## Errors\n";
    expect(mcpToolNames(text)).toStrictEqual([
      "keelio_get_vault",
      "keelio_journal",
    ]);
  });

  it("refuses a document with no tool headings", () => {
    expect(() => mcpToolNames("## Errors\n")).toThrow(
      /docs\/mcp-tools\.md.*## `keelio_/,
    );
  });
});

describe("vaultErrorCount", () => {
  it("counts the keelio-vault rows of the error table", () => {
    const text = [
      "| Contract | Code | Name | When |",
      "| `keelio-vault`      | `u100` | `ERR-ZERO-AMOUNT` | x |",
      "| `keelio-vault`      | `u101` | `ERR-INSUFFICIENT-BALANCE` | y |",
      "| `mock-sbtc`       | `u1`   | `ERR-NOT-OWNER` | z |",
    ].join("\n");
    expect(vaultErrorCount(text)).toBe(2);
  });

  it("refuses a table with no keelio-vault rows", () => {
    expect(() => vaultErrorCount("| `mock-sbtc` | `u1` | `ERR-X` |\n")).toThrow(
      /docs\/errors\.md.*keelio-vault/,
    );
  });
});

describe("demoBanner", () => {
  it("returns the banner paragraph with its whitespace collapsed", () => {
    const html =
      '<body>\n  <header class="banner">\n    <p>\n      Local simulation.\n      No real funds.\n    </p>\n  </header>';
    expect(demoBanner(html)).toBe("Local simulation. No real funds.");
  });

  it("refuses a page with no banner", () => {
    expect(() => demoBanner("<header><p>x</p></header>")).toThrow(
      /apps\/demo\/index\.html.*banner/,
    );
  });
});

describe("demoOutput", () => {
  it("returns the first text block under See it work", () => {
    const readme = [
      "## Run it",
      "",
      "```text",
      "not this",
      "```",
      "",
      "## See it work",
      "",
      "```bash",
      "pnpm run demo",
      "```",
      "",
      "```text",
      "line one",
      "  line two",
      "```",
      "",
      "```text",
      "not this either",
      "```",
    ].join("\n");
    expect(demoOutput(readme)).toBe("line one\n  line two");
  });

  it("refuses a README with no text block in that section", () => {
    expect(() =>
      demoOutput(
        "## See it work\n\n```bash\nx\n```\n\n## License\n\n```text\ny\n```\n",
      ),
    ).toThrow(/README\.md.*## See it work/);
  });
});

describe("inlineMarkdown", () => {
  it("escapes HTML and turns code and bold into tags, nothing else", () => {
    expect(
      inlineMarkdown(
        "**Holders** use `min-out` & <b>'x'</b> \"y\" [a](http://e.com)",
      ),
    ).toBe(
      "<strong>Holders</strong> use <code>min-out</code> &amp; &lt;b&gt;&#39;x&#39;&lt;/b&gt; &quot;y&quot; [a](http://e.com)",
    );
  });

  it("leaves bold markers inside code alone", () => {
    expect(inlineMarkdown("`a **b** c`")).toBe("<code>a **b** c</code>");
  });
});

describe("testCount", () => {
  const files = ["/r/tests/a.test.ts", "/r/packages/p/b.test.ts"];
  const report = {
    success: true,
    numPassedTests: 7,
    numFailedTests: 0,
    testResults: [
      { name: "/r/tests/a.test.ts" },
      { name: "/r/packages/p/b.test.ts" },
    ],
  };

  it("returns numPassedTests from a full, passing run", () => {
    expect(testCount(report, files)).toBe(7);
  });

  it("refuses a run that failed", () => {
    expect(() => testCount({ ...report, success: false }, files)).toThrow(
      /failed/,
    );
    expect(() => testCount({ ...report, numFailedTests: 1 }, files)).toThrow(
      /failed/,
    );
  });

  it("refuses a partial run and names a missing file", () => {
    expect(() =>
      testCount(
        { ...report, testResults: [{ name: "/r/tests/a.test.ts" }] },
        files,
      ),
    ).toThrow(/partial run.*packages\/p\/b\.test\.ts/);
  });

  it("names three missing files and counts the rest", () => {
    const many = [
      "/r/a.test.ts",
      "/r/b.test.ts",
      "/r/c.test.ts",
      "/r/d.test.ts",
      "/r/e.test.ts",
    ];
    expect(() => testCount({ ...report, testResults: [] }, many)).toThrow(
      "partial run (not run: /r/a.test.ts, /r/b.test.ts, /r/c.test.ts and 2 more)",
    );
  });

  it("refuses a run with a file that is not in the suite", () => {
    expect(() =>
      testCount(
        {
          ...report,
          testResults: [
            ...report.testResults,
            { name: "/r/apps/site/dist.test.ts" },
          ],
        },
        files,
      ),
    ).toThrow(/apps\/site\/dist\.test\.ts/);
  });

  it("refuses something that is not a Vitest JSON report", () => {
    expect(() => testCount({ numPassedTests: "7" }, files)).toThrow(
      /not a Vitest JSON report/,
    );
  });
});

describe("the readers on the repo's own files", () => {
  const read = (path: string) => readFileSync(join(root, path), "utf8");

  it("reads the one-sentence what from docs/frame.md", () => {
    expect(firstSentence(read("docs/frame.md"))).toBe(
      "Keelio lets a Bitcoin holder hand sBTC to a trading agent without handing over custody.",
    );
  });

  it("reads 34 keelio-vault error codes from docs/errors.md", () => {
    expect(vaultErrorCount(read("docs/errors.md"))).toBe(34);
  });

  it("reads the four milestone titles of the roadmap", () => {
    expect(milestones(read("docs/roadmap.md"))).toHaveLength(4);
  });

  it("reads the nine MCP tools", () => {
    expect(mcpToolNames(read("docs/mcp-tools.md"))).toStrictEqual([
      "keelio_get_vault",
      "keelio_check_trade",
      "keelio_build_swap",
      "keelio_build_swap_request",
      "keelio_build_cancel_request",
      "keelio_size_position",
      "keelio_journal",
      "keelio_agent_history",
      "keelio_accountability",
    ]);
  });

  it("reads the demo banner and the README demo output", () => {
    expect(demoBanner(read("apps/demo/index.html"))).toMatch(
      /^Local simulation\..*no real funds\./,
    );
    expect(demoOutput(read("README.md"))).toMatch(
      /^Keelio demo: an owner, an agent and a refused trade\n/,
    );
  });

  it("finds every suite test file, and none outside tests/ and packages/", () => {
    const files = suiteTestFiles(root).map((f) =>
      relative(realpathSync(root), f),
    );
    expect(files).toContain(join("tests", "site.test.ts"));
    expect(files).toContain(
      join("packages", "sdk", "src", "size-position.test.ts"),
    );
    expect(files.every((f) => !f.includes("node_modules"))).toBe(true);
    expect(files).not.toContain(join("apps", "site", "dist.test.ts"));
  });
});

const content: SiteContent = {
  what: "Keelio does one thing.",
  problem: "A **hot** wallet & `min-out`.",
  limits: ["No oracle.", "No `strategies`."],
  milestones: ["Milestone 1: a vault", "Milestone 2: an adapter"],
  mcpTools: ["keelio_get_vault", "keelio_journal"],
  vaultErrors: 19,
  demoBanner: "Local simulation. No real funds.",
  demoOutput: "a < b\n  c",
  sample: "export const x = 1 < 2;\n",
  testCount: 368,
};

function listItems(html: string, id: string): string[] {
  const section = new RegExp(`<h2 id="${id}">[\\s\\S]*?</section>`).exec(html);
  return [...(section?.[0] ?? "").matchAll(/<li>([\s\S]*?)<\/li>/g)].map(
    (m) => m[1]!,
  );
}

describe("renderPage", () => {
  const html = renderPage(content);

  it("puts the what and the exact status line before the first h2", () => {
    const firstH2 = html.indexOf("<h2");
    expect(html.indexOf("<h1>Keelio</h1>")).toBeLessThan(firstH2);
    expect(html.indexOf("Keelio does one thing.")).toBeLessThan(firstH2);
    expect(html).toContain(
      '<p id="status">Status: prototype. It runs on a local simnet. Nothing is deployed. No real funds are involved.</p>',
    );
    expect(html.indexOf('id="status"')).toBeLessThan(firstH2);
  });

  it("renders the docs' Markdown through inlineMarkdown", () => {
    expect(html).toContain(
      "<p>A <strong>hot</strong> wallet &amp; <code>min-out</code>.</p>",
    );
    expect(listItems(html, "limits")).toStrictEqual([
      "No oracle.",
      "No <code>strategies</code>.",
    ]);
  });

  it("lists the milestones and MCP tools it is given", () => {
    expect(listItems(html, "roadmap")).toStrictEqual([
      "Milestone 1: a vault",
      "Milestone 2: an adapter",
    ]);
    expect(html).toContain("From the roadmap:");
    expect(listItems(html, "builders")).toStrictEqual([
      "<code>keelio_get_vault</code>",
      "<code>keelio_journal</code>",
    ]);
  });

  it("shows the figures in marked spans", () => {
    expect(html).toContain(
      '<span id="test-count">368</span> tests in <code>pnpm run test</code> pass.',
    );
    expect(html).toContain(
      '<span id="vault-error-count">19</span> error codes',
    );
  });

  it("escapes the demo output and the code sample inside focusable regions", () => {
    expect(html).toContain(
      '<div class="scroll" role="region" tabindex="0" aria-label="Output of pnpm run demo"><pre>a &lt; b\n  c</pre></div>',
    );
    expect(html).toContain(
      "<pre><code>export const x = 1 &lt; 2;\n</code></pre>",
    );
    expect(html).toContain(
      '<p class="banner">Local simulation. No real funds.</p>',
    );
  });

  it("starts with the skip link and ends with the licence and repo link", () => {
    expect(/<a [^>]*>/.exec(html)?.[0]).toBe('<a class="skip" href="#main">');
    expect(html).toContain('<main id="main">');
    expect(html).toMatch(
      /<footer>\s*<p>MIT licence\. Source: <a href="https:\/\/github\.com\/0xlloyd\/keelio">/,
    );
  });

  it("defines each token once as a custom property", () => {
    for (const [token, value] of Object.entries(TOKENS)) {
      const name = `--${token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
      expect(html.split(`${name}: ${value};`)).toHaveLength(2);
    }
  });
});

describe("repoLink", () => {
  it("links files with blob, folders with tree, and the root bare", () => {
    expect(repoLink("docs/errors.md")).toBe(
      "https://github.com/0xlloyd/keelio/blob/main/docs/errors.md",
    );
    expect(repoLink("tests/")).toBe(
      "https://github.com/0xlloyd/keelio/tree/main/tests",
    );
    expect(repoLink("")).toBe(REPO_URL);
  });
});

function fixtureReport(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    numPassedTests: 412,
    numFailedTests: 0,
    testResults: suiteTestFiles(root).map((name) => ({ name })),
    ...overrides,
  };
}

let tmp: string;
let builtHtml: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "keelio-site-"));
  writeFileSync(join(tmp, "report.json"), JSON.stringify(fixtureReport()));
  const page = buildSite({
    root,
    outDir: join(tmp, "dist"),
    reportPath: join(tmp, "report.json"),
  });
  builtHtml = readFileSync(page, "utf8");
});

afterAll(() => {
  if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true });
});

describe("buildSite", () => {
  const read = (path: string) => readFileSync(join(root, path), "utf8");

  it("writes index.html and nothing else", () => {
    expect(readdirSync(join(tmp, "dist"))).toStrictEqual(["index.html"]);
  });

  it("shows the report's passed count and the errors.md row count", () => {
    expect(builtHtml).toContain('<span id="test-count">412</span>');
    expect(builtHtml).toContain('<span id="vault-error-count">34</span>');
  });

  it("shows the demo banner and README output from the repo", () => {
    expect(builtHtml).toContain(
      `<p class="banner">${escapeHtml(demoBanner(read("apps/demo/index.html")))}</p>`,
    );
    expect(/<pre>([^<]*)<\/pre>/.exec(builtHtml)?.[1]).toBe(
      escapeHtml(demoOutput(read("README.md"))),
    );
    expect(builtHtml).toContain(
      'href="https://github.com/0xlloyd/keelio/tree/main/apps/demo"',
    );
  });

  it("shows the frame's limits, the roadmap's milestones and the MCP tools", () => {
    const frame = read("docs/frame.md");
    expect(listItems(builtHtml, "limits")).toStrictEqual(
      sectionBullets(frame, "## What v0 does not do", "docs/frame.md").map(
        inlineMarkdown,
      ),
    );
    expect(listItems(builtHtml, "roadmap")).toStrictEqual(
      milestones(read("docs/roadmap.md")),
    );
    expect(listItems(builtHtml, "builders")).toStrictEqual(
      mcpToolNames(read("docs/mcp-tools.md")).map((n) => `<code>${n}</code>`),
    );
  });

  it("shows apps/site/sample.ts verbatim", () => {
    expect(/<pre><code>([\s\S]*?)<\/code><\/pre>/.exec(builtHtml)?.[1]).toBe(
      escapeHtml(read("apps/site/sample.ts")),
    );
  });

  it("refuses when the test report is missing", () => {
    expect(() =>
      buildSite({
        root,
        outDir: join(tmp, "missing"),
        reportPath: join(tmp, "nope.json"),
      }),
    ).toThrow(/no test report at .*nope\.json; run pnpm run test first/);
  });

  it("refuses a report of a failed run", () => {
    const reportPath = join(tmp, "failed.json");
    writeFileSync(
      reportPath,
      JSON.stringify(fixtureReport({ success: false, numFailedTests: 1 })),
    );
    expect(() =>
      buildSite({ root, outDir: join(tmp, "failed"), reportPath }),
    ).toThrow(/the last test run failed/);
  });

  it("refuses a report of one file, like pnpm run test -- tests/mock-sbtc.test.ts", () => {
    const reportPath = join(tmp, "partial.json");
    const one = suiteTestFiles(root).filter((f) =>
      f.endsWith(join("tests", "mock-sbtc.test.ts")),
    );
    expect(one).toHaveLength(1);
    writeFileSync(
      reportPath,
      JSON.stringify(
        fixtureReport({ testResults: one.map((name) => ({ name })) }),
      ),
    );
    expect(() =>
      buildSite({ root, outDir: join(tmp, "partial"), reportPath }),
    ).toThrow(/partial run/);
  });
});

describe("the built page passes every check", () => {
  it("has no forbidden content", () => {
    expect(forbiddenContent(builtHtml)).toStrictEqual([]);
  });
  it("has no broken link", () => {
    expect(brokenLinks(builtHtml, root)).toStrictEqual([]);
  });
  it("has a sound structure", () => {
    expect(structureProblems(builtHtml)).toStrictEqual([]);
  });
  it("has its sections in order after the skip link and status", () => {
    expect(sectionOrder(builtHtml)).toStrictEqual([]);
  });
  it("has every token pair at 4.5:1 or more", () => {
    expect(contrastProblems(TOKENS)).toStrictEqual([]);
  });
});

/** The built page with `from` replaced by `to`, which must be there. */
function edited(from: string | RegExp, to: string): string {
  const html = builtHtml.replace(from, to);
  expect(html).not.toBe(builtHtml);
  return html;
}

const BODY_END = "</main>";

describe("forbiddenContent", () => {
  it("uses the wallet markers of the demo bundle test", () => {
    const bundleTest = readFileSync(
      join(root, "tests", "demo-web-bundle.test.ts"),
      "utf8",
    );
    const wallet = /\/\/ Wallet libraries[^\n]*\n([\s\S]*?)\];/.exec(
      bundleTest,
    );
    const markers = [...(wallet?.[1] ?? "").matchAll(/"([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(markers).toStrictEqual(WALLET_MARKERS);
  });

  it.each([
    [
      "an analytics script",
      '<script src="https://www.googletagmanager.com/gtag/js?id=G-1"></script>',
      [
        "a <script> element",
        "analytics marker googletagmanager",
        "a link off the repo: https://www.googletagmanager.com/gtag/js?id=G-1",
        "a link that is neither in-page nor the repo: https://www.googletagmanager.com/gtag/js?id=G-1",
      ],
    ],
    [
      "a form that posts",
      '<form action="/subscribe" method="post"></form>',
      [
        "a <form> element",
        "a link that is neither in-page nor the repo: /subscribe",
      ],
    ],
    [
      "a wallet library",
      "<p>import { showConnect } from '@stacks/connect'</p>",
      [
        "wallet library marker @stacks/connect",
        "wallet library marker showConnect",
      ],
    ],
    [
      "an explorer link to a contract",
      '<a href="https://explorer.hiro.so/txid/SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR.pox-4?chain=mainnet">contract</a>',
      [
        "a Stacks principal SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR",
        "a link off the repo: https://explorer.hiro.so/txid/SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR.pox-4?chain=mainnet",
        "a link that is neither in-page nor the repo: https://explorer.hiro.so/txid/SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR.pox-4?chain=mainnet",
      ],
    ],
    [
      "a protocol-relative link",
      '<a href="//evil.example/x">x</a>',
      [
        'a link off the repo: href="//',
        "a link that is neither in-page nor the repo: //evil.example/x",
      ],
    ],
    [
      "a handler attribute",
      '<p onClick="x()">x</p>',
      ["an onclick= handler attribute"],
    ],
    ["an iframe", '<iframe title="demo"></iframe>', ["a <iframe> element"]],
    [
      "a web font",
      "<p style=\"background: url('https://fonts.example/a.woff')\">x</p>",
      [
        "CSS that loads a file",
        "a link off the repo: https://fonts.example/a.woff",
      ],
    ],
  ])("fires on %s", (_name, fragment, expected) => {
    expect(
      forbiddenContent(edited(BODY_END, `${fragment}${BODY_END}`)),
    ).toStrictEqual(expected);
  });

  it("fires on each claim phrase, whatever its case and spacing", () => {
    for (const phrase of CLAIM_PHRASES) {
      const shouted = phrase.toUpperCase().replace(/ /g, " \n <b>");
      expect(
        forbiddenContent(edited(BODY_END, `<p>${shouted}</p>${BODY_END}`)),
        phrase,
      ).toStrictEqual([`the claim phrase "${phrase}"`]);
    }
  });

  it("fires on each analytics marker", () => {
    for (const marker of ANALYTICS_MARKERS) {
      expect(
        forbiddenContent(edited(BODY_END, `<p>${marker}</p>${BODY_END}`)),
        marker,
      ).toContain(`analytics marker ${marker}`);
    }
  });

  it("fires on an ST testnet principal in plain text", () => {
    expect(
      forbiddenContent(
        edited(
          BODY_END,
          `<p>ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM</p>${BODY_END}`,
        ),
      ),
    ).toStrictEqual([
      "a Stacks principal ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM",
    ]);
  });
});

describe("brokenLinks", () => {
  it("fires on a repo link to a missing file and a missing in-page id", () => {
    const html = edited(
      BODY_END,
      `<a href="${REPO_URL}/blob/main/docs/nope.md">x</a><a href="#nowhere">y</a>${BODY_END}`,
    );
    expect(brokenLinks(html, root)).toStrictEqual([
      "no file docs/nope.md for https://github.com/0xlloyd/keelio/blob/main/docs/nope.md",
      "no id for #nowhere",
    ]);
  });

  it("fires on a tree link to a file, a blob link to a folder and a repo page", () => {
    const html = edited(
      BODY_END,
      [
        `<a href="${REPO_URL}/tree/main/README.md">a</a>`,
        `<a href="${REPO_URL}/blob/main/docs">b</a>`,
        `<a href="${REPO_URL}/issues">c</a>`,
        `<a href="${REPO_URL}/blob/main/../secrets">d</a>`,
        BODY_END,
      ].join(""),
    );
    expect(brokenLinks(html, root)).toStrictEqual([
      "no folder README.md for https://github.com/0xlloyd/keelio/tree/main/README.md",
      "no file docs for https://github.com/0xlloyd/keelio/blob/main/docs",
      "not a repo file or folder link: https://github.com/0xlloyd/keelio/issues",
      "a repo link that leaves the repo: https://github.com/0xlloyd/keelio/blob/main/../secrets",
    ]);
  });
});

describe("structureProblems", () => {
  it.each([
    [
      "two h1",
      "<h1>Keelio</h1>",
      "<h1>Keelio</h1><h1>Again</h1>",
      ["2 <h1> elements, not 1"],
    ],
    [
      "a skipped heading level",
      '<h2 id="proof">Proof</h2>',
      '<h2 id="proof">Proof</h2><h4>Deep</h4>',
      ["heading level skipped: h2 to h4"],
    ],
    [
      "an img without alt",
      BODY_END,
      `<img src="#logo">${BODY_END}`,
      ['an <img> without alt: <img src="#logo">'],
    ],
    ["no lang", '<html lang="en">', "<html>", ['no <html lang="en">']],
    [
      "no content security policy",
      /<meta http-equiv="Content-Security-Policy"[^>]*>/,
      "",
      ["no Content-Security-Policy meta tag that blocks scripts"],
    ],
    [
      "a policy that lets a script run",
      "default-src 'none'",
      "default-src 'none'; script-src 'self'",
      ["no Content-Security-Policy meta tag that blocks scripts"],
    ],
    [
      "no viewport",
      /<meta name="viewport"[^>]*>/,
      "",
      ["no viewport meta tag"],
    ],
    [
      "a px max-width",
      "max-width: 46rem;",
      "max-width: 736px;",
      ["a px value on max-width"],
    ],
    [
      "a px width in a style attribute",
      BODY_END,
      `<div style="min-width:360px"></div>${BODY_END}`,
      ["a px value on min-width"],
    ],
    [
      "no focus-visible",
      /:focus-visible/g,
      ":focus",
      ["no :focus-visible rule"],
    ],
    [
      "links without underline",
      "text-decoration: underline;",
      "text-decoration: none;",
      ["links are not underlined"],
    ],
    [
      "a colour outside TOKENS",
      "body { margin: 0; }",
      "body { margin: 0; color: #777777; }",
      ["a colour outside the TOKENS custom properties: #777777"],
    ],
    [
      "an unlabelled scroll region",
      'aria-label="Output of pnpm run demo"',
      "",
      [
        'a scroll region that is not focusable and labelled: <div class="scroll" role="region" tabindex="0" >',
      ],
    ],
  ])("fires on %s", (_name, from, to, expected) => {
    expect(structureProblems(edited(from, to))).toStrictEqual(expected);
  });
});

describe("contrastProblems", () => {
  it("computes WCAG ratios from worked examples", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
  });

  it("fires on a pair below 4.5:1", () => {
    expect(contrastProblems({ ...TOKENS, accent: "#7aa2ff" })).toStrictEqual([
      "accent on background is 2.49:1, below 4.5:1",
      "accent on bannerBg is 2.27:1, below 4.5:1",
    ]);
  });
});

describe("sectionOrder", () => {
  it("fires on swapped sections", () => {
    const html = edited('id="limits"', 'id="tmp"')
      .replace('id="roadmap"', 'id="limits"')
      .replace('id="tmp"', 'id="roadmap"');
    expect(sectionOrder(html)).toStrictEqual([
      "h2 ids are problem, how-it-works, demo, proof, roadmap, limits, builders, not problem, how-it-works, demo, proof, limits, roadmap, builders",
    ]);
  });

  it("fires on a changed or moved status line", () => {
    expect(sectionOrder(edited("Nothing is deployed. ", ""))).toStrictEqual([
      "#status is not the status line",
    ]);
    const status = /<p id="status">[^<]*<\/p>\n/.exec(builtHtml)![0];
    const moved = edited(status, "").replace(
      '<section aria-labelledby="limits">',
      `${status}<section aria-labelledby="limits">`,
    );
    expect(sectionOrder(moved)).toStrictEqual([
      "#status is not before the first <h2>",
    ]);
  });

  it("fires when the skip link is not first", () => {
    expect(
      sectionOrder(
        edited('<a class="skip" href="#main">Skip to content</a>', ""),
      ),
    ).toStrictEqual(['the first link is not "Skip to content" to #main']);
    expect(
      sectionOrder(edited("<body>", '<body>\n<div tabindex="0">x</div>')),
    ).toStrictEqual(["the skip link is not the first focusable element"]);
  });
});
