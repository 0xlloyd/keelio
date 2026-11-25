// `pnpm run web:build`: builds everything served at keelio.xyz into dist/web.
// `/` is the public page (apps/site), `/demo/` the web demo and `/dashboard/`
// the owner dashboard. Both apps run a simnet in the browser. The dashboard is
// built without a testnet config, so the hosted copy is the simulation alone.
// Needs a full `pnpm run test` first: the page shows the test report's count.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSite } from "../apps/site/build.js";
import { SITE_PATHS, SITE_URL } from "../apps/site/page.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist", "web");

/**
 * The apps' policy. They load only their own files; the simnet is wasm, and
 * the pages set a few styles inline. Nothing may frame them or post a form.
 */
const APP_CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** Cloudflare Pages reads `_headers`: one block of headers per path pattern. */
export function headersFile(): string {
  const everywhere = [
    "X-Content-Type-Options: nosniff",
    "X-Frame-Options: DENY",
    "Referrer-Policy: strict-origin-when-cross-origin",
    "Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()",
    "Strict-Transport-Security: max-age=31536000; includeSubDomains",
    "Cross-Origin-Opener-Policy: same-origin",
  ];
  const blocks = [
    ["/*", ...everywhere],
    ["/", `Link: <${SITE_URL}>; rel="canonical"`],
    ...SITE_PATHS.flatMap((path) => [
      [`${path}*`, `Content-Security-Policy: ${APP_CSP}`],
      [`${path}assets/*`, "Cache-Control: public, max-age=31536000, immutable"],
    ]),
  ];
  return (
    blocks
      .map(([pattern, ...lines]) =>
        [pattern, ...lines.map((line) => `  ${line}`)].join("\n"),
      )
      .join("\n\n") + "\n"
  );
}

export function sitemap(): string {
  const urls = ["", ...SITE_PATHS.map((path) => path.slice(1))]
    .map((path) => `  <url><loc>${SITE_URL}${path}</loc></url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

function main(): void {
  if (existsSync(join(root, "apps", "dashboard", "testnet.config.json"))) {
    throw new Error(
      "apps/dashboard/testnet.config.json exists: the hosted dashboard must be the simulation alone. Move the file away and build again.",
    );
  }
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  buildSite({
    root,
    outDir: out,
    reportPath: join(root, ".cache", "test-results.json"),
  });
  for (const path of SITE_PATHS) {
    const app = path.replaceAll("/", "");
    execFileSync(
      "pnpm",
      [
        "exec",
        "vite",
        "build",
        join("apps", app),
        "--base",
        path,
        "--outDir",
        join(out, app),
        "--emptyOutDir",
      ],
      { cwd: root, stdio: "inherit" },
    );
  }
  writeFileSync(join(out, "_headers"), headersFile());
  writeFileSync(
    join(out, "robots.txt"),
    `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}sitemap.xml\n`,
  );
  writeFileSync(join(out, "sitemap.xml"), sitemap());
  console.log(`web:build: wrote ${out}`);
}

main();
