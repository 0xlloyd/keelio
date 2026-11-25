// Checks over the built page's HTML. Each returns a list of problems; an
// empty list is a pass. tests/site.test.ts runs them on a fresh build and on
// broken fixtures; apps/site/dist.test.ts runs them on the real dist page.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  CONTRAST_PAIRS,
  REPO_URL,
  SITE_PATHS,
  SITE_URL,
  STATUS,
  type Token,
} from "./page.js";

/** The wallet entries of MARKERS in tests/demo-web-bundle.test.ts. */
export const WALLET_MARKERS = [
  "@stacks/connect",
  "showConnect",
  "openContractCall",
  "stx_callContract",
  "stx_signTransaction",
  "stx_transferStx",
  "LeatherProvider",
  "XverseProviders",
  "StacksProvider",
  "sats-connect",
  "@walletconnect",
];

export const ANALYTICS_MARKERS = [
  "googletagmanager",
  "google-analytics",
  "gtag(",
  "plausible",
  "segment.com",
  "posthog",
  "mixpanel",
];

/** Matched case-insensitively from a word start, so plurals count too. */
export const CLAIM_PHRASES = [
  "audited",
  "security audit",
  "partner",
  "yield",
  "apy",
  "launch app",
  "connect wallet",
  "sign up",
  "live on mainnet",
  "live on testnet",
  "deployed to mainnet",
  "deployed to testnet",
  "deployed on",
];

/** Tags that would load or embed something, or take input. */
const FORBIDDEN_TAGS = ["script", "form", "iframe", "object", "embed", "link"];

const PRINCIPAL = /\bS[PMTN][0-9A-Z]{28,41}\b/g;

export const SECTION_IDS = [
  "problem",
  "how-it-works",
  "demo",
  "proof",
  "limits",
  "roadmap",
  "builders",
];

/** The page's visible text: tags dropped, entities decoded, spaces collapsed. */
export function pageText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every URL with a scheme or a leading `//`, in attributes or text. */
function urls(html: string): string[] {
  const found = [...html.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`)]*/gi)];
  const relative = [...html.matchAll(/(?:href|src|action)\s*=\s*["']?\/\//gi)];
  return [...found.map((m) => m[0]), ...relative.map((m) => m[0])];
}

function isRepoUrl(url: string): boolean {
  return url === REPO_URL || url.startsWith(`${REPO_URL}/`);
}

/** The site's two apps, by their exact paths. */
function isSitePath(target: string): boolean {
  return (SITE_PATHS as readonly string[]).includes(target);
}

/** Every href, src and action value, decoded. */
function linkTargets(html: string): string[] {
  return [
    ...html.matchAll(
      /\s(?:href|src|action)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    ),
  ].map((m) => (m[1] ?? m[2] ?? m[3] ?? "").replace(/&amp;/g, "&"));
}

/**
 * Script, handlers, embeds, forms, wallet and analytics code, Stacks
 * principals, links off the repo, and claims the repo cannot back. The page's
 * own address and its two apps (SITE_PATHS) are the only other targets.
 */
export function forbiddenContent(html: string): string[] {
  const problems: string[] = [];
  const lower = html.toLowerCase();
  for (const tag of FORBIDDEN_TAGS) {
    if (new RegExp(`<${tag}\\b`, "i").test(html)) {
      problems.push(`a <${tag}> element`);
    }
  }
  for (const m of html.matchAll(/<[a-z][^>]*?\s(on[a-z]+)\s*=/gi)) {
    problems.push(`an ${m[1]!.toLowerCase()}= handler attribute`);
  }
  if (/@import|url\(/i.test(html)) problems.push("CSS that loads a file");
  for (const marker of WALLET_MARKERS) {
    if (lower.includes(marker.toLowerCase())) {
      problems.push(`wallet library marker ${marker}`);
    }
  }
  for (const marker of ANALYTICS_MARKERS) {
    if (lower.includes(marker)) problems.push(`analytics marker ${marker}`);
  }
  for (const m of html.matchAll(PRINCIPAL)) {
    problems.push(`a Stacks principal ${m[0]}`);
  }
  for (const url of urls(html)) {
    if (!isRepoUrl(url) && url !== SITE_URL) {
      problems.push(`a link off the repo: ${url}`);
    }
  }
  for (const target of linkTargets(html)) {
    if (!target.startsWith("#") && !isRepoUrl(target) && !isSitePath(target)) {
      problems.push(`a link that is neither in-page nor the repo: ${target}`);
    }
  }
  const text = pageText(html);
  for (const phrase of CLAIM_PHRASES) {
    const words = phrase.split(" ").map(escapeRegExp).join("\\s+");
    if (new RegExp(`\\b${words}`, "i").test(text)) {
      problems.push(`the claim phrase "${phrase}"`);
    }
  }
  return problems;
}

/**
 * In-page links whose id is missing, and repo links whose file (blob) or
 * folder (tree) is not in the checkout at `root`.
 */
export function brokenLinks(html: string, root: string): string[] {
  const problems: string[] = [];
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!));
  for (const target of linkTargets(html)) {
    if (target.startsWith("#")) {
      if (!ids.has(target.slice(1))) problems.push(`no id for ${target}`);
      continue;
    }
    if (target === REPO_URL || isSitePath(target)) continue;
    const m =
      /^https:\/\/github\.com\/0xlloyd\/keelio\/(blob|tree)\/main\/(.+)$/.exec(
        target,
      );
    if (m === null) {
      problems.push(`not a repo file or folder link: ${target}`);
      continue;
    }
    const path = decodeURIComponent(m[2]!);
    if (path.split("/").includes("..")) {
      problems.push(`a repo link that leaves the repo: ${target}`);
      continue;
    }
    const full = join(root, path);
    const kind = m[1] === "blob" ? "file" : "folder";
    const ok =
      existsSync(full) &&
      (kind === "file"
        ? statSync(full).isFile()
        : statSync(full).isDirectory());
    if (!ok) problems.push(`no ${kind} ${path} for ${target}`);
  }
  return problems;
}

/** Accessibility and layout structure. */
export function structureProblems(html: string): string[] {
  const problems: string[] = [];
  if (!/<html\s[^>]*lang="en"/.test(html)) problems.push('no <html lang="en">');
  if (
    !/<meta\s+name="viewport"\s+content="[^"]*width=device-width/.test(html)
  ) {
    problems.push("no viewport meta tag");
  }
  const csp =
    /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(
      html,
    )?.[1];
  if (
    csp === undefined ||
    !csp.startsWith("default-src 'none'") ||
    /script-src/.test(csp)
  ) {
    problems.push("no Content-Security-Policy meta tag that blocks scripts");
  }
  const levels = [...html.matchAll(/<h([1-6])\b/gi)].map((m) => Number(m[1]));
  const h1s = levels.filter((l) => l === 1).length;
  if (h1s !== 1) problems.push(`${h1s} <h1> elements, not 1`);
  if (levels[0] !== 1) problems.push("the first heading is not the <h1>");
  levels.forEach((level, i) => {
    const prev = levels[i - 1];
    if (prev !== undefined && level > prev + 1) {
      problems.push(`heading level skipped: h${prev} to h${level}`);
    }
  });
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    if (!/\salt\s*=/.test(m[0])) problems.push(`an <img> without alt: ${m[0]}`);
  }
  const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)];
  if (styles.length !== 1)
    problems.push(`${styles.length} <style> elements, not 1`);
  const css = styles.map((m) => m[1]).join("\n");
  const inline = [...html.matchAll(/\sstyle="([^"]*)"/g)].map((m) => m[1]);
  for (const m of [css, ...inline]
    .join("\n")
    .matchAll(
      /(?:^|[\s;{])((?:min-|max-)?width)\s*:\s*[^;}]*\d(?:\.\d+)?px/g,
    )) {
    problems.push(`a px value on ${m[1]}`);
  }
  if (!/:focus-visible/.test(css)) problems.push("no :focus-visible rule");
  if (!/a\s*\{[^}]*text-decoration:\s*underline/.test(css)) {
    problems.push("links are not underlined");
  }
  const rootBlock = /:root\s*\{[^}]*\}/.exec(css)?.[0] ?? "";
  const outside = css.replace(rootBlock, "");
  for (const m of outside.matchAll(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/gi)) {
    problems.push(`a colour outside the TOKENS custom properties: ${m[0]}`);
  }
  for (const m of html.matchAll(/<div class="scroll"[^>]*>/g)) {
    if (
      !/role="region"/.test(m[0]) ||
      !/tabindex="0"/.test(m[0]) ||
      !/aria-label="[^"]+"/.test(m[0])
    ) {
      problems.push(
        `a scroll region that is not focusable and labelled: ${m[0]}`,
      );
    }
  }
  return problems;
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map(
    (i) => parseInt(hex.slice(i, i + 2), 16) / 255,
  );
  const [r, g, b] = channels.map((c) =>
    c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  ) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The WCAG contrast ratio of two `#rrggbb` colours. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
}

/** Text/background pairs below 4.5:1. */
export function contrastProblems(
  tokens: Readonly<Record<Token, string>>,
  pairs: readonly (readonly [Token, Token])[] = CONTRAST_PAIRS,
): string[] {
  return pairs.flatMap(([fg, bg]) => {
    const ratio = contrastRatio(tokens[fg], tokens[bg]);
    return ratio >= 4.5
      ? []
      : [`${fg} on ${bg} is ${ratio.toFixed(2)}:1, below 4.5:1`];
  });
}

/** The skip link, the status line and the order of the sections. */
export function sectionOrder(html: string): string[] {
  const problems: string[] = [];
  const ids = [...html.matchAll(/<h2\b[^>]*\sid="([^"]+)"/g)].map((m) => m[1]);
  if (ids.join(",") !== SECTION_IDS.join(",")) {
    problems.push(
      `h2 ids are ${ids.join(", ")}, not ${SECTION_IDS.join(", ")}`,
    );
  }
  const status = /<p id="status">([^<]*)<\/p>/.exec(html);
  if (status?.[1] !== STATUS) problems.push("#status is not the status line");
  const firstH2 = html.indexOf("<h2");
  if (status === null || firstH2 === -1 || status.index > firstH2) {
    problems.push("#status is not before the first <h2>");
  }
  const firstLink = /<a\b[^>]*>([\s\S]*?)<\/a>/.exec(html);
  if (
    firstLink === null ||
    !/\shref="#main"/.test(firstLink[0]) ||
    firstLink[1] !== "Skip to content"
  ) {
    problems.push('the first link is not "Skip to content" to #main');
  }
  const focusable = /<(a|button|input|select|textarea)\b|tabindex="0"/.exec(
    html,
  );
  if (focusable?.index !== firstLink?.index) {
    problems.push("the skip link is not the first focusable element");
  }
  if (!/<main id="main">/.test(html)) problems.push('no <main id="main">');
  return problems;
}
