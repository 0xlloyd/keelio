import { readFileSync } from "node:fs";
import { initSimnet } from "@stacks/clarinet-sdk";
import { Cl, type ClarityValue } from "@stacks/transactions";
import { describe, expect, it } from "vitest";
import { vaultClarityVersion } from "./vault-clarity-version.js";

// These tests deploy variants of the shipped `keelio-vault` source, so they run
// the real `withdraw` code against a token that misbehaves. Each variant is
// made by exact string replacement, and every replacement is asserted to have
// changed the source, so a renamed line fails here instead of turning the
// variant into a silent copy of the real vault.

const simnet = await initSimnet();
const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const alice = accounts.get("wallet_1")!;
const bob = accounts.get("wallet_2")!;

const greedy = Cl.contractPrincipal(deployer, "greedy-sbtc");
const failing = Cl.contractPrincipal(deployer, "failing-sbtc");

const source = readFileSync(
  new URL("../contracts/keelio-vault.clar", import.meta.url),
  "utf8",
);

function replaceOnce(text: string, from: string, to: string): string {
  const changed = text.replace(from, to);
  expect(changed).not.toBe(text);
  return changed;
}

// Same code as keelio-vault, but ALLOWED-TOKEN is the greedy token.
const greedySource = replaceOnce(
  source,
  "(define-constant ALLOWED-TOKEN .mock-sbtc)",
  "(define-constant ALLOWED-TOKEN .greedy-sbtc)",
);
// The control: as above, with the allowance switched off.
const unsafeSource = replaceOnce(
  greedySource,
  "((with-ft ALLOWED-TOKEN ALLOWED-TOKEN-FT sbtc-out) (with-ft QUOTE-TOKEN QUOTE-TOKEN-FT usd-out))",
  "((with-all-assets-unsafe))",
);

// A token whose `transfer` refuses a payout with its own `(err u1)`.
const failingSource = replaceOnce(
  source,
  "(define-constant ALLOWED-TOKEN .mock-sbtc)",
  "(define-constant ALLOWED-TOKEN .failing-sbtc)",
);
// The mutant: `withdraw`'s `try!` and `unwrap!` swapped, so the token's own
// error is mapped to ERR-ALLOWANCE-EXCEEDED.
const swappedSource = replaceOnce(
  replaceOnce(
    failingSource,
    "(try! (contract-call? token transfer amount tx-sender owner none))",
    "(unwrap! (contract-call? token transfer amount tx-sender owner none) ERR-ALLOWANCE-EXCEEDED)",
  ),
  "(unwrap!\n        ;; The asset names",
  "(try!\n        ;; The asset names",
);
const swappedFinal = replaceOnce(
  swappedSource,
  '        )\n        ERR-ALLOWANCE-EXCEEDED\n      )\n      (print {\n        event: "withdraw"',
  '        )\n      )\n      (print {\n        event: "withdraw"',
);

for (const [name, code] of [
  ["vault-greedy", greedySource],
  ["vault-unsafe", unsafeSource],
  ["vault-failing", failingSource],
  ["vault-swapped", swappedFinal],
] as const) {
  const { result } = simnet.deployContract(
    name,
    code,
    { clarityVersion: vaultClarityVersion() },
    deployer,
  );
  expect(result).toStrictEqual(Cl.ok(Cl.bool(true)));
}

function readUint(value: ClarityValue, wrappedInOk: boolean): bigint {
  const inner = wrappedInOk && value.type === "ok" ? value.value : value;
  if (inner.type !== "uint")
    throw new Error(`expected uint, got ${inner.type}`);
  return BigInt(inner.value);
}

function mint(amount: bigint, recipient: string) {
  const { result } = simnet.callPublicFn(
    "greedy-sbtc",
    "mint",
    [Cl.uint(amount), Cl.principal(recipient)],
    recipient,
  );
  expect(result).toStrictEqual(Cl.ok(Cl.bool(true)));
}

function wallet(who: string): bigint {
  const { result } = simnet.callReadOnlyFn(
    "greedy-sbtc",
    "get-balance",
    [Cl.principal(who)],
    deployer,
  );
  return readUint(result, true);
}

function printEvents(events: { event: string; data: unknown }[]) {
  return events
    .filter((e) => e.event === "print_event")
    .map((e) => (e.data as { value: ClarityValue }).value);
}

function vaultUnder(name: "vault-greedy" | "vault-unsafe") {
  const address = `${deployer}.${name}`;
  const ledger = (owner: string) =>
    readUint(
      simnet.callReadOnlyFn(
        name,
        "get-balance",
        [Cl.principal(owner), greedy],
        deployer,
      ).result,
      false,
    );
  return {
    address,
    ledger,
    deposit: (sender: string, amount: bigint) =>
      simnet.callPublicFn(name, "deposit", [greedy, Cl.uint(amount)], sender),
    withdraw: (sender: string, amount: bigint) =>
      simnet.callPublicFn(name, "withdraw", [greedy, Cl.uint(amount)], sender),
    snapshot: () => ({
      vault: wallet(address),
      wallets: [wallet(alice), wallet(bob)],
      ledgers: [ledger(alice), ledger(bob)],
    }),
  };
}

// Alice deposits 100 and Bob deposits 5. The greedy token moves the sender's
// whole balance, so each depositor holds exactly the amount they deposit and
// the deposit is honest.
function openVaults(vault: ReturnType<typeof vaultUnder>) {
  mint(100n - wallet(alice), alice);
  mint(5n - wallet(bob), bob);
  expect(wallet(alice)).toBe(100n);
  expect(wallet(bob)).toBe(5n);
  expect(vault.deposit(alice, 100n).result).toStrictEqual(Cl.ok(Cl.uint(100)));
  expect(vault.deposit(bob, 5n).result).toStrictEqual(Cl.ok(Cl.uint(5)));
  expect(wallet(vault.address)).toBe(105n);
}

describe("keelio-vault withdraw allowance", () => {
  it("refuses a greedy allowed token that moves more than amount", () => {
    const vault = vaultUnder("vault-greedy");
    openVaults(vault);
    const before = vault.snapshot();
    expect(before).toStrictEqual({
      vault: 105n,
      wallets: [0n, 0n],
      ledgers: [100n, 5n],
    });

    // The token is this vault's ALLOWED-TOKEN, the amount is non-zero and
    // Bob's ledger covers it, so u102, u100 and u101 cannot apply. Only the
    // allowance can refuse.
    const wd = vault.withdraw(bob, 1n);
    expect(wd.result).toStrictEqual(Cl.error(Cl.uint(104)));
    expect(printEvents(wd.events)).toStrictEqual([]);
    // Nothing moved, and Bob's ledger debit rolled back.
    expect(vault.snapshot()).toStrictEqual(before);
    expect(vault.ledger(bob)).toBe(5n);
  });

  it("control: the same token drains a vault with no allowance", () => {
    const vault = vaultUnder("vault-unsafe");
    openVaults(vault);
    const before = vault.snapshot();

    const wd = vault.withdraw(bob, 1n);
    expect(wd.result).toStrictEqual(Cl.ok(Cl.uint(4)));
    expect(wallet(vault.address)).toBe(0n);
    expect(wallet(bob)).toBe(before.wallets[1]! + 105n);
    // Alice's ledger still says 100, but the vault holds nothing.
    expect(vault.ledger(alice)).toBe(100n);
  });

  describe("a token's own error", () => {
    const bal = (token: string, who: string) =>
      readUint(
        simnet.callReadOnlyFn(
          token,
          "get-balance",
          [Cl.principal(who)],
          deployer,
        ).result,
        true,
      );
    const ledgerOf = (name: string, who: string) =>
      readUint(
        simnet.callReadOnlyFn(
          name,
          "get-balance",
          [Cl.principal(who), failing],
          deployer,
        ).result,
        false,
      );
    function run(name: "vault-failing" | "vault-swapped") {
      const vault = `${deployer}.${name}`;
      const mintTo = (amount: bigint) =>
        expect(
          simnet.callPublicFn(
            "failing-sbtc",
            "mint",
            [Cl.uint(amount), Cl.principal(alice)],
            alice,
          ).result,
        ).toStrictEqual(Cl.ok(Cl.bool(true)));
      mintTo(50n);
      expect(
        simnet.callPublicFn(name, "deposit", [failing, Cl.uint(50)], alice)
          .result,
      ).toStrictEqual(Cl.ok(Cl.uint(50)));
      const state = () => ({
        ledger: ledgerOf(name, alice),
        vault: bal("failing-sbtc", vault),
        owner: bal("failing-sbtc", alice),
      });
      const before = state();
      expect(before).toStrictEqual({ ledger: 50n, vault: 50n, owner: 0n });
      const wd = simnet.callPublicFn(
        name,
        "withdraw",
        [failing, Cl.uint(10)],
        alice,
      );
      return { wd, before, after: state() };
    }

    it("passes through withdraw unchanged, not as u104", () => {
      const { wd, before, after } = run("vault-failing");
      expect(wd.result).toStrictEqual(Cl.error(Cl.uint(1)));
      expect(printEvents(wd.events)).toStrictEqual([]);
      expect(after).toStrictEqual(before);
    });

    it("control: a vault with try! and unwrap! swapped reports u104", () => {
      const { wd, after, before } = run("vault-swapped");
      expect(wd.result).toStrictEqual(Cl.error(Cl.uint(104)));
      expect(after).toStrictEqual(before);
    });
  });
});
