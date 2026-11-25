// Shared set-up for the vault's oracle floor (job 025). Not a test file.
import type { initSimnet } from "@stacks/clarinet-sdk";
import { Cl } from "@stacks/transactions";
import { expect } from "vitest";

type Simnet = Awaited<ReturnType<typeof initSimnet>>;

/** $90,000 a BTC with 8 decimals: 900 USD base units a sat, mock-dex's rate 900. */
export const PRICE_90K = 9_000_000_000_000n;

/** 10^(8 + 8 - 6): the oracle's 8 decimals, sBTC's 8 and mock-usd's 6. */
export const PRICE_SCALE = 10_000_000_000n;

export const ORACLE_KEY = "BTC/USD";

export type OracleArm = {
  price: bigint;
  slippageBps: bigint;
  maxAgeMs: bigint;
};

/**
 * Sets the mock oracle's BTC/USD price with a timestamp of now, as the
 * deployer, then the owner's price bounds in `vault` (the shipped
 * `keelio-vault` unless named). Both calls must succeed.
 */
export function armOracle(
  simnet: Simnet,
  owner: string,
  { price, slippageBps, maxAgeMs }: OracleArm,
  vault = "keelio-vault",
) {
  const deployer = simnet.deployer;
  expect(
    simnet.callPublicFn(
      "mock-oracle",
      "set-value-aged",
      [Cl.stringAscii(ORACLE_KEY), Cl.uint(price), Cl.uint(0)],
      deployer,
    ).result,
  ).toStrictEqual(Cl.ok(Cl.bool(true)));
  expect(
    simnet.callPublicFn(
      vault,
      "set-price-bounds",
      [Cl.uint(slippageBps), Cl.uint(maxAgeMs)],
      owner,
    ).result,
  ).toStrictEqual(Cl.ok(Cl.bool(true)));
}

function ceilDiv(n: bigint, d: bigint): bigint {
  return (n + d - 1n) / d;
}

/**
 * The least `min-out` the vault accepts, written independently of the
 * contract from the spec's formula: the exact value less `slippageBps`,
 * rounded up. Selling sBTC gives quote base units; buying gives sats.
 */
export function floorOf(
  amountIn: bigint,
  price: bigint,
  slippageBps: bigint,
  sellingSbtc: boolean,
): bigint {
  const keep = 10_000n - slippageBps;
  return sellingSbtc
    ? ceilDiv(amountIn * price * keep, PRICE_SCALE * 10_000n)
    : ceilDiv(amountIn * PRICE_SCALE * keep, price * 10_000n);
}

/** The timestamp (ms) the mock oracle currently holds for BTC/USD. */
export function oracleTimestamp(simnet: Simnet): bigint {
  const read = simnet.callReadOnlyFn(
    "mock-oracle",
    "get-value",
    [Cl.stringAscii(ORACLE_KEY)],
    simnet.deployer,
  ).result;
  if (read.type !== "ok" || read.value.type !== "tuple")
    throw new Error("mock-oracle get-value did not return (ok tuple)");
  const timestamp = read.value.value["timestamp"];
  if (timestamp?.type !== "uint") throw new Error("no uint timestamp");
  return BigInt(timestamp.value);
}
