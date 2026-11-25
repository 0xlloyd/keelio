import { readFileSync } from "node:fs";
import { initSimnet } from "@stacks/clarinet-sdk";
import { Cl, type ClarityValue } from "@stacks/transactions";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  PRICE_90K,
  armOracle,
  floorOf,
  oracleTimestamp,
} from "./oracle-fixture.js";
import { vaultClarityVersion } from "./vault-clarity-version.js";

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
const evil = `${deployer}.evil-token`;
const vault = `${deployer}.keelio-vault`;
const intermediary = `${deployer}.vault-caller`;

const MAX_UINT = 340282366920938463463374607431768211455n;

// Simnet state persists across the tests in this file. `beforeEach` mines a
// full day of burn blocks, so no earlier trade is still in Alice's window or
// cooldown, and then resets the passing fixture.

// The passing fixture. Rate 900/1, so one sat buys 900 base units of USD.
const RATE = 900n;
const DEPOSIT = 1_000_000n;
const AMOUNT_IN = 10_000n;
const OUT = AMOUNT_IN * RATE; // 9_000_000
const MAX_PER_TRADE = 100_000n;
const MAX_PER_DAY = 1_000_000_000n;
// The fixture's USD caps, sized like the sBTC ones at the fixture rate.
const USD_MAX_PER_TRADE = MAX_PER_TRADE * RATE;
const USD_MAX_PER_DAY = MAX_PER_DAY * RATE;
const EXPIRES_AT = 1_000_000n;
// The oracle fixture: $90,000 (the dex rate 900) and 100 bps, with an age
// limit no test here reaches. `price` is the oracle's current price.
const SLIPPAGE_BPS = 100n;
const MAX_AGE_MS = 10n ** 15n;
let price = PRICE_90K;

function setOraclePrice(newPrice: bigint, owner = alice) {
  armOracle(simnet, owner, {
    price: newPrice,
    slippageBps: SLIPPAGE_BPS,
    maxAgeMs: MAX_AGE_MS,
  });
  price = newPrice;
}

// Every principal this file ever deposits for, or that could hold a ledger
// entry. The invariant sums the ledgers over all of them.
const everyone = [alice, bob, mallory, carol, deployer, intermediary];

function readUint(value: ClarityValue, wrappedInOk: boolean): bigint {
  const inner = wrappedInOk && value.type === "ok" ? value.value : value;
  if (inner.type !== "uint")
    throw new Error(`expected uint, got ${inner.type}`);
  return BigInt(inner.value);
}

function mint(contract: string, amount: bigint, recipient: string) {
  const { result } = simnet.callPublicFn(
    contract,
    "mint",
    [Cl.uint(amount), Cl.principal(recipient)],
    deployer,
  );
  expect(result).toStrictEqual(Cl.ok(Cl.bool(true)));
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

function printEvents(events: { event: string; data: unknown }[]) {
  return events
    .filter((e) => e.event === "print_event")
    .map((e) => (e.data as { value: ClarityValue }).value);
}

function ok(call: { result: ClarityValue }) {
  expect(call.result).toStrictEqual(Cl.ok(Cl.bool(true)));
}

function vaultCall(sender: string, fn: string, args: ClarityValue[] = []) {
  return simnet.callPublicFn("keelio-vault", fn, args, sender);
}

function deposit(sender: string, token: string, amount: bigint) {
  return vaultCall(sender, "deposit", [Cl.principal(token), Cl.uint(amount)]);
}

function withdraw(sender: string, token: string, amount: bigint) {
  return vaultCall(sender, "withdraw", [Cl.principal(token), Cl.uint(amount)]);
}

// Sets one token's caps (sBTC unless named) and the owner-wide cooldown and
// expiry.
function setPolicy(
  maxPerTrade: bigint,
  maxPerDay: bigint,
  cooldownBlocks: bigint,
  expiresAt: bigint,
  owner = alice,
  token = sbtc,
) {
  ok(
    vaultCall(owner, "set-token-caps", [
      Cl.principal(token),
      Cl.uint(maxPerTrade),
      Cl.uint(maxPerDay),
    ]),
  );
  ok(
    vaultCall(owner, "set-policy", [
      Cl.uint(cooldownBlocks),
      Cl.uint(expiresAt),
    ]),
  );
}

function allowToken(token: string, allowed: boolean, owner = alice) {
  ok(vaultCall(owner, "allow-token", [Cl.principal(token), Cl.bool(allowed)]));
}

function allowAdapter(allowed: boolean, owner = alice) {
  ok(vaultCall(owner, "allow-adapter", [Cl.principal(dex), Cl.bool(allowed)]));
}

function setSkim(amount: bigint) {
  ok(simnet.callPublicFn("mock-dex", "set-skim", [Cl.uint(amount)], deployer));
}

type Swap = {
  sender?: string;
  owner?: string;
  tokenIn?: string;
  tokenOut?: string;
  amountIn?: bigint;
  minOut?: bigint;
};

// `min-out` defaults to the oracle floor for the trade, the least the vault
// accepts.
function swapArgs(s: Swap) {
  const tokenIn = s.tokenIn ?? sbtc;
  const amountIn = s.amountIn ?? AMOUNT_IN;
  return [
    Cl.principal(s.owner ?? alice),
    Cl.principal(dex),
    Cl.principal(s.tokenIn ?? sbtc),
    Cl.principal(s.tokenOut ?? usd),
    Cl.uint(s.amountIn ?? AMOUNT_IN),
    Cl.uint(
      s.minOut ?? floorOf(amountIn, price, SLIPPAGE_BPS, tokenIn === sbtc),
    ),
  ];
}

function swap(s: Swap = {}) {
  const call = vaultCall(s.sender ?? bob, "execute-swap", swapArgs(s));
  expectInvariant();
  return call;
}

function tradeState(owner = alice, token = sbtc) {
  return simnet.callReadOnlyFn(
    "keelio-vault",
    "get-trade-state",
    [Cl.principal(owner), Cl.principal(token)],
    deployer,
  ).result;
}

function dayTotal(owner = alice, token = sbtc): bigint {
  const state = tradeState(owner, token);
  if (state.type !== "tuple") throw new Error("expected tuple");
  return readUint(state.value["day-total"]!, false);
}

function expectTradeState(
  lastTrade: bigint | null,
  dayTotal: bigint,
  token = sbtc,
) {
  expect(tradeState(alice, token)).toStrictEqual(
    Cl.tuple({
      "last-trade":
        lastTrade === null ? Cl.none() : Cl.some(Cl.uint(lastTrade)),
      "day-total": Cl.uint(dayTotal),
    }),
  );
}

// The vault's balance of each token equals the sum of every ledger.
// `get-ledger-total` reads that sum too.
function expectInvariant() {
  for (const token of [sbtc, usd]) {
    let sum = 0n;
    for (const who of everyone) sum += ledger(who, token);
    expect(wallet(token, vault)).toBe(sum);
    const total = simnet.callReadOnlyFn(
      "keelio-vault",
      "get-ledger-total",
      [Cl.principal(token)],
      deployer,
    ).result;
    expect(readUint(total, false)).toBe(sum);
  }
}

function snapshot(owner = alice) {
  return {
    ledgers: [sbtc, usd].map((t) => everyone.map((w) => ledger(w, t))),
    tradeState: [tradeState(owner, sbtc), tradeState(owner, usd)],
    vault: [sbtc, usd].map((t) => wallet(t, vault)),
    dex: [sbtc, usd].map((t) => wallet(t, dex)),
    wallets: [sbtc, usd].map((t) => everyone.map((w) => wallet(t, w))),
  };
}

// A refused swap returns its own error, prints nothing and changes nothing.
function expectRefused(code: number, s: Swap = {}) {
  const before = snapshot(s.owner ?? alice);
  const call = swap(s);
  expect(call.result).toStrictEqual(Cl.error(Cl.uint(code)));
  expect(printEvents(call.events)).toStrictEqual([]);
  expect(snapshot(s.owner ?? alice)).toStrictEqual(before);
  expectInvariant();
}

function expectSwapped(amountIn: bigint, received: bigint, s: Swap = {}) {
  const tokenIn = s.tokenIn ?? sbtc;
  const tokenOut = s.tokenOut ?? usd;
  const before = {
    inLedger: ledger(alice, tokenIn),
    outLedger: ledger(alice, tokenOut),
  };
  const call = swap({ ...s, amountIn });
  expect(call.result).toStrictEqual(Cl.ok(Cl.uint(received)));
  expect(ledger(alice, tokenIn)).toBe(before.inLedger - amountIn);
  expect(ledger(alice, tokenOut)).toBe(before.outLedger + received);
  return call;
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

// Sells `amountIn` of `tokenIn` for the other token at 900 USD units a sat.
function sell(tokenIn: string, amountIn: bigint) {
  if (tokenIn === sbtc) {
    setRate(RATE, 1n);
    return expectSwapped(amountIn, amountIn * RATE);
  }
  setRate(1n, RATE);
  return expectSwapped(amountIn, amountIn / RATE, {
    tokenIn: usd,
    tokenOut: sbtc,
  });
}

function fund(token: string, amount: bigint, owner = alice) {
  mint(token.split(".")[1]!, amount, owner);
  expect(deposit(owner, token, amount).result.type).toBe("ok");
}

// The raw window list for one owner and token, straight from the map.
function windowEntries(token: string, owner = alice) {
  const entry = simnet.getMapEntry("keelio-vault", "trade-window", {
    type: "tuple",
    value: { owner: Cl.principal(owner), token: Cl.principal(token) },
  } as ClarityValue);
  if (entry.type === "none") return [];
  if (entry.type !== "some" || entry.value.type !== "list")
    throw new Error("expected (some list)");
  return entry.value.value;
}

beforeAll(() => {
  mint("mock-usd", 10n ** 18n, dex);
  // sBTC reserves, so a buy-back never depends on an earlier sale.
  mint("mock-sbtc", 10n ** 15n, dex);
});

beforeEach(() => {
  simnet.mineEmptyBurnBlocks(144);
  ok(
    simnet.callPublicFn(
      "mock-dex",
      "set-rate",
      [Cl.uint(RATE), Cl.uint(1)],
      deployer,
    ),
  );
  setSkim(0n);
  mint("mock-sbtc", DEPOSIT, alice);
  expect(deposit(alice, sbtc, DEPOSIT).result.type).toBe("ok");
  ok(vaultCall(alice, "set-agent", [Cl.principal(bob)]));
  ok(vaultCall(alice, "unpause"));
  allowToken(sbtc, true);
  allowToken(usd, true);
  allowAdapter(true);
  setPolicy(USD_MAX_PER_TRADE, USD_MAX_PER_DAY, 0n, EXPIRES_AT, alice, usd);
  setPolicy(MAX_PER_TRADE, MAX_PER_DAY, 0n, EXPIRES_AT);
  setOraclePrice(PRICE_90K);
  expectInvariant();
});

describe("keelio-vault execute-swap", () => {
  // Criteria 1 and 2
  it("round trip: Bob swaps Alice's sBTC for USD and Alice withdraws both", () => {
    const sbtcBefore = ledger(alice, sbtc);
    const usdBefore = ledger(alice, usd);
    const bobWallets = [wallet("mock-sbtc", bob), wallet("mock-usd", bob)];
    const aliceWallets = [
      wallet("mock-sbtc", alice),
      wallet("mock-usd", alice),
    ];
    const now = BigInt(simnet.burnBlockHeight);

    const call = swap({ minOut: OUT });
    expect(call.result).toStrictEqual(Cl.ok(Cl.uint(9_000_000n)));
    expect(ledger(alice, sbtc)).toBe(sbtcBefore - 10_000n);
    expect(ledger(alice, usd)).toBe(usdBefore + 9_000_000n);
    expect([wallet("mock-sbtc", bob), wallet("mock-usd", bob)]).toStrictEqual(
      bobWallets,
    );
    expectTradeState(now, 10_000n);

    // Criterion 2: the journal event, with the real values. The tokens print
    // nothing for a transfer with no memo, so this is the only event.
    expect(printEvents(call.events)).toStrictEqual([
      Cl.tuple({
        event: Cl.stringAscii("execute-swap"),
        owner: Cl.principal(alice),
        agent: Cl.principal(bob),
        adapter: Cl.principal(dex),
        "token-in": Cl.principal(sbtc),
        "token-out": Cl.principal(usd),
        "amount-in": Cl.uint(10_000n),
        "min-out": Cl.uint(9_000_000n),
        "amount-out": Cl.uint(9_000_000n),
        "balance-in": Cl.uint(sbtcBefore - 10_000n),
        "balance-out": Cl.uint(usdBefore + 9_000_000n),
        "day-total": Cl.uint(10_000n),
        "oracle-price": Cl.uint(price),
        "oracle-timestamp": Cl.uint(oracleTimestamp(simnet)),
        "min-out-floor": Cl.uint(floorOf(10_000n, price, SLIPPAGE_BPS, true)),
      }),
    ]);

    const sbtcAll = ledger(alice, sbtc);
    const usdAll = ledger(alice, usd);
    expect(withdraw(alice, sbtc, sbtcAll).result).toStrictEqual(
      Cl.ok(Cl.uint(0)),
    );
    expect(withdraw(alice, usd, usdAll).result).toStrictEqual(
      Cl.ok(Cl.uint(0)),
    );
    expect(ledger(alice, sbtc)).toBe(0n);
    expect(ledger(alice, usd)).toBe(0n);
    expect(wallet("mock-sbtc", alice)).toBe(aliceWallets[0]! + sbtcAll);
    expect(wallet("mock-usd", alice)).toBe(aliceWallets[1]! + usdAll);
    expectInvariant();
  });

  it("swaps USD back to sBTC", () => {
    // 9_000_000 USD in is inside the fixture's USD caps.
    expectSwapped(AMOUNT_IN, OUT, { minOut: OUT });
    ok(
      simnet.callPublicFn(
        "mock-dex",
        "set-rate",
        [Cl.uint(1), Cl.uint(900)],
        deployer,
      ),
    );
    // The dex holds sBTC from the first swap, so it can pay this one.
    expectSwapped(OUT, AMOUNT_IN, {
      tokenIn: usd,
      tokenOut: sbtc,
      minOut: AMOUNT_IN,
    });
    // Each token's window holds only its own units.
    expectTradeState(BigInt(simnet.burnBlockHeight), AMOUNT_IN, sbtc);
    expectTradeState(BigInt(simnet.burnBlockHeight), OUT, usd);
    expectInvariant();
  });

  // Criterion 3, one refusal per check, in the order the vault checks them.
  it("u108: refuses a stranger", () => {
    expectRefused(108, { sender: mallory });
  });

  it("u109: refuses while the vault is paused", () => {
    ok(vaultCall(alice, "pause"));
    expectRefused(109);
  });

  it("u110: refuses after the policy expires", () => {
    setPolicy(
      MAX_PER_TRADE,
      MAX_PER_DAY,
      0n,
      BigInt(simnet.burnBlockHeight) - 1n,
    );
    expectRefused(110);
  });

  it("u111: refuses a token-in the owner has not allowed", () => {
    allowToken(sbtc, false);
    expectRefused(111);
  });

  it("u111: refuses a token-out the owner has not allowed", () => {
    allowToken(usd, false);
    expectRefused(111);
  });

  it("u111: refuses a token outside the fixed set without calling it", () => {
    expectRefused(111, { tokenIn: evil });
    expectRefused(111, { tokenOut: evil });
  });

  it("u112: refuses the same token in and out", () => {
    expectRefused(112, { tokenOut: sbtc });
  });

  it("u113: refuses an adapter the owner has not allowed", () => {
    allowAdapter(false);
    expectRefused(113);
  });

  it("u100: refuses a zero amount-in", () => {
    expectRefused(100, { amountIn: 0n });
  });

  it("u114: refuses an amount-in over max-per-trade", () => {
    expectRefused(114, { amountIn: MAX_PER_TRADE + 1n });
    expectSwapped(MAX_PER_TRADE, MAX_PER_TRADE * RATE);
  });

  it("u115: refuses an amount-in that would pass max-per-day", () => {
    setPolicy(AMOUNT_IN, AMOUNT_IN + 1n, 0n, EXPIRES_AT);
    expectSwapped(AMOUNT_IN, OUT);
    expectRefused(115, { amountIn: 2n });
    expectSwapped(1n, RATE);
    expectTradeState(BigInt(simnet.burnBlockHeight), AMOUNT_IN + 1n);
  });

  it("u116: refuses during the cooldown", () => {
    setPolicy(MAX_PER_TRADE, MAX_PER_DAY, 1n, EXPIRES_AT);
    expectSwapped(AMOUNT_IN, OUT);
    expectRefused(116);
  });

  it("u101: refuses an amount-in over the owner's ledger", () => {
    setPolicy(MAX_UINT, MAX_UINT, 0n, EXPIRES_AT, alice, usd);
    setPolicy(MAX_UINT, MAX_UINT, 0n, EXPIRES_AT);
    expectRefused(101, { amountIn: ledger(alice, sbtc) + 1n });
    expectRefused(101, {
      tokenIn: usd,
      tokenOut: sbtc,
      amountIn: ledger(alice, usd) + 1n,
    });
  });

  // Criterion 4
  it("u108: refuses the owner, a removed agent, a replaced agent and the agent through a contract", () => {
    expectRefused(108, { sender: alice });

    ok(vaultCall(alice, "remove-agent"));
    expectRefused(108);

    ok(vaultCall(alice, "set-agent", [Cl.principal(mallory)]));
    expectRefused(108);

    ok(vaultCall(alice, "set-agent", [Cl.principal(bob)]));
    const before = snapshot();
    const via = simnet.callPublicFn(
      "vault-caller",
      "execute-swap-via",
      swapArgs({}),
      bob,
    );
    expect(via.result).toStrictEqual(Cl.error(Cl.uint(108)));
    expect(printEvents(via.events)).toStrictEqual([]);
    expect(snapshot()).toStrictEqual(before);
    expectInvariant();
  });

  it("u108: refuses an owner with no agent", () => {
    expectRefused(108, { owner: mallory, sender: bob });
  });

  // Criterion 5
  it("trades at expires-at and refuses one block later", () => {
    const now = BigInt(simnet.burnBlockHeight);
    setPolicy(MAX_PER_TRADE, MAX_PER_DAY, 0n, now);
    expectSwapped(AMOUNT_IN, OUT);
    simnet.mineEmptyBurnBlocks(1);
    expect(BigInt(simnet.burnBlockHeight)).toBe(now + 1n);
    expectRefused(110);
  });

  // Criterion 6
  it("cooldown 3: refuses at H+2 and trades at H+3", () => {
    setPolicy(MAX_PER_TRADE, MAX_PER_DAY, 3n, EXPIRES_AT);
    const h = BigInt(simnet.burnBlockHeight);
    expectSwapped(AMOUNT_IN, OUT);
    expectTradeState(h, AMOUNT_IN);
    simnet.mineEmptyBurnBlocks(2);
    expectRefused(116);
    simnet.mineEmptyBurnBlocks(1);
    expectSwapped(AMOUNT_IN, OUT);
    expectTradeState(h + 3n, 2n * AMOUNT_IN);
  });

  it("cooldown 0: two swaps in one burn block both succeed and sum", () => {
    const h = BigInt(simnet.burnBlockHeight);
    expectSwapped(AMOUNT_IN, OUT);
    expectSwapped(3n, 3n * RATE);
    expect(BigInt(simnet.burnBlockHeight)).toBe(h);
    expectTradeState(h, AMOUNT_IN + 3n);
  });

  it("a huge cooldown refuses the next trade without overflow", () => {
    expectSwapped(AMOUNT_IN, OUT);
    setPolicy(MAX_UINT, MAX_UINT, MAX_UINT, EXPIRES_AT);
    simnet.mineEmptyBurnBlocks(1_000);
    expectRefused(116);
  });

  it("MAX_UINT caps let a trade through without overflow", () => {
    setPolicy(MAX_UINT, MAX_UINT, 0n, EXPIRES_AT);
    expectSwapped(AMOUNT_IN, OUT);
    expectSwapped(AMOUNT_IN, OUT);
    expectTradeState(BigInt(simnet.burnBlockHeight), 2n * AMOUNT_IN);
  });

  // Criterion 7
  it("the day window rolls: refused at H+143, trades at H+144", () => {
    const trade = 20_000n;
    setPolicy(trade, 2n * trade, 0n, EXPIRES_AT);
    const h = BigInt(simnet.burnBlockHeight);
    expect(dayTotal()).toBe(0n);

    expectSwapped(trade, trade * RATE);
    expectTradeState(h, trade);
    simnet.mineEmptyBurnBlocks(10);
    expectSwapped(trade, trade * RATE);
    expectTradeState(h + 10n, 2n * trade);

    simnet.mineEmptyBurnBlocks(133);
    expect(BigInt(simnet.burnBlockHeight)).toBe(h + 143n);
    expectTradeState(h + 10n, 2n * trade);
    expectRefused(115, { amountIn: trade });
    expectRefused(115, { amountIn: 1n });

    simnet.mineEmptyBurnBlocks(1);
    expect(BigInt(simnet.burnBlockHeight)).toBe(h + 144n);
    expectTradeState(h + 10n, trade);
    expectSwapped(trade, trade * RATE);
    expectTradeState(h + 144n, 2n * trade);
  });

  it("a trade at each of 144 heights, then a second in the last block, fits the window", () => {
    const h = BigInt(simnet.burnBlockHeight);
    for (let i = 0; i < 144; i++) {
      if (i > 0) simnet.mineEmptyBurnBlocks(1);
      const call = vaultCall(bob, "execute-swap", swapArgs({ amountIn: 1n }));
      expect(call.result).toStrictEqual(Cl.ok(Cl.uint(RATE)));
    }
    expect(BigInt(simnet.burnBlockHeight)).toBe(h + 143n);
    expect(dayTotal()).toBe(144n);
    // The window already holds 144 entries. This one joins the last entry,
    // so it fits.
    expectSwapped(2n, 2n * RATE);
    expectTradeState(h + 143n, 146n);
    simnet.mineEmptyBurnBlocks(1);
    expectTradeState(h + 143n, 145n);
  });

  it("a lower max-per-day applies to trades already in the window", () => {
    expectSwapped(AMOUNT_IN, OUT);
    setPolicy(AMOUNT_IN - 1n, AMOUNT_IN - 1n, 0n, EXPIRES_AT);
    expectRefused(115, { amountIn: 1n });
    simnet.mineEmptyBurnBlocks(144);
    expectSwapped(1n, RATE);
  });

  // Criterion 8
  it("u118: refuses when the dex delivers less than min-out", () => {
    setSkim(1n);
    try {
      // mock-dex computes out = 9_000_000 >= min-out and reports it, but
      // sends only 8_999_999.
      expectRefused(118, { minOut: OUT });
    } finally {
      setSkim(0n);
    }
  });

  // Criterion 9
  it("credits what arrived, not what the adapter reports", () => {
    setSkim(5n);
    try {
      const vaultUsd = wallet("mock-usd", vault);
      const sbtcBefore = ledger(alice, sbtc);
      const usdBefore = ledger(alice, usd);
      const call = expectSwapped(AMOUNT_IN, 8_999_995n, {
        minOut: 8_999_900n,
      });
      // The vault's measured rise, not the 9_000_000 mock-dex returned.
      expect(wallet("mock-usd", vault) - vaultUsd).toBe(8_999_995n);
      expect(ledger(alice, usd) - usdBefore).toBe(8_999_995n);
      expect(printEvents(call.events)).toStrictEqual([
        Cl.tuple({
          event: Cl.stringAscii("execute-swap"),
          owner: Cl.principal(alice),
          agent: Cl.principal(bob),
          adapter: Cl.principal(dex),
          "token-in": Cl.principal(sbtc),
          "token-out": Cl.principal(usd),
          "amount-in": Cl.uint(10_000n),
          "min-out": Cl.uint(8_999_900n),
          "amount-out": Cl.uint(8_999_995n),
          "balance-in": Cl.uint(sbtcBefore - 10_000n),
          "balance-out": Cl.uint(usdBefore + 8_999_995n),
          "day-total": Cl.uint(10_000n),
          "oracle-price": Cl.uint(price),
          "oracle-timestamp": Cl.uint(oracleTimestamp(simnet)),
          "min-out-floor": Cl.uint(floorOf(10_000n, price, SLIPPAGE_BPS, true)),
        }),
      ]);
      expectInvariant();
    } finally {
      setSkim(0n);
    }
  });

  // Criterion 10
  it("u117: an adapter error comes back as the vault's own code", () => {
    expectRefused(117, { minOut: OUT + 1n });
  });

  // Criterion 11
  it("the agent cannot withdraw the owner's tokens", () => {
    const before = snapshot();
    const call = withdraw(bob, sbtc, 1n);
    expect(call.result).toStrictEqual(Cl.error(Cl.uint(101)));
    expect(printEvents(call.events)).toStrictEqual([]);
    expect(snapshot()).toStrictEqual(before);
    expectInvariant();
  });

  it("withdrawals still work while paused", () => {
    expectSwapped(AMOUNT_IN, OUT);
    ok(vaultCall(alice, "pause"));
    const usdAll = ledger(alice, usd);
    expect(withdraw(alice, usd, usdAll).result).toStrictEqual(
      Cl.ok(Cl.uint(0)),
    );
    expectInvariant();
  });

  // Criterion 12
  it("an owner with no policy is refused with u110", () => {
    mint("mock-sbtc", DEPOSIT, carol);
    expect(deposit(carol, sbtc, DEPOSIT).result.type).toBe("ok");
    ok(vaultCall(carol, "set-agent", [Cl.principal(bob)]));
    allowToken(sbtc, true, carol);
    allowToken(usd, true, carol);
    allowAdapter(true, carol);
    expectRefused(110, { owner: carol });

    // With a policy, Carol's first trade passes even a MAX_UINT cooldown:
    // there is no earlier trade to wait after.
    expect(tradeState(carol)).toStrictEqual(
      Cl.tuple({ "last-trade": Cl.none(), "day-total": Cl.uint(0) }),
    );
    expect(tradeState(carol, usd)).toStrictEqual(
      Cl.tuple({ "last-trade": Cl.none(), "day-total": Cl.uint(0) }),
    );
    setPolicy(MAX_PER_TRADE, MAX_PER_DAY, MAX_UINT, EXPIRES_AT, carol);
    setOraclePrice(PRICE_90K, carol);
    const call = swap({ owner: carol });
    expect(call.result).toStrictEqual(Cl.ok(Cl.uint(OUT)));
    expect(ledger(carol, sbtc)).toBe(DEPOSIT - AMOUNT_IN);
    expect(ledger(carol, usd)).toBe(OUT);
    expect(tradeState(carol)).toStrictEqual(
      Cl.tuple({
        "last-trade": Cl.some(Cl.uint(simnet.burnBlockHeight)),
        "day-total": Cl.uint(AMOUNT_IN),
      }),
    );
    expectRefused(116, { owner: carol });
  });

  // Criterion 13 (the deposit and withdraw half lives in the policy and
  // allowance tests): evil-token is still refused by deposit.
  it("deposit still refuses a token outside the fixed set", () => {
    const call = deposit(mallory, evil, 1n);
    expect(call.result).toStrictEqual(Cl.error(Cl.uint(102)));
    expectInvariant();
  });
});

// Job 015: caps and the day window belong to an owner and an input token.
describe("keelio-vault caps per token", () => {
  // Criterion 1's caps: 0.1 sBTC and 10000 USD a trade, three of each a day.
  const SBTC_TRADE = 10_000_000n;
  const SBTC_DAY = 30_000_000n;
  const USD_TRADE = 10_000_000_000n;
  const USD_DAY = 30_000_000_000n;

  function setCaps(
    sbtcCaps: [bigint, bigint],
    usdCaps: [bigint, bigint],
    cooldown = 0n,
  ) {
    setPolicy(sbtcCaps[0], sbtcCaps[1], cooldown, EXPIRES_AT, alice, sbtc);
    setPolicy(usdCaps[0], usdCaps[1], cooldown, EXPIRES_AT, alice, usd);
  }

  beforeEach(() => {
    fund(sbtc, 100_000_000n);
    fund(usd, 100_000_000_000n);
    setCaps([SBTC_TRADE, SBTC_DAY], [USD_TRADE, USD_DAY]);
  });

  // Criterion 1
  it("buy-back: sells sBTC for USD and buys it back under each token's caps", () => {
    const sbtcStart = ledger(alice, sbtc);
    setRate(RATE, 1n);
    expect(swap({ amountIn: SBTC_TRADE }).result).toStrictEqual(
      Cl.ok(Cl.uint(9_000_000_000n)),
    );
    setRate(1n, RATE);
    expect(
      swap({ tokenIn: usd, tokenOut: sbtc, amountIn: 9_000_000_000n }).result,
    ).toStrictEqual(Cl.ok(Cl.uint(10_000_000n)));
    expect(ledger(alice, sbtc)).toBe(sbtcStart);
  });

  // Criterion 2
  it("selling sBTC to its day cap leaves the USD cap untouched", () => {
    for (let i = 0; i < 3; i++) sell(sbtc, SBTC_TRADE);
    expect(dayTotal(alice, sbtc)).toBe(SBTC_DAY);
    expect(tradeState(alice, usd)).toStrictEqual(
      Cl.tuple({
        "last-trade": Cl.some(Cl.uint(simnet.burnBlockHeight)),
        "day-total": Cl.uint(0),
      }),
    );
    sell(usd, USD_TRADE - 1_000n);
    expectRefused(115, { amountIn: 1n });
    expect(dayTotal(alice, sbtc)).toBe(SBTC_DAY);
  });

  // Criterion 2, the other way round
  it("selling USD to its day cap leaves the sBTC cap untouched", () => {
    for (let i = 0; i < 3; i++) sell(usd, USD_TRADE);
    expect(dayTotal(alice, usd)).toBe(USD_DAY);
    expect(dayTotal(alice, sbtc)).toBe(0n);
    sell(sbtc, SBTC_TRADE);
    expectRefused(115, { tokenIn: usd, tokenOut: sbtc, amountIn: 900n });
    expect(dayTotal(alice, usd)).toBe(USD_DAY);
  });

  // Criterion 3: u114 against token-in's own max-per-trade
  it("u114 per token: the other token's larger cap never lets a trade through", () => {
    // USD's cap (1e10) is far above sBTC's (1e7).
    expectRefused(114, { amountIn: SBTC_TRADE + 1n });
    sell(sbtc, SBTC_TRADE);
    expectRefused(114, {
      tokenIn: usd,
      tokenOut: sbtc,
      amountIn: USD_TRADE + 1n,
    });
    sell(usd, USD_TRADE);

    // Now sBTC's cap (5000) is above USD's (1000), in fresh windows.
    simnet.mineEmptyBurnBlocks(144);
    setCaps([5_000n, 5_000_000n], [1_000n, 5_000_000n]);
    expectRefused(114, { tokenIn: usd, tokenOut: sbtc, amountIn: 1_001n });
    setRate(1n, 1n);
    // The oracle price at rate 1/1: one quote base unit a sat.
    setOraclePrice(10_000_000_000n);
    expectSwapped(1_000n, 1_000n, { tokenIn: usd, tokenOut: sbtc });
    expectRefused(114, { amountIn: 5_001n });
    expectSwapped(5_000n, 5_000n);
  });

  // Criterion 4: u115 per token, each window rolling on its own
  it("u115 per token: each window reaches its cap and rolls independently", () => {
    setCaps([20_000n, 40_000n], [18_000_000n, 36_000_000n]);
    const h = BigInt(simnet.burnBlockHeight);

    sell(sbtc, 20_000n);
    sell(sbtc, 20_000n); // reaches the sBTC cap exactly
    expectRefused(115, { amountIn: 1n });
    expect(dayTotal(alice, usd)).toBe(0n);

    simnet.mineEmptyBurnBlocks(10);
    sell(usd, 18_000_000n);
    sell(usd, 18_000_000n); // reaches the USD cap exactly
    expectRefused(115, { tokenIn: usd, tokenOut: sbtc, amountIn: 900n });
    expect(dayTotal(alice, sbtc)).toBe(40_000n);

    simnet.mineEmptyBurnBlocks(134);
    expect(BigInt(simnet.burnBlockHeight)).toBe(h + 144n);
    // sBTC's window rolled at H+144; USD's, opened at H+10, has not.
    expect(dayTotal(alice, sbtc)).toBe(0n);
    expect(dayTotal(alice, usd)).toBe(36_000_000n);
    sell(sbtc, 20_000n);
    expectRefused(115, { tokenIn: usd, tokenOut: sbtc, amountIn: 900n });

    simnet.mineEmptyBurnBlocks(10);
    expect(dayTotal(alice, usd)).toBe(0n);
    expect(dayTotal(alice, sbtc)).toBe(20_000n);
    sell(usd, 18_000_000n);
  });

  // Criterion 5
  it("a token whose caps were never set may not be sold (u114)", () => {
    // The deployer owns no vault elsewhere in this file; it sets sBTC only.
    const erin = deployer;
    fund(usd, 1_000_000n, erin);
    ok(vaultCall(erin, "set-agent", [Cl.principal(bob)]));
    allowToken(sbtc, true, erin);
    allowToken(usd, true, erin);
    allowAdapter(true, erin);
    setPolicy(SBTC_TRADE, SBTC_DAY, 0n, EXPIRES_AT, erin, sbtc);
    for (const amountIn of [1n, 1_000_000n]) {
      expectRefused(114, {
        owner: erin,
        tokenIn: usd,
        tokenOut: sbtc,
        amountIn,
      });
    }
  });

  // Criterion 7
  it("the cooldown counts from the last trade in either token", () => {
    setCaps([SBTC_TRADE, SBTC_DAY], [USD_TRADE, USD_DAY], 5n);
    sell(sbtc, SBTC_TRADE);
    simnet.mineEmptyBurnBlocks(2);
    expectRefused(116, { tokenIn: usd, tokenOut: sbtc, amountIn: 900n });
    simnet.mineEmptyBurnBlocks(3);
    sell(usd, 900n);
  });

  // Criterion 8
  it("same-block trades merge within one token's list only", () => {
    const h = BigInt(simnet.burnBlockHeight);
    sell(sbtc, 1_000n);
    sell(sbtc, 2_000n);
    expect(BigInt(simnet.burnBlockHeight)).toBe(h);
    const merged = [Cl.tuple({ height: Cl.uint(h), amount: Cl.uint(3_000n) })];
    expect(windowEntries(sbtc)).toStrictEqual(merged);

    sell(usd, 9_000n);
    expect(windowEntries(sbtc)).toStrictEqual(merged);
    expect(windowEntries(usd)).toStrictEqual([
      Cl.tuple({ height: Cl.uint(h), amount: Cl.uint(9_000n) }),
    ]);
    expect(dayTotal(alice, sbtc)).toBe(3_000n);
    expect(dayTotal(alice, usd)).toBe(9_000n);
  });
});

// The swap's allowance, shown against an adapter that takes more than it
// should. These tests deploy a copy of the shipped `keelio-vault` whose fixed
// adapter is the greedy one below, made by exact string replacement (each
// replacement is asserted to change the source), as
// `keelio-vault-allowance.test.ts` does for `withdraw`.
describe("keelio-vault execute-swap allowance", () => {
  const greedyAdapter = `
(impl-trait .swap-adapter-trait.swap-adapter-trait)
(use-trait sip-010 .sip-010-trait.sip-010-trait)
;; 1: take amount-in + 1 of token-in. 2: take amount-in of token-in and 1 of
;; token-out. 3: take amount-in of token-in and 1 uSTX. Delivers nothing.
(define-data-var mode uint u1)
(define-public (set-mode (m uint)) (begin (var-set mode m) (ok true)))
(define-public (swap (token-in <sip-010>) (token-out <sip-010>) (amount-in uint) (min-out uint) (recipient principal))
  (begin
    (if (is-eq (var-get mode) u1)
      (try! (contract-call? token-in transfer (+ amount-in u1) recipient (as-contract tx-sender) none))
      (begin
        (try! (contract-call? token-in transfer amount-in recipient (as-contract tx-sender) none))
        (if (is-eq (var-get mode) u2)
          (try! (contract-call? token-out transfer u1 recipient (as-contract tx-sender) none))
          (try! (stx-transfer? u1 recipient (as-contract tx-sender)))
        )
      )
    )
    (ok u0)
  )
)`;

  function replaceOnce(text: string, from: string, to: string): string {
    const changed = text.replace(from, to);
    expect(changed).not.toBe(text);
    return changed;
  }

  const source = readFileSync(
    new URL("../contracts/keelio-vault.clar", import.meta.url),
    "utf8",
  );
  const greedySource = replaceOnce(
    source,
    "(define-constant ALLOWED-ADAPTER .mock-dex)",
    "(define-constant ALLOWED-ADAPTER .greedy-adapter)",
  );
  // The control also drops the oracle floor (to u0), so its min-out 0 lets
  // the greedy adapter's swap complete and show what it took.
  const unsafeSource = replaceOnce(
    replaceOnce(
      greedySource,
      "((with-ft ALLOWED-TOKEN ALLOWED-TOKEN-FT sbtc-in) (with-ft QUOTE-TOKEN QUOTE-TOKEN-FT usd-in))",
      "((with-all-assets-unsafe))",
    ),
    "(try! (oracle-floor token-in-id amount-in bounds))",
    "{ floor: u0, price: u0, timestamp: u0 }",
  );
  const adapter = `${deployer}.greedy-adapter`;

  beforeAll(() => {
    for (const [name, code, version] of [
      ["greedy-adapter", greedyAdapter, 3],
      ["swap-greedy", greedySource, vaultClarityVersion()],
      ["swap-unsafe", unsafeSource, vaultClarityVersion()],
    ] as const) {
      const { result } = simnet.deployContract(
        name,
        code,
        { clarityVersion: version },
        deployer,
      );
      expect(result).toStrictEqual(Cl.ok(Cl.bool(true)));
    }
  });

  // Alice opens a vault in the copy with 1_000 of each token, Bob as agent.
  function open(name: "swap-greedy" | "swap-unsafe", minOut: bigint) {
    const call = (sender: string, fn: string, args: ClarityValue[] = []) =>
      simnet.callPublicFn(name, fn, args, sender);
    const copyLedger = (token: string) =>
      readUint(
        simnet.callReadOnlyFn(
          name,
          "get-balance",
          [Cl.principal(alice), Cl.principal(token)],
          deployer,
        ).result,
        false,
      );
    for (const token of [sbtc, usd]) {
      mint(token.split(".")[1]!, 1_000n, alice);
      expect(
        call(alice, "deposit", [Cl.principal(token), Cl.uint(1_000n)]).result
          .type,
      ).toBe("ok");
      ok(call(alice, "allow-token", [Cl.principal(token), Cl.bool(true)]));
    }
    ok(call(alice, "allow-adapter", [Cl.principal(adapter), Cl.bool(true)]));
    ok(call(alice, "set-agent", [Cl.principal(bob)]));
    ok(
      call(alice, "set-token-caps", [
        Cl.principal(sbtc),
        Cl.uint(MAX_PER_TRADE),
        Cl.uint(MAX_PER_DAY),
      ]),
    );
    ok(call(alice, "set-policy", [Cl.uint(0), Cl.uint(EXPIRES_AT)]));
    armOracle(
      simnet,
      alice,
      { price, slippageBps: SLIPPAGE_BPS, maxAgeMs: MAX_AGE_MS },
      name,
    );
    const address = `${deployer}.${name}`;
    return {
      swap: () =>
        call(bob, "execute-swap", [
          Cl.principal(alice),
          Cl.principal(adapter),
          Cl.principal(sbtc),
          Cl.principal(usd),
          Cl.uint(100n),
          Cl.uint(minOut),
        ]),
      state: () => ({
        ledgers: [copyLedger(sbtc), copyLedger(usd)],
        vault: [wallet("mock-sbtc", address), wallet("mock-usd", address)],
        adapter: [wallet("mock-sbtc", adapter), wallet("mock-usd", adapter)],
      }),
    };
  }

  function setMode(mode: bigint) {
    ok(
      simnet.callPublicFn(
        "greedy-adapter",
        "set-mode",
        [Cl.uint(mode)],
        deployer,
      ),
    );
  }

  it("refuses an adapter that takes more than amount-in, or any token-out", () => {
    // min-out at the oracle floor, so the floor is not what refuses it.
    const vaultCopy = open(
      "swap-greedy",
      floorOf(100n, price, SLIPPAGE_BPS, true),
    );
    const before = vaultCopy.state();
    expect(before.ledgers).toStrictEqual([1_000n, 1_000n]);

    for (const mode of [1n, 2n]) {
      setMode(mode);
      const call = vaultCopy.swap();
      expect(call.result).toStrictEqual(Cl.error(Cl.uint(104)));
      expect(printEvents(call.events)).toStrictEqual([]);
      expect(vaultCopy.state()).toStrictEqual(before);
    }
    setMode(1n);
  });

  it("refuses an adapter that takes any STX from the vault", () => {
    const vaultCopy = open(
      "swap-greedy",
      floorOf(100n, price, SLIPPAGE_BPS, true),
    );
    const address = `${deployer}.swap-greedy`;
    // STX someone sent straight to the vault: no ledger holds it.
    simnet.transferSTX(1_000n, address, deployer);
    const stx = () => simnet.getAssetsMap().get("STX")?.get(address) ?? 0n;
    const before = { ...vaultCopy.state(), stx: stx() };
    expect(before.stx).toBe(1_000n);

    setMode(3n);
    const call = vaultCopy.swap();
    expect(call.result).toStrictEqual(Cl.error(Cl.uint(104)));
    expect(printEvents(call.events)).toStrictEqual([]);
    expect({ ...vaultCopy.state(), stx: stx() }).toStrictEqual(before);
    setMode(1n);
  });

  it("control: the same adapter takes STX with no allowance", () => {
    const vaultCopy = open("swap-unsafe", 0n);
    const address = `${deployer}.swap-unsafe`;
    simnet.transferSTX(1_000n, address, deployer);
    const stx = () => simnet.getAssetsMap().get("STX")?.get(address) ?? 0n;
    const before = stx();

    setMode(3n);
    expect(vaultCopy.swap().result).toStrictEqual(Cl.ok(Cl.uint(0)));
    expect(before - stx()).toBe(1n);
    setMode(1n);
  });

  it("control: the same adapter takes more with no allowance", () => {
    const vaultCopy = open("swap-unsafe", 0n);
    const before = vaultCopy.state();

    setMode(1n);
    const call = vaultCopy.swap();
    // min-out 0, so the vault accepts receiving nothing; the adapter took 101.
    expect(call.result).toStrictEqual(Cl.ok(Cl.uint(0)));
    const after = vaultCopy.state();
    expect(before.vault[0]! - after.vault[0]!).toBe(101n);
    expect(after.adapter[0]! - before.adapter[0]!).toBe(101n);
  });
});
