import { initSimnet } from "@stacks/clarinet-sdk";
import { Cl } from "@stacks/transactions";
import { describe, expect, it } from "vitest";

const simnet = await initSimnet();
const accounts = simnet.getAccounts();
const alice = accounts.get("wallet_1")!;
const bob = accounts.get("wallet_2")!;

describe("mock-sbtc", () => {
  it("mints and transfers like a SIP-010 token", () => {
    const mint = simnet.callPublicFn(
      "mock-sbtc",
      "mint",
      [Cl.uint(100_000_000), Cl.principal(alice)],
      alice,
    );
    expect(mint.result).toStrictEqual(Cl.ok(Cl.bool(true)));

    const transfer = simnet.callPublicFn(
      "mock-sbtc",
      "transfer",
      [Cl.uint(40_000_000), Cl.principal(alice), Cl.principal(bob), Cl.none()],
      alice,
    );
    expect(transfer.result).toStrictEqual(Cl.ok(Cl.bool(true)));

    const balance = simnet.callReadOnlyFn(
      "mock-sbtc",
      "get-balance",
      [Cl.principal(bob)],
      bob,
    );
    expect(balance.result).toStrictEqual(Cl.ok(Cl.uint(40_000_000)));
  });

  it("refuses a transfer sent by someone other than the owner", () => {
    simnet.callPublicFn(
      "mock-sbtc",
      "mint",
      [Cl.uint(1_000), Cl.principal(alice)],
      alice,
    );
    const theft = simnet.callPublicFn(
      "mock-sbtc",
      "transfer",
      [Cl.uint(1_000), Cl.principal(alice), Cl.principal(bob), Cl.none()],
      bob,
    );
    expect(theft.result).toStrictEqual(Cl.error(Cl.uint(4)));
  });
});
