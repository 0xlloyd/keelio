// Builds the demo page with Vite and scans every output file for network
// broadcast and wallet code. The page may only talk to its in-page simnet.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = join(root, "apps", "demo");

// Not banned on purpose: the bare words `broadcastTransaction`, `fetch(` and
// `hiro.so`. The simnet's own proxy and wasm glue define a local
// `broadcastTransaction` (it mines a simnet block), the glue calls `fetch` to
// load the `.wasm` and for remote data, and the wasm embeds Hiro URLs for
// remote data, which Clarinet.toml leaves off.
const MARKERS = [
  // BROADCAST_PATH in @stacks/transactions, used by its network broadcastTransaction.
  "/v2/transactions",
  // The SDK's read-only Stacks API client.
  "/v2/contracts/call-read",
  // Wallet libraries and wallet RPC methods.
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

function forbiddenMarkers(text: string): string[] {
  return MARKERS.filter((marker) => text.includes(marker));
}

let outDir: string;

beforeAll(async () => {
  outDir = mkdtempSync(join(tmpdir(), "keelio-demo-web-"));
  await build({
    root: app,
    configFile: join(app, "vite.config.ts"),
    logLevel: "silent",
    build: { outDir, emptyOutDir: true },
  });
}, 120_000);

afterAll(() => {
  if (outDir !== undefined) rmSync(outDir, { recursive: true, force: true });
});

function outputFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? outputFiles(path) : [path];
  });
}

describe("forbiddenMarkers", () => {
  it("flags a broadcast path and a wallet call", () => {
    expect(forbiddenMarkers('fetch(url + "/v2/transactions")')).toStrictEqual([
      "/v2/transactions",
    ]);
    expect(forbiddenMarkers("connect.showConnect({})")).toStrictEqual([
      "showConnect",
    ]);
    expect(forbiddenMarkers("simnet.broadcastTransaction(hex)")).toStrictEqual(
      [],
    );
  });
});

describe("the built demo page", () => {
  it("has the page, its script and the simnet wasm", () => {
    const files = outputFiles(outDir);
    expect(files).toContain(join(outDir, "index.html"));
    expect(files.some((f) => f.endsWith(".js"))).toBe(true);
    expect(files.some((f) => f.endsWith(".wasm"))).toBe(true);
  });

  it("holds no broadcast call and no wallet library", () => {
    const found = outputFiles(outDir).flatMap((file) =>
      forbiddenMarkers(readFileSync(file, "latin1")).map(
        (marker) => `${file}: ${marker}`,
      ),
    );
    expect(found).toStrictEqual([]);
  });
});
