import { initSimnet } from "@stacks/clarinet-sdk";
import { Cl, type ResponseOkCV, type UIntCV } from "@stacks/transactions";
import { beforeEach, describe, expect, it } from "vitest";

const simnet = await initSimnet();
const accounts = simnet.getAccounts();
const alice = accounts.get("wallet_1")!;
const bob = accounts.get("wallet_2")!;
const deployer = accounts.get("deployer")!;
const dex = `${deployer}.mock-dex`;

const mint = (token: string, amount: number, to: string) =>
  simnet.callPublicFn(
    token,
    "mint",
    [Cl.uint(amount), Cl.principal(to)],
    alice,
  );

const balance = (token: string, who: string): bigint => {
  const r = simnet.callReadOnlyFn(
    token,
    "get-balance",
    [Cl.principal(who)],
    alice,
  );
  return BigInt((r.result as ResponseOkCV<UIntCV>).value.value);
};

const setRate = (num: number, den: number) =>
  simnet.callPublicFn(
    "mock-dex",
    "set-rate",
    [Cl.uint(num), Cl.uint(den)],
    alice,
  );

const swap = (amountIn: number, minOut: number) =>
  simnet.callPublicFn(
    "mock-dex",
    "swap",
    [
      Cl.contractPrincipal(deployer, "mock-sbtc"),
      Cl.contractPrincipal(deployer, "mock-usd"),
      Cl.uint(amountIn),
      Cl.uint(minOut),
      Cl.principal(bob),
    ],
    alice,
  );

const snapshot = () => ({
  aliceSbtc: balance("mock-sbtc", alice),
  bobUsd: balance("mock-usd", bob),
  dexSbtc: balance("mock-sbtc", dex),
  dexUsd: balance("mock-usd", dex),
});

describe("mock-dex", () => {
  beforeEach(() => {
    setRate(900, 1);
    mint("mock-sbtc", 1_000_000_000, alice);
    mint("mock-usd", 1_000_000_000_000, dex);
  });

  it("swaps at the set rate and moves the balances", () => {
    const before = snapshot();
    const r = swap(100_000_000, 0);
    expect(r.result).toStrictEqual(Cl.ok(Cl.uint(90_000_000_000)));
    const after = snapshot();
    expect(after.bobUsd - before.bobUsd).toBe(90_000_000_000n);
    expect(after.dexSbtc - before.dexSbtc).toBe(100_000_000n);
    expect(before.dexUsd - after.dexUsd).toBe(90_000_000_000n);
    expect(before.aliceSbtc - after.aliceSbtc).toBe(100_000_000n);
  });

  it("with skim set, returns out but delivers out minus skim", () => {
    const setSkim = (amount: number) =>
      simnet.callPublicFn("mock-dex", "set-skim", [Cl.uint(amount)], alice)
        .result;
    expect(setSkim(7)).toStrictEqual(Cl.ok(Cl.bool(true)));
    const before = snapshot();
    const r = swap(100_000_000, 0);
    expect(setSkim(0)).toStrictEqual(Cl.ok(Cl.bool(true)));
    expect(r.result).toStrictEqual(Cl.ok(Cl.uint(90_000_000_000)));
    const after = snapshot();
    expect(after.bobUsd - before.bobUsd).toBe(89_999_999_993n);
    expect(before.dexUsd - after.dexUsd).toBe(89_999_999_993n);
    expect(after.dexSbtc - before.dexSbtc).toBe(100_000_000n);
  });

  it("refuses when min-out is one above the output and moves nothing", () => {
    const before = snapshot();
    expect(swap(100_000_000, 90_000_000_001).result).toStrictEqual(
      Cl.error(Cl.uint(101)),
    );
    expect(snapshot()).toStrictEqual(before);
  });

  it("refuses when the output exceeds the reserve and moves nothing", () => {
    // Simnet state persists between tests, so size the swap from the live reserve.
    const tooMuch = Number(balance("mock-usd", dex) / 900n) + 1;
    mint("mock-sbtc", tooMuch, alice);
    const before = snapshot();
    expect(swap(tooMuch, 0).result).toStrictEqual(Cl.error(Cl.uint(102)));
    expect(snapshot()).toStrictEqual(before);
  });

  it("refuses a zero amount in", () => {
    expect(swap(0, 0).result).toStrictEqual(Cl.error(Cl.uint(100)));
  });

  it("refuses when the floored output is zero", () => {
    setRate(1, 3);
    expect(swap(2, 0).result).toStrictEqual(Cl.error(Cl.uint(100)));
  });

  it("floors a non-multiple output", () => {
    setRate(1, 3);
    expect(swap(10, 0).result).toStrictEqual(Cl.ok(Cl.uint(3)));
  });

  it("refuses a zero numerator or denominator", () => {
    expect(setRate(0, 1).result).toStrictEqual(Cl.error(Cl.uint(103)));
    expect(setRate(1, 0).result).toStrictEqual(Cl.error(Cl.uint(103)));
  });

  it("returns the rate", () => {
    const r = simnet.callReadOnlyFn("mock-dex", "get-rate", [], alice);
    expect(r.result).toStrictEqual(
      Cl.tuple({ num: Cl.uint(900), den: Cl.uint(1) }),
    );
  });
});
