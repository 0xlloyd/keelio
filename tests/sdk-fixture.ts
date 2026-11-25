// Shared set-up for the SDK's journal-reading tests. Not a test file.
import type { initSimnet } from "@stacks/clarinet-sdk";
import { Cl, type ClarityValue } from "@stacks/transactions";
import { expect } from "vitest";
import type { JournalRecord } from "../packages/sdk/src/index.js";
import { ORACLE_KEY, PRICE_90K, floorOf } from "./oracle-fixture.js";

type Simnet = Awaited<ReturnType<typeof initSimnet>>;

export const RATE = 900n;
export const SLIPPAGE_BPS = 100n;
export const MAX_AGE_MS = 10n ** 15n;
export const EXPIRES_AT = 1_000_000n;

export interface OwnerSetup {
  owner: string;
  agent: string;
  /** sBTC minted to the owner and deposited. */
  deposit: bigint;
  maxPerTrade: bigint;
  maxPerDay: bigint;
  cooldownBlocks?: bigint;
}

/**
 * Drives the simnet's vault and keeps its journal: the simnet has no event
 * history, so every vault call a test wants journalled goes through `call`.
 */
export function vaultHarness(simnet: Simnet) {
  const deployer = simnet.deployer;
  const vaultId = `${deployer}.keelio-vault`;
  const sbtc = `${deployer}.mock-sbtc`;
  const usd = `${deployer}.mock-usd`;
  const dex = `${deployer}.mock-dex`;
  const records: JournalRecord[] = [];

  /** Calls the vault; a successful call's print events join the journal. */
  function call(sender: string, fn: string, args: ClarityValue[] = []) {
    const burnHeight = BigInt(simnet.burnBlockHeight);
    const res = simnet.callPublicFn("keelio-vault", fn, args, sender);
    if (res.result.type === "ok") {
      for (const e of res.events) {
        const data = e.data as {
          contract_identifier?: string;
          value?: ClarityValue;
        };
        if (
          e.event === "print_event" &&
          data.contract_identifier === vaultId &&
          data.value !== undefined
        ) {
          records.push({ burnHeight, value: data.value });
        }
      }
    }
    return res;
  }

  function ok(sender: string, fn: string, args: ClarityValue[] = []) {
    const res = call(sender, fn, args);
    expect(res.result.type, `${fn} by ${sender}`).toBe("ok");
    return res;
  }

  function mint(token: "mock-sbtc" | "mock-usd", amount: bigint, to: string) {
    expect(
      simnet.callPublicFn(
        token,
        "mint",
        [Cl.uint(amount), Cl.principal(to)],
        deployer,
      ).result.type,
    ).toBe("ok");
  }

  function setRate(num: bigint, den: bigint) {
    expect(
      simnet.callPublicFn(
        "mock-dex",
        "set-rate",
        [Cl.uint(num), Cl.uint(den)],
        deployer,
      ).result.type,
    ).toBe("ok");
  }

  /** Gives the mock dex reserves and the oracle a fresh $90,000 price. */
  function fundDex() {
    mint("mock-usd", 10n ** 18n, dex);
    mint("mock-sbtc", 10n ** 14n, dex);
    expect(
      simnet.callPublicFn(
        "mock-oracle",
        "set-value-aged",
        [Cl.stringAscii(ORACLE_KEY), Cl.uint(PRICE_90K), Cl.uint(0)],
        deployer,
      ).result.type,
    ).toBe("ok");
  }

  /**
   * One owner ready to be traded for: a deposit, an agent, both tokens and
   * the adapter allowed, sBTC caps, a policy and price bounds. Eight journal
   * events, in the order of the calls below.
   */
  function setUpOwner(s: OwnerSetup) {
    mint("mock-sbtc", s.deposit, s.owner);
    ok(s.owner, "deposit", [Cl.principal(sbtc), Cl.uint(s.deposit)]);
    ok(s.owner, "set-agent", [Cl.principal(s.agent)]);
    ok(s.owner, "allow-token", [Cl.principal(sbtc), Cl.bool(true)]);
    ok(s.owner, "allow-token", [Cl.principal(usd), Cl.bool(true)]);
    ok(s.owner, "allow-adapter", [Cl.principal(dex), Cl.bool(true)]);
    ok(s.owner, "set-token-caps", [
      Cl.principal(sbtc),
      Cl.uint(s.maxPerTrade),
      Cl.uint(s.maxPerDay),
    ]);
    ok(s.owner, "set-policy", [
      Cl.uint(s.cooldownBlocks ?? 0n),
      Cl.uint(EXPIRES_AT),
    ]);
    ok(s.owner, "set-price-bounds", [
      Cl.uint(SLIPPAGE_BPS),
      Cl.uint(MAX_AGE_MS),
    ]);
  }

  /**
   * An `execute-swap` with min-out at the oracle floor. The mock dex has one
   * rate, so it is pointed at the oracle price for the direction first.
   */
  function swap(
    agent: string,
    owner: string,
    amountIn: bigint,
    direction: "sell" | "buy" = "sell",
  ) {
    const selling = direction === "sell";
    if (selling) setRate(RATE, 1n);
    else setRate(1n, RATE);
    return call(agent, "execute-swap", [
      Cl.principal(owner),
      Cl.principal(dex),
      Cl.principal(selling ? sbtc : usd),
      Cl.principal(selling ? usd : sbtc),
      Cl.uint(amountIn),
      Cl.uint(floorOf(amountIn, PRICE_90K, SLIPPAGE_BPS, selling)),
    ]);
  }

  return {
    vaultId,
    sbtc,
    usd,
    dex,
    records,
    call,
    ok,
    mint,
    fundDex,
    setUpOwner,
    swap,
  };
}
