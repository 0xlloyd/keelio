import { readFileSync } from "node:fs";
import { initSimnet, tx, type Tx } from "@stacks/clarinet-sdk";
import { Cl, type ClarityValue } from "@stacks/transactions";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ORACLE_KEY,
  PRICE_90K,
  armOracle,
  floorOf,
  oracleTimestamp,
} from "./oracle-fixture.js";

// Job 025: execute-swap refuses a min-out below a floor the vault computes
// from the fixed oracle's price, and a price older (or further ahead) than the
// owner's max-price-age. Names start with "T3:" so docs/threat-model.md can
// cite them.
//
// Every swap here is mined in one block with the oracle update before it, so
// the price's age is exactly what the test sets: two transactions in one
// block see the same `stacks-block-time`.

const simnet = await initSimnet();
const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const alice = accounts.get("wallet_1")!;
const bob = accounts.get("wallet_2")!;
const carol = accounts.get("wallet_4")!;

const sbtc = `${deployer}.mock-sbtc`;
const usd = `${deployer}.mock-usd`;
const dex = `${deployer}.mock-dex`;
const vault = `${deployer}.keelio-vault`;

const MAX_UINT = 340282366920938463463374607431768211455n;

// The fixture: price $90,000, 100 bps, max-price-age 60 s; mock-dex at 900/1
// for a sale and 1/900 for a buy.
const PRICE = PRICE_90K;
const BPS = 100n;
const MAX_AGE = 60_000n;
const DEPOSIT = 1_000_000n;
const USD_DEPOSIT = 1_000_000_000n;
const AMOUNT_IN = 10_000n;
const USD_IN = 9_000_000n;
const CAP = 10n ** 12n;
const EXPIRES_AT = 1_000_000n;

function readUint(value: ClarityValue, wrappedInOk: boolean): bigint {
  const inner = wrappedInOk && value.type === "ok" ? value.value : value;
  if (inner.type !== "uint")
    throw new Error(`expected uint, got ${inner.type}`);
  return BigInt(inner.value);
}

function ok(call: { result: ClarityValue }) {
  expect(call.result).toStrictEqual(Cl.ok(Cl.bool(true)));
}

function call(
  sender: string,
  contract: string,
  fn: string,
  args: ClarityValue[] = [],
) {
  return simnet.callPublicFn(contract, fn, args, sender);
}

function mint(token: string, amount: bigint, recipient: string) {
  ok(call(deployer, token, "mint", [Cl.uint(amount), Cl.principal(recipient)]));
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
    simnet.callReadOnlyFn(
      "keelio-vault",
      "get-balance",
      [Cl.principal(owner), Cl.principal(token)],
      deployer,
    ).result,
    false,
  );
}

function readOnly(fn: string, args: ClarityValue[]) {
  return simnet.callReadOnlyFn("keelio-vault", fn, args, deployer).result;
}

function bounds(owner: string) {
  return readOnly("get-price-bounds", [Cl.principal(owner)]);
}

function boundsTuple(bps: bigint, age: bigint) {
  return Cl.tuple({
    "max-slippage-bps": Cl.uint(bps),
    "max-price-age": Cl.uint(age),
  });
}

function setBounds(owner: string, bps: bigint, age: bigint) {
  return call(owner, "keelio-vault", "set-price-bounds", [
    Cl.uint(bps),
    Cl.uint(age),
  ]);
}

function setRate(num: bigint, den: bigint) {
  ok(call(deployer, "mock-dex", "set-rate", [Cl.uint(num), Cl.uint(den)]));
}

function setFailing(on: boolean) {
  ok(call(deployer, "mock-oracle", "set-failing", [Cl.bool(on)]));
}

// Sets `token`'s caps, then the owner-wide cooldown and expiry.
function setPolicy(owner: string, token: string, cap = CAP) {
  ok(
    call(owner, "keelio-vault", "set-token-caps", [
      Cl.principal(token),
      Cl.uint(cap),
      Cl.uint(cap),
    ]),
  );
  ok(
    call(owner, "keelio-vault", "set-policy", [
      Cl.uint(0),
      Cl.uint(EXPIRES_AT),
    ]),
  );
}

// Alice's (or Carol's) vault, with Bob as agent and both tokens and the
// adapter allowed. Price bounds are not set here.
function openVault(owner: string) {
  for (const [token, amount] of [
    [sbtc, DEPOSIT],
    [usd, USD_DEPOSIT],
  ] as const) {
    mint(token.split(".")[1]!, amount, owner);
    expect(
      call(owner, "keelio-vault", "deposit", [
        Cl.principal(token),
        Cl.uint(amount),
      ]).result.type,
    ).toBe("ok");
    ok(
      call(owner, "keelio-vault", "allow-token", [
        Cl.principal(token),
        Cl.bool(true),
      ]),
    );
    setPolicy(owner, token);
  }
  ok(
    call(owner, "keelio-vault", "allow-adapter", [
      Cl.principal(dex),
      Cl.bool(true),
    ]),
  );
  ok(call(owner, "keelio-vault", "set-agent", [Cl.principal(bob)]));
  ok(call(owner, "keelio-vault", "unpause"));
}

type Swap = {
  owner?: string;
  sell?: boolean;
  amountIn?: bigint;
  minOut: bigint;
};

function swapTx(s: Swap): Tx {
  const sell = s.sell ?? true;
  return tx.callPublicFn(
    "keelio-vault",
    "execute-swap",
    [
      Cl.principal(s.owner ?? alice),
      Cl.principal(dex),
      Cl.principal(sell ? sbtc : usd),
      Cl.principal(sell ? usd : sbtc),
      Cl.uint(s.amountIn ?? (sell ? AMOUNT_IN : USD_IN)),
      Cl.uint(s.minOut),
    ],
    bob,
  );
}

// The oracle's price as of the block it is mined in: `age` ms before it, or
// `ahead` ms after it.
type Price = { price?: bigint; age?: bigint; ahead?: bigint };

function priceTx({ price = PRICE, age = 0n, ahead }: Price): Tx {
  return ahead === undefined
    ? tx.callPublicFn(
        "mock-oracle",
        "set-value-aged",
        [Cl.stringAscii(ORACLE_KEY), Cl.uint(price), Cl.uint(age)],
        deployer,
      )
    : tx.callPublicFn(
        "mock-oracle",
        "set-value-ahead",
        [Cl.stringAscii(ORACLE_KEY), Cl.uint(price), Cl.uint(ahead)],
        deployer,
      );
}

// Sets the price and swaps in one mined block. Sets the dex rate for the
// direction first (900/1 to sell sBTC, 1/900 to buy it).
function swapAt(s: Swap, p: Price = {}) {
  if (s.sell ?? true) setRate(900n, 1n);
  else setRate(1n, 900n);
  const [priceResult, swapResult] = simnet.mineBlock([priceTx(p), swapTx(s)]);
  if (priceResult!.status === "rejected") throw new Error(priceResult!.error);
  expect(priceResult!.execution.result).toStrictEqual(Cl.ok(Cl.bool(true)));
  if (swapResult!.status === "rejected") throw new Error(swapResult!.error);
  return swapResult!.execution;
}

function snapshot(owner = alice) {
  return {
    ledgers: [sbtc, usd].map((t) => ledger(owner, t)),
    vault: [sbtc, usd].map((t) => wallet(t, vault)),
    dex: [sbtc, usd].map((t) => wallet(t, dex)),
    bob: [sbtc, usd].map((t) => wallet(t, bob)),
    trades: [sbtc, usd].map((t) =>
      readOnly("get-trade-state", [Cl.principal(owner), Cl.principal(t)]),
    ),
  };
}

// A refused swap returns its code, emits no event of any kind (no print, no
// transfer) and changes nothing.
function expectRefused(code: number, s: Swap, p: Price = {}) {
  const before = snapshot(s.owner);
  const result = swapAt(s, p);
  expect(result.result).toStrictEqual(Cl.error(Cl.uint(code)));
  expect(result.events).toStrictEqual([]);
  expect(snapshot(s.owner)).toStrictEqual(before);
}

function expectSwapped(s: Swap, received: bigint, p: Price = {}) {
  const sell = s.sell ?? true;
  const tokenOut = sell ? usd : sbtc;
  const before = ledger(s.owner ?? alice, tokenOut);
  const result = swapAt(s, p);
  expect(result.result).toStrictEqual(Cl.ok(Cl.uint(received)));
  expect(ledger(s.owner ?? alice, tokenOut)).toBe(before + received);
}

beforeAll(() => {
  mint("mock-usd", 10n ** 18n, dex);
  mint("mock-sbtc", 10n ** 15n, dex);
  openVault(alice);
});

beforeEach(() => {
  // A fresh window, the fixture bounds and a working oracle.
  simnet.mineEmptyBurnBlocks(144);
  setFailing(false);
  armOracle(simnet, alice, {
    price: PRICE,
    slippageBps: BPS,
    maxAgeMs: MAX_AGE,
  });
});

describe("keelio-vault oracle floor", () => {
  // Criterion 1
  it("T3: min-out 0 is refused with u125", () => {
    expectRefused(125, { minOut: 0n });
  });

  // Criterion 2
  it("T3: a swap at the floor succeeds and one below it is refused", () => {
    expect(floorOf(AMOUNT_IN, PRICE, BPS, true)).toBe(8_910_000n);
    expectRefused(125, { minOut: 8_909_999n });
    expectSwapped({ minOut: 8_910_000n }, 9_000_000n);

    expect(floorOf(USD_IN, PRICE, BPS, false)).toBe(9_900n);
    expectRefused(125, { sell: false, minOut: 9_899n });
    expectSwapped({ sell: false, minOut: 9_900n }, 10_000n);
  });

  // Criterion 3
  it("T3: the floor rounds up, never in the agent's favour (sell)", () => {
    // Exact value 10_000 × 9_000_000_000_001 × 9_900 / 10^14 = 8_910_000.00000099.
    const price = PRICE + 1n;
    expect(floorOf(AMOUNT_IN, price, BPS, true)).toBe(8_910_001n);
    expectRefused(125, { minOut: 8_910_000n }, { price });
    expectSwapped({ minOut: 8_910_001n }, 9_000_000n, { price });
  });

  it("T3: the floor rounds up, never in the agent's favour (buy)", () => {
    // Exact value 9_000_001 × 10^10 × 9_900 / (9 × 10^12 × 10^4) = 9_900.0011.
    const amountIn = 9_000_001n;
    expect(floorOf(amountIn, PRICE, BPS, false)).toBe(9_901n);
    expectRefused(125, { sell: false, amountIn, minOut: 9_900n });
    expectSwapped({ sell: false, amountIn, minOut: 9_901n }, 10_000n);
  });

  // Criterion 4
  it("T3: a stale price is refused with u123", () => {
    const minOut = 8_910_000n;
    expectSwapped({ minOut }, 9_000_000n, { age: MAX_AGE });
    expectRefused(123, { minOut }, { age: MAX_AGE + 1n });
    expectSwapped({ minOut }, 9_000_000n, { ahead: MAX_AGE });
    expectRefused(123, { minOut }, { ahead: MAX_AGE + 1n });
  });

  // Criterion 5
  it("T3: a zero price is refused with u122", () => {
    expectRefused(122, { minOut: 8_910_000n }, { price: 0n });
    expectRefused(122, { sell: false, minOut: 9_900n }, { price: 0n });
  });

  it("T3: an oracle error is refused with u121", () => {
    setFailing(true);
    try {
      expectRefused(121, { minOut: 8_910_000n });
      expectRefused(121, { sell: false, minOut: 9_900n });
    } finally {
      setFailing(false);
    }
  });

  // Criterion 6
  it("T3: unset price bounds refuse every swap with u119", () => {
    openVault(carol);
    expect(bounds(carol)).toStrictEqual(boundsTuple(0n, 0n));
    // The oracle fails throughout, and u119 still wins: it is never called.
    setFailing(true);
    try {
      expectRefused(119, { owner: carol, minOut: 8_910_000n });
      ok(setBounds(carol, 0n, MAX_AGE));
      expectRefused(119, { owner: carol, minOut: 8_910_000n });
      ok(setBounds(carol, BPS, 0n));
      expectRefused(119, { owner: carol, minOut: 8_910_000n });
    } finally {
      setFailing(false);
    }

    const before = bounds(carol);
    expect(setBounds(carol, 10_000n, MAX_AGE).result).toStrictEqual(
      Cl.error(Cl.uint(120)),
    );
    expect(setBounds(carol, MAX_UINT, MAX_AGE).result).toStrictEqual(
      Cl.error(Cl.uint(120)),
    );
    expect(bounds(carol)).toStrictEqual(before);
    ok(setBounds(carol, 9_999n, MAX_AGE));
    expect(bounds(carol)).toStrictEqual(boundsTuple(9_999n, MAX_AGE));
    // At 9999 bps the floor is 1 basis point of the reference, never 0.
    expect(floorOf(AMOUNT_IN, PRICE, 9_999n, true)).toBe(900n);
    expectRefused(125, { owner: carol, minOut: 899n });
    expectSwapped({ owner: carol, minOut: 900n }, 9_000_000n);
  });

  // Criterion 7
  it("T3: a price that would overflow the floor is refused with u124", () => {
    // Sell: amount-in × price passes u128.
    expectRefused(124, { minOut: MAX_UINT }, { price: MAX_UINT });
    // Buy: price × 10000 passes u128.
    expectRefused(124, { sell: false, minOut: MAX_UINT }, { price: MAX_UINT });
  });

  // Criterion 8: each pair refuses with the earlier code.
  it("T3: the oracle checks come after the policy checks, in order", () => {
    const minOut = 8_910_000n;

    // paused + stale → u109
    ok(call(alice, "keelio-vault", "pause"));
    expectRefused(109, { minOut }, { age: MAX_AGE + 1n });
    ok(call(alice, "keelio-vault", "unpause"));

    // insufficient balance + zero price → u101
    expectRefused(
      101,
      { amountIn: ledger(alice, sbtc) + 1n, minOut },
      { price: 0n },
    );

    // unset bounds + failing oracle → u119
    ok(setBounds(alice, 0n, 0n));
    setFailing(true);
    try {
      expectRefused(119, { minOut });
      ok(setBounds(alice, BPS, MAX_AGE));
      // failing + zero → u121 (failing wins)
      expectRefused(121, { minOut }, { price: 0n });
    } finally {
      setFailing(false);
    }

    // zero + stale → u122
    expectRefused(122, { minOut }, { price: 0n, age: MAX_AGE + 1n });
    // stale + below floor → u123
    expectRefused(123, { minOut: 0n }, { age: MAX_AGE + 1n });
    // overflow + below floor → u124
    expectRefused(124, { minOut: 0n }, { price: MAX_UINT });
  });

  // Criterion 9
  it("T3: PRICE-SCALE matches the mock tokens' decimals", () => {
    const source = readFileSync(
      new URL("../contracts/keelio-vault.clar", import.meta.url),
      "utf8",
    );
    const match = source.match(/\(define-constant PRICE-SCALE u(\d+)\)/);
    expect(match).not.toBeNull();
    const decimals = (token: string) =>
      readUint(
        simnet.callReadOnlyFn(token, "get-decimals", [], deployer).result,
        true,
      );
    expect(BigInt(match![1]!)).toBe(
      10n ** (8n + decimals("mock-sbtc") - decimals("mock-usd")),
    );
    expect(source).toMatch(/\(define-constant ORACLE \.mock-oracle\)/);
  });

  // Criterion 10
  it("T3: set-price-bounds prints its event and writes only the caller's entry", () => {
    const bobBefore = bounds(bob);
    const result = setBounds(alice, 250n, 30_000n);
    expect(result.result).toStrictEqual(Cl.ok(Cl.bool(true)));
    expect(
      result.events
        .filter((e) => e.event === "print_event")
        .map((e) => e.data.value),
    ).toStrictEqual([
      Cl.tuple({
        event: Cl.stringAscii("set-price-bounds"),
        owner: Cl.principal(alice),
        "max-slippage-bps": Cl.uint(250n),
        "max-price-age": Cl.uint(30_000n),
      }),
    ]);
    expect(bounds(alice)).toStrictEqual(boundsTuple(250n, 30_000n));
    expect(bounds(bob)).toStrictEqual(bobBefore);
    // Refused calls print nothing.
    expect(setBounds(alice, 10_000n, 1n).events).toStrictEqual([]);
    expect(bounds(alice)).toStrictEqual(boundsTuple(250n, 30_000n));
  });

  // The journal carries what the floor check used, so an auditor can redo it.
  it("execute-swap prints the oracle price, its timestamp and the floor it applied", () => {
    function swapEvent(s: Swap, received: bigint, price: bigint) {
      const result = swapAt(s, { price, age: 7_000n });
      expect(result.result).toStrictEqual(Cl.ok(Cl.uint(received)));
      const prints = result.events.filter((e) => e.event === "print_event");
      expect(prints).toHaveLength(1);
      const value = prints[0]!.data.value as ClarityValue;
      if (value.type !== "tuple") throw new Error("expected a tuple");
      return value.value;
    }
    // A sale at a price whose floor rounds up, with min-out above the floor:
    // the event carries the floor, not the agent's min-out.
    const price = PRICE + 1n;
    const sale = swapEvent({ minOut: 8_950_000n }, 9_000_000n, price);
    expect(sale["oracle-price"]).toStrictEqual(Cl.uint(price));
    expect(sale["oracle-timestamp"]).toStrictEqual(
      Cl.uint(oracleTimestamp(simnet)),
    );
    expect(sale["min-out-floor"]).toStrictEqual(
      Cl.uint(floorOf(AMOUNT_IN, price, BPS, true)),
    );
    expect(sale["min-out-floor"]).toStrictEqual(Cl.uint(8_910_001n));
    expect(sale["min-out"]).toStrictEqual(Cl.uint(8_950_000n));

    // A buy, where the floor is in sats.
    const amountIn = 9_000_001n;
    const buy = swapEvent(
      { sell: false, amountIn, minOut: 9_950n },
      10_000n,
      PRICE,
    );
    expect(buy["oracle-price"]).toStrictEqual(Cl.uint(PRICE));
    expect(buy["oracle-timestamp"]).toStrictEqual(
      Cl.uint(oracleTimestamp(simnet)),
    );
    expect(buy["min-out-floor"]).toStrictEqual(Cl.uint(9_901n));
    expect(Object.keys(buy).sort()).toStrictEqual(
      [
        "adapter",
        "agent",
        "amount-in",
        "amount-out",
        "balance-in",
        "balance-out",
        "day-total",
        "event",
        "min-out",
        "min-out-floor",
        "oracle-price",
        "oracle-timestamp",
        "owner",
        "token-in",
        "token-out",
      ].sort(),
    );
  });
});

describe("the oracle codes and T3 in the docs", () => {
  const read = (path: string) =>
    readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

  // Criterion 13
  it("docs/errors.md lists u119 to u125 and mock-oracle's u300 once each", () => {
    const rows = read("docs/errors.md")
      .split("\n")
      .filter((line) => line.startsWith("| `"))
      .map((line) =>
        line
          .split("|")
          .slice(1, 3)
          .map((cell) => cell.trim()),
      );
    const count = (contract: string, code: string) =>
      rows.filter(([c, n]) => c === `\`${contract}\`` && n === `\`${code}\``)
        .length;
    for (let n = 119; n <= 125; n++)
      expect(count("keelio-vault", `u${n}`)).toBe(1);
    expect(count("mock-oracle", "u300")).toBe(1);

    const codes = [
      ...read("contracts/keelio-vault.clar").matchAll(/\(err u(\d+)\)/g),
    ].map((m) => m[1]);
    expect(new Set(codes).size).toBe(codes.length);
  });

  // Criterion 12
  it("docs/threat-model.md lists T3 as handled and states its residuals", () => {
    const row = read("docs/threat-model.md")
      .split("\n")
      .find((line) => line.startsWith("| T3 "));
    expect(row).toBeDefined();
    const cells = row!.split("|").map((cell) => cell.trim());
    expect(cells[3]).toBe("handled");
    expect(cells[4]).toContain("single updater key");
    expect(cells[4]).toContain("no confidence value or deviation band");
    expect(cells[4]).toContain("does not see sBTC lose its peg to BTC");
  });
});
