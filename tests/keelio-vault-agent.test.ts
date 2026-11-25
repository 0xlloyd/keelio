import { initSimnet } from "@stacks/clarinet-sdk";
import { Cl, type ClarityValue } from "@stacks/transactions";
import { beforeAll, describe, expect, it } from "vitest";

const simnet = await initSimnet();
const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const alice = accounts.get("wallet_1")!;
const bob = accounts.get("wallet_2")!;
const mallory = accounts.get("wallet_3")!;
const carol = accounts.get("wallet_4")!;

const token = Cl.contractPrincipal(deployer, "mock-sbtc");
const vault = `${deployer}.keelio-vault`;
const intermediary = `${deployer}.vault-caller`;

// Simnet state persists across the tests in this file, so every test sets the
// vault state it needs at its start and asserts deltas for balances. The
// deployer never writes a vault here, so it stands for an owner with no entry.

type VaultState = { agent: string | null; paused: boolean };

function vaultTuple({ agent, paused }: VaultState) {
  return Cl.tuple({
    agent: agent === null ? Cl.none() : Cl.some(Cl.principal(agent)),
    paused: Cl.bool(paused),
  });
}

function eventTuple(event: string, owner: string, state: VaultState) {
  return Cl.tuple({
    event: Cl.stringAscii(event),
    owner: Cl.principal(owner),
    agent:
      state.agent === null ? Cl.none() : Cl.some(Cl.principal(state.agent)),
    paused: Cl.bool(state.paused),
  });
}

function mint(amount: bigint, recipient: string) {
  const { result } = simnet.callPublicFn(
    "mock-sbtc",
    "mint",
    [Cl.uint(amount), Cl.principal(recipient)],
    recipient,
  );
  expect(result).toStrictEqual(Cl.ok(Cl.bool(true)));
}

function readUint(value: ClarityValue, wrappedInOk: boolean): bigint {
  const inner = wrappedInOk && value.type === "ok" ? value.value : value;
  if (inner.type !== "uint")
    throw new Error(`expected uint, got ${inner.type}`);
  return BigInt(inner.value);
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

function getVault(owner: string) {
  return simnet.callReadOnlyFn(
    "keelio-vault",
    "get-vault",
    [Cl.principal(owner)],
    deployer,
  ).result;
}

function setAgent(sender: string, agent: string) {
  return simnet.callPublicFn(
    "keelio-vault",
    "set-agent",
    [Cl.principal(agent)],
    sender,
  );
}

function removeAgent(sender: string) {
  return simnet.callPublicFn("keelio-vault", "remove-agent", [], sender);
}

function pause(sender: string) {
  return simnet.callPublicFn("keelio-vault", "pause", [], sender);
}

function unpause(sender: string) {
  return simnet.callPublicFn("keelio-vault", "unpause", [], sender);
}

const ok = Cl.ok(Cl.bool(true));

// Criterion 10: every setter call leaves wallets, ledgers and the vault's
// token balance exactly as they were.
function withoutMovingFunds<T>(call: () => T): T {
  const before = snapshot(alice, bob, mallory, intermediary);
  const result = call();
  expect(snapshot(alice, bob, mallory, intermediary)).toStrictEqual(before);
  return result;
}

// Puts `owner`'s vault into `state` through the public setters.
function setState(owner: string, state: VaultState) {
  const agentCall =
    state.agent === null ? removeAgent(owner) : setAgent(owner, state.agent);
  expect(agentCall.result).toStrictEqual(ok);
  const pauseCall = state.paused ? pause(owner) : unpause(owner);
  expect(pauseCall.result).toStrictEqual(ok);
  expect(getVault(owner)).toStrictEqual(vaultTuple(state));
}

describe("keelio-vault agent and kill switch", () => {
  // Criterion 10 needs alice to hold a non-zero ledger balance throughout.
  beforeAll(() => {
    mint(10_000n, alice);
    expect(deposit(alice, 10_000n).result.type).toBe("ok");
    expect(ledger(alice)).toBeGreaterThan(0n);
  });

  // Criterion 1
  it("reads no agent and not paused for an owner with no entry", () => {
    expect(getVault(deployer)).toStrictEqual(
      vaultTuple({ agent: null, paused: false }),
    );
  });

  // Criteria 2, 3, 10
  it("sets an agent, then fully replaces it", () => {
    setState(alice, { agent: null, paused: false });

    const first = withoutMovingFunds(() => setAgent(alice, bob));
    expect(first.result).toStrictEqual(ok);
    expect(getVault(alice)).toStrictEqual(
      vaultTuple({ agent: bob, paused: false }),
    );
    expect(printEvents(first.events)).toStrictEqual([
      eventTuple("set-agent", alice, { agent: bob, paused: false }),
    ]);

    const second = withoutMovingFunds(() => setAgent(alice, mallory));
    expect(second.result).toStrictEqual(ok);
    expect(getVault(alice)).toStrictEqual(
      vaultTuple({ agent: mallory, paused: false }),
    );
    expect(printEvents(second.events)).toStrictEqual([
      eventTuple("set-agent", alice, { agent: mallory, paused: false }),
    ]);

    // Setting the same agent again succeeds.
    const again = withoutMovingFunds(() => setAgent(alice, mallory));
    expect(again.result).toStrictEqual(ok);
    expect(getVault(alice)).toStrictEqual(
      vaultTuple({ agent: mallory, paused: false }),
    );
  });

  // Criteria 4, 10
  it("refuses the owner as its own agent", () => {
    setState(alice, { agent: bob, paused: false });

    const call = withoutMovingFunds(() => setAgent(alice, alice));
    expect(call.result).toStrictEqual(Cl.error(Cl.uint(103)));
    expect(printEvents(call.events)).toStrictEqual([]);
    expect(getVault(alice)).toStrictEqual(
      vaultTuple({ agent: bob, paused: false }),
    );
  });

  // Criteria 5, 10
  it("removes the agent, and removing again succeeds", () => {
    setState(alice, { agent: bob, paused: false });

    const first = withoutMovingFunds(() => removeAgent(alice));
    expect(first.result).toStrictEqual(ok);
    expect(getVault(alice)).toStrictEqual(
      vaultTuple({ agent: null, paused: false }),
    );
    expect(printEvents(first.events)).toStrictEqual([
      eventTuple("remove-agent", alice, { agent: null, paused: false }),
    ]);

    const second = withoutMovingFunds(() => removeAgent(alice));
    expect(second.result).toStrictEqual(ok);
    expect(getVault(alice)).toStrictEqual(
      vaultTuple({ agent: null, paused: false }),
    );
    expect(printEvents(second.events)).toStrictEqual([
      eventTuple("remove-agent", alice, { agent: null, paused: false }),
    ]);
  });

  // Criteria 6, 10
  it("pauses and unpauses, each twice, keeping the agent", () => {
    setState(alice, { agent: bob, paused: false });

    for (let i = 0; i < 2; i++) {
      const call = withoutMovingFunds(() => pause(alice));
      expect(call.result).toStrictEqual(ok);
      expect(getVault(alice)).toStrictEqual(
        vaultTuple({ agent: bob, paused: true }),
      );
      expect(printEvents(call.events)).toStrictEqual([
        eventTuple("pause", alice, { agent: bob, paused: true }),
      ]);
    }

    for (let i = 0; i < 2; i++) {
      const call = withoutMovingFunds(() => unpause(alice));
      expect(call.result).toStrictEqual(ok);
      expect(getVault(alice)).toStrictEqual(
        vaultTuple({ agent: bob, paused: false }),
      );
      expect(printEvents(call.events)).toStrictEqual([
        eventTuple("unpause", alice, { agent: bob, paused: false }),
      ]);
    }
  });

  // Criteria 7, 10
  it("keeps the vault paused across agent changes", () => {
    setState(alice, { agent: null, paused: true });

    const set = withoutMovingFunds(() => setAgent(alice, bob));
    expect(set.result).toStrictEqual(ok);
    expect(getVault(alice)).toStrictEqual(
      vaultTuple({ agent: bob, paused: true }),
    );
    expect(printEvents(set.events)).toStrictEqual([
      eventTuple("set-agent", alice, { agent: bob, paused: true }),
    ]);

    const remove = withoutMovingFunds(() => removeAgent(alice));
    expect(remove.result).toStrictEqual(ok);
    expect(getVault(alice)).toStrictEqual(
      vaultTuple({ agent: null, paused: true }),
    );
    expect(printEvents(remove.events)).toStrictEqual([
      eventTuple("remove-agent", alice, { agent: null, paused: true }),
    ]);
  });

  // Criteria 8, 10
  it("lets a non-owner change only its own vault, never alice's", () => {
    const aliceState = { agent: bob, paused: true };
    setState(alice, aliceState);
    setState(mallory, { agent: null, paused: false });

    const steps: [() => { result: ClarityValue }, VaultState][] = [
      [() => setAgent(mallory, carol), { agent: carol, paused: false }],
      [() => pause(mallory), { agent: carol, paused: true }],
      [() => removeAgent(mallory), { agent: null, paused: true }],
      [() => unpause(mallory), { agent: null, paused: false }],
    ];
    for (const [call, malloryAfter] of steps) {
      expect(withoutMovingFunds(call).result).toStrictEqual(ok);
      expect(getVault(alice)).toStrictEqual(vaultTuple(aliceState));
      expect(getVault(mallory)).toStrictEqual(vaultTuple(malloryAfter));
    }
  });

  // Criteria 9, 10
  it("treats an intermediary contract as the owner, not the signer", () => {
    const aliceState = { agent: bob, paused: false };
    setState(alice, aliceState);
    const via = (fn: string, args: ClarityValue[] = []) =>
      withoutMovingFunds(() =>
        simnet.callPublicFn("vault-caller", fn, args, alice),
      );

    const set = via("set-agent-via", [Cl.principal(bob)]);
    expect(set.result).toStrictEqual(ok);
    expect(printEvents(set.events)).toStrictEqual([
      eventTuple("set-agent", intermediary, { agent: bob, paused: false }),
    ]);
    expect(getVault(alice)).toStrictEqual(vaultTuple(aliceState));
    expect(getVault(intermediary)).toStrictEqual(
      vaultTuple({ agent: bob, paused: false }),
    );

    expect(via("pause-via").result).toStrictEqual(ok);
    expect(getVault(alice)).toStrictEqual(vaultTuple(aliceState));
    expect(getVault(intermediary)).toStrictEqual(
      vaultTuple({ agent: bob, paused: true }),
    );

    expect(via("remove-agent-via").result).toStrictEqual(ok);
    expect(getVault(alice)).toStrictEqual(vaultTuple(aliceState));
    expect(getVault(intermediary)).toStrictEqual(
      vaultTuple({ agent: null, paused: true }),
    );

    expect(via("unpause-via").result).toStrictEqual(ok);
    expect(getVault(alice)).toStrictEqual(vaultTuple(aliceState));
    expect(getVault(intermediary)).toStrictEqual(
      vaultTuple({ agent: null, paused: false }),
    );

    // The signer is not the owner here, so naming alice as agent is allowed,
    // and it sets the contract's agent, not alice's.
    const signerAsAgent = via("set-agent-via", [Cl.principal(alice)]);
    expect(signerAsAgent.result).toStrictEqual(ok);
    expect(getVault(alice)).toStrictEqual(vaultTuple(aliceState));
    expect(getVault(intermediary)).toStrictEqual(
      vaultTuple({ agent: alice, paused: false }),
    );
  });

  // Criterion 11
  it("deposits and withdraws while paused, with and without an agent", () => {
    for (const state of [
      { agent: bob, paused: true },
      { agent: null, paused: true },
    ]) {
      setState(alice, state);
      depositThenWithdraw(alice, 3_000n);
      expect(getVault(alice)).toStrictEqual(vaultTuple(state));
    }
  });

  // Criterion 11
  it("deposits and withdraws for an owner who never set an agent", () => {
    // carol is only ever named as someone else's agent in this file.
    expect(getVault(carol)).toStrictEqual(
      vaultTuple({ agent: null, paused: false }),
    );
    depositThenWithdraw(carol, 2_000n);
    expect(getVault(carol)).toStrictEqual(
      vaultTuple({ agent: null, paused: false }),
    );
  });
});

function depositThenWithdraw(owner: string, amount: bigint) {
  mint(amount, owner);
  const before = snapshot(owner);

  const dep = deposit(owner, amount);
  expect(dep.result).toStrictEqual(Cl.ok(Cl.uint(before.ledgers[0]! + amount)));
  expect(ledger(owner)).toBe(before.ledgers[0]! + amount);
  expect(wallet(owner)).toBe(before.wallets[0]! - amount);
  expect(wallet(vault)).toBe(before.vault + amount);
  expect(printEvents(dep.events)).toStrictEqual([
    Cl.tuple({
      event: Cl.stringAscii("deposit"),
      owner: Cl.principal(owner),
      token,
      amount: Cl.uint(amount),
      balance: Cl.uint(before.ledgers[0]! + amount),
    }),
  ]);

  const wd = withdraw(owner, amount);
  expect(wd.result).toStrictEqual(Cl.ok(Cl.uint(before.ledgers[0]!)));
  expect(snapshot(owner)).toStrictEqual(before);
  expect(printEvents(wd.events)).toStrictEqual([
    Cl.tuple({
      event: Cl.stringAscii("withdraw"),
      owner: Cl.principal(owner),
      token,
      amount: Cl.uint(amount),
      balance: Cl.uint(before.ledgers[0]!),
    }),
  ]);
}
