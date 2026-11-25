import { readFileSync } from "node:fs";
import { initSimnet } from "@stacks/clarinet-sdk";
import { Cl, type ClarityValue } from "@stacks/transactions";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ORACLE_KEY,
  PRICE_90K,
  armOracle,
  floorOf,
  oracleTimestamp,
} from "./oracle-fixture.js";

// R1, the owner-approval band (docs/requirements-trustshift.md). A trade above
// the owner's threshold for its input token cannot be executed by the agent
// alone: the agent records it with `request-swap` and the owner runs it with
// `approve-swap`. Names start with "T9" where docs/threat-model.md cites them.
//
// One simnet for the file. `beforeEach` puts Alice's vault back to the
// fixture and clears any request, so each test starts from the same state.

const simnet = await initSimnet();
const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const alice = accounts.get("wallet_1")!;
const bob = accounts.get("wallet_2")!;
const mallory = accounts.get("wallet_3")!;
const carol = accounts.get("wallet_4")!;

const sbtc = `${deployer}.mock-sbtc`;
const usd = `${deployer}.mock-usd`;
const dex = `${deployer}.mock-dex`;
const vault = `${deployer}.keelio-vault`;
const evil = `${deployer}.evil-token`;
const otherDex = `${deployer}.other-dex`;

const everyone = [alice, bob, mallory, carol, deployer];

// The fixture. Rate 900/1 and $90,000: 900 USD base units a sat.
const RATE = 900n;
const DEPOSIT = 1_000_000n;
const USD_DEPOSIT = 1_000_000_000n;
const MAX_PER_TRADE = 100_000n;
const MAX_PER_DAY = 250_000n;
const USD_CAP = 10n ** 12n;
const EXPIRES_AT = 10_000_000n;
const THRESHOLD = 20_000n;
// SMALL is inside the agent's own authority; BIG is in the band.
const SMALL = 10_000n;
const BIG = 50_000n;
const SLIPPAGE_BPS = 100n;
const NO_AGE_LIMIT = 10n ** 15n;
const WINDOW = 6n;
const floor = (amountIn: bigint, price = PRICE_90K, sell = true) =>
  floorOf(amountIn, price, SLIPPAGE_BPS, sell);

function readUint(value: ClarityValue, wrappedInOk: boolean): bigint {
  const inner = wrappedInOk && value.type === "ok" ? value.value : value;
  if (inner.type !== "uint")
    throw new Error(`expected uint, got ${inner.type}`);
  return BigInt(inner.value);
}

function ok(call: { result: ClarityValue }) {
  expect(call.result).toStrictEqual(Cl.ok(Cl.bool(true)));
}

function refused(call: { result: ClarityValue; events: unknown[] }, n: number) {
  expect(call.result).toStrictEqual(Cl.error(Cl.uint(n)));
  // A refused call emits nothing: no print and no transfer.
  expect(call.events).toStrictEqual([]);
}

function vaultCall(sender: string, fn: string, args: ClarityValue[] = []) {
  return simnet.callPublicFn("keelio-vault", fn, args, sender);
}

function readOnly(fn: string, args: ClarityValue[]) {
  return simnet.callReadOnlyFn("keelio-vault", fn, args, deployer).result;
}

function prints(events: { event: string; data: unknown }[]) {
  return events
    .filter((e) => e.event === "print_event")
    .map((e) => (e.data as { value: ClarityValue }).value);
}

function mint(token: string, amount: bigint, recipient: string) {
  ok(
    simnet.callPublicFn(
      token,
      "mint",
      [Cl.uint(amount), Cl.principal(recipient)],
      deployer,
    ),
  );
}

function wallet(token: string, who: string): bigint {
  return readUint(
    simnet.callReadOnlyFn(token, "get-balance", [Cl.principal(who)], deployer)
      .result,
    true,
  );
}

function ledger(owner: string, token: string): bigint {
  return readUint(
    readOnly("get-balance", [Cl.principal(owner), Cl.principal(token)]),
    false,
  );
}

function tradeState(owner: string, token: string) {
  return readOnly("get-trade-state", [
    Cl.principal(owner),
    Cl.principal(token),
  ]);
}

function setRate(num: bigint, den: bigint) {
  ok(
    simnet.callPublicFn(
      "mock-dex",
      "set-rate",
      [Cl.uint(num), Cl.uint(den)],
      deployer,
    ),
  );
}

function setCaps(token: string, perTrade: bigint, perDay: bigint) {
  ok(
    vaultCall(alice, "set-token-caps", [
      Cl.principal(token),
      Cl.uint(perTrade),
      Cl.uint(perDay),
    ]),
  );
}

function setPolicy(cooldown: bigint, expiresAt: bigint) {
  ok(vaultCall(alice, "set-policy", [Cl.uint(cooldown), Cl.uint(expiresAt)]));
}

function setThreshold(token: string, threshold: bigint | null, owner = alice) {
  return vaultCall(owner, "set-approval-threshold", [
    Cl.principal(token),
    threshold === null ? Cl.none() : Cl.some(Cl.uint(threshold)),
  ]);
}

function threshold(owner: string, token: string) {
  return readOnly("get-approval-threshold", [
    Cl.principal(owner),
    Cl.principal(token),
  ]);
}

function pending(owner = alice) {
  return readOnly("get-pending-swap", [Cl.principal(owner)]);
}

type Trade = {
  // Who calls request-swap or execute-swap (the agent, Bob, unless named).
  sender?: string;
  // Who calls approve-swap (the owner, Alice, unless named).
  approver?: string;
  owner?: string;
  adapter?: string;
  tokenIn?: string;
  tokenOut?: string;
  amountIn?: bigint;
  minOut?: bigint;
  // approve-swap only: the burn height of the request the owner means to
  // approve. Left out, it is the stored request's, as an owner who has just
  // read the request would sign it (0 when nothing is pending).
  requestedAt?: bigint;
};

// The trade's five fields. `min-out` defaults to the oracle floor at $90,000.
function tradeArgs(t: Trade) {
  const tokenIn = t.tokenIn ?? sbtc;
  const amountIn = t.amountIn ?? BIG;
  return [
    Cl.principal(t.adapter ?? dex),
    Cl.principal(tokenIn),
    Cl.principal(t.tokenOut ?? (tokenIn === sbtc ? usd : sbtc)),
    Cl.uint(amountIn),
    Cl.uint(t.minOut ?? floor(amountIn, PRICE_90K, tokenIn === sbtc)),
  ];
}

function execute(t: Trade = {}) {
  return vaultCall(t.sender ?? bob, "execute-swap", [
    Cl.principal(t.owner ?? alice),
    ...tradeArgs(t),
  ]);
}

function request(t: Trade = {}) {
  return vaultCall(t.sender ?? bob, "request-swap", [
    Cl.principal(t.owner ?? alice),
    ...tradeArgs(t),
  ]);
}

// The stored request's `requested-at`, read as its owner would read it.
function storedRequestedAt(owner: string): bigint {
  const stored = pending(owner);
  if (stored.type !== "some" || stored.value.type !== "tuple") return 0n;
  const at = stored.value.value["requested-at"];
  if (at?.type !== "uint") throw new Error("requested-at is not a uint");
  return BigInt(at.value);
}

function approve(t: Trade = {}) {
  const approver = t.approver ?? alice;
  return vaultCall(approver, "approve-swap", [
    ...tradeArgs(t),
    Cl.uint(t.requestedAt ?? storedRequestedAt(approver)),
  ]);
}

function reject(sender = alice) {
  return vaultCall(sender, "reject-swap");
}

function cancel(sender = bob, owner = alice) {
  return vaultCall(sender, "cancel-swap-request", [Cl.principal(owner)]);
}

// The stored request for a trade Bob asked for at burn height `at`.
function requestTuple(t: Trade, at: bigint) {
  const [adapter, tokenIn, tokenOut, amountIn, minOut] = tradeArgs(t);
  return {
    agent: Cl.principal(t.sender ?? bob),
    adapter: adapter!,
    "token-in": tokenIn!,
    "token-out": tokenOut!,
    "amount-in": amountIn!,
    "min-out": minOut!,
    "requested-at": Cl.uint(at),
    "expires-at": Cl.uint(at + WINDOW),
  };
}

function height(): bigint {
  return BigInt(simnet.burnBlockHeight);
}

// Everything a request or a refused approval must leave alone.
function snapshot() {
  return {
    ledgers: [sbtc, usd].map((t) => everyone.map((w) => ledger(w, t))),
    totals: [sbtc, usd].map((t) =>
      readOnly("get-ledger-total", [Cl.principal(t)]),
    ),
    wallets: [sbtc, usd].map((t) =>
      [...everyone, vault, dex].map((w) => wallet(t, w)),
    ),
    trades: [sbtc, usd].map((t) => tradeState(alice, t)),
    vaultEntry: readOnly("get-vault", [Cl.principal(alice)]),
  };
}

// A refused approval returns its code, emits nothing, moves nothing and
// leaves the request where it was.
function expectApproveRefused(code: number, t: Trade = {}) {
  const before = { ...snapshot(), pending: pending() };
  refused(approve(t), code);
  expect({ ...snapshot(), pending: pending() }).toStrictEqual(before);
}

// A refused request returns its code, emits nothing and stores nothing.
function expectRequestRefused(code: number, t: Trade = {}) {
  const before = { ...snapshot(), pending: pending(t.owner ?? alice) };
  refused(request(t), code);
  expect({ ...snapshot(), pending: pending(t.owner ?? alice) }).toStrictEqual(
    before,
  );
}

beforeAll(() => {
  mint("mock-usd", 10n ** 18n, dex);
  mint("mock-sbtc", 10n ** 15n, dex);
  for (const [token, amount] of [
    [sbtc, DEPOSIT],
    [usd, USD_DEPOSIT],
  ] as const) {
    mint(token.split(".")[1]!, amount, alice);
    expect(
      vaultCall(alice, "deposit", [Cl.principal(token), Cl.uint(amount)]).result
        .type,
    ).toBe("ok");
  }
  // A second contract with the adapter trait, outside the vault's fixed set.
  simnet.deployContract(
    "other-dex",
    `(impl-trait .swap-adapter-trait.swap-adapter-trait)
(use-trait sip-010 .sip-010-trait.sip-010-trait)
(define-public (swap (token-in <sip-010>) (token-out <sip-010>) (amount-in uint) (min-out uint) (recipient principal))
  (ok u0))`,
    { clarityVersion: 3 },
    deployer,
  );
});

beforeEach(() => {
  // A fresh window for both tokens; this also takes any request past its
  // expiry, and the reject below removes it.
  simnet.mineEmptyBurnBlocks(144);
  reject();
  // Top the ledgers back up to the fixture.
  for (const [token, amount] of [
    [sbtc, DEPOSIT],
    [usd, USD_DEPOSIT],
  ] as const) {
    const have = ledger(alice, token);
    if (have > amount)
      expect(
        vaultCall(alice, "withdraw", [
          Cl.principal(token),
          Cl.uint(have - amount),
        ]).result.type,
      ).toBe("ok");
    if (have < amount) {
      mint(token.split(".")[1]!, amount - have, alice);
      expect(
        vaultCall(alice, "deposit", [
          Cl.principal(token),
          Cl.uint(amount - have),
        ]).result.type,
      ).toBe("ok");
    }
    ok(vaultCall(alice, "allow-token", [Cl.principal(token), Cl.bool(true)]));
  }
  setCaps(sbtc, MAX_PER_TRADE, MAX_PER_DAY);
  setCaps(usd, USD_CAP, USD_CAP);
  setPolicy(0n, EXPIRES_AT);
  ok(vaultCall(alice, "allow-adapter", [Cl.principal(dex), Cl.bool(true)]));
  ok(vaultCall(alice, "set-agent", [Cl.principal(bob)]));
  ok(vaultCall(alice, "unpause"));
  ok(setThreshold(sbtc, THRESHOLD));
  ok(setThreshold(usd, null));
  setRate(RATE, 1n);
  ok(
    simnet.callPublicFn(
      "mock-oracle",
      "set-failing",
      [Cl.bool(false)],
      deployer,
    ),
  );
  armOracle(simnet, alice, {
    price: PRICE_90K,
    slippageBps: SLIPPAGE_BPS,
    maxAgeMs: NO_AGE_LIMIT,
  });
  expect(pending()).toStrictEqual(Cl.none());
});

describe("keelio-vault set-approval-threshold", () => {
  it("sets, replaces and clears the caller's threshold and prints each change", () => {
    ok(setThreshold(sbtc, null));
    expect(threshold(alice, sbtc)).toStrictEqual(Cl.none());

    const set = setThreshold(sbtc, 7n);
    ok(set);
    expect(prints(set.events)).toStrictEqual([
      Cl.tuple({
        event: Cl.stringAscii("set-approval-threshold"),
        owner: Cl.principal(alice),
        token: Cl.principal(sbtc),
        threshold: Cl.some(Cl.uint(7n)),
      }),
    ]);
    expect(threshold(alice, sbtc)).toStrictEqual(Cl.some(Cl.uint(7n)));

    // u0 is a real threshold, not "unset".
    ok(setThreshold(sbtc, 0n));
    expect(threshold(alice, sbtc)).toStrictEqual(Cl.some(Cl.uint(0n)));

    const cleared = setThreshold(sbtc, null);
    ok(cleared);
    expect(prints(cleared.events)).toStrictEqual([
      Cl.tuple({
        event: Cl.stringAscii("set-approval-threshold"),
        owner: Cl.principal(alice),
        token: Cl.principal(sbtc),
        threshold: Cl.none(),
      }),
    ]);
    expect(threshold(alice, sbtc)).toStrictEqual(Cl.none());
  });

  it("u106: refuses a token outside the fixed set, to set or to clear", () => {
    refused(setThreshold(evil, 5n), 106);
    refused(setThreshold(evil, null), 106);
    expect(threshold(alice, evil)).toStrictEqual(Cl.none());
  });

  it("writes only the caller's own entry, for one token", () => {
    ok(setThreshold(sbtc, 1n, mallory));
    expect(threshold(mallory, sbtc)).toStrictEqual(Cl.some(Cl.uint(1n)));
    expect(threshold(mallory, usd)).toStrictEqual(Cl.none());
    // Alice's is still the fixture's, and the agent cannot move it for her.
    expect(threshold(alice, sbtc)).toStrictEqual(Cl.some(Cl.uint(THRESHOLD)));
    ok(setThreshold(sbtc, 10n ** 12n, bob));
    expect(threshold(alice, sbtc)).toStrictEqual(Cl.some(Cl.uint(THRESHOLD)));
    refused(execute({ amountIn: BIG }), 126);
    ok(setThreshold(sbtc, null, mallory));
    ok(setThreshold(sbtc, null, bob));
  });
});

describe("keelio-vault execute-swap and the approval threshold", () => {
  it("no threshold: execute-swap behaves as before and request-swap refuses with u127", () => {
    ok(setThreshold(sbtc, null));
    expectRequestRefused(127, { amountIn: MAX_PER_TRADE });
    expect(execute({ amountIn: MAX_PER_TRADE }).result).toStrictEqual(
      Cl.ok(Cl.uint(MAX_PER_TRADE * RATE)),
    );
    refused(execute({ amountIn: MAX_PER_TRADE + 1n }), 114);
  });

  it("executes at and below the threshold and refuses above it with u126", () => {
    expect(execute({ amountIn: THRESHOLD - 1n }).result).toStrictEqual(
      Cl.ok(Cl.uint((THRESHOLD - 1n) * RATE)),
    );
    expect(execute({ amountIn: THRESHOLD }).result).toStrictEqual(
      Cl.ok(Cl.uint(THRESHOLD * RATE)),
    );
    const before = snapshot();
    refused(execute({ amountIn: THRESHOLD + 1n }), 126);
    refused(execute({ amountIn: MAX_PER_TRADE }), 126);
    expect(snapshot()).toStrictEqual(before);
  });

  it("threshold u0: every trade in that token needs approval", () => {
    ok(setThreshold(sbtc, 0n));
    refused(execute({ amountIn: 1n }), 126);
    // A zero amount is still u100: that check comes first.
    refused(execute({ amountIn: 0n, minOut: 1n }), 100);
    expect(request({ amountIn: 1n }).result.type).toBe("ok");
    expect(approve({ amountIn: 1n }).result).toStrictEqual(
      Cl.ok(Cl.uint(RATE)),
    );
  });

  it("the threshold belongs to the input token only", () => {
    // sBTC has a threshold and USD has none: a large USD sale just runs.
    setRate(1n, RATE);
    const usdIn = 90_000_000n;
    expect(execute({ tokenIn: usd, amountIn: usdIn }).result).toStrictEqual(
      Cl.ok(Cl.uint(usdIn / RATE)),
    );
    expectRequestRefused(127, { tokenIn: usd, amountIn: usdIn });
    // With a USD threshold the same sale needs approval, and sBTC's is not
    // read for it.
    ok(setThreshold(usd, 1_000n));
    ok(setThreshold(sbtc, null));
    refused(execute({ tokenIn: usd, amountIn: usdIn }), 126);
    expect(execute({ tokenIn: usd, amountIn: 900n }).result).toStrictEqual(
      Cl.ok(Cl.uint(1n)),
    );
  });

  it("u126 sits after the per-trade cap (u114) and before the day cap (u115)", () => {
    // Over the cap and over the threshold: u114.
    refused(execute({ amountIn: MAX_PER_TRADE + 1n }), 114);
    // Over the threshold with the day cap already spent, the cooldown
    // running, no price bounds and a min-out of 0: u126.
    setCaps(sbtc, MAX_PER_TRADE, MAX_PER_TRADE);
    for (let spent = 0n; spent < MAX_PER_TRADE; spent += THRESHOLD)
      expect(execute({ amountIn: THRESHOLD }).result.type).toBe("ok");
    setPolicy(1_000n, EXPIRES_AT);
    ok(vaultCall(alice, "set-price-bounds", [Cl.uint(0), Cl.uint(0)]));
    refused(execute({ amountIn: BIG, minOut: 0n }), 126);
    // At the threshold the same call reaches the day cap.
    refused(execute({ amountIn: THRESHOLD, minOut: 0n }), 115);
  });
});

describe("keelio-vault request-swap", () => {
  it("stores the request, prints it and returns its expiry height", () => {
    const at = height();
    const call = request();
    expect(call.result).toStrictEqual(Cl.ok(Cl.uint(at + WINDOW)));
    const stored = requestTuple({}, at);
    expect(pending()).toStrictEqual(Cl.some(Cl.tuple(stored)));
    expect(prints(call.events)).toStrictEqual([
      Cl.tuple({
        event: Cl.stringAscii("request-swap"),
        owner: Cl.principal(alice),
        ...stored,
      }),
    ]);
    // Only the caller's owner has one.
    expect(pending(bob)).toStrictEqual(Cl.none());
    expect(pending(mallory)).toStrictEqual(Cl.none());
  });

  it("T9a: a request moves no token, calls nothing and leaves the caps and cooldown untouched", () => {
    // The oracle is down and the dex has no rate that could pay min-out: a
    // request that called either would fail.
    ok(
      simnet.callPublicFn(
        "mock-oracle",
        "set-failing",
        [Cl.bool(true)],
        deployer,
      ),
    );
    // beforeEach mined 144 burn blocks, so no earlier trade is inside this
    // cooldown; a request that wrote last-trade would be.
    setPolicy(144n, EXPIRES_AT);
    const before = snapshot();
    const call = request({ minOut: 0n });
    expect(call.result.type).toBe("ok");
    // The print is the only event: no transfer of any asset.
    expect(call.events.map((e) => e.event)).toStrictEqual(["print_event"]);
    expect(snapshot()).toStrictEqual(before);
    // The agent's own small trade is not blocked by a cooldown or a window
    // entry from the request.
    ok(
      simnet.callPublicFn(
        "mock-oracle",
        "set-failing",
        [Cl.bool(false)],
        deployer,
      ),
    );
    expect(execute({ amountIn: SMALL }).result).toStrictEqual(
      Cl.ok(Cl.uint(SMALL * RATE)),
    );
  });

  it("u108: only the owner's agent can request", () => {
    expectRequestRefused(108, { sender: mallory });
    expectRequestRefused(108, { sender: alice });
    expectRequestRefused(108, { sender: deployer });
    // Bob is Alice's agent, not Mallory's.
    expectRequestRefused(108, { owner: mallory });
    ok(vaultCall(alice, "remove-agent"));
    expectRequestRefused(108);
    ok(vaultCall(alice, "set-agent", [Cl.principal(carol)]));
    expectRequestRefused(108);
  });

  it("refuses each policy failure with execute-swap's code: u109, u110, u111, u112, u113, u100, u114", () => {
    ok(vaultCall(alice, "pause"));
    expectRequestRefused(109);
    ok(vaultCall(alice, "unpause"));

    setPolicy(0n, height() - 1n);
    expectRequestRefused(110);
    setPolicy(0n, height());
    expect(request().result.type).toBe("ok");
    ok(reject());
    setPolicy(0n, EXPIRES_AT);

    ok(vaultCall(alice, "allow-token", [Cl.principal(usd), Cl.bool(false)]));
    expectRequestRefused(111);
    ok(vaultCall(alice, "allow-token", [Cl.principal(usd), Cl.bool(true)]));
    expectRequestRefused(111, { tokenOut: evil });
    expectRequestRefused(111, { tokenIn: evil, tokenOut: usd });

    expectRequestRefused(112, { tokenOut: sbtc });

    expectRequestRefused(113, { adapter: otherDex });
    ok(vaultCall(alice, "allow-adapter", [Cl.principal(dex), Cl.bool(false)]));
    expectRequestRefused(113);
    ok(vaultCall(alice, "allow-adapter", [Cl.principal(dex), Cl.bool(true)]));

    expectRequestRefused(100, { amountIn: 0n, minOut: 1n });
    expectRequestRefused(114, { amountIn: MAX_PER_TRADE + 1n });
  });

  it("u127: refuses an amount at or below the threshold", () => {
    expectRequestRefused(127, { amountIn: THRESHOLD });
    expectRequestRefused(127, { amountIn: 1n });
    expect(request({ amountIn: THRESHOLD + 1n }).result.type).toBe("ok");
  });

  it("u101: refuses an amount the owner's ledger does not hold", () => {
    setCaps(sbtc, 10n * DEPOSIT, 10n * DEPOSIT);
    expectRequestRefused(101, { amountIn: DEPOSIT + 1n });
    expect(request({ amountIn: DEPOSIT }).result.type).toBe("ok");
  });

  it("T9a: u128 refuses a second request until the first expires, then overwrites it", () => {
    const at = height();
    expect(request().result.type).toBe("ok");
    expectRequestRefused(128);
    expectRequestRefused(128, { amountIn: BIG + 1n });
    // Still pending at its last valid height.
    simnet.mineEmptyBurnBlocks(Number(WINDOW));
    expect(height()).toBe(at + WINDOW);
    expectRequestRefused(128, { amountIn: BIG + 1n });
    // One block later it has expired and a new request replaces it.
    simnet.mineEmptyBurnBlocks(1);
    const second = { amountIn: BIG + 1n };
    expect(request(second).result).toStrictEqual(
      Cl.ok(Cl.uint(at + WINDOW + 1n + WINDOW)),
    );
    expect(pending()).toStrictEqual(
      Cl.some(Cl.tuple(requestTuple(second, at + WINDOW + 1n))),
    );
  });
});

describe("keelio-vault approve-swap", () => {
  it("runs the requested swap with execute-swap's accounting and prints approve-swap", () => {
    const minOut = floor(BIG) + 5n;
    const trade = { minOut };
    const requestedAt = height();
    expect(request(trade).result.type).toBe("ok");
    simnet.mineEmptyBurnBlocks(2);
    const at = height();
    const before = snapshot();

    const call = approve(trade);
    const out = BIG * RATE;
    expect(call.result).toStrictEqual(Cl.ok(Cl.uint(out)));

    // Ledger and real balances: BIG sBTC out, `out` USD in, nothing else.
    expect(ledger(alice, sbtc)).toBe(DEPOSIT - BIG);
    expect(ledger(alice, usd)).toBe(USD_DEPOSIT + out);
    const after = snapshot();
    const vaultAt = everyone.length;
    const dexAt = everyone.length + 1;
    expect(after.wallets[0]![vaultAt]).toBe(before.wallets[0]![vaultAt]! - BIG);
    expect(after.wallets[1]![vaultAt]).toBe(before.wallets[1]![vaultAt]! + out);
    expect(after.wallets[0]![dexAt]).toBe(before.wallets[0]![dexAt]! + BIG);
    expect(after.wallets[1]![dexAt]).toBe(before.wallets[1]![dexAt]! - out);
    // No person's wallet moved: not the owner's, not the agent's.
    expect(after.wallets.map((w) => w.slice(0, vaultAt))).toStrictEqual(
      before.wallets.map((w) => w.slice(0, vaultAt)),
    );
    for (const token of [sbtc, usd])
      expect(wallet(token, vault)).toBe(
        readUint(readOnly("get-ledger-total", [Cl.principal(token)]), false),
      );

    // The daily window and last-trade move at approval, not at request.
    expect(tradeState(alice, sbtc)).toStrictEqual(
      Cl.tuple({
        "last-trade": Cl.some(Cl.uint(at)),
        "day-total": Cl.uint(BIG),
      }),
    );
    expect(tradeState(alice, usd)).toStrictEqual(
      Cl.tuple({ "last-trade": Cl.some(Cl.uint(at)), "day-total": Cl.uint(0) }),
    );

    // execute-swap's fields, the requesting agent, and requested-at.
    expect(prints(call.events)).toStrictEqual([
      Cl.tuple({
        event: Cl.stringAscii("approve-swap"),
        owner: Cl.principal(alice),
        agent: Cl.principal(bob),
        adapter: Cl.principal(dex),
        "token-in": Cl.principal(sbtc),
        "token-out": Cl.principal(usd),
        "amount-in": Cl.uint(BIG),
        "min-out": Cl.uint(minOut),
        "amount-out": Cl.uint(out),
        "balance-in": Cl.uint(DEPOSIT - BIG),
        "balance-out": Cl.uint(USD_DEPOSIT + out),
        "day-total": Cl.uint(BIG),
        "oracle-price": Cl.uint(PRICE_90K),
        "oracle-timestamp": Cl.uint(oracleTimestamp(simnet)),
        "min-out-floor": Cl.uint(floor(BIG)),
        "requested-at": Cl.uint(requestedAt),
      }),
    ]);

    // The request is gone and cannot be approved twice.
    expect(pending()).toStrictEqual(Cl.none());
    expectApproveRefused(129, trade);
  });

  it("execute-swap's event keeps its shape", () => {
    const call = execute({ amountIn: SMALL });
    expect(prints(call.events)).toStrictEqual([
      Cl.tuple({
        event: Cl.stringAscii("execute-swap"),
        owner: Cl.principal(alice),
        agent: Cl.principal(bob),
        adapter: Cl.principal(dex),
        "token-in": Cl.principal(sbtc),
        "token-out": Cl.principal(usd),
        "amount-in": Cl.uint(SMALL),
        "min-out": Cl.uint(floor(SMALL)),
        "amount-out": Cl.uint(SMALL * RATE),
        "balance-in": Cl.uint(DEPOSIT - SMALL),
        "balance-out": Cl.uint(USD_DEPOSIT + SMALL * RATE),
        "day-total": Cl.uint(SMALL),
        "oracle-price": Cl.uint(PRICE_90K),
        "oracle-timestamp": Cl.uint(oracleTimestamp(simnet)),
        "min-out-floor": Cl.uint(floor(SMALL)),
      }),
    ]);
  });

  it("approves a buy as well as a sale", () => {
    ok(setThreshold(usd, 1_000_000n));
    setRate(1n, RATE);
    const trade = { tokenIn: usd, amountIn: 90_000_000n };
    refused(execute(trade), 126);
    expect(request(trade).result.type).toBe("ok");
    expect(approve(trade).result).toStrictEqual(Cl.ok(Cl.uint(100_000n)));
    expect(ledger(alice, usd)).toBe(USD_DEPOSIT - 90_000_000n);
    expect(ledger(alice, sbtc)).toBe(DEPOSIT + 100_000n);
  });

  it("u129: only the owner can approve, and only with a request pending", () => {
    expectApproveRefused(129);
    expect(request().result.type).toBe("ok");
    // The agent, a stranger and the deployer each reach only their own
    // (empty) entry: there is no owner argument.
    for (const sender of [bob, mallory, carol, deployer])
      expectApproveRefused(129, { approver: sender });
    expect(approve().result.type).toBe("ok");
  });

  it("T9b: approves at the request's expiry height and refuses one block later with u130", () => {
    const at = height();
    expect(request().result.type).toBe("ok");
    simnet.mineEmptyBurnBlocks(Number(WINDOW));
    expect(height()).toBe(at + WINDOW);
    expect(approve().result.type).toBe("ok");

    const again = height();
    expect(request().result.type).toBe("ok");
    simnet.mineEmptyBurnBlocks(Number(WINDOW) + 1);
    expect(height()).toBe(again + WINDOW + 1n);
    expectApproveRefused(130);
    // The expired request is still readable until it is replaced or removed.
    expect(pending()).toStrictEqual(Cl.some(Cl.tuple(requestTuple({}, again))));
  });

  it("u131: refuses an adapter, token, amount or min-out that is not the stored request's", () => {
    expect(request().result.type).toBe("ok");
    expectApproveRefused(131, { adapter: otherDex });
    expectApproveRefused(131, { tokenIn: usd, tokenOut: sbtc, minOut: 1n });
    expectApproveRefused(131, { tokenOut: evil });
    expectApproveRefused(131, { tokenIn: evil, tokenOut: usd });
    expectApproveRefused(131, { amountIn: BIG - 1n, minOut: floor(BIG) });
    expectApproveRefused(131, { amountIn: BIG + 1n, minOut: floor(BIG) });
    expectApproveRefused(131, { minOut: floor(BIG) + 1n });
    expectApproveRefused(131, { minOut: floor(BIG) - 1n });
    expect(approve().result.type).toBe("ok");
  });

  it("u131: refuses a requested-at that is not the stored request's, and runs with the right one", () => {
    const at = height();
    expect(request().result.type).toBe("ok");
    simnet.mineEmptyBurnBlocks(2);
    // The five trade fields are the stored request's every time: only the
    // height differs.
    for (const requestedAt of [0n, at - 1n, at + 1n, height(), at + WINDOW])
      expectApproveRefused(131, { requestedAt });
    expect(pending()).toStrictEqual(Cl.some(Cl.tuple(requestTuple({}, at))));
    expect(approve({ requestedAt: at }).result.type).toBe("ok");
    expect(pending()).toStrictEqual(Cl.none());
  });

  it("u130 comes before u131: an expired request is refused as expired whatever requested-at is sent", () => {
    const at = height();
    expect(request().result.type).toBe("ok");
    simnet.mineEmptyBurnBlocks(Number(WINDOW) + 1);
    expectApproveRefused(130, { requestedAt: at + 1n });
    expectApproveRefused(130, { requestedAt: at });
  });

  it("T9c: an approval for the request made at H does not run the same request re-made later", () => {
    // Regression for the review finding: `approve-swap` used to compare the
    // five trade fields only. The simnet has no mempool, so "a signed
    // transaction that lands late" is the same call with the same arguments
    // made at the later height: the contract sees nothing else of it.
    const at = height();
    expect(request().result.type).toBe("ok");
    // The owner reads this request and signs approve-swap for it. The
    // transaction is not mined (low fee, or a nonce gap).
    const signed = { requestedAt: at };
    simnet.mineEmptyBurnBlocks(5);
    // The agent withdraws the request and makes the same one again: the
    // stored request now expires at H+11.
    ok(cancel());
    expect(request().result.type).toBe("ok");
    expect(pending()).toStrictEqual(
      Cl.some(Cl.tuple(requestTuple({}, at + 5n))),
    );
    simnet.mineEmptyBurnBlocks(5);
    expect(height()).toBe(at + WINDOW + 4n);
    // The owner's transaction lands at H+10, after the request the owner saw
    // expired at H+6. The stored request is another one: u131, nothing moves.
    expectApproveRefused(131, signed);
    expect(ledger(alice, sbtc)).toBe(DEPOSIT);
    // The owner can still approve the request that is there, knowingly.
    expect(approve({ requestedAt: at + 5n }).result.type).toBe("ok");
  });

  it("T9c: an approval signed before a request existed does not run that request", () => {
    // The owner signed approve-swap for an earlier request with these
    // fields; that request is gone and the transaction never landed.
    const at = height();
    expect(request().result.type).toBe("ok");
    const signed = { requestedAt: at };
    ok(reject());
    expect(pending()).toStrictEqual(Cl.none());
    // Two days later the agent makes a request with the same five fields,
    // which the owner has not seen, and the old transaction is mined.
    simnet.mineEmptyBurnBlocks(288);
    expect(request().result.type).toBe("ok");
    expectApproveRefused(131, signed);
    expect(ledger(alice, sbtc)).toBe(DEPOSIT);
  });

  it("T9c residual: the same trade re-made in the same burn block still matches", () => {
    // Stated in the contract and in docs/threat-model.md: `requested-at` is
    // a burn height, so a withdraw and re-request inside one burn block
    // yields an identical request. Same trade, same window.
    const at = height();
    expect(request().result.type).toBe("ok");
    const before = pending();
    ok(cancel());
    expect(request().result.type).toBe("ok");
    expect(height()).toBe(at);
    expect(pending()).toStrictEqual(before);
    expect(approve({ requestedAt: at }).result.type).toBe("ok");
  });

  it("T9c: the agent cannot swap the request under the owner's approval", () => {
    // The owner reads this request and signs an approval for it.
    const seen = { amountIn: BIG, requestedAt: height() };
    expect(request(seen).result.type).toBe("ok");
    // Before the approval is mined the agent replaces it with a larger trade
    // in the same tokens.
    ok(cancel());
    const swapped = { amountIn: MAX_PER_TRADE };
    expect(request(swapped).result.type).toBe("ok");
    expectApproveRefused(131, seen);
    expect(ledger(alice, sbtc)).toBe(DEPOSIT);
  });

  it("T9d: u132 refuses a request whose agent was removed or replaced", () => {
    expect(request().result.type).toBe("ok");
    ok(vaultCall(alice, "remove-agent"));
    expectApproveRefused(132);
    ok(vaultCall(alice, "set-agent", [Cl.principal(carol)]));
    expectApproveRefused(132);
    // The new agent cannot adopt or cancel it either.
    refused(cancel(carol), 133);
    // The owner clears it, and the new agent can then ask for its own.
    ok(reject());
    const trade = { sender: carol };
    expect(request(trade).result.type).toBe("ok");
    expect(approve(trade).result.type).toBe("ok");
  });

  it("T9e: u109 refuses while paused and keeps the request for after unpause", () => {
    const at = height();
    expect(request().result.type).toBe("ok");
    ok(vaultCall(alice, "pause"));
    expect(pending()).toStrictEqual(Cl.some(Cl.tuple(requestTuple({}, at))));
    expectApproveRefused(109);
    ok(vaultCall(alice, "unpause"));
    expect(approve().result.type).toBe("ok");
  });

  it("u110: refuses after the policy has expired", () => {
    expect(request().result.type).toBe("ok");
    setPolicy(0n, height() - 1n);
    expectApproveRefused(110);
    setPolicy(0n, height());
    expect(approve().result.type).toBe("ok");
  });

  it("T9b: u115 refuses when the day cap was used up between request and approval", () => {
    setCaps(sbtc, BIG, BIG + THRESHOLD - 1n);
    expect(request().result.type).toBe("ok");
    // The agent spends from the same window on its own authority.
    expect(execute({ amountIn: THRESHOLD }).result.type).toBe("ok");
    expectApproveRefused(115);
    // One more unit of cap and the same approval fits.
    setCaps(sbtc, BIG, BIG + THRESHOLD);
    expect(approve().result.type).toBe("ok");
    expect(tradeState(alice, sbtc)).toStrictEqual(
      Cl.tuple({
        "last-trade": Cl.some(Cl.uint(height())),
        "day-total": Cl.uint(BIG + THRESHOLD),
      }),
    );
  });

  it("u116: refuses inside the cooldown and approves once it has passed", () => {
    setPolicy(3n, EXPIRES_AT);
    expect(execute({ amountIn: SMALL }).result.type).toBe("ok");
    expect(request().result.type).toBe("ok");
    expectApproveRefused(116);
    simnet.mineEmptyBurnBlocks(2);
    expectApproveRefused(116);
    simnet.mineEmptyBurnBlocks(1);
    expect(approve().result.type).toBe("ok");
    // The approved trade starts the next cooldown for the agent too.
    refused(execute({ amountIn: SMALL }), 116);
  });

  it("T9b: u125 refuses when the price rose so the stored min-out is under the floor", () => {
    // min-out is the floor at $90,000.
    expect(request().result.type).toBe("ok");
    const higher = PRICE_90K + PRICE_90K / 100n;
    armOracle(simnet, alice, {
      price: higher,
      slippageBps: SLIPPAGE_BPS,
      maxAgeMs: NO_AGE_LIMIT,
    });
    expect(floor(BIG, higher)).toBeGreaterThan(floor(BIG));
    expectApproveRefused(125);
    // Back at the requested price the same approval runs.
    armOracle(simnet, alice, {
      price: PRICE_90K,
      slippageBps: SLIPPAGE_BPS,
      maxAgeMs: NO_AGE_LIMIT,
    });
    expect(approve().result.type).toBe("ok");
  });

  it("T9b: u123 refuses a stale price, u121 a failing oracle and u119 unset bounds", () => {
    expect(request().result.type).toBe("ok");
    // Ten minutes old against a one-minute limit.
    ok(vaultCall(alice, "set-price-bounds", [Cl.uint(100), Cl.uint(60_000)]));
    ok(
      simnet.callPublicFn(
        "mock-oracle",
        "set-value-aged",
        [Cl.stringAscii(ORACLE_KEY), Cl.uint(PRICE_90K), Cl.uint(600_000)],
        deployer,
      ),
    );
    expectApproveRefused(123);

    ok(
      simnet.callPublicFn(
        "mock-oracle",
        "set-failing",
        [Cl.bool(true)],
        deployer,
      ),
    );
    expectApproveRefused(121);
    ok(vaultCall(alice, "set-price-bounds", [Cl.uint(0), Cl.uint(0)]));
    expectApproveRefused(119);
    ok(
      simnet.callPublicFn(
        "mock-oracle",
        "set-failing",
        [Cl.bool(false)],
        deployer,
      ),
    );
    armOracle(simnet, alice, {
      price: PRICE_90K,
      slippageBps: SLIPPAGE_BPS,
      maxAgeMs: NO_AGE_LIMIT,
    });
    expect(approve().result.type).toBe("ok");
  });

  it("re-checks the lists, the per-trade cap and the balance: u111, u113, u114, u101", () => {
    expect(request().result.type).toBe("ok");

    ok(vaultCall(alice, "allow-token", [Cl.principal(usd), Cl.bool(false)]));
    expectApproveRefused(111);
    ok(vaultCall(alice, "allow-token", [Cl.principal(usd), Cl.bool(true)]));

    ok(vaultCall(alice, "allow-adapter", [Cl.principal(dex), Cl.bool(false)]));
    expectApproveRefused(113);
    ok(vaultCall(alice, "allow-adapter", [Cl.principal(dex), Cl.bool(true)]));

    setCaps(sbtc, BIG - 1n, MAX_PER_DAY);
    expectApproveRefused(114);
    setCaps(sbtc, MAX_PER_TRADE, MAX_PER_DAY);

    expect(
      vaultCall(alice, "withdraw", [
        Cl.principal(sbtc),
        Cl.uint(DEPOSIT - BIG + 1n),
      ]).result.type,
    ).toBe("ok");
    expectApproveRefused(101);
    mint("mock-sbtc", 1n, alice);
    expect(
      vaultCall(alice, "deposit", [Cl.principal(sbtc), Cl.uint(1n)]).result
        .type,
    ).toBe("ok");
    expect(approve().result.type).toBe("ok");
    expect(ledger(alice, sbtc)).toBe(0n);
  });

  it("u117 and u118: refuses when the dex no longer pays the stored min-out", () => {
    expect(request().result.type).toBe("ok");
    // The pool now pays 1% under the floor: the dex itself refuses.
    setRate(RATE - 18n, 1n);
    expectApproveRefused(117);
    // The pool reports the full amount and keeps some back.
    setRate(RATE, 1n);
    ok(
      simnet.callPublicFn(
        "mock-dex",
        "set-skim",
        [Cl.uint(BIG * RATE - floor(BIG) + 1n)],
        deployer,
      ),
    );
    try {
      expectApproveRefused(118);
    } finally {
      ok(simnet.callPublicFn("mock-dex", "set-skim", [Cl.uint(0)], deployer));
    }
    expect(approve().result.type).toBe("ok");
  });

  it("approves a request made before the owner lowered, raised or cleared the threshold", () => {
    for (const next of [0n, MAX_PER_TRADE, null]) {
      ok(setThreshold(sbtc, THRESHOLD));
      const trade = { amountIn: THRESHOLD + 1n };
      expect(request(trade).result.type).toBe("ok");
      ok(setThreshold(sbtc, next));
      expect(approve(trade).result.type).toBe("ok");
    }
  });
});

describe("keelio-vault reject-swap and cancel-swap-request", () => {
  it("the owner rejects a pending request, and the event carries it", () => {
    const at = height();
    expect(request().result.type).toBe("ok");
    const before = snapshot();
    const call = reject();
    ok(call);
    expect(prints(call.events)).toStrictEqual([
      Cl.tuple({
        event: Cl.stringAscii("reject-swap"),
        owner: Cl.principal(alice),
        ...requestTuple({}, at),
      }),
    ]);
    expect(call.events).toHaveLength(1);
    expect(pending()).toStrictEqual(Cl.none());
    expect(snapshot()).toStrictEqual(before);
    expectApproveRefused(129);
    // The agent can ask again at once.
    expect(request().result.type).toBe("ok");
  });

  it("u129: reject-swap with nothing pending, and no one can reject for the owner", () => {
    refused(reject(), 129);
    expect(request().result.type).toBe("ok");
    const stored = pending();
    for (const sender of [bob, mallory, deployer]) refused(reject(sender), 129);
    expect(pending()).toStrictEqual(stored);
  });

  it("the owner can reject an expired request", () => {
    expect(request().result.type).toBe("ok");
    simnet.mineEmptyBurnBlocks(Number(WINDOW) + 1);
    ok(reject());
    expect(pending()).toStrictEqual(Cl.none());
  });

  it("the requesting agent withdraws its request, and the event carries it", () => {
    const at = height();
    expect(request().result.type).toBe("ok");
    const before = snapshot();
    const call = cancel();
    ok(call);
    expect(prints(call.events)).toStrictEqual([
      Cl.tuple({
        event: Cl.stringAscii("cancel-swap-request"),
        owner: Cl.principal(alice),
        ...requestTuple({}, at),
      }),
    ]);
    expect(call.events).toHaveLength(1);
    expect(pending()).toStrictEqual(Cl.none());
    expect(snapshot()).toStrictEqual(before);
    expectApproveRefused(129);
  });

  it("u133 and u129: only the agent that made the request can withdraw it", () => {
    refused(cancel(), 129);
    refused(cancel(bob, mallory), 129);
    expect(request().result.type).toBe("ok");
    const stored = pending();
    for (const sender of [alice, mallory, carol, deployer])
      refused(cancel(sender), 133);
    expect(pending()).toStrictEqual(stored);
  });

  it("a removed agent can still withdraw the request it left, paused or expired", () => {
    expect(request().result.type).toBe("ok");
    ok(vaultCall(alice, "remove-agent"));
    ok(vaultCall(alice, "pause"));
    simnet.mineEmptyBurnBlocks(Number(WINDOW) + 1);
    ok(cancel());
    expect(pending()).toStrictEqual(Cl.none());
  });
});

describe("the approval band in the source and the docs", () => {
  const read = (path: string) =>
    readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const source = read("contracts/keelio-vault.clar");

  it("execute-swap and approve-swap share one swap body", () => {
    const body = (name: string) => {
      const at = source.match(new RegExp(`\\(define-public \\(${name}[\\s)]`));
      expect(at, name).not.toBeNull();
      const start = at!.index!;
      const end = source.indexOf("\n(define-", start + 1);
      return source.slice(start, end === -1 ? undefined : end);
    };
    // One adapter call in the whole contract, inside `run-swap`.
    expect(source.split("(contract-call? adapter swap ").length).toBe(2);
    expect(body("execute-swap")).toContain(
      "(run-swap owner contract-caller adapter token-in token-out amount-in min-out",
    );
    expect(body("approve-swap")).toContain(
      "(run-swap owner agent adapter token-in token-out amount-in min-out true)",
    );
    // The approval names the request it is for.
    expect(body("approve-swap")).toContain(
      "(is-eq requested-at (get requested-at request))",
    );
    // A request calls no contract at all.
    expect(body("request-swap")).not.toContain("contract-call?");
    expect(body("request-swap")).not.toContain("as-contract?");
    for (const name of ["reject-swap", "cancel-swap-request"]) {
      expect(body(name), name).not.toContain("contract-call?");
      expect(body(name), name).not.toContain("map-set");
    }
    expect(source).toMatch(/\(define-constant APPROVAL-WINDOW u6\)/);
  });

  it("docs/errors.md lists u126 to u133 once in each table", () => {
    const lines = read("docs/errors.md").split("\n");
    const constants = new Map(
      [...source.matchAll(/\(define-constant (ERR-[A-Z-]+) \(err u(\d+)\)\)/g)]
        .map((m) => [Number(m[2]), m[1]!] as const)
        .filter(([n]) => n >= 126),
    );
    expect([...constants.keys()].sort((a, b) => a - b)).toStrictEqual([
      126, 127, 128, 129, 130, 131, 132, 133,
    ]);
    for (const [n, constant] of constants) {
      expect(
        lines.filter((line) =>
          line.startsWith(
            `| \`keelio-vault\`    | \`u${n}\` | \`${constant}\``,
          ),
        ),
        constant,
      ).toHaveLength(1);
      expect(
        lines.filter((line) => line.startsWith(`| \`u${n}\` |`)),
        `plain words for u${n}`,
      ).toHaveLength(1);
    }
  });

  it("docs/events.md has a section for each new event", () => {
    const events = read("docs/events.md");
    for (const name of [
      "set-approval-threshold",
      "request-swap",
      "approve-swap",
      "reject-swap",
      "cancel-swap-request",
    ]) {
      expect(events, name).toContain(`\n## \`${name}\`\n`);
      expect(source, name).toContain(`event: "${name}"`);
    }
  });
});
