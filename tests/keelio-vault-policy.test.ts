import { initSimnet } from "@stacks/clarinet-sdk";
import { Cl, type ClarityValue } from "@stacks/transactions";
import { beforeAll, describe, expect, it } from "vitest";

const simnet = await initSimnet();
const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const alice = accounts.get("wallet_1")!;
const bob = accounts.get("wallet_2")!;
const mallory = accounts.get("wallet_3")!;

const sbtc = `${deployer}.mock-sbtc`;
const usd = `${deployer}.mock-usd`;
const dex = `${deployer}.mock-dex`;
const evil = `${deployer}.evil-token`;
const vault = `${deployer}.keelio-vault`;
const intermediary = `${deployer}.vault-caller`;

const MAX_UINT = 340282366920938463463374607431768211455n;

// Simnet state persists across the tests in this file, so every test sets the
// state it needs at its start. The deployer never writes a policy or list
// here, so it stands for an owner with no entry.

// What `get-policy (owner, token)` reads: one token's caps with the owner's
// cooldown and expiry.
type Policy = {
  maxPerTrade: bigint;
  maxPerDay: bigint;
  cooldownBlocks: bigint;
  expiresAt: bigint;
};

const policy = (
  maxPerTrade: bigint,
  maxPerDay: bigint,
  cooldownBlocks: bigint,
  expiresAt: bigint,
): Policy => ({ maxPerTrade, maxPerDay, cooldownBlocks, expiresAt });

function policyTuple(p: Policy) {
  return Cl.tuple({
    "max-per-trade": Cl.uint(p.maxPerTrade),
    "max-per-day": Cl.uint(p.maxPerDay),
    "cooldown-blocks": Cl.uint(p.cooldownBlocks),
    "expires-at": Cl.uint(p.expiresAt),
  });
}

function mint(contract: string, amount: bigint, recipient: string) {
  const { result } = simnet.callPublicFn(
    contract,
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

function wallet(contract: string, who: string): bigint {
  const { result } = simnet.callReadOnlyFn(
    contract,
    "get-balance",
    [Cl.principal(who)],
    deployer,
  );
  return readUint(result, true);
}

function ledger(owner: string, token: string): bigint {
  const { result } = simnet.callReadOnlyFn(
    "keelio-vault",
    "get-balance",
    [Cl.principal(owner), Cl.principal(token)],
    deployer,
  );
  return readUint(result, false);
}

function deposit(sender: string, token: string, amount: bigint) {
  return simnet.callPublicFn(
    "keelio-vault",
    "deposit",
    [Cl.principal(token), Cl.uint(amount)],
    sender,
  );
}

function withdraw(sender: string, token: string, amount: bigint) {
  return simnet.callPublicFn(
    "keelio-vault",
    "withdraw",
    [Cl.principal(token), Cl.uint(amount)],
    sender,
  );
}

function printEvents(events: { event: string; data: unknown }[]) {
  return events
    .filter((e) => e.event === "print_event")
    .map((e) => (e.data as { value: ClarityValue }).value);
}

function getVault(owner: string) {
  return simnet.callReadOnlyFn(
    "keelio-vault",
    "get-vault",
    [Cl.principal(owner)],
    deployer,
  ).result;
}

const everyone = [alice, bob, mallory, intermediary];

// Criterion 10: wallets and ledgers of both fixed-set tokens, the vault's
// token balances, and every vault entry (agent, paused).
function snapshot() {
  return {
    wallets: [sbtc, usd].map((t) => everyone.map((w) => wallet(t, w))),
    ledgers: [sbtc, usd].map((t) => everyone.map((w) => ledger(w, t))),
    vault: [sbtc, usd].map((t) => wallet(t, vault)),
    vaults: everyone.map(getVault),
  };
}

function withoutMovingFunds<T>(call: () => T): T {
  const before = snapshot();
  const result = call();
  expect(snapshot()).toStrictEqual(before);
  return result;
}

type Call = ReturnType<typeof simnet.callPublicFn>;

function setPolicy(
  sender: string,
  cooldownBlocks: bigint,
  expiresAt: bigint,
): Call {
  return withoutMovingFunds(() =>
    simnet.callPublicFn(
      "keelio-vault",
      "set-policy",
      [Cl.uint(cooldownBlocks), Cl.uint(expiresAt)],
      sender,
    ),
  );
}

function setTokenCaps(
  sender: string,
  token: string,
  maxPerTrade: bigint,
  maxPerDay: bigint,
): Call {
  return withoutMovingFunds(() =>
    simnet.callPublicFn(
      "keelio-vault",
      "set-token-caps",
      [Cl.principal(token), Cl.uint(maxPerTrade), Cl.uint(maxPerDay)],
      sender,
    ),
  );
}

function allowToken(sender: string, token: string, allowed: boolean): Call {
  return withoutMovingFunds(() =>
    simnet.callPublicFn(
      "keelio-vault",
      "allow-token",
      [Cl.principal(token), Cl.bool(allowed)],
      sender,
    ),
  );
}

function allowAdapter(sender: string, adapter: string, allowed: boolean): Call {
  return withoutMovingFunds(() =>
    simnet.callPublicFn(
      "keelio-vault",
      "allow-adapter",
      [Cl.principal(adapter), Cl.bool(allowed)],
      sender,
    ),
  );
}

function via(fn: string, args: ClarityValue[]): Call {
  return withoutMovingFunds(() =>
    simnet.callPublicFn("vault-caller", fn, args, alice),
  );
}

function getPolicy(owner: string, token: string = sbtc) {
  return simnet.callReadOnlyFn(
    "keelio-vault",
    "get-policy",
    [Cl.principal(owner), Cl.principal(token)],
    deployer,
  ).result;
}

function isTokenAllowed(owner: string, token: string) {
  return simnet.callReadOnlyFn(
    "keelio-vault",
    "is-token-allowed",
    [Cl.principal(owner), Cl.principal(token)],
    deployer,
  ).result;
}

function isAdapterAllowed(owner: string, adapter: string) {
  return simnet.callReadOnlyFn(
    "keelio-vault",
    "is-adapter-allowed",
    [Cl.principal(owner), Cl.principal(adapter)],
    deployer,
  ).result;
}

function policyEvent(owner: string, cooldownBlocks: bigint, expiresAt: bigint) {
  return Cl.tuple({
    event: Cl.stringAscii("set-policy"),
    owner: Cl.principal(owner),
    "cooldown-blocks": Cl.uint(cooldownBlocks),
    "expires-at": Cl.uint(expiresAt),
  });
}

function capsEvent(
  owner: string,
  token: string,
  maxPerTrade: bigint,
  maxPerDay: bigint,
) {
  return Cl.tuple({
    event: Cl.stringAscii("set-token-caps"),
    owner: Cl.principal(owner),
    token: Cl.principal(token),
    "max-per-trade": Cl.uint(maxPerTrade),
    "max-per-day": Cl.uint(maxPerDay),
  });
}

function tokenEvent(owner: string, token: string, allowed: boolean) {
  return Cl.tuple({
    event: Cl.stringAscii("allow-token"),
    owner: Cl.principal(owner),
    token: Cl.principal(token),
    allowed: Cl.bool(allowed),
  });
}

function adapterEvent(owner: string, adapter: string, allowed: boolean) {
  return Cl.tuple({
    event: Cl.stringAscii("allow-adapter"),
    owner: Cl.principal(owner),
    adapter: Cl.principal(adapter),
    allowed: Cl.bool(allowed),
  });
}

const ok = Cl.ok(Cl.bool(true));
const yes = Cl.bool(true);
const no = Cl.bool(false);
const zero = policy(0n, 0n, 0n, 0n);

// Sets `owner`'s cooldown and expiry and checks the call succeeded with its
// one event.
function expectPolicySet(
  owner: string,
  cooldownBlocks: bigint,
  expiresAt: bigint,
) {
  const call = setPolicy(owner, cooldownBlocks, expiresAt);
  expect(call.result).toStrictEqual(ok);
  expect(printEvents(call.events)).toStrictEqual([
    policyEvent(owner, cooldownBlocks, expiresAt),
  ]);
}

// Sets `owner`'s caps for `token` and the cooldown and expiry, then checks
// `get-policy` reads all four.
function expectFullPolicySet(owner: string, token: string, p: Policy) {
  expectCapsSet(owner, token, p.maxPerTrade, p.maxPerDay);
  expectPolicySet(owner, p.cooldownBlocks, p.expiresAt);
  expect(getPolicy(owner, token)).toStrictEqual(policyTuple(p));
}

// Sets `owner`'s caps for `token` and checks the call succeeded with its one
// event.
function expectCapsSet(
  owner: string,
  token: string,
  maxPerTrade: bigint,
  maxPerDay: bigint,
) {
  const call = setTokenCaps(owner, token, maxPerTrade, maxPerDay);
  expect(call.result).toStrictEqual(ok);
  expect(printEvents(call.events)).toStrictEqual([
    capsEvent(owner, token, maxPerTrade, maxPerDay),
  ]);
}

function expectToken(owner: string, token: string, allowed: boolean) {
  const call = allowToken(owner, token, allowed);
  expect(call.result).toStrictEqual(ok);
  expect(printEvents(call.events)).toStrictEqual([
    tokenEvent(owner, token, allowed),
  ]);
}

function expectAdapter(owner: string, adapter: string, allowed: boolean) {
  const call = allowAdapter(owner, adapter, allowed);
  expect(call.result).toStrictEqual(ok);
  expect(printEvents(call.events)).toStrictEqual([
    adapterEvent(owner, adapter, allowed),
  ]);
}

describe("keelio-vault trading policy", () => {
  // Criterion 10 needs alice to hold a non-zero ledger balance and an agent.
  beforeAll(() => {
    mint("mock-sbtc", 10_000n, alice);
    expect(deposit(alice, sbtc, 10_000n).result.type).toBe("ok");
    expect(ledger(alice, sbtc)).toBeGreaterThan(0n);
    expect(
      simnet.callPublicFn(
        "keelio-vault",
        "set-agent",
        [Cl.principal(bob)],
        alice,
      ).result,
    ).toStrictEqual(ok);
    expect(getVault(alice)).toStrictEqual(
      Cl.tuple({ agent: Cl.some(Cl.principal(bob)), paused: Cl.bool(false) }),
    );
  });

  // Criterion 1
  it("reads a zero policy and empty lists for an owner with no entry", () => {
    expect(getPolicy(deployer)).toStrictEqual(policyTuple(zero));
    expect(isTokenAllowed(deployer, sbtc)).toStrictEqual(no);
    expect(isTokenAllowed(deployer, usd)).toStrictEqual(no);
    expect(isAdapterAllowed(deployer, dex)).toStrictEqual(no);
  });

  // Criteria 2, 3, 10
  it("sets each field, then replaces the whole policy", () => {
    expectFullPolicySet(alice, sbtc, policy(100n, 500n, 6n, 1000n));
    expectFullPolicySet(alice, sbtc, policy(7n, 7n, 0n, 2n));
  });

  // Criteria 4, 10
  it("refuses max-per-day below max-per-trade, changing nothing", () => {
    const known = policy(1n, 2n, 3n, 4n);
    expectFullPolicySet(alice, sbtc, known);

    const call = setTokenCaps(alice, sbtc, 10n, 9n);
    expect(call.result).toStrictEqual(Cl.error(Cl.uint(105)));
    expect(printEvents(call.events)).toStrictEqual([]);
    expect(getPolicy(alice)).toStrictEqual(policyTuple(known));
  });

  // Criteria 4, 10
  it("accepts zeros, equal caps, max-uint and a past expiry", () => {
    expect(simnet.burnBlockHeight).toBeGreaterThan(0);
    const pastExpiry = BigInt(simnet.burnBlockHeight) - 1n;
    for (const p of [
      zero,
      policy(0n, 5n, 0n, 0n),
      policy(5n, 5n, 0n, 0n),
      policy(MAX_UINT, MAX_UINT, MAX_UINT, MAX_UINT),
      policy(1n, 2n, 3n, pastExpiry),
    ]) {
      expectFullPolicySet(alice, sbtc, p);
    }
  });

  // Job 026, criterion 3: set-policy has no refusal path.
  it("set-policy accepts zeros, max-uint and a past expiry", () => {
    expectCapsSet(alice, sbtc, 10n, 20n);
    expectCapsSet(alice, usd, 1000n, 3000n);
    expect(simnet.burnBlockHeight).toBeGreaterThan(0);
    const pastExpiry = BigInt(simnet.burnBlockHeight) - 1n;
    for (const [cooldown, expiresAt] of [
      [0n, 0n],
      [MAX_UINT, MAX_UINT],
      [0n, pastExpiry],
    ] as const) {
      expectPolicySet(alice, cooldown, expiresAt);
      expect(getPolicy(alice, sbtc)).toStrictEqual(
        policyTuple(policy(10n, 20n, cooldown, expiresAt)),
      );
      expect(getPolicy(alice, usd)).toStrictEqual(
        policyTuple(policy(1000n, 3000n, cooldown, expiresAt)),
      );
    }
  });

  // Per-token caps (job 015, criterion 6; job 026)
  describe("caps per token", () => {
    // Caps of one token; the owner-wide fields are whatever `shared` holds.
    const caps = (owner: string, token: string) => {
      const value = getPolicy(owner, token);
      if (value.type !== "tuple") throw new Error("expected a tuple");
      return {
        trade: value.value["max-per-trade"],
        day: value.value["max-per-day"],
      };
    };
    // Both tokens' full reads (caps, cooldown, expiry) for `owner`.
    const both = (owner: string) => [
      getPolicy(owner, sbtc),
      getPolicy(owner, usd),
    ];

    it("reads u0 caps for a token never set, and for one outside the set", () => {
      const fresh = accounts.get("wallet_4")!;
      // Job 026, criterion 2: set-policy with no caps ever set leaves both
      // tokens' caps at u0.
      expectPolicySet(fresh, 5n, 6n);
      for (const token of [sbtc, usd]) {
        expect(getPolicy(fresh, token)).toStrictEqual(
          policyTuple(policy(0n, 0n, 5n, 6n)),
        );
      }
      expectFullPolicySet(fresh, sbtc, policy(3n, 4n, 5n, 6n));
      // USD was never set: its caps are u0, the owner-wide fields are shared.
      expect(getPolicy(fresh, usd)).toStrictEqual(
        policyTuple(policy(0n, 0n, 5n, 6n)),
      );
      expect(getPolicy(fresh, evil)).toStrictEqual(
        policyTuple(policy(0n, 0n, 5n, 6n)),
      );
    });

    // Job 026, criterion 1
    it("set-token-caps leaves the cooldown, the expiry and the other token's caps alone", () => {
      expectPolicySet(alice, 2n, 200n);
      expectCapsSet(alice, sbtc, 10n, 20n);
      expectCapsSet(alice, usd, 1000n, 3000n);
      expectCapsSet(alice, sbtc, 5n, 50n);
      expect(getPolicy(alice, sbtc)).toStrictEqual(
        policyTuple(policy(5n, 50n, 2n, 200n)),
      );
      expect(getPolicy(alice, usd)).toStrictEqual(
        policyTuple(policy(1000n, 3000n, 2n, 200n)),
      );
    });

    // Job 026, criterion 2
    it("set-policy leaves every token's caps alone", () => {
      expectPolicySet(alice, 2n, 200n);
      expectCapsSet(alice, sbtc, 5n, 50n);
      expectCapsSet(alice, usd, 1000n, 3000n);
      expectPolicySet(alice, 7n, 999n);
      expect(getPolicy(alice, sbtc)).toStrictEqual(
        policyTuple(policy(5n, 50n, 7n, 999n)),
      );
      expect(getPolicy(alice, usd)).toStrictEqual(
        policyTuple(policy(1000n, 3000n, 7n, 999n)),
      );
    });

    // Job 026, criterion 4
    it("refuses a token outside the fixed set with u106, writing nothing", () => {
      expectCapsSet(alice, sbtc, 10n, 20n);
      expectCapsSet(alice, usd, 1000n, 3000n);
      expectPolicySet(alice, 1n, 100n);
      const before = both(alice);
      for (const token of [evil, dex, bob]) {
        const call = setTokenCaps(alice, token, 5n, 50n);
        expect(call.result).toStrictEqual(Cl.error(Cl.uint(106)));
        expect(printEvents(call.events)).toStrictEqual([]);
        expect(getPolicy(alice, token)).toStrictEqual(
          policyTuple(policy(0n, 0n, 1n, 100n)),
        );
        expect(both(alice)).toStrictEqual(before);
      }
      expect(both(alice)).toStrictEqual(before);
    });

    // Job 026, criterion 5
    it("refuses max-per-day below max-per-trade on one token, leaving the other", () => {
      expectCapsSet(alice, sbtc, 10n, 20n);
      expectCapsSet(alice, usd, 1000n, 3000n);
      expectPolicySet(alice, 1n, 100n);
      const before = both(alice);

      for (const token of [sbtc, usd]) {
        // Smaller than the other token's caps, larger day than trade fails.
        const call = setTokenCaps(alice, token, 9n, 8n);
        expect(call.result).toStrictEqual(Cl.error(Cl.uint(105)));
        expect(printEvents(call.events)).toStrictEqual([]);
        expect(both(alice)).toStrictEqual(before);
      }
      expect(caps(alice, sbtc)).toStrictEqual({
        trade: Cl.uint(10n),
        day: Cl.uint(20n),
      });
      expect(caps(alice, usd)).toStrictEqual({
        trade: Cl.uint(1000n),
        day: Cl.uint(3000n),
      });
    });

    // Job 026, criterion 5
    it("gives u106 precedence when both checks fail", () => {
      const before = both(alice);
      const call = setTokenCaps(alice, evil, 9n, 8n);
      expect(call.result).toStrictEqual(Cl.error(Cl.uint(106)));
      expect(printEvents(call.events)).toStrictEqual([]);
      expect(both(alice)).toStrictEqual(before);
    });
  });

  // Criteria 5, 10
  it("allows and revokes each accepted token on its own", () => {
    expectToken(alice, sbtc, false);
    expectToken(alice, usd, false);

    expectToken(alice, sbtc, true);
    expect(isTokenAllowed(alice, sbtc)).toStrictEqual(yes);
    expect(isTokenAllowed(alice, usd)).toStrictEqual(no);

    expectToken(alice, usd, true);
    expect(isTokenAllowed(alice, usd)).toStrictEqual(yes);

    expectToken(alice, sbtc, false);
    expect(isTokenAllowed(alice, sbtc)).toStrictEqual(no);
    expect(isTokenAllowed(alice, usd)).toStrictEqual(yes);

    // Repeating a call succeeds and keeps the value.
    expectToken(alice, usd, true);
    expect(isTokenAllowed(alice, usd)).toStrictEqual(yes);
    expectToken(alice, sbtc, false);
    expect(isTokenAllowed(alice, sbtc)).toStrictEqual(no);

    // Revoking a token bob never allowed succeeds.
    expectToken(bob, usd, false);
    expect(isTokenAllowed(bob, usd)).toStrictEqual(no);
  });

  // Criteria 6, 10
  it("refuses a token outside the fixed set, allowed or not", () => {
    expectToken(alice, sbtc, true);
    expectToken(alice, usd, true);

    for (const token of [evil, dex, bob]) {
      for (const allowed of [true, false]) {
        const call = allowToken(alice, token, allowed);
        expect(call.result).toStrictEqual(Cl.error(Cl.uint(106)));
        expect(printEvents(call.events)).toStrictEqual([]);
        expect(isTokenAllowed(alice, token)).toStrictEqual(no);
      }
    }
    expect(isTokenAllowed(alice, evil)).toStrictEqual(no);
    expect(isTokenAllowed(alice, sbtc)).toStrictEqual(yes);
    expect(isTokenAllowed(alice, usd)).toStrictEqual(yes);
  });

  // Criteria 7, 10
  it("allows and revokes the accepted adapter", () => {
    expectAdapter(alice, dex, false);
    expect(isAdapterAllowed(alice, dex)).toStrictEqual(no);

    expectAdapter(alice, dex, true);
    expect(isAdapterAllowed(alice, dex)).toStrictEqual(yes);
    expectAdapter(alice, dex, true);
    expect(isAdapterAllowed(alice, dex)).toStrictEqual(yes);

    expectAdapter(alice, dex, false);
    expect(isAdapterAllowed(alice, dex)).toStrictEqual(no);
    expectAdapter(alice, dex, false);
    expect(isAdapterAllowed(alice, dex)).toStrictEqual(no);

    // Revoking an adapter bob never allowed succeeds.
    expectAdapter(bob, dex, false);
    expect(isAdapterAllowed(bob, dex)).toStrictEqual(no);
  });

  // Criteria 8, 10
  it("refuses an adapter outside the fixed set, allowed or not", () => {
    expectAdapter(alice, dex, true);

    for (const adapter of [evil, sbtc, bob]) {
      for (const allowed of [true, false]) {
        const call = allowAdapter(alice, adapter, allowed);
        expect(call.result).toStrictEqual(Cl.error(Cl.uint(107)));
        expect(printEvents(call.events)).toStrictEqual([]);
        expect(isAdapterAllowed(alice, adapter)).toStrictEqual(no);
      }
    }
    expect(isAdapterAllowed(alice, sbtc)).toStrictEqual(no);
    expect(isAdapterAllowed(alice, dex)).toStrictEqual(yes);
  });

  // Alice's known state for the isolation tests.
  const aliceKnown = policy(11n, 22n, 33n, 44n);
  const aliceKnownUsd = policy(1100n, 2200n, 33n, 44n);
  function setAliceKnown() {
    expectFullPolicySet(alice, sbtc, aliceKnown);
    expectCapsSet(
      alice,
      usd,
      aliceKnownUsd.maxPerTrade,
      aliceKnownUsd.maxPerDay,
    );
    expectToken(alice, sbtc, true);
    expectToken(alice, usd, false);
    expectAdapter(alice, dex, true);
  }
  function expectAliceKnown() {
    expect(getPolicy(alice)).toStrictEqual(policyTuple(aliceKnown));
    expect(getPolicy(alice, usd)).toStrictEqual(policyTuple(aliceKnownUsd));
    expect(isTokenAllowed(alice, sbtc)).toStrictEqual(yes);
    expect(isTokenAllowed(alice, usd)).toStrictEqual(no);
    expect(isAdapterAllowed(alice, dex)).toStrictEqual(yes);
  }
  // One token's caps, without the owner-wide fields.
  function capsOf(owner: string, token: string) {
    const value = getPolicy(owner, token);
    if (value.type !== "tuple") throw new Error("expected a tuple");
    return {
      trade: value.value["max-per-trade"],
      day: value.value["max-per-day"],
    };
  }

  // Criteria 9, 10; job 026, criterion 6
  it("set-policy writes only the caller's own policy", () => {
    setAliceKnown();

    const mine = policy(1n, 1n, 1n, 1n);
    expectFullPolicySet(mallory, sbtc, mine);
    expectAliceKnown();

    const capsBefore = [capsOf(intermediary, sbtc), capsOf(intermediary, usd)];
    const call = via("set-policy-via", [Cl.uint(7n), Cl.uint(8n)]);
    expect(call.result).toStrictEqual(ok);
    expect(printEvents(call.events)).toStrictEqual([
      policyEvent(intermediary, 7n, 8n),
    ]);
    // The intermediary's cooldown and expiry change; its caps don't.
    for (const token of [sbtc, usd]) {
      const value = getPolicy(intermediary, token);
      if (value.type !== "tuple") throw new Error("expected a tuple");
      expect(value.value["cooldown-blocks"]).toStrictEqual(Cl.uint(7n));
      expect(value.value["expires-at"]).toStrictEqual(Cl.uint(8n));
    }
    expect([
      capsOf(intermediary, sbtc),
      capsOf(intermediary, usd),
    ]).toStrictEqual(capsBefore);
    expectAliceKnown();
    expect(getPolicy(mallory)).toStrictEqual(policyTuple(mine));
  });

  // Job 026, criterion 6
  it("set-token-caps writes only the caller's own caps", () => {
    setAliceKnown();

    const mine = policy(1n, 1n, 1n, 1n);
    expectFullPolicySet(mallory, sbtc, mine);
    expectCapsSet(mallory, usd, 2n, 3n);
    expectAliceKnown();
    const malloryUsd = getPolicy(mallory, usd);

    const usdBefore = getPolicy(intermediary, usd);
    const call = via("set-token-caps-via", [
      Cl.principal(sbtc),
      Cl.uint(5n),
      Cl.uint(6n),
    ]);
    expect(call.result).toStrictEqual(ok);
    expect(printEvents(call.events)).toStrictEqual([
      capsEvent(intermediary, sbtc, 5n, 6n),
    ]);
    expect(capsOf(intermediary, sbtc)).toStrictEqual({
      trade: Cl.uint(5n),
      day: Cl.uint(6n),
    });
    expect(getPolicy(intermediary, usd)).toStrictEqual(usdBefore);
    expectAliceKnown();

    // Refusals through the intermediary change nothing either.
    const after = [getPolicy(intermediary, sbtc), getPolicy(intermediary, usd)];
    for (const [token, trade, day, code] of [
      [sbtc, 9n, 8n, 105],
      [evil, 1n, 2n, 106],
      [evil, 9n, 8n, 106],
    ] as const) {
      const refused = via("set-token-caps-via", [
        Cl.principal(token),
        Cl.uint(trade),
        Cl.uint(day),
      ]);
      expect(refused.result).toStrictEqual(Cl.error(Cl.uint(code)));
      expect(printEvents(refused.events)).toStrictEqual([]);
      expect([
        getPolicy(intermediary, sbtc),
        getPolicy(intermediary, usd),
      ]).toStrictEqual(after);
    }
    expectAliceKnown();
    expect(getPolicy(mallory)).toStrictEqual(policyTuple(mine));
    expect(getPolicy(mallory, usd)).toStrictEqual(malloryUsd);
  });

  // Criteria 9, 10
  it("allow-token writes only the caller's own list", () => {
    setAliceKnown();

    expectToken(mallory, usd, true);
    expect(isTokenAllowed(mallory, usd)).toStrictEqual(yes);
    expectAliceKnown();

    // Mallory revoking sbtc leaves alice's true.
    expectToken(mallory, sbtc, false);
    expect(isTokenAllowed(mallory, sbtc)).toStrictEqual(no);
    expectAliceKnown();

    const call = via("allow-token-via", [Cl.principal(usd), Cl.bool(true)]);
    expect(call.result).toStrictEqual(ok);
    expect(printEvents(call.events)).toStrictEqual([
      tokenEvent(intermediary, usd, true),
    ]);
    expect(isTokenAllowed(intermediary, usd)).toStrictEqual(yes);
    expectAliceKnown();

    const revoke = via("allow-token-via", [Cl.principal(sbtc), Cl.bool(false)]);
    expect(revoke.result).toStrictEqual(ok);
    expect(isTokenAllowed(intermediary, sbtc)).toStrictEqual(no);
    expectAliceKnown();

    const refused = via("allow-token-via", [Cl.principal(evil), Cl.bool(true)]);
    expect(refused.result).toStrictEqual(Cl.error(Cl.uint(106)));
    expect(isTokenAllowed(intermediary, evil)).toStrictEqual(no);
    expectAliceKnown();
  });

  // Criteria 9, 10
  it("allow-adapter writes only the caller's own list", () => {
    setAliceKnown();

    expectAdapter(mallory, dex, true);
    expect(isAdapterAllowed(mallory, dex)).toStrictEqual(yes);
    expectAliceKnown();

    // Mallory revoking the adapter leaves alice's true.
    expectAdapter(mallory, dex, false);
    expect(isAdapterAllowed(mallory, dex)).toStrictEqual(no);
    expectAliceKnown();

    const call = via("allow-adapter-via", [Cl.principal(dex), Cl.bool(true)]);
    expect(call.result).toStrictEqual(ok);
    expect(printEvents(call.events)).toStrictEqual([
      adapterEvent(intermediary, dex, true),
    ]);
    expect(isAdapterAllowed(intermediary, dex)).toStrictEqual(yes);
    expectAliceKnown();

    const revoke = via("allow-adapter-via", [
      Cl.principal(dex),
      Cl.bool(false),
    ]);
    expect(revoke.result).toStrictEqual(ok);
    expect(isAdapterAllowed(intermediary, dex)).toStrictEqual(no);
    expectAliceKnown();

    const refused = via("allow-adapter-via", [
      Cl.principal(evil),
      Cl.bool(true),
    ]);
    expect(refused.result).toStrictEqual(Cl.error(Cl.uint(107)));
    expect(isAdapterAllowed(intermediary, evil)).toStrictEqual(no);
    expectAliceKnown();
  });

  // Criterion 10
  it("deposits and withdraws mock-sbtc and mock-usd", () => {
    mint("mock-sbtc", 500n, alice);
    const before = ledger(alice, sbtc);
    expect(deposit(alice, sbtc, 500n).result).toStrictEqual(
      Cl.ok(Cl.uint(before + 500n)),
    );
    expect(withdraw(alice, sbtc, 500n).result).toStrictEqual(
      Cl.ok(Cl.uint(before)),
    );

    // The quote token is in the vault's fixed set, so it round-trips too.
    mint("mock-usd", 500n, alice);
    const usdWallet = wallet("mock-usd", alice);
    const usdVault = wallet("mock-usd", vault);
    const usdLedger = ledger(alice, usd);
    const usdDeposit = deposit(alice, usd, 500n);
    expect(usdDeposit.result).toStrictEqual(Cl.ok(Cl.uint(usdLedger + 500n)));
    expect(printEvents(usdDeposit.events)).toStrictEqual([
      Cl.tuple({
        event: Cl.stringAscii("deposit"),
        owner: Cl.principal(alice),
        token: Cl.principal(usd),
        amount: Cl.uint(500n),
        balance: Cl.uint(usdLedger + 500n),
      }),
    ]);
    expect(ledger(alice, usd)).toBe(usdLedger + 500n);
    expect(wallet("mock-usd", alice)).toBe(usdWallet - 500n);
    expect(wallet("mock-usd", vault)).toBe(usdVault + 500n);

    const usdWithdraw = withdraw(alice, usd, 500n);
    expect(usdWithdraw.result).toStrictEqual(Cl.ok(Cl.uint(usdLedger)));
    expect(printEvents(usdWithdraw.events)).toStrictEqual([
      Cl.tuple({
        event: Cl.stringAscii("withdraw"),
        owner: Cl.principal(alice),
        token: Cl.principal(usd),
        amount: Cl.uint(500n),
        balance: Cl.uint(usdLedger),
      }),
    ]);
    expect(ledger(alice, usd)).toBe(usdLedger);
    expect(wallet("mock-usd", alice)).toBe(usdWallet);
    expect(wallet("mock-usd", vault)).toBe(usdVault);
  });
});
