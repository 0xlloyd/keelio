// Builds the owner dashboard with Vite, twice, and scans the output for
// network broadcast, signing, API-client and wallet code, as
// tests/demo-web-bundle.test.ts does for the demo.
//
// 1. With no testnet config, which is the repo as committed: no output file
//    may hold any of it. The page can only talk to its in-page simnet.
// 2. With a testnet config: that code is in the build, in files that only
//    testnet mode loads. No file simulation mode can load holds a wallet
//    library, the API client or the broadcast path.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contrastRatio, WALLET_MARKERS } from "../apps/site/checks.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = join(root, "apps", "dashboard");

// Signing a transaction with a key, in @stacks/transactions.
const SIGNING_MARKERS = [
  "makeContractCall",
  "makeUnsignedContractCall",
  "TransactionSigner",
  "privateKeyToPublic",
];

// Not banned on purpose, for the reasons in tests/demo-web-bundle.test.ts:
// the bare words `broadcastTransaction`, `fetch(` and `hiro.so` are the
// simnet's own proxy, wasm loader and remote-data URLs, which stay unused.
const NETWORK_AND_WALLET_MARKERS = [
  // BROADCAST_PATH in @stacks/transactions, used by its network broadcastTransaction.
  "/v2/transactions",
  // The SDK's read-only Stacks API client.
  "/v2/contracts/call-read",
  // The dashboard's own API reads (apps/dashboard/src/chain-api.ts). Its
  // paths cannot be markers: the simnet's wasm names the same API for its
  // unused remote-data feature.
  "ChainApiError",
  ...WALLET_MARKERS,
];

const MARKERS = [...NETWORK_AND_WALLET_MARKERS, ...SIGNING_MARKERS];

function forbiddenMarkers(text: string, markers = MARKERS): string[] {
  return markers.filter((marker) => text.includes(marker));
}

/** The build with no testnet config. */
let outDir: string;
/** The build with a testnet config. */
let testnetDir: string;

async function buildDashboard(hasTestnetConfig: boolean): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "keelio-dashboard-"));
  await build({
    root: app,
    configFile: join(app, "vite.config.ts"),
    logLevel: "silent",
    // Set here so the test does not depend on a config file on this machine.
    define: { __KEELIO_TESTNET_CONFIG__: JSON.stringify(hasTestnetConfig) },
    // Function names are kept so the signing markers above can be found.
    // The manifest says which file imports which.
    build: { outDir: dir, emptyOutDir: true, minify: false, manifest: true },
  });
  return dir;
}

beforeAll(async () => {
  outDir = await buildDashboard(false);
  testnetDir = await buildDashboard(true);
}, 240_000);

afterAll(() => {
  for (const dir of [outDir, testnetDir]) {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function outputFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? outputFiles(path) : [path];
  });
}

/** One chunk of Vite's build manifest, by source path. */
interface ManifestChunk {
  file: string;
  isDynamicEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
  css?: string[];
  assets?: string[];
}

const ENTRY = "index.html";
const TESTNET_MODE = "src/testnet-mode.ts";
const MANIFEST = join(".vite", "manifest.json");

function readManifest(dir: string): Record<string, ManifestChunk> {
  return JSON.parse(readFileSync(join(dir, MANIFEST), "utf8")) as Record<
    string,
    ManifestChunk
  >;
}

/**
 * The chunks the page can load in simulation mode: everything reachable from
 * the entry by a static or dynamic import, except through the entry's one
 * dynamic import of testnet mode.
 */
function simulationChunks(dir: string): Map<string, ManifestChunk> {
  const manifest = readManifest(dir);
  const seen = new Map<string, ManifestChunk>();
  const visit = (key: string): void => {
    if (seen.has(key)) return;
    const chunk = manifest[key];
    if (chunk === undefined) throw new Error(`no manifest entry ${key}`);
    seen.set(key, chunk);
    for (const next of chunk.imports ?? []) visit(next);
    for (const next of chunk.dynamicImports ?? []) {
      if (!(key === ENTRY && next === TESTNET_MODE)) visit(next);
    }
  };
  visit(ENTRY);
  return seen;
}

function filesOf(dir: string, chunks: Map<string, ManifestChunk>): string[] {
  const files = new Set<string>([join(dir, "index.html")]);
  for (const chunk of chunks.values()) {
    for (const file of [
      chunk.file,
      ...(chunk.css ?? []),
      ...(chunk.assets ?? []),
    ]) {
      files.add(join(dir, file));
    }
  }
  return [...files];
}

const scan = (files: string[], markers = MARKERS): string[] =>
  files.flatMap((file) =>
    forbiddenMarkers(readFileSync(file, "latin1"), markers).map(
      (marker) => `${file}: ${marker}`,
    ),
  );

describe("forbiddenMarkers", () => {
  it("flags a broadcast path, a signing call and a wallet call", () => {
    expect(forbiddenMarkers('fetch(url + "/v2/transactions")')).toStrictEqual([
      "/v2/transactions",
    ]);
    expect(forbiddenMarkers("await makeContractCall(options)")).toStrictEqual([
      "makeContractCall",
    ]);
    expect(forbiddenMarkers("connect.showConnect({})")).toStrictEqual([
      "showConnect",
    ]);
    expect(forbiddenMarkers("throw new ChainApiError(code)")).toStrictEqual([
      "ChainApiError",
    ]);
    expect(forbiddenMarkers("simnet.callPublicFn(a, b, c, d)")).toStrictEqual(
      [],
    );
  });
});

describe("the built dashboard, with no testnet config", () => {
  it("has the page, its script and the simnet wasm", () => {
    const files = outputFiles(outDir);
    expect(files).toContain(join(outDir, "index.html"));
    expect(files.some((f) => f.endsWith(".js"))).toBe(true);
    expect(files.some((f) => f.endsWith(".wasm"))).toBe(true);
  });

  it("holds no broadcast call, no signing call, no API client and no wallet library", () => {
    const files = outputFiles(outDir).filter((f) => !f.endsWith(MANIFEST));
    expect(scan(files)).toStrictEqual([]);
  });

  it("holds no testnet mode at all, only the note that a config is missing", () => {
    const manifest = readManifest(outDir);
    expect(Object.keys(manifest)).not.toContain(TESTNET_MODE);
    expect(
      Object.keys(manifest).filter((key) =>
        /wallet|connect|chain-api/.test(key),
      ),
    ).toStrictEqual([]);
    expect(manifest["src/testnet-page.ts"]?.isDynamicEntry).toBe(true);
    const page = readFileSync(
      join(outDir, manifest["src/testnet-page.ts"]!.file),
      "utf8",
    );
    expect(page).toContain("Testnet mode needs a config, and none was found.");
  });

  it("says on the page that it is a local simulation", () => {
    const html = readFileSync(join(outDir, "index.html"), "utf8");
    const banner = /<header class="banner">([\s\S]*?)<\/header>/.exec(html);
    const text = (banner?.[1] ?? "")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ");
    expect(text).toContain("Local simulation.");
    expect(text).toContain("Mock tokens, no real funds, nothing deployed.");
  });

  it("keeps every text colour at 4.5:1 or more on its background", () => {
    const css = readFileSync(join(app, "src", "styles.css"), "utf8");
    const token = (name: string): string => {
      const match = new RegExp(`--${name}: (#[0-9a-f]{6});`).exec(css);
      if (match === null) throw new Error(`no colour token --${name}`);
      return match[1]!;
    };
    const pairs: [string, string][] = [
      // Ink on the page, on a card and on a filled button.
      ...["paper", "surface", "orange", "rule"].map((bg): [string, string] => [
        token("text"),
        token(bg),
      ]),
      ...["muted", "accent", "error", "ok"].flatMap(
        (fg): [string, string][] => [
          [token(fg), token("paper")],
          [token(fg), token("surface")],
        ],
      ),
      // The mode strip, the agent console and the review dialog's title.
      ...[
        "on-ink",
        "on-ink-muted",
        "on-ink-ok",
        "on-ink-error",
        "orange",
      ].flatMap((fg): [string, string][] => [
        [token(fg), token("ink")],
        [token(fg), token("ink-raised")],
      ]),
      [token("text"), token("on-ink")],
      // The returned-value tag in the agent console.
      [token("on-ink"), token("ink-rule")],
      // An input's border needs only 3:1; it is held to the text bar too.
      [token("border"), token("surface")],
    ];
    for (const [fg, bg] of pairs) {
      expect(contrastRatio(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });
});

describe("the built dashboard, with a testnet config", () => {
  it("picks the mode from the address and defaults to the simulation", () => {
    const main = readFileSync(join(app, "src", "main.ts"), "utf8");
    expect(main).toContain(
      'if (modeFromSearch(window.location.search) === "testnet") {',
    );
    expect(main).toContain("if (__KEELIO_TESTNET_CONFIG__) {");
  });

  it("reaches testnet mode from simulation mode's files only by the entry's one dynamic import", () => {
    const manifest = readManifest(testnetDir);
    expect(manifest[TESTNET_MODE]?.isDynamicEntry).toBe(true);
    expect(manifest[ENTRY]?.dynamicImports).toContain(TESTNET_MODE);
    expect(manifest[ENTRY]?.imports ?? []).not.toContain(TESTNET_MODE);
    const chunks = simulationChunks(testnetDir);
    expect(chunks.has(TESTNET_MODE)).toBe(false);
    expect(chunks.size).toBeGreaterThan(2);
  });

  it("in simulation mode loads no broadcast path, no API client and no wallet library", () => {
    const files = filesOf(testnetDir, simulationChunks(testnetDir));
    expect(files).toContain(join(testnetDir, "index.html"));
    expect(files.some((f) => f.endsWith(".wasm"))).toBe(true);
    expect(scan(files, NETWORK_AND_WALLET_MARKERS)).toStrictEqual([]);
    // Both modes use @stacks/transactions, so the bundler puts what they
    // share of it in one file. In this build that file also carries the
    // library's key-to-public-key helper, which the wallet library imports
    // and simulation mode never calls. No call that builds or signs a
    // transaction is in a file simulation mode loads.
    const signing = new Set(
      files.flatMap((file) =>
        forbiddenMarkers(readFileSync(file, "latin1"), SIGNING_MARKERS),
      ),
    );
    signing.delete("privateKeyToPublic");
    expect([...signing]).toStrictEqual([]);
  });

  it("holds the wallet library and the API client in files only testnet mode loads", () => {
    const simulation = new Set(
      filesOf(testnetDir, simulationChunks(testnetDir)),
    );
    const testnetOnly = outputFiles(testnetDir).filter(
      (file) => !simulation.has(file) && !file.endsWith(MANIFEST),
    );
    const found = new Set(
      testnetOnly.flatMap((file) =>
        forbiddenMarkers(readFileSync(file, "latin1")),
      ),
    );
    // The scans above are not empty-handed: this code is in the build.
    expect(found).toContain("stx_callContract");
    expect(found).toContain("/v2/contracts/call-read");
    expect(found).toContain("ChainApiError");
  });
});
