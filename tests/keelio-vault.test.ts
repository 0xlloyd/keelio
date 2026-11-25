import { initSimnet } from "@stacks/clarinet-sdk";
import { Cl, type ClarityValue } from "@stacks/transactions";
import { describe, expect, it } from "vitest";

const simnet = await initSimnet();
const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const alice = accounts.get("wallet_1")!;
const bob = accounts.get("wallet_2")!;
const mallory = accounts.get("wallet_3")!;
const carol = accounts.get("wallet_4")!;

const token = Cl.contractPrincipal(deployer, "mock-sbtc");
const vault = `${deployer}.keelio-vault`;

// The deployer never deposits in this file, so it stands for an owner who
// never opened a vault.
const neverDeposited = deployer;

// Simnet state persists across the tests in this file, so every test mints
// what it needs and asserts deltas rather than absolute balances.

function mint(amount: bigint, recipient: string) {
  const { result } = simnet.callPublicFn(
    "mock-sbtc",
    "mint",
    [Cl.uint(amount), Cl.principal(recipient)],
    recipient,
  );
  expect(result).toStrictEqual(Cl.ok(Cl.bool(true)));
}

function wallet(who: string): bigint {
  const { result } = simnet.callReadOnlyFn(
    "mock-sbtc",
    "get-balance",
    [Cl.principal(who)],
    deployer,
  );
  return readUint(result, true);
}

function ledger(owner: string): bigint {
  const { result } = simnet.callReadOnlyFn(
    "keelio-vault",
    "get-balance",
    [Cl.principal(owner), token],
    deployer,
  );
  return readUint(result, false);
}

function readUint(value: ClarityValue, wrappedInOk: boolean): bigint {
  const inner = wrappedInOk && value.type === "ok" ? value.value : value;
  if (inner.type !== "uint")
    throw new Error(`expected uint, got ${inner.type}`);
  return BigInt(inner.value);
}

function deposit(sender: string, amount: bigint) {
  return simnet.callPublicFn(
    "keelio-vault",
    "deposit",
    [token, Cl.uint(amount)],
    sender,
  );
}

function withdraw(sender: string, amount: bigint) {
  return simnet.callPublicFn(
    "keelio-vault",
    "withdraw",
    [token, Cl.uint(amount)],
    sender,
  );
}

function printEvents(events: { event: string; data: unknown }[]) {
  return events
    .filter((e) => e.event === "print_event")
    .map((e) => (e.data as { value: ClarityValue }).value);
}

function snapshot(...who: string[]) {
  return {
    wallets: who.map(wallet),
    ledgers: who.map(ledger),
    vault: wallet(vault),
  };
}

describe("keelio-vault", () => {
  it("deposits, then withdraws in full", () => {
    const amount = 100_000_000n;
    mint(amount, alice);
    const before = snapshot(alice);

    const dep = deposit(alice, amount);
    expect(dep.result).toStrictEqual(
      Cl.ok(Cl.uint(before.ledgers[0]! + amount)),
    );
    expect(ledger(alice)).toBe(before.ledgers[0]! + amount);
    expect(wallet(alice)).toBe(before.wallets[0]! - amount);
    expect(wallet(vault)).toBe(before.vault + amount);
    expect(printEvents(dep.events)).toStrictEqual([
      Cl.tuple({
        event: Cl.stringAscii("deposit"),
        owner: Cl.principal(alice),
        token,
        amount: Cl.uint(amount),
        balance: Cl.uint(before.ledgers[0]! + amount),
      }),
    ]);

    const wd = withdraw(alice, amount);
    expect(wd.result).toStrictEqual(Cl.ok(Cl.uint(before.ledgers[0]!)));
    expect(snapshot(alice)).toStrictEqual(before);
    expect(printEvents(wd.events)).toStrictEqual([
      Cl.tuple({
        event: Cl.stringAscii("withdraw"),
        owner: Cl.principal(alice),
        token,
        amount: Cl.uint(amount),
        balance: Cl.uint(before.ledgers[0]!),
      }),
    ]);
  });

  it("withdraws part of a deposit", () => {
    const amount = 50_000_000n;
    const part = 20_000_000n;
    mint(amount, alice);
    const startLedger = ledger(alice);
    expect(deposit(alice, amount).result).toStrictEqual(
      Cl.ok(Cl.uint(startLedger + amount)),
    );
    const walletBefore = wallet(alice);
    const vaultBefore = wallet(vault);

    const wd = withdraw(alice, part);
    expect(wd.result).toStrictEqual(
      Cl.ok(Cl.uint(startLedger + amount - part)),
    );
    expect(ledger(alice)).toBe(startLedger + amount - part);
    expect(wallet(alice)).toBe(walletBefore + part);
    expect(wallet(vault)).toBe(vaultBefore - part);
  });

  it("keeps each owner's ledger separate", () => {
    const aliceAmount = 7_000n;
    const bobAmount = 3_000n;
    mint(aliceAmount, alice);
    mint(bobAmount, bob);
    const aliceStart = ledger(alice);
    const bobStart = ledger(bob);

    expect(deposit(alice, aliceAmount).result).toStrictEqual(
      Cl.ok(Cl.uint(aliceStart + aliceAmount)),
    );
    expect(deposit(bob, bobAmount).result).toStrictEqual(
      Cl.ok(Cl.uint(bobStart + bobAmount)),
    );
    expect(ledger(alice)).toBe(aliceStart + aliceAmount);
    expect(ledger(bob)).toBe(bobStart + bobAmount);

    const bobWallet = wallet(bob);
    expect(withdraw(bob, bobStart + bobAmount).result).toStrictEqual(
      Cl.ok(Cl.uint(0n)),
    );
    expect(ledger(bob)).toBe(0n);
    expect(wallet(bob)).toBe(bobWallet + bobStart + bobAmount);
    expect(ledger(alice)).toBe(aliceStart + aliceAmount);
  });

  it("refuses a withdrawal above the ledger balance", () => {
    mint(5_000n, alice);
    deposit(alice, 5_000n);
    const before = snapshot(alice);

    const wd = withdraw(alice, before.ledgers[0]! + 1n);
    expect(wd.result).toStrictEqual(Cl.error(Cl.uint(101)));
    expect(printEvents(wd.events)).toStrictEqual([]);
    expect(snapshot(alice)).toStrictEqual(before);
  });

  it("refuses a withdrawal by a third party with no ledger", () => {
    mint(9_000n, alice);
    deposit(alice, 9_000n);
    expect(ledger(alice)).toBeGreaterThan(0n);
    expect(ledger(mallory)).toBe(0n);
    const before = snapshot(alice, mallory);

    for (const amount of [1n, 9_000n, before.ledgers[0]!]) {
      const wd = withdraw(mallory, amount);
      expect(wd.result).toStrictEqual(Cl.error(Cl.uint(101)));
    }
    expect(snapshot(alice, mallory)).toStrictEqual(before);
  });

  it("refuses zero amounts on deposit and withdraw", () => {
    mint(1_000n, alice);
    deposit(alice, 1_000n);
    const before = snapshot(alice);

    expect(deposit(alice, 0n).result).toStrictEqual(Cl.error(Cl.uint(100)));
    expect(withdraw(alice, 0n).result).toStrictEqual(Cl.error(Cl.uint(100)));
    expect(snapshot(alice)).toStrictEqual(before);
  });

  it("refuses a deposit above the wallet balance with the token's error", () => {
    mint(2_000n, carol);
    const before = snapshot(carol);

    const dep = deposit(carol, before.wallets[0]! + 1n);
    expect(dep.result).toStrictEqual(Cl.error(Cl.uint(1)));
    expect(snapshot(carol)).toStrictEqual(before);
  });

  it("reads zero for an owner who never deposited", () => {
    const { result } = simnet.callReadOnlyFn(
      "keelio-vault",
      "get-balance",
      [Cl.principal(neverDeposited), token],
      neverDeposited,
    );
    expect(result).toStrictEqual(Cl.uint(0n));
  });

  it("holds exactly the sum of all ledgers after mixed calls", () => {
    mint(10_000n, alice);
    mint(10_000n, bob);

    const ledgerSum = () => {
      let sum = 0n;
      for (const address of accounts.values()) sum += ledger(address);
      return sum;
    };
    const step = (call: () => ClarityValue, expected: "ok" | ClarityValue) => {
      const result = call();
      if (expected === "ok") expect(result.type).toBe("ok");
      else expect(result).toStrictEqual(expected);
      expect(wallet(vault)).toBe(ledgerSum());
      const total = simnet.callReadOnlyFn(
        "keelio-vault",
        "get-ledger-total",
        [token],
        deployer,
      ).result;
      expect(readUint(total, false)).toBe(ledgerSum());
    };

    step(() => deposit(alice, 4_000n).result, "ok");
    step(() => deposit(bob, 6_000n).result, "ok");
    step(() => withdraw(alice, 1_500n).result, "ok");
    step(() => deposit(alice, 2_500n).result, "ok");
    step(() => withdraw(bob, ledger(bob) + 1n).result, Cl.error(Cl.uint(101)));
    step(() => withdraw(bob, 2_000n).result, "ok");
    step(() => deposit(bob, 1_000n).result, "ok");
    expect(ledgerSum()).toBeGreaterThan(0n);
  });

  it("refuses a token outside the allow-list, so it cannot drain the vault", () => {
    const evil = Cl.contractPrincipal(deployer, "evil-token");
    const thief = mallory;
    expect(
      simnet.callPublicFn(
        "evil-token",
        "set-thief",
        [Cl.principal(thief)],
        thief,
      ).result,
    ).toStrictEqual(Cl.ok(Cl.bool(true)));
    mint(100_000_000n, alice);
    deposit(alice, 100_000_000n);
    const before = snapshot(alice, thief);
    expect(before.vault).toBeGreaterThanOrEqual(100_000_000n);

    const dep = simnet.callPublicFn(
      "keelio-vault",
      "deposit",
      [evil, Cl.uint(1n)],
      thief,
    );
    expect(dep.result).toStrictEqual(Cl.error(Cl.uint(102)));
    const wd = simnet.callPublicFn(
      "keelio-vault",
      "withdraw",
      [evil, Cl.uint(1n)],
      thief,
    );
    expect(wd.result).toStrictEqual(Cl.error(Cl.uint(102)));
    expect(snapshot(alice, thief)).toStrictEqual(before);

    expect(withdraw(alice, before.ledgers[0]!).result).toStrictEqual(
      Cl.ok(Cl.uint(0n)),
    );
    expect(wallet(alice)).toBe(before.wallets[0]! + before.ledgers[0]!);
  });

  it("debits only an intermediary contract's own ledger when it calls withdraw", () => {
    const intermediary = `${deployer}.vault-caller`;
    mint(4_000n, alice);
    deposit(alice, 4_000n);
    const before = snapshot(alice, intermediary);
    expect(before.ledgers[0]!).toBeGreaterThanOrEqual(4_000n);
    expect(before.ledgers[1]!).toBe(0n);

    // alice signs, but the vault sees `vault-caller` as contract-caller.
    const wd = simnet.callPublicFn(
      "vault-caller",
      "withdraw-via",
      [token, Cl.uint(1_000n)],
      alice,
    );
    expect(wd.result).toStrictEqual(Cl.error(Cl.uint(101)));
    expect(snapshot(alice, intermediary)).toStrictEqual(before);
  });

  it("binds a deposit to contract-caller, never tx-sender", () => {
    const intermediary = `${deployer}.vault-caller`;
    mint(4_000n, alice);
    const before = snapshot(alice, intermediary);

    // alice signs, but the vault sees `vault-caller` as the owner, so it asks
    // the token to move vault-caller's funds. The token refuses with its own
    // u4, because alice is not the sender. A vault that took `tx-sender` as the
    // owner would pull alice's tokens and credit them to alice instead.
    const dep = simnet.callPublicFn(
      "vault-caller",
      "deposit-via",
      [token, Cl.uint(1_000n)],
      alice,
    );
    expect(dep.result).toStrictEqual(Cl.error(Cl.uint(4)));
    expect(printEvents(dep.events)).toStrictEqual([]);
    // Nobody is credited and no wallet moved.
    expect(snapshot(alice, intermediary)).toStrictEqual(before);
  });
});

describe("keelio-vault journal: refused calls print nothing", () => {
  const evil = Cl.contractPrincipal(deployer, "evil-token");
  const call = (fn: "deposit" | "withdraw", t: ClarityValue, amount: bigint) =>
    simnet.callPublicFn("keelio-vault", fn, [t, Cl.uint(amount)], carol);

  it("deposit prints nothing for a zero amount", () => {
    const dep = deposit(carol, 0n);
    expect(dep.result).toStrictEqual(Cl.error(Cl.uint(100)));
    expect(printEvents(dep.events)).toStrictEqual([]);
  });

  it("deposit prints nothing for a token outside the fixed set", () => {
    const dep = call("deposit", evil, 1n);
    expect(dep.result).toStrictEqual(Cl.error(Cl.uint(102)));
    expect(printEvents(dep.events)).toStrictEqual([]);
  });

  it("deposit prints nothing above the wallet balance", () => {
    const dep = deposit(carol, wallet(carol) + 1n);
    expect(dep.result).toStrictEqual(Cl.error(Cl.uint(1)));
    expect(printEvents(dep.events)).toStrictEqual([]);
  });

  it("withdraw prints nothing for a zero amount", () => {
    const wd = withdraw(carol, 0n);
    expect(wd.result).toStrictEqual(Cl.error(Cl.uint(100)));
    expect(printEvents(wd.events)).toStrictEqual([]);
  });

  it("withdraw prints nothing for a token outside the fixed set", () => {
    const wd = call("withdraw", evil, 1n);
    expect(wd.result).toStrictEqual(Cl.error(Cl.uint(102)));
    expect(printEvents(wd.events)).toStrictEqual([]);
  });
});
