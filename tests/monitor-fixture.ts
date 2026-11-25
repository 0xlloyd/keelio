// Shared set-up for the monitor's tests that drive the real contract on the
// simnet. Not a test file.
import { initSimnet } from "@stacks/clarinet-sdk";
import { Cl, type ClarityValue } from "@stacks/transactions";
import { expect } from "vitest";
import {
  createMonitor,
  memoryStore,
  monitorSimnetChain,
  type Alert,
  type AlertCode,
  type Monitor,
  type SimnetMonitorChain,
  type StateStore,
  type Thresholds,
} from "../packages/monitor/src/index.js";
import type { VaultConfig } from "../packages/sdk/src/index.js";
import {
  ORACLE_KEY,
  PRICE_90K,
  PRICE_SCALE,
  floorOf,
} from "./oracle-fixture.js";

export const DEPOSIT = 1_000_000n;
export const MAX_PER_TRADE = 100_000n;
export const MAX_PER_DAY = 250_000n;
export const SLIPPAGE_BPS = 100n;
export const MAX_AGE_MS = 3_600_000n;
/** The contract's `APPROVAL-WINDOW`, in burn blocks. */
export const APPROVAL_WINDOW = 6n;

export function codes(alerts: readonly Alert[]): AlertCode[] {
  return alerts.map((a) => a.code);
}

export function only(alerts: readonly Alert[], code: AlertCode): Alert {
  const found = alerts.filter((a) => a.code === code);
  expect(found, `${code} in ${codes(alerts).join(", ")}`).toHaveLength(1);
  return found[0]!;
}

/**
 * The five trade arguments `request-swap`, `approve-swap` and `execute-swap`
 * share. `approve-swap` adds the request's `requested-at` (`approveArgs`).
 */
export interface Trade {
  amount: bigint;
  /** Defaults to the oracle floor at $90,000 less 1%. */
  minOut?: bigint;
}

/**
 * A fresh simnet with a monitor watching it through `monitorSimnetChain`.
 * Alice and Carol are owners, Bob is the agent. The mock dex trades sBTC for
 * the quote token at the oracle price, 900 base units a sat.
 */
export async function monitorFixture() {
  const simnet = await initSimnet();
  const accounts = simnet.getAccounts();
  const deployer = accounts.get("deployer")!;
  const alice = accounts.get("wallet_1")!;
  const bob = accounts.get("wallet_2")!;
  const carol = accounts.get("wallet_3")!;
  const sbtc = `${deployer}.mock-sbtc`;
  const usd = `${deployer}.mock-usd`;
  const dex = `${deployer}.mock-dex`;
  const read: VaultConfig = {
    vault: "keelio-vault",
    tokens: [sbtc, usd],
    adapters: [dex],
    oracle: "mock-oracle",
    sbtcToken: sbtc,
    priceScale: PRICE_SCALE,
  };
  const chain: SimnetMonitorChain = monitorSimnetChain(simnet, deployer);
  const store: StateStore = memoryStore();
  const watch = (
    thresholds: Partial<Thresholds> = {},
    from: StateStore = store,
  ): Monitor => createMonitor({ chain, read, store: from, thresholds });
  const monitor = watch();

  const call = (
    contract: string,
    fn: string,
    args: ClarityValue[],
    sender: string,
  ): ClarityValue => chain.callPublicFn(contract, fn, args, sender).result;
  const ok = (
    contract: string,
    fn: string,
    args: ClarityValue[],
    sender: string,
  ) => {
    const result = call(contract, fn, args, sender);
    expect(result.type, `${fn}: ${Cl.prettyPrint(result)}`).toBe("ok");
  };
  const vault = (sender: string, fn: string, args: ClarityValue[] = []) =>
    ok("keelio-vault", fn, args, sender);
  const refused = (
    sender: string,
    fn: string,
    args: ClarityValue[],
    code: number,
  ) =>
    expect(call("keelio-vault", fn, args, sender)).toStrictEqual(
      Cl.error(Cl.uint(code)),
    );

  const freshOracle = () =>
    ok(
      "mock-oracle",
      "set-value-aged",
      [Cl.stringAscii(ORACLE_KEY), Cl.uint(PRICE_90K), Cl.uint(0)],
      deployer,
    );
  /** Mines burn blocks, then gives the oracle a price of the new block time. */
  const mine = (blocks: number) => {
    simnet.mineEmptyBurnBlocks(blocks);
    freshOracle();
  };
  const height = () => BigInt(simnet.burnBlockHeight);

  /** Opens `owner`'s vault with Bob as agent, ready to sell sBTC. */
  const open = (owner = alice, expiresAt = 1_000_000n) => {
    ok("mock-sbtc", "mint", [Cl.uint(DEPOSIT), Cl.principal(owner)], deployer);
    ok(
      "mock-usd",
      "mint",
      [Cl.uint(1_000_000_000_000n), Cl.principal(dex)],
      deployer,
    );
    ok("mock-dex", "set-rate", [Cl.uint(900), Cl.uint(1)], deployer);
    freshOracle();
    vault(owner, "deposit", [Cl.principal(sbtc), Cl.uint(DEPOSIT)]);
    vault(owner, "set-agent", [Cl.principal(bob)]);
    vault(owner, "set-token-caps", [
      Cl.principal(sbtc),
      Cl.uint(MAX_PER_TRADE),
      Cl.uint(MAX_PER_DAY),
    ]);
    vault(owner, "set-policy", [Cl.uint(0), Cl.uint(expiresAt)]);
    vault(owner, "allow-token", [Cl.principal(sbtc), Cl.bool(true)]);
    vault(owner, "allow-token", [Cl.principal(usd), Cl.bool(true)]);
    vault(owner, "allow-adapter", [Cl.principal(dex), Cl.bool(true)]);
    vault(owner, "set-price-bounds", [
      Cl.uint(SLIPPAGE_BPS),
      Cl.uint(MAX_AGE_MS),
    ]);
  };

  /** Selling sBTC for the quote token on the mock dex. */
  const tradeArgs = ({ amount, minOut }: Trade): ClarityValue[] => [
    Cl.principal(dex),
    Cl.principal(sbtc),
    Cl.principal(usd),
    Cl.uint(amount),
    Cl.uint(minOut ?? floorOf(amount, PRICE_90K, SLIPPAGE_BPS, true)),
  ];
  const agentArgs = (trade: Trade, owner = alice) => [
    Cl.principal(owner),
    ...tradeArgs(trade),
  ];
  /** The burn height of `owner`'s stored request, or 0 with none stored. */
  const requestedAt = (owner = alice): bigint => {
    const stored = simnet.callReadOnlyFn(
      "keelio-vault",
      "get-pending-swap",
      [Cl.principal(owner)],
      deployer,
    ).result;
    if (stored.type !== "some" || stored.value.type !== "tuple") return 0n;
    const at = stored.value.value["requested-at"];
    if (at?.type !== "uint") throw new Error("requested-at is not a uint");
    return BigInt(at.value);
  };
  /**
   * `approve-swap`'s arguments for `trade`, naming the request `owner` has
   * stored now, as an owner who has just read it would sign.
   */
  const approveArgs = (trade: Trade, owner = alice): ClarityValue[] => [
    ...tradeArgs(trade),
    Cl.uint(requestedAt(owner)),
  ];
  const setThreshold = (threshold: bigint | null, owner = alice) =>
    vault(owner, "set-approval-threshold", [
      Cl.principal(sbtc),
      threshold === null ? Cl.none() : Cl.some(Cl.uint(threshold)),
    ]);

  return {
    simnet,
    deployer,
    alice,
    bob,
    carol,
    sbtc,
    usd,
    dex,
    read,
    chain,
    store,
    monitor,
    watch,
    call,
    ok,
    vault,
    refused,
    mine,
    height,
    open,
    tradeArgs,
    agentArgs,
    approveArgs,
    setThreshold,
    /** Bob sells `amount` sats of `owner`'s with `execute-swap`. */
    swap: (amount: bigint, owner = alice) =>
      vault(bob, "execute-swap", agentArgs({ amount }, owner)),
    /** Bob records a request to sell `amount` sats of `owner`'s. */
    request: (amount: bigint, owner = alice) =>
      vault(bob, "request-swap", agentArgs({ amount }, owner)),
    /** `owner` approves their pending request for `amount` sats. */
    approve: (amount: bigint, owner = alice) =>
      vault(owner, "approve-swap", approveArgs({ amount }, owner)),
  };
}

export type MonitorFixture = Awaited<ReturnType<typeof monitorFixture>>;
