// The dashboard's plain-language policy parser
// (apps/dashboard/src/plain-policy.ts): a fixed set of rules, no model and no
// network. Every amount must come out as an exact bigint, and anything
// ambiguous must be an error, never a guess.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TokenInfo } from "../apps/dashboard/src/chain.js";
import { prepareCall } from "../apps/dashboard/src/flows.js";
import {
  clausesOf,
  FROM_SENTENCE,
  proposePolicy,
  toBaseUnits,
  UNCHANGED,
  type PolicyContext,
  type Proposal,
} from "../apps/dashboard/src/plain-policy.js";

const ADDR = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM";
const sbtc: TokenInfo = {
  id: `${ADDR}.mock-sbtc`,
  name: "mock sBTC",
  symbol: "sBTC",
  decimals: 8,
  unit: "sats",
};
const usd: TokenInfo = {
  id: `${ADDR}.mock-usd`,
  name: "mock USD",
  symbol: "USD",
  decimals: 6,
  unit: "base units",
};

const ctx: PolicyContext = {
  tokens: [sbtc, usd],
  sbtcToken: sbtc.id,
  burnHeight: 1000n,
  current: {
    caps: {
      [sbtc.id]: { maxPerTrade: 10_000_000n, maxPerDay: 30_000_000n },
      [usd.id]: { maxPerTrade: 0n, maxPerDay: 0n },
    },
    thresholds: { [sbtc.id]: null, [usd.id]: null },
    cooldownBlocks: 0n,
    expiresAt: 2000n,
    maxSlippageBps: 100n,
    maxPriceAge: 3_600_000n,
  },
};

const read = (sentence: string, context = ctx): Proposal =>
  proposePolicy(sentence, context);

/** The form values a sentence proposes, by flow, with the token's symbol. */
function proposed(sentence: string, context = ctx): Record<string, unknown> {
  const proposal = read(sentence, context);
  expect(proposal.errors, sentence).toStrictEqual([]);
  expect(proposal.ok, sentence).toBe(true);
  const out: Record<string, unknown> = {};
  for (const flow of proposal.flows) {
    const { token, ...values } = flow.values as Record<string, string>;
    const symbol = context.tokens.find((t) => t.id === token)?.symbol;
    out[symbol === undefined ? flow.id : `${flow.id} ${symbol}`] = values;
  }
  return out;
}

const row = (proposal: Proposal, setting: string) => {
  const found = proposal.rows.find((r) => r.setting === setting);
  if (found === undefined) throw new Error(`no row ${setting}`);
  return found;
};

describe("exact amounts from decimal strings", () => {
  it("turns a decimal string into base units with integer maths", () => {
    expect(toBaseUnits("0.01", 8)).toBe(1_000_000n);
    expect(toBaseUnits("1", 8)).toBe(100_000_000n);
    expect(toBaseUnits("0.00000001", 8)).toBe(1n);
    expect(toBaseUnits("21000000", 8)).toBe(2_100_000_000_000_000n);
    expect(toBaseUnits("1.50", 2)).toBe(150n);
    expect(toBaseUnits("7", 0)).toBe(7n);
    // Past 2^53, where a float would lose the last digits.
    expect(toBaseUnits("90071992547409.93000001", 8)).toBe(
      9_007_199_254_740_993_000_001n,
    );
    // 0.1 + 0.2 is not 0.3 in floating point; here each is exact.
    expect(toBaseUnits("0.3", 8)).toBe(30_000_000n);
    expect(toBaseUnits("0.1", 8)! + toBaseUnits("0.2", 8)!).toBe(30_000_000n);
  });

  it("refuses more decimal places than the unit has, and anything that is not a plain decimal", () => {
    expect(toBaseUnits("0.000000001", 8)).toBeNull();
    expect(toBaseUnits("1.5", 0)).toBeNull();
    // Trailing zeros past the unit's places lose nothing.
    expect(toBaseUnits("0.0100000000", 8)).toBe(1_000_000n);
    for (const text of ["", "1e3", "-1", "+1", ".5", "5.", "1,000", "0x10"]) {
      expect(toBaseUnits(text, 8), text).toBeNull();
    }
  });
});

describe("the brief's example sentence", () => {
  const sentence =
    "let the agent trade up to 0.01 BTC per trade and 0.05 BTC per day, wait 3 blocks between trades, stop after 2 weeks, max slippage 1%, ask me above 0.005 BTC";
  const proposal = read(sentence);

  it("is understood in full", () => {
    expect(proposal.ok).toBe(true);
    expect(proposal.errors).toStrictEqual([]);
    expect(proposal.notUnderstood).toStrictEqual([]);
  });

  it("gives the exact values for the four ordinary forms, as their field text", () => {
    expect(proposal.flows).toStrictEqual([
      {
        id: "set-token-caps",
        title:
          "Caps for mock sBTC: 0.01000000 sBTC per trade, 0.05000000 sBTC per day",
        values: {
          token: sbtc.id,
          maxPerTrade: "1000000",
          maxPerDay: "5000000",
        },
      },
      {
        id: "set-approval-threshold",
        title: "Approval threshold for mock sBTC: ask me above 0.00500000 sBTC",
        values: { token: sbtc.id, threshold: "500000" },
      },
      {
        id: "set-policy",
        title:
          "Cooldown and expiry: 3 burn blocks between trades, expiry at burn height 3016",
        values: { cooldownBlocks: "3", expiresAt: "3016" },
      },
      {
        id: "set-price-bounds",
        title: "Price bounds: 100 bps slippage, price at most 3600000 ms old",
        values: { maxSlippageBps: "100", maxPriceAge: "3600000" },
      },
    ]);
  });

  it("marks each row as from the sentence or unchanged, in base and human units", () => {
    expect(row(proposal, "mock sBTC: max per trade")).toStrictEqual({
      setting: "mock sBTC: max per trade",
      exact: "1000000 sats",
      human: "0.01000000 sBTC",
      source: FROM_SENTENCE,
    });
    expect(row(proposal, "mock sBTC: approval threshold")).toStrictEqual({
      setting: "mock sBTC: approval threshold",
      exact: "500000 sats",
      human:
        "a trade selling more than 500000 sats of mock sBTC (0.00500000 sBTC) needs your approval",
      source: FROM_SENTENCE,
    });
    expect(row(proposal, "Cooldown between trades")).toMatchObject({
      exact: "3 burn blocks",
      human: "about 30 minutes",
      source: FROM_SENTENCE,
    });
    expect(row(proposal, "Policy expires")).toMatchObject({
      exact: "burn height 3016",
      source: FROM_SENTENCE,
    });
    expect(row(proposal, "Max slippage below the oracle price")).toMatchObject({
      exact: "100 bps",
      human: "100 bps (1.00%)",
      source: FROM_SENTENCE,
    });
    // Not in the sentence: shown with the vault's value, marked unchanged.
    expect(row(proposal, "Max price age")).toStrictEqual({
      setting: "Max price age",
      exact: "3600000 ms",
      human: "3600000 ms (60 minutes)",
      source: UNCHANGED,
    });
    expect(row(proposal, "mock USD: max per trade")).toMatchObject({
      exact: "0 base units",
      source: UNCHANGED,
    });
    expect(row(proposal, "mock USD: approval threshold")).toMatchObject({
      exact: "none",
      human: "none: the agent trades alone up to the per-trade cap",
      source: UNCHANGED,
    });
    expect(proposal.rows).toHaveLength(10);
  });

  it("works out the worst case per trade and per day from the caps and the slippage", () => {
    // 1% of 1000000 sats and of 5000000 sats.
    expect(proposal.worstCase[0]).toBe(
      "mock sBTC: one trade can sell at most 0.01000000 sBTC and may settle up to 100 bps (1.00%) below the oracle price, so it can give up at most 10000 sats (0.00010000 sBTC) of value against that price. Over a day (144 burn blocks) the agent can sell at most 0.05000000 sBTC and give up at most 50000 sats (0.00050000 sBTC).",
    );
    expect(proposal.worstCase[1]).toMatch(/^mock USD: no cap is set/);
    expect(proposal.worstCase.at(-1)).toMatch(/do not count the market price/);
  });

  it("says how it converted the two weeks", () => {
    expect(proposal.notes).toStrictEqual([
      "Expiry: 2 weeks is 2016 burn blocks at 10 minutes per burn block, counted from burn height 1000 (now). The vault counts burn blocks, not days, so the real date can come sooner or later.",
    ]);
  });

  it("builds real calls from its form values through the ordinary flows", () => {
    const env = {
      owner: ADDR,
      config: {
        tx: {
          vault: `${ADDR}.keelio-vault`,
          assetNames: { [sbtc.id]: "mock-sbtc", [usd.id]: "mock-usd" },
        },
        read: {
          vault: `${ADDR}.keelio-vault`,
          tokens: [sbtc.id, usd.id],
          adapters: [],
          oracle: `${ADDR}.mock-oracle`,
          sbtcToken: sbtc.id,
          priceScale: 10_000_000_000n,
        },
        tokens: [sbtc, usd],
        adapters: [],
        labels: {},
      },
    };
    for (const flow of proposal.flows) {
      const prepared = prepareCall(env, flow.id, flow.values);
      expect(prepared.ok, flow.id).toBe(true);
      if (prepared.ok) expect(prepared.call.functionName).toBe(flow.id);
    }
  });
});

describe("sentences it understands", () => {
  const cases: [sentence: string, expected: Record<string, unknown>][] = [
    // Caps, in each unit.
    [
      "0.01 BTC per trade",
      {
        "set-token-caps sBTC": {
          maxPerTrade: "1000000",
          maxPerDay: "30000000",
        },
      },
    ],
    [
      "up to 250000 sats per trade and 2000000 sats a day",
      {
        "set-token-caps sBTC": { maxPerTrade: "250000", maxPerDay: "2000000" },
      },
    ],
    [
      "Max 0.1 sBTC each trade; 0.3 sbtc daily.",
      {
        "set-token-caps sBTC": {
          maxPerTrade: "10000000",
          maxPerDay: "30000000",
        },
      },
    ],
    [
      "sell at most 500 USD per trade and 1500.50 USD per day",
      {
        "set-token-caps USD": {
          maxPerTrade: "500000000",
          maxPerDay: "1500500000",
        },
      },
    ],
    [
      "0.01 BTC per trade, 0.05 BTC per day, 900 usd per trade, 2700 usd per day",
      {
        "set-token-caps sBTC": { maxPerTrade: "1000000", maxPerDay: "5000000" },
        "set-token-caps USD": {
          maxPerTrade: "900000000",
          maxPerDay: "2700000000",
        },
      },
    ],
    [
      "trade cap 0.02 BTC and daily limit of 0.04 BTC",
      {
        "set-token-caps sBTC": { maxPerTrade: "2000000", maxPerDay: "4000000" },
      },
    ],
    [
      "no more than 0.2 bitcoin per day",
      {
        "set-token-caps sBTC": {
          maxPerTrade: "10000000",
          maxPerDay: "20000000",
        },
      },
    ],
    [
      "1 satoshi per-trade",
      { "set-token-caps sBTC": { maxPerTrade: "1", maxPerDay: "30000000" } },
    ],
    // The cooldown, in blocks and in time at 10 minutes a block.
    [
      "wait 3 blocks between trades",
      { "set-policy": { cooldownBlocks: "3", expiresAt: "2000" } },
    ],
    [
      "wait 30 minutes between trades",
      { "set-policy": { cooldownBlocks: "3", expiresAt: "2000" } },
    ],
    [
      "cooldown of 2 hours",
      { "set-policy": { cooldownBlocks: "12", expiresAt: "2000" } },
    ],
    [
      "1.5 hours between trades",
      { "set-policy": { cooldownBlocks: "9", expiresAt: "2000" } },
    ],
    // 25 minutes is 2.5 blocks: a cooldown rounds up, the safer way.
    [
      "wait 25 mins between swaps",
      { "set-policy": { cooldownBlocks: "3", expiresAt: "2000" } },
    ],
    [
      "a 6 burn block cooldown",
      { "set-policy": { cooldownBlocks: "6", expiresAt: "2000" } },
    ],
    // The expiry, as a duration from now (burn height 1000) or a height.
    [
      "stop after 2 weeks",
      { "set-policy": { cooldownBlocks: "0", expiresAt: "3016" } },
    ],
    [
      "expire in 3 days",
      { "set-policy": { cooldownBlocks: "0", expiresAt: "1432" } },
    ],
    [
      "let it trade for 1 day",
      { "set-policy": { cooldownBlocks: "0", expiresAt: "1144" } },
    ],
    [
      "stop after 500 blocks",
      { "set-policy": { cooldownBlocks: "0", expiresAt: "1500" } },
    ],
    // 95 minutes is 9.5 blocks: an expiry rounds down, the safer way.
    [
      "stops in 95 minutes",
      { "set-policy": { cooldownBlocks: "0", expiresAt: "1009" } },
    ],
    [
      "until burn height 900000",
      { "set-policy": { cooldownBlocks: "0", expiresAt: "900000" } },
    ],
    [
      "expires at block 1000",
      { "set-policy": { cooldownBlocks: "0", expiresAt: "1000" } },
    ],
    [
      "wait 1 hour between trades and stop at block height 5000",
      { "set-policy": { cooldownBlocks: "6", expiresAt: "5000" } },
    ],
    // Slippage, as a percentage or in basis points.
    [
      "max slippage 1%",
      { "set-price-bounds": { maxSlippageBps: "100", maxPriceAge: "3600000" } },
    ],
    [
      "slippage of 0.5 percent",
      { "set-price-bounds": { maxSlippageBps: "50", maxPriceAge: "3600000" } },
    ],
    [
      "slippage at most 25 bps",
      { "set-price-bounds": { maxSlippageBps: "25", maxPriceAge: "3600000" } },
    ],
    [
      "0.01% slippage",
      { "set-price-bounds": { maxSlippageBps: "1", maxPriceAge: "3600000" } },
    ],
    [
      "maximum slippage: 99.99%",
      {
        "set-price-bounds": { maxSlippageBps: "9999", maxPriceAge: "3600000" },
      },
    ],
    [
      "30 basis points slippage",
      { "set-price-bounds": { maxSlippageBps: "30", maxPriceAge: "3600000" } },
    ],
    // The price's age, exact to the millisecond.
    [
      "price at most 10 minutes old",
      { "set-price-bounds": { maxSlippageBps: "100", maxPriceAge: "600000" } },
    ],
    [
      "max price age 90 seconds",
      { "set-price-bounds": { maxSlippageBps: "100", maxPriceAge: "90000" } },
    ],
    [
      "reject prices older than 2 hours",
      { "set-price-bounds": { maxSlippageBps: "100", maxPriceAge: "7200000" } },
    ],
    [
      "oracle price no older than 1500 ms",
      { "set-price-bounds": { maxSlippageBps: "100", maxPriceAge: "1500" } },
    ],
    [
      "slippage 2% and price age 0.5 hours",
      { "set-price-bounds": { maxSlippageBps: "200", maxPriceAge: "1800000" } },
    ],
    // The approval threshold.
    [
      "ask me above 0.005 BTC",
      { "set-approval-threshold sBTC": { threshold: "500000" } },
    ],
    [
      "ask me first for any trade over 100000 sats",
      { "set-approval-threshold sBTC": { threshold: "100000" } },
    ],
    [
      "trades above 250 USD need my approval",
      { "set-approval-threshold USD": { threshold: "250000000" } },
    ],
    [
      "approval threshold of 0.002 btc",
      { "set-approval-threshold sBTC": { threshold: "200000" } },
    ],
    [
      "check with me before anything more than 0.001 BTC per trade",
      { "set-approval-threshold sBTC": { threshold: "100000" } },
    ],
    // The same value twice is not a contradiction.
    [
      "0.01 BTC per trade and 1000000 sats per trade",
      {
        "set-token-caps sBTC": {
          maxPerTrade: "1000000",
          maxPerDay: "30000000",
        },
      },
    ],
  ];

  it.each(cases)("%s", (sentence, expected) => {
    expect(proposed(sentence)).toStrictEqual(expected);
    expect(read(sentence).notUnderstood).toStrictEqual([]);
  });

  it("is the same whatever the case, spacing or line breaks", () => {
    const a = read("0.01 BTC per trade, wait 3 blocks between trades");
    const b = read("  0.01btc  PER TRADE\nWait   3 Blocks between trades.  ");
    expect(b).toStrictEqual(a);
    // And the same sentence always reads the same.
    expect(
      read("0.01 BTC per trade, wait 3 blocks between trades"),
    ).toStrictEqual(a);
  });

  it("says when it rounded a time to burn blocks", () => {
    expect(read("wait 25 minutes between trades").notes).toStrictEqual([
      "Cooldown: 25 minutes is 3 burn blocks at 10 minutes per burn block, rounded up. The vault counts burn blocks, not minutes, and a real block can take more or less than 10 minutes.",
    ]);
    expect(read("stop in 95 minutes").notes[0]).toMatch(
      /^Expiry: 95 minutes is 9 burn blocks at 10 minutes per burn block, rounded down, counted from burn height 1000/,
    );
    // A cooldown given in blocks needs no conversion, so no note.
    expect(read("wait 3 blocks between trades").notes).toStrictEqual([]);
  });

  it("notes a threshold that can never apply, and unset values the sentence leaves unset", () => {
    expect(
      read("0.01 BTC per trade, 0.05 BTC per day, ask me above 0.01 BTC").notes,
    ).toStrictEqual([
      "For mock sBTC the approval threshold (0.01000000 sBTC) is not below the per-trade cap (0.01000000 sBTC), so no trade can be above it and inside the cap: the agent would never need to ask.",
    ]);
    const fresh: PolicyContext = {
      ...ctx,
      current: {
        ...ctx.current,
        expiresAt: 0n,
        maxSlippageBps: 0n,
        maxPriceAge: 0n,
      },
    };
    expect(read("wait 3 blocks between trades", fresh).notes).toStrictEqual([
      "No expiry is set (burn height 0) and the sentence states none, so the agent may not trade until you set one.",
    ]);
    const bounds = read("max slippage 1%", fresh);
    expect(bounds.notes).toStrictEqual([
      "No price age is set and the sentence states none, so the agent may not trade until you set one.",
    ]);
    expect(row(bounds, "Max price age")).toMatchObject({
      exact: "0 ms",
      human: "not set: the agent may not trade",
      source: UNCHANGED,
    });
    // With no slippage bound there is no worst case to compute.
    expect(read("0.01 BTC per trade", fresh).worstCase[0]).toBe(
      "mock sBTC: the slippage bound is not set, so the agent may not trade and there is no worst case to work out yet.",
    );
  });

  it("rounds the worst case up, in integer maths", () => {
    // 1 bps of 15 sats is 0.0015 sats: at most 1 sat, never 0.
    const proposal = read(
      "15 sats per trade, 150 sats per day, slippage 1 bps",
    );
    expect(proposal.worstCase[0]).toContain(
      "give up at most 1 sats (0.00000001 sBTC) of value against that price",
    );
    expect(proposal.worstCase[0]).toContain(
      "give up at most 1 sats (0.00000001 sBTC).",
    );
    // An amount far past 2^53 keeps every digit.
    const big = read("90071992547409.93 BTC per day");
    expect(big.errors).toStrictEqual([]);
    expect(row(big, "mock sBTC: max per day (144 burn blocks)").exact).toBe(
      "9007199254740993000000 sats",
    );
  });
});

describe("what it does not understand is listed, never dropped", () => {
  it("lists a clause with no rule, and still proposes the rest", () => {
    const proposal = read(
      "0.01 BTC per trade, only on weekdays, and be careful",
    );
    expect(proposal.ok).toBe(true);
    expect(proposal.notUnderstood).toStrictEqual([
      "only on weekdays",
      "be careful",
    ]);
    expect(proposal.flows.map((f) => f.id)).toStrictEqual(["set-token-caps"]);
  });

  it("lists the words around a rule it did understand", () => {
    expect(read("0.01 BTC per trade on mondays").notUnderstood).toStrictEqual([
      '"mondays" in "0.01 btc per trade on mondays"',
    ]);
  });

  it("lists a negation with no number instead of acting on it", () => {
    const proposal = read("0.01 BTC per trade, no cooldown");
    expect(proposal.ok).toBe(true);
    expect(proposal.notUnderstood).toStrictEqual(["no cooldown"]);
    expect(row(proposal, "Cooldown between trades").source).toBe(UNCHANGED);
  });
});

describe("sentences it must reject", () => {
  const rejected = (sentence: string, context = ctx): string[] => {
    const proposal = read(sentence, context);
    expect(proposal.ok, sentence).toBe(false);
    // A rejected sentence proposes no form at all.
    expect(proposal.flows, sentence).toStrictEqual([]);
    expect(proposal.errors.length, sentence).toBeGreaterThan(0);
    return proposal.errors;
  };

  it("an empty sentence", () => {
    for (const text of ["", "   ", "\n", ",.;"]) {
      expect(rejected(text)[0]).toMatch(/^Write a sentence first/);
    }
  });

  it("a sentence with no limit in it", () => {
    const proposal = read("please be careful with my money");
    expect(proposal.ok).toBe(false);
    expect(proposal.errors[0]).toMatch(/^Nothing in the sentence set a limit/);
    expect(proposal.notUnderstood).toStrictEqual([
      "please be careful with my money",
    ]);
  });

  it("an amount with no unit: an error, not a guess", () => {
    expect(rejected("0.01 per trade")).toStrictEqual([
      '"0.01 per trade" has no unit, so the amount could mean anything. Write it with a unit: BTC, sats, USD.',
    ]);
    expect(rejected("0.01 BTC per trade and 0.05 per day")).toStrictEqual([
      '"0.05 per day" has no unit, so the amount could mean anything. Write it with a unit: BTC, sats, USD.',
    ]);
    expect(rejected("ask me above 5000")[0]).toMatch(
      /^"ask me above 5000" has no unit/,
    );
  });

  it.each([
    // A number the rules cannot place.
    "trade up to 0.01 BTC",
    "0.01",
    "wait 3 between trades",
    "stop after 2",
    "slippage 1",
    "500 dollars per trade",
    "$500 per trade",
    "0.01 ETH per trade",
    // A unit the rules do not know, or one that is ambiguous.
    "stop after 2 months",
    "stop after 1 year",
    // Numbers that are not plain decimals.
    "1,000 sats per trade",
    "1e6 sats per trade",
    "-5 sats per trade",
    ".5 BTC per trade",
    "0.01-0.05 BTC per trade",
    "1.5.2 BTC per trade",
    "0x10 sats per trade",
  ])("a number it cannot place: %s", (sentence) => {
    const errors = rejected(sentence);
    expect(errors.join(" ")).toMatch(/Could not tell what|has no unit/);
  });

  it("one amount given two scopes", () => {
    expect(rejected("trade limit 0.01 BTC per day")).toStrictEqual([
      '"trade limit 0.01 btc per day" names both a trade and a day for one amount. State each cap on its own, for example "0.01 BTC per trade and 0.05 BTC per day".',
    ]);
    expect(rejected("daily cap of 0.05 BTC per trade")[0]).toMatch(
      /names both a trade and a day/,
    );
  });

  it("an amount finer than the token's smallest unit", () => {
    expect(rejected("0.000000001 BTC per trade")).toStrictEqual([
      '"0.000000001 btc" has more than 8 decimal places, so it is not a whole number of sats.',
    ]);
    expect(rejected("1.5 sats per trade")).toStrictEqual([
      '"1.5 sats" is not a whole number of sats.',
    ]);
    expect(rejected("0.0000001 USD per trade")[0]).toMatch(
      /more than 6 decimal places/,
    );
  });

  it("a negation with a number", () => {
    expect(rejected("don't trade more than 0.01 BTC per trade")[0]).toMatch(
      /says "don't", and this parser does not read negations/,
    );
    expect(rejected("never ask me above 0.005 BTC")[0]).toMatch(/says "never"/);
    expect(
      rejected("0.01 BTC per trade except 0.05 BTC on fridays")[0],
    ).toMatch(/says "except"/);
  });

  it("the same setting stated twice with different values", () => {
    expect(rejected("0.01 BTC per trade and 0.02 BTC per trade")).toStrictEqual(
      [
        "The sentence states the per-trade cap for mock sBTC twice, with different values. State it once.",
      ],
    );
    expect(rejected("slippage 1%, slippage 2%")[0]).toMatch(
      /states the slippage twice/,
    );
    expect(rejected("stop after 2 weeks, until block 5000")[0]).toMatch(
      /states the expiry twice/,
    );
  });

  it("a day cap below the trade cap, stated or left unchanged", () => {
    expect(rejected("0.05 BTC per trade and 0.01 BTC per day")[0]).toBe(
      "For mock sBTC the day cap (0.01000000 sBTC) would be below the trade cap (0.05000000 sBTC), which the vault refuses. State both caps, with the day cap at least the trade cap.",
    );
    // The vault's day cap is 0.3 sBTC, and the sentence leaves it alone.
    expect(rejected("0.5 BTC per trade")[0]).toBe(
      "For mock sBTC the day cap (0.30000000 sBTC, unchanged) would be below the trade cap (0.50000000 sBTC), which the vault refuses. State both caps, with the day cap at least the trade cap.",
    );
    expect(rejected("5 USD per trade")[0]).toMatch(
      /^For mock USD the day cap \(0\.000000 USD, unchanged\)/,
    );
  });

  it("a slippage the vault refuses or that stops the agent", () => {
    expect(rejected("slippage 100%")[0]).toBe(
      "A slippage of 10000 bps (100.00%) is 100% or more, which the vault refuses.",
    );
    expect(rejected("slippage 20000 bps")[0]).toMatch(/100% or more/);
    expect(rejected("slippage 0%")[0]).toMatch(/^A slippage of 0 means/);
    expect(rejected("slippage 0.001%")[0]).toBe(
      '"0.001%" is not a whole number of basis points: use at most two decimal places.',
    );
    expect(rejected("slippage 1.5 bps")[0]).toBe(
      '"1.5 bps" is not a whole number of basis points.',
    );
  });

  it("a time the vault cannot hold", () => {
    expect(rejected("wait 1.5 blocks between trades")[0]).toBe(
      '"1.5 blocks" is not a whole number of burn blocks.',
    );
    expect(rejected("price at most 3 blocks old")[0]).toMatch(
      /is in burn blocks, but the vault measures the price's age in time/,
    );
    expect(rejected("price at most 0 seconds old")[0]).toMatch(
      /^A price age of 0 means/,
    );
    expect(rejected("price at most 0.0001 seconds old")[0]).toBe(
      '"0.0001 seconds" is not a whole number of milliseconds.',
    );
  });

  it("an expiry height that has already passed", () => {
    expect(rejected("until burn height 999")).toStrictEqual([
      "Burn height 999 has already passed (it is now 1000), so the policy would be expired at once.",
    ]);
    expect(rejected("until block 12.5")).toStrictEqual([
      '"12.5" is not a whole burn height.',
    ]);
  });

  it("a value too large for the vault", () => {
    const huge = "9".repeat(40);
    expect(rejected(`${huge} sats per trade`)[0]).toMatch(
      /is too large for the vault/,
    );
    expect(rejected(`until burn height ${huge}`)[0]).toMatch(
      /is too large for the vault/,
    );
  });

  it("keeps every error when a sentence has several", () => {
    const errors = rejected("0.01 per trade, slippage 100%, wait 2 months");
    expect(errors).toHaveLength(3);
  });

  it("never throws, whatever the text", () => {
    const pieces = [
      "0.01",
      "btc",
      "per trade",
      "per day",
      "wait",
      "3",
      "blocks",
      "%",
      "slippage",
      "ask me above",
      ",",
      ".",
      "and",
      "-",
      "$",
      "1e9",
      "—",
      "not",
      "sats",
      "until block",
      "for",
      "weeks",
      "price",
      "old",
      "()",
      "[",
    ];
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
    for (let i = 0; i < 400; i++) {
      const text = Array.from(
        { length: 1 + (next() % 8) },
        () => pieces[next() % pieces.length]!,
      ).join(next() % 3 === 0 ? "" : " ");
      const proposal = read(text);
      expect(proposal.ok && proposal.errors.length > 0, text).toBe(false);
      if (!proposal.ok) expect(proposal.flows, text).toStrictEqual([]);
    }
  });
});

describe("the parser's source", () => {
  const source = readFileSync(
    join(import.meta.dirname, "../apps/dashboard/src/plain-policy.ts"),
    "utf8",
  );

  it("never parses a number through a float", () => {
    expect(source).not.toMatch(/parseFloat|parseInt|Number\(|Math\./);
    // Decimal places and block counts are the only `number`s it holds.
    expect(source).not.toMatch(/\bNumber\b|toFixed|toPrecision/);
  });

  it("uses no network and no model", () => {
    expect(source).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket|import\(/);
    expect(source).not.toMatch(/from "(?!\.\/)/);
  });
});

describe("clauses", () => {
  it("splits on separators but not inside a number", () => {
    expect(clausesOf("0.01 BTC per trade, 0.05 BTC per day.")).toStrictEqual([
      "0.01 btc per trade",
      "0.05 btc per day",
    ]);
    expect(clausesOf("1,000 sats per trade")).toStrictEqual([
      "1,000 sats per trade",
    ]);
    expect(clausesOf("a; b and c then d\ne")).toStrictEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
    expect(clausesOf("not more than 5-minute gaps")).toStrictEqual([
      "at most 5 minute gaps",
    ]);
  });
});
