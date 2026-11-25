// Drives the browser build of the simnet (@stacks/clarinet-sdk-browser, wasm)
// through the demo page's session, in Node. The wasm is initialised from its
// bytes, so initSimnet()'s own init() returns at once and never fetches.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
// The package has a `module` field and no `main` or `exports`, which Node and
// Vite's SSR resolver both skip, so the test imports its entry file by path.
import {
  defaultFileStore,
  init,
  initSimnet,
} from "@stacks/clarinet-sdk-browser/dist/esm/browser/src/index.js";
import { Cl } from "@stacks/transactions";
import { beforeAll, describe, expect, it } from "vitest";
import {
  describeCheck,
  describeResult,
  ERROR_NAMES,
  loadProject,
  parseBaseUnits,
  startDemo,
  type DemoSession,
} from "../apps/demo/src/session.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function clarFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return clarFiles(path);
    return entry.name.endsWith(".clar") ? [path] : [];
  });
}

function projectFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  const add = (path: string) => {
    files[relative(root, path).split(sep).join("/")] = readFileSync(
      path,
      "utf8",
    );
  };
  add(join(root, "Clarinet.toml"));
  // The browser build reads the accounts from Devnet.toml, not Simnet.toml.
  add(join(root, "settings", "Devnet.toml"));
  for (const path of clarFiles(join(root, "contracts"))) add(path);
  return files;
}

let session: DemoSession;

beforeAll(async () => {
  const wasm = readFileSync(
    fileURLToPath(
      import.meta
        .resolve("@stacks/clarinet-sdk-wasm-browser/clarinet_sdk_bg.wasm"),
    ),
  );
  await init({ module_or_path: wasm });
  loadProject(defaultFileStore, projectFiles());
  session = await startDemo(await initSimnet());
}, 120_000);

describe("loadProject", () => {
  it("writes each file under /project", () => {
    const store = new Map<string, string>();
    loadProject(store, {
      "Clarinet.toml": "manifest",
      "contracts/mocks/mock-sbtc.clar": "(ok true)",
    });
    expect([...store.entries()]).toStrictEqual([
      ["/project/Clarinet.toml", "manifest"],
      ["/project/contracts/mocks/mock-sbtc.clar", "(ok true)"],
    ]);
  });
});

describe("the demo session on the browser-build simnet", () => {
  it("runs runDemo's setup", () => {
    expect(session.setup).toHaveLength(13);
    for (const value of session.setup) expect(value.type).toBe("ok");
    expect(session.setup).toContainEqual(Cl.ok(Cl.uint(100_000_000n)));
  });

  it("names wallet_1 the owner and wallet_2 the agent", () => {
    expect(session.owner).toMatch(/^ST/);
    expect(session.agent).toMatch(/^ST/);
    expect(session.owner).not.toBe(session.agent);
    expect(session.ids.vault).toMatch(/\.keelio-vault$/);
  });

  it("reads the opened vault", async () => {
    const { vault, burnHeight } = await session.read();
    expect(vault.balances).toStrictEqual({
      [session.ids.sbtc]: 100_000_000n,
      [session.ids.usd]: 0n,
    });
    expect(vault.vault).toStrictEqual({ agent: session.agent, paused: false });
    expect(vault.policy.expiresAt - burnHeight).toBeGreaterThan(0n);
  });

  it("lets the agent swap inside the policy", async () => {
    const outcome = await session.swap({
      amountIn: 10_000_000n,
      minOut: 9_000_000_000n,
    });
    expect(outcome.check).toStrictEqual({ ok: true });
    expect("result" in outcome && outcome.result).toStrictEqual(
      Cl.ok(Cl.uint(9_000_000_000n)),
    );
    if (!("result" in outcome)) throw new Error("no result");
    expect(describeCheck(outcome.check)).toBe("ok, no policy rule refuses");
    expect(describeResult(outcome.result)).toBe(
      "(ok u9000000000), 9000.000000 USD received",
    );

    const { vault } = await session.read();
    expect(vault.balances).toStrictEqual({
      [session.ids.sbtc]: 90_000_000n,
      [session.ids.usd]: 9_000_000_000n,
    });
    expect(vault.usage.dayTotals[session.ids.sbtc]).toBe(10_000_000n);
  });

  it("refuses a trade above the per-trade cap, as checkIntent said", async () => {
    const outcome = await session.swap({ amountIn: 50_000_000n, minOut: 0n });
    expect(outcome.check).toMatchObject({
      ok: false,
      rule: "TRADE_CAP_EXCEEDED",
      errorCode: 114,
    });
    if (!("result" in outcome)) throw new Error("no result");
    expect(outcome.result).toStrictEqual(Cl.error(Cl.uint(114)));
    expect(describeResult(outcome.result)).toBe(
      "(err u114) ERR-TRADE-CAP-EXCEEDED",
    );
    expect(describeCheck(outcome.check)).toMatch(
      /^TRADE_CAP_EXCEEDED \(u114\): /,
    );

    const { vault } = await session.read();
    expect(vault.balances).toStrictEqual({
      [session.ids.sbtc]: 90_000_000n,
      [session.ids.usd]: 9_000_000_000n,
    });
    expect(vault.usage.dayTotals[session.ids.sbtc]).toBe(10_000_000n);
  });

  it("refuses min-out one below the oracle floor, as checkIntent said", async () => {
    // 10,000,000 sats at $90,000 less 1%: a floor of 8,910,000,000.
    const outcome = await session.swap({
      amountIn: 10_000_000n,
      minOut: 8_909_999_999n,
    });
    expect(outcome.check).toStrictEqual({
      ok: false,
      rule: "BELOW_ORACLE_FLOOR",
      errorCode: 125,
      message: "min-out is below the oracle floor",
    });
    if (!("result" in outcome)) throw new Error("no result");
    expect(outcome.result).toStrictEqual(Cl.error(Cl.uint(125)));
    expect(describeResult(outcome.result)).toBe(
      "(err u125) ERR-BELOW-ORACLE-FLOOR",
    );
    expect((await session.read()).vault.balances).toStrictEqual({
      [session.ids.sbtc]: 90_000_000n,
      [session.ids.usd]: 9_000_000_000n,
    });
  });

  it("reports a builder refusal instead of sending", async () => {
    const outcome = await session.swap({ amountIn: 0n, minOut: 0n });
    expect(outcome.check).toMatchObject({ ok: false, rule: "ZERO_AMOUNT" });
    expect(outcome).toHaveProperty("buildError");
    expect(outcome).not.toHaveProperty("result");
  });
});

describe("ERROR_NAMES", () => {
  it("matches the keelio-vault rows of docs/errors.md", () => {
    const doc = readFileSync(join(root, "docs", "errors.md"), "utf8");
    const rows: Record<string, string> = {};
    for (const match of doc.matchAll(
      /^\| `keelio-vault`\s+\| `u(\d+)`\s*\| `([A-Z-]+)`/gm,
    )) {
      rows[match[1]!] = match[2]!;
    }
    expect(Object.keys(rows)).toHaveLength(34);
    expect(ERROR_NAMES).toStrictEqual(rows);
  });
});

describe("describeResult", () => {
  it("prints an unknown error code without a name", () => {
    expect(describeResult(Cl.error(Cl.uint(999)))).toBe("(err u999)");
  });
});

describe("parseBaseUnits", () => {
  it("refuses anything but whole numbers in range", () => {
    for (const text of ["", "1.5", "-1", "1e3", " ", "0x10", "+1", "1 2"]) {
      expect(parseBaseUnits(text, 0n), JSON.stringify(text)).toBeNull();
    }
    expect(parseBaseUnits("0", 1n)).toBeNull();
    expect(parseBaseUnits("340282366920938463463374607431768211456", 0n)).toBe(
      null,
    );
  });

  it("accepts whole numbers up to 2^128 - 1", () => {
    expect(parseBaseUnits(" 42 ", 0n)).toBe(42n);
    expect(parseBaseUnits("0", 0n)).toBe(0n);
    expect(parseBaseUnits("1", 1n)).toBe(1n);
    expect(parseBaseUnits("340282366920938463463374607431768211455", 1n)).toBe(
      2n ** 128n - 1n,
    );
  });
});
