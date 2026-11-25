// `pnpm run demo:bitflow` (scripts/demo-bitflow.ts): the demo's story traded through
// bitflow-adapter against Bitflow's mainnet sBTC/USDCx pool, in the remote-data simnet.
//
// Like tests/bitflow-adapter.test.ts it reads mainnet state through Hiro's public API (read only)
// and changes nothing outside the local simnet, so it runs only under `pnpm run test:online`;
// `pnpm run check` reports it as skipped. The pool is live state at a pinned height, so the tests
// assert relations between amounts, never fixed outputs.
import { readFileSync } from "node:fs";
import { initSimnet } from "@stacks/clarinet-sdk";
import { Cl, type ClarityValue } from "@stacks/transactions";
import { beforeAll, describe, expect, it } from "vitest";
import {
  BITFLOW_MANIFEST,
  BITFLOW_VAULT_NAME,
  pinnedHeight,
  SBTC,
  USDCX,
} from "../scripts/bitflow-world.js";
import {
  BIG_SWAP,
  DEPOSIT,
  MAX_PER_TRADE,
  renderBitflowDemo,
  runBitflowDemo,
  SWAP,
  USDCX_MAX_PER_TRADE,
  type BitflowDemoResult,
} from "../scripts/demo-bitflow.js";

const online = process.env.KEELIO_ONLINE === "1";

const packagePath = new URL("../package.json", import.meta.url);

/** The value of an `(ok uN)`. */
function okUint(value: ClarityValue): bigint {
  expect(value.type, Cl.prettyPrint(value)).toBe("ok");
  if (value.type !== "ok" || value.value.type !== "uint")
    throw new Error(`expected (ok uint), got ${Cl.prettyPrint(value)}`);
  return BigInt(value.value.value);
}

/** The journal's events as plain field maps, in order. */
function events(result: BitflowDemoResult): Record<string, ClarityValue>[] {
  return result.journal.map((event) => {
    if (event.type !== "tuple") throw new Error("journal event is no tuple");
    return event.value;
  });
}

const principalOf = (value: ClarityValue | undefined): string =>
  Cl.prettyPrint(value!).replace(/^'/, "");
const uintOf = (value: ClarityValue | undefined): bigint => {
  if (value?.type !== "uint") throw new Error("expected uint");
  return BigInt(value.value);
};

it("package.json: demo:bitflow runs the script and test:online runs this file", () => {
  const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as {
    scripts: Record<string, string>;
  };
  expect(pkg.scripts["demo:bitflow"]).toBe(
    "node --import ./scripts/resolve-ts.mjs scripts/demo-bitflow.ts",
  );
  expect(pkg.scripts["test:online"]).toContain("tests/demo-bitflow.test.ts");
  expect(pkg.scripts["test:online"]).toMatch(/^KEELIO_ONLINE=1 /);
});

describe.runIf(online)(
  "runBitflowDemo (mainnet state, simnet execution)",
  { timeout: 120_000 },
  () => {
    let result: BitflowDemoResult;
    let output: string;
    let adapter: string;
    let vault: string;

    beforeAll(async () => {
      const simnet = await initSimnet(BITFLOW_MANIFEST);
      adapter = `${simnet.deployer}.bitflow-adapter`;
      vault = `${simnet.deployer}.${BITFLOW_VAULT_NAME}`;
      result = await runBitflowDemo(simnet);
      output = renderBitflowDemo(result);
    }, 180_000);

    it("sets up the simnet and opens the vault", () => {
      expect(result.ids).toStrictEqual({ vault, adapter });
      expect(result.setup.deploy).toStrictEqual(Cl.ok(Cl.bool(true)));
      expect(result.setup.fund).toStrictEqual(Cl.ok(Cl.bool(true)));
      expect(result.setup.oracle).toStrictEqual(Cl.ok(Cl.bool(true)));
      expect(result.setup.oraclePrice).toBeGreaterThan(0n);
      expect(result.ownerWalletBefore.sbtc).toBeGreaterThanOrEqual(DEPOSIT);
      expect(result.open).toHaveLength(9);
      expect(result.open[0]).toStrictEqual(Cl.ok(Cl.uint(DEPOSIT)));
      for (const value of result.open.slice(1))
        expect(value).toStrictEqual(Cl.ok(Cl.bool(true)));
    });

    it("the in-cap swap succeeds through bitflow-adapter and the USDCx ledger rises by at least min-out", () => {
      const { swap } = result;
      expect(swap.amountIn).toBe(SWAP);
      expect(swap.amountIn).toBeLessThanOrEqual(MAX_PER_TRADE);
      expect(swap.minOut).toBeGreaterThan(0n);
      expect(swap.check).toStrictEqual({ ok: true });
      const received = okUint(swap.result);
      expect(received).toBeGreaterThanOrEqual(swap.minOut);

      // The vault's own event: the adapter it used and its ledgers after the swap.
      const event = events(result).find(
        (e) =>
          e["event"]?.type === "ascii" && e["event"].value === "execute-swap",
      )!;
      expect(principalOf(event["adapter"])).toBe(adapter);
      expect(principalOf(event["token-in"])).toBe(SBTC);
      expect(principalOf(event["token-out"])).toBe(USDCX);
      expect(uintOf(event["amount-out"])).toBe(received);
      // The USDCx ledger was 0 before this swap, so its balance is its rise.
      expect(uintOf(event["balance-out"])).toBe(received);
      expect(uintOf(event["balance-out"])).toBeGreaterThanOrEqual(swap.minOut);
      expect(uintOf(event["balance-in"])).toBe(DEPOSIT - SWAP);
    });

    it("the buy-back succeeds inside the USDCx caps and returns at least its min-out", () => {
      const { buyBack } = result;
      const usdcxIn = okUint(result.swap.result) / 2n;
      expect(buyBack.amountIn).toBe(usdcxIn);
      expect(buyBack.amountIn).toBeLessThanOrEqual(USDCX_MAX_PER_TRADE);
      expect(buyBack.check).toStrictEqual({ ok: true });
      const sats = okUint(buyBack.result);
      expect(sats).toBeGreaterThanOrEqual(buyBack.minOut);
      expect(result.ledgerBeforeWithdraw).toStrictEqual({
        sbtc: DEPOSIT - SWAP + sats,
        usdcx: okUint(result.swap.result) - usdcxIn,
      });
    });

    it("refuses the trade above the per-trade cap with u114, as checkIntent said", () => {
      expect(result.bigSwap.amountIn).toBe(BIG_SWAP);
      expect(BIG_SWAP).toBeGreaterThan(MAX_PER_TRADE);
      expect(result.bigSwap.check).toMatchObject({
        ok: false,
        rule: "TRADE_CAP_EXCEEDED",
        errorCode: 114,
      });
      expect(result.bigSwap.result).toStrictEqual(Cl.error(Cl.uint(114)));
    });

    it("refuses the agent's withdrawal with u101 and pays the agent nothing", () => {
      expect(result.agentWithdraw).toStrictEqual(Cl.error(Cl.uint(101)));
      expect(result.final.agentWallet).toStrictEqual({ sbtc: 0n, usdcx: 0n });
    });

    it("refuses a swap inside the caps with u109 once the vault is paused", () => {
      expect(result.pause).toStrictEqual(Cl.ok(Cl.bool(true)));
      expect(result.pausedSwap.amountIn).toBeLessThanOrEqual(MAX_PER_TRADE);
      expect(result.pausedSwap.check).toMatchObject({
        ok: false,
        rule: "VAULT_PAUSED",
        errorCode: 109,
      });
      expect(result.pausedSwap.result).toStrictEqual(Cl.error(Cl.uint(109)));
    });

    it("the owner ends with everything withdrawn, while paused", () => {
      const { final, ledgerBeforeWithdraw, ownerWalletBefore } = result;
      expect(result.ownerWithdraw.sbtc).toStrictEqual(Cl.ok(Cl.uint(0)));
      expect(result.ownerWithdraw.usdcx).toStrictEqual(Cl.ok(Cl.uint(0)));
      expect(final.vault.vault.paused).toBe(true);
      expect(final.vault.balances[SBTC]).toBe(0n);
      expect(final.vault.balances[USDCX]).toBe(0n);
      expect(ledgerBeforeWithdraw.usdcx).toBeGreaterThan(0n);
      expect(final.ownerWallet).toStrictEqual({
        sbtc: ownerWalletBefore.sbtc - DEPOSIT + ledgerBeforeWithdraw.sbtc,
        usdcx: ownerWalletBefore.usdcx + ledgerBeforeWithdraw.usdcx,
      });
      // The adapter kept nothing.
      expect(final.adapterWallet).toStrictEqual({ sbtc: 0n, usdcx: 0n });
    });

    it("the journal holds the successful calls only, and every execute-swap names bitflow-adapter", () => {
      const names = events(result).map((e) =>
        e["event"]?.type === "ascii" ? e["event"].value : "?",
      );
      expect(names).toStrictEqual([
        "deposit",
        "set-agent",
        "set-token-caps",
        "set-token-caps",
        "set-policy",
        "allow-token",
        "allow-token",
        "allow-adapter",
        "set-price-bounds",
        "execute-swap",
        "execute-swap",
        "pause",
        "withdraw",
        "withdraw",
      ]);
      const swaps = events(result).filter(
        (e) =>
          e["event"]?.type === "ascii" && e["event"].value === "execute-swap",
      );
      expect(swaps.map((e) => principalOf(e["adapter"]))).toStrictEqual([
        adapter,
        adapter,
      ]);
      expect(
        output.split("\n").filter((l) => l.startsWith("  execute-swap     ")),
      ).toStrictEqual([
        expect.stringContaining(" on bitflow-adapter (min "),
        expect.stringContaining(" on bitflow-adapter (min "),
      ]);
    });

    it("the output says first that it is online, read only and unsigned", () => {
      const head = output.split("\n").slice(0, 3).join("\n");
      expect(head).toContain("Needs the network");
      expect(head).toContain("Hiro's public API (read only)");
      expect(head).toContain(`height ${pinnedHeight()}`);
      expect(head).toContain("Nothing is signed or broadcast.");
    });

    it("renders checkIntent next to each swap's result, with labels and no addresses", () => {
      const lines = output.split("\n");
      const after = lines
        .map((line, i) =>
          line.startsWith("  checkIntent: ") ? lines[i + 1] : undefined,
        )
        .filter((line) => line !== undefined);
      expect(after).toHaveLength(4);
      for (const line of after) expect(line).toMatch(/^ {2}execute-swap: /);
      for (const text of [
        "TRADE_CAP_EXCEEDED",
        "(err u114) ERR-TRADE-CAP-EXCEEDED",
        "(err u101) ERR-INSUFFICIENT-BALANCE",
        "VAULT_PAUSED",
        "(err u109) ERR-VAULT-PAUSED",
      ]) {
        expect(output).toContain(text);
      }
      expect(/\bS[TPM][0-9A-Z]{20,}/.test(output)).toBe(false);
      expect(lines.filter((line) => /\s$/.test(line))).toEqual([]);
      expect(output.endsWith("\n")).toBe(true);
      expect(output.endsWith("\n\n")).toBe(false);
      expect(output).not.toMatch(
        /post-conditions? (were |was )?(checked|enforced)/i,
      );
    });
  },
);
