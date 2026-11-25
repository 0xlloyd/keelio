// Renders the public page from the facts in SiteContent. Plain HTML with one
// inline <style>: no script, no external file, no form.
import { escapeHtml, inlineMarkdown, type SiteContent } from "./content.js";

export { escapeHtml };

export const REPO_URL = "https://github.com/0xlloyd/keelio";

/** The page's own address, with the trailing slash. */
export const SITE_URL = "https://keelio.xyz/";

/** The two apps served beside the page; both run a simnet in the browser. */
export const SITE_PATHS = ["/demo/", "/dashboard/"] as const;

/** The page's colours: the demo page's palette. */
export const TOKENS = {
  text: "#1a1a1a",
  background: "#ffffff",
  accent: "#1d4ed8",
  bannerBg: "#fff4d6",
  bannerBorder: "#7a5c00",
  codeBg: "#f3f4f6",
} as const;

export type Token = keyof typeof TOKENS;

/**
 * Every text colour on every background it is drawn on. The contrast test
 * checks each pair; the CSS uses no colour outside TOKENS.
 */
export const CONTRAST_PAIRS: readonly (readonly [Token, Token])[] = [
  ["text", "background"],
  ["accent", "background"],
  ["text", "bannerBg"],
  ["accent", "bannerBg"],
  ["text", "codeBg"],
];

/**
 * A link into the repo: `blob/main/<file>` for a file, `tree/main/<dir>` for
 * a path ending in `/`, and the repo root for an empty path.
 */
export function repoLink(path: string): string {
  if (path === "") return REPO_URL;
  return path.endsWith("/")
    ? `${REPO_URL}/tree/main/${path.slice(0, -1)}`
    : `${REPO_URL}/blob/main/${path}`;
}

function a(href: string, text: string): string {
  return `<a href="${escapeHtml(href)}">${text}</a>`;
}

function repoA(path: string, text = `<code>${escapeHtml(path)}</code>`) {
  return a(repoLink(path), text);
}

function cssVar(token: Token): string {
  return `--${token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

function style(): string {
  const vars = (Object.keys(TOKENS) as Token[])
    .map((token) => `${cssVar(token)}: ${TOKENS[token]};`)
    .join(" ");
  return `
:root { ${vars} }
html { color: var(--text); background: var(--background); font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; line-height: 1.5; }
body { margin: 0; }
main, footer { margin: 0 auto; max-width: 46rem; padding: 0 1rem; }
main { padding-bottom: 2rem; }
h1 { font-size: 2rem; margin: 2rem 0 0.5rem; }
h2 { font-size: 1.3rem; margin: 2rem 0 0.5rem; }
a { color: var(--accent); text-decoration: underline; }
a:focus-visible, .scroll:focus-visible { outline: 0.2rem solid var(--accent); outline-offset: 0.15rem; }
.what { font-size: 1.2rem; }
#status { font-weight: 600; }
.skip { position: absolute; left: 0.5rem; top: -10rem; padding: 0.5rem 0.75rem; background: var(--background); }
.skip:focus { top: 0.5rem; }
.banner { background: var(--banner-bg); border: 0.125rem solid var(--banner-border); padding: 0.75rem 1rem; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9em; overflow-wrap: anywhere; }
.scroll { overflow-x: auto; background: var(--code-bg); padding: 0.75rem 1rem; }
.scroll pre { margin: 0; }
.scroll code { overflow-wrap: normal; }
li { margin: 0.25rem 0; }
footer { border-top: 0.0625rem solid var(--text); padding-top: 1rem; padding-bottom: 2rem; }
`;
}

function scrollRegion(label: string, body: string): string {
  return `<div class="scroll" role="region" tabindex="0" aria-label="${escapeHtml(label)}"><pre>${body}</pre></div>`;
}

function list(items: string[]): string {
  return `<ul>\n${items.map((item) => `<li>${item}</li>`).join("\n")}\n</ul>`;
}

/**
 * The page's policy, as a meta tag because the page has no host of its own to
 * send headers. Nothing may load or run: no script, font, image or request.
 * The one inline <style> is all the page needs. A host may add more headers.
 */
export const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

export const STATUS =
  "Status: prototype. It runs on a local simnet. Nothing is deployed. No real funds are involved.";

/** The whole page as one HTML string. */
export function renderPage(content: SiteContent): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Keelio: limits for a trading agent, enforced by a vault (prototype)</title>
<meta name="description" content="${escapeHtml(content.what)}">
<meta property="og:type" content="website">
<meta property="og:title" content="Keelio">
<meta property="og:description" content="${escapeHtml(content.what)}">
<meta property="og:url" content="${SITE_URL}">
<style>${style()}</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<main id="main">
<h1>Keelio</h1>
<p class="what">${escapeHtml(content.what)}</p>
<p id="status">${STATUS}</p>

<section aria-labelledby="problem">
<h2 id="problem">The problem</h2>
<p>${inlineMarkdown(content.problem)}</p>
</section>

<section aria-labelledby="how-it-works">
<h2 id="how-it-works">How the vault works</h2>
<ol>
<li>The owner deposits sBTC into the vault and sets limits: which tokens and swap adapters the agent may use, a cap per trade and per day, a cooldown and an expiry. See the contract, ${repoA("contracts/keelio-vault.clar")}.</li>
<li>The agent swaps inside those limits. It calls <code>execute-swap</code>; the vault checks each limit, moves the tokens to the adapter itself and refuses any trade outside them. See ${repoA("tests/keelio-vault-swap.test.ts")}.</li>
<li>The agent can never withdraw. Only the owner can take funds out, and a property test runs random call sequences and checks after every call that no one else's call took the owner's funds out. See ${repoA("tests/keelio-vault-property.test.ts")}.</li>
</ol>
</section>

<section aria-labelledby="demo">
<h2 id="demo">The demo</h2>
<p class="banner">${escapeHtml(content.demoBanner)}</p>
<p>Run it in this browser: ${a("/demo/", "the demo")} and ${a("/dashboard/", "the owner dashboard")}. Each runs the contracts on a simnet inside the page: no wallet, no network, no real funds.</p>
<p>Or run it from a checkout of the repo: <code>pnpm run demo</code> in a terminal, or <code>pnpm run demo:web</code> for the browser demo. The browser demo's source is in ${repoA("apps/demo/")}.</p>
<p>The output of <code>pnpm run demo</code>, from the README:</p>
${scrollRegion("Output of pnpm run demo", escapeHtml(content.demoOutput))}
</section>

<section aria-labelledby="proof">
<h2 id="proof">Proof</h2>
<ul>
<li><span id="test-count">${content.testCount}</span> tests in <code>pnpm run test</code> pass. See ${repoA("tests/")}.</li>
<li>Each of the vault's <span id="vault-error-count">${content.vaultErrors}</span> error codes is a named constant listed in ${repoA("docs/errors.md")}.</li>
<li>The property test: ${repoA("tests/keelio-vault-property.test.ts")}.</li>
<li>The threat model: ${repoA("docs/threat-model.md")}.</li>
</ul>
</section>

<section aria-labelledby="limits">
<h2 id="limits">What v0 does not do</h2>
${list(content.limits.map(inlineMarkdown))}
</section>

<section aria-labelledby="roadmap">
<h2 id="roadmap">Roadmap</h2>
<p>From the roadmap:</p>
${list(content.milestones.map(escapeHtml))}
<p>See ${repoA("docs/roadmap.md")}.</p>
</section>

<section aria-labelledby="builders">
<h2 id="builders">For agent builders</h2>
<p>The TypeScript SDK (${repoA("packages/sdk/")}) checks a trade against the vault's policy before the agent sends it and builds the vault's transactions; the MCP server (${repoA("packages/mcp/")}) offers the same reads and checks as tools any agent can call.</p>
<p>MCP tools:</p>
${list(content.mcpTools.map((name) => `<code>${escapeHtml(name)}</code>`))}
<p>An agent-side check with the SDK, from ${repoA("apps/site/sample.ts")}:</p>
${scrollRegion("Code sample: apps/site/sample.ts", `<code>${escapeHtml(content.sample)}</code>`)}
</section>
</main>
<footer>
<p>MIT licence. Source: ${a(REPO_URL, "github.com/0xlloyd/keelio")}.</p>
</footer>
</body>
</html>
`;
}
