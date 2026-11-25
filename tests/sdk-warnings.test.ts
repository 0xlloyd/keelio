import { initSimnet } from "@stacks/clarinet-sdk";
import { Cl } from "@stacks/transactions";
import { describe, expect, it } from "vitest";
import {
  checkIntent,
  DEFAULT_WARNING_THRESHOLDS,
  parseJournal,
  readVault,
  simnetClient,
  tradeWarnings,
  type IntendedTrade,
  type JournalEvent,
  type VaultConfig,
} from "../packages/sdk/src/index.js";
import { PRICE_90K, PRICE_SCALE, floorOf } from "./oracle-fixture.js";
import { SLIPPAGE_BPS, vaultHarness } from "./sdk-fixture.js";

const simnet = await initSimnet();
const accounts = simnet.getAccounts();
const alice = accounts.get("wallet_1")!;
const bob = accounts.get("wallet_2")!;
const carol = accounts.get("wallet_3")!;
const h = vaultHarness(simnet);
const { sbtc, usd, dex } = h;

/** A synthetic execute-swap event with every field the contract prints. */
function swapAt(
  burnHeight: bigint,
  amountIn: bigint,
  over: { owner?: string; tokenIn?: string; tokenOut?: string } = {},
): JournalEvent {
  const [event] = parseJournal([
    {
      burnHeight,
      value: Cl.tuple({
        event: Cl.stringAscii("execute-swap"),
        owner: Cl.principal(over.owner ?? alice),
        agent: Cl.principal(bob),
        adapter: Cl.principal(dex),
        "token-in": Cl.principal(over.tokenIn ?? sbtc),
        "token-out": Cl.principal(over.tokenOut ?? usd),
        "amount-in": Cl.uint(amountIn),
        "min-out": Cl.uint(1),
        "amount-out": Cl.uint(1),
        "balance-in": Cl.uint(0),
        "balance-out": Cl.uint(1),
        "day-total": Cl.uint(amountIn),
        "oracle-price": Cl.uint(1),
        "oracle-timestamp": Cl.uint(1),
        "min-out-floor": Cl.uint(1),
      }),
    },
  ]);
  return event!;
}

function trade(amountIn: bigint, burnHeight: bigint): IntendedTrade {
  return { owner: alice, tokenIn: sbtc, tokenOut: usd, amountIn, burnHeight };
}

const kinds = (...args: Parameters<typeof tradeWarnings>) =>
  tradeWarnings(...args).map((w) => w.kind);

describe("DEFAULT_WARNING_THRESHOLDS", () => {
  it("is the documented set", () => {
    expect(DEFAULT_WARNING_THRESHOLDS).toStrictEqual({
      sizeMultiple: 3n,
      sizeBaseline: "median",
      burstTrades: 3n,
      burstBlocks: 6n,
      quietBlocks: 1008n,
    });
  });
});

describe("tradeWarnings", () => {
  it("returns no warning for a trade like the ones before it", () => {
    const journal = [swapAt(100n, 1_000n), swapAt(200n, 1_200n)];
    expect(tradeWarnings(journal, trade(1_100n, 300n))).toStrictEqual([]);
  });

  describe("FIRST_TRADE_IN_DIRECTION", () => {
    it("warns on an empty journal", () => {
      expect(tradeWarnings([], trade(5n, 10n))).toStrictEqual([
        {
          kind: "FIRST_TRADE_IN_DIRECTION",
          message: "this vault has never sold this token for that one before",
          tokenIn: sbtc,
          tokenOut: usd,
        },
      ]);
    });

    it("counts only this owner and this direction", () => {
      const journal = [
        swapAt(100n, 1_000n, { tokenIn: usd, tokenOut: sbtc }),
        swapAt(101n, 1_000n, { owner: carol }),
      ];
      expect(kinds(journal, trade(1_000n, 110n))).toStrictEqual([
        "FIRST_TRADE_IN_DIRECTION",
      ]);
      // The other direction has its one trade, so it is not a first.
      expect(
        kinds(journal, {
          ...trade(1_000n, 110n),
          tokenIn: usd,
          tokenOut: sbtc,
        }),
      ).toStrictEqual([]);
    });

    it("ignores events after the trade's height", () => {
      expect(kinds([swapAt(500n, 1n)], trade(1n, 499n))).toStrictEqual([
        "FIRST_TRADE_IN_DIRECTION",
      ]);
    });
  });

  describe("LARGE_TRADE", () => {
    // Median of 100, 200, 900 is 200; the largest is 900.
    const journal = [swapAt(10n, 900n), swapAt(20n, 100n), swapAt(30n, 200n)];

    it("warns above the multiple of the median, not at it", () => {
      expect(tradeWarnings(journal, trade(600n, 100n))).toStrictEqual([]);
      expect(tradeWarnings(journal, trade(601n, 100n))).toStrictEqual([
        {
          kind: "LARGE_TRADE",
          message:
            "the amount is more than 3 times the median of this vault's past trades in this direction",
          amountIn: 601n,
          baseline: 200n,
          basis: "median",
          sizeMultiple: 3n,
          pastTrades: 3n,
        },
      ]);
    });

    it("takes the mean of the two middle amounts, rounded down, for an even count", () => {
      // 100, 200, 301, 900: (200 + 301) / 2 = 250.
      const even = [...journal, swapAt(40n, 301n)];
      expect(tradeWarnings(even, trade(750n, 100n))).toStrictEqual([]);
      expect(tradeWarnings(even, trade(751n, 100n))).toMatchObject([
        { kind: "LARGE_TRADE", baseline: 250n, pastTrades: 4n },
      ]);
    });

    it("can compare with the largest past trade and another multiple", () => {
      const t = { sizeBaseline: "largest", sizeMultiple: 2n } as const;
      expect(tradeWarnings(journal, trade(1_800n, 100n), t)).toStrictEqual([]);
      expect(tradeWarnings(journal, trade(1_801n, 100n), t)).toMatchObject([
        {
          kind: "LARGE_TRADE",
          baseline: 900n,
          basis: "largest",
          sizeMultiple: 2n,
        },
      ]);
    });

    it("stays exact for amounts past 2^64", () => {
      const big = 2n ** 100n;
      const past = [swapAt(10n, big)];
      expect(tradeWarnings(past, trade(3n * big, 20n))).toStrictEqual([]);
      expect(kinds(past, trade(3n * big + 1n, 20n))).toStrictEqual([
        "LARGE_TRADE",
      ]);
    });
  });

  describe("BURST", () => {
    it("warns when this is the K-th trade within M burn blocks", () => {
      // Two trades at 95 and 99: at 100 both are within 6 blocks.
      const journal = [swapAt(95n, 1_000n), swapAt(99n, 1_000n)];
      expect(tradeWarnings(journal, trade(1_000n, 100n))).toStrictEqual([
        {
          kind: "BURST",
          message: "this would be trade 3 of this vault within 6 burn blocks",
          trades: 3n,
          burstBlocks: 6n,
        },
      ]);
      // At 101 the trade at 95 has left the 6-block span.
      expect(tradeWarnings(journal, trade(1_000n, 101n))).toStrictEqual([]);
    });

    it("counts trades in either direction, and only this owner's", () => {
      const journal = [
        swapAt(99n, 1_000n),
        swapAt(100n, 900_000n, { tokenIn: usd, tokenOut: sbtc }),
        swapAt(100n, 1_000n, { owner: carol }),
        swapAt(100n, 1_000n, { owner: carol }),
      ];
      expect(tradeWarnings(journal, trade(1_000n, 100n))).toMatchObject([
        { kind: "BURST", trades: 3n },
      ]);
      expect(kinds(journal.slice(1), trade(1_000n, 100n))).toStrictEqual([
        "FIRST_TRADE_IN_DIRECTION",
      ]);
    });

    it("takes its own K and M, and is off for K of 1 or less", () => {
      const journal = [swapAt(90n, 1_000n)];
      const at = (burstTrades: bigint, burstBlocks: bigint) =>
        kinds(journal, trade(1_000n, 100n), { burstTrades, burstBlocks });
      expect(at(2n, 11n)).toStrictEqual(["BURST"]);
      expect(at(2n, 10n)).toStrictEqual([]);
      expect(at(1n, 1_000n)).toStrictEqual([]);
      expect(at(0n, 1_000n)).toStrictEqual([]);
    });
  });

  describe("QUIET_PERIOD", () => {
    it("warns at Q burn blocks since the last trade, not before", () => {
      const journal = [swapAt(50n, 1_000n), swapAt(100n, 1_000n)];
      expect(tradeWarnings(journal, trade(1_000n, 1_107n))).toStrictEqual([]);
      expect(tradeWarnings(journal, trade(1_000n, 1_108n))).toStrictEqual([
        {
          kind: "QUIET_PERIOD",
          message: "this vault's last trade was 1008 burn blocks ago",
          lastTradeHeight: 100n,
          blocksSince: 1_008n,
          quietBlocks: 1_008n,
        },
      ]);
    });

    it("measures from the last trade in either direction", () => {
      const journal = [
        swapAt(100n, 1_000n),
        swapAt(900n, 900_000n, { tokenIn: usd, tokenOut: sbtc }),
      ];
      expect(tradeWarnings(journal, trade(1_000n, 1_200n))).toStrictEqual([]);
    });

    it("takes its own Q, is off at 0, and never fires before any trade", () => {
      const journal = [swapAt(100n, 1_000n)];
      expect(
        kinds(journal, trade(1_000n, 110n), { quietBlocks: 10n }),
      ).toStrictEqual(["QUIET_PERIOD"]);
      expect(
        kinds(journal, trade(1_000n, 5_000n), { quietBlocks: 0n }),
      ).toStrictEqual([]);
      expect(
        kinds([], trade(1_000n, 5_000n), { quietBlocks: 1n }),
      ).toStrictEqual(["FIRST_TRADE_IN_DIRECTION"]);
    });
  });

  it("returns every warning that applies, in a fixed order", () => {
    const journal = [swapAt(10n, 100n), swapAt(11n, 100n), swapAt(12n, 100n)];
    expect(kinds(journal, trade(301n, 12n), { quietBlocks: 0n })).toStrictEqual(
      ["LARGE_TRADE", "BURST"],
    );
    expect(kinds(journal, trade(301n, 2_000n))).toStrictEqual([
      "LARGE_TRADE",
      "QUIET_PERIOD",
    ]);
  });

  it("skips unknown events and swaps with a field missing", () => {
    const good = swapAt(100n, 1_000n);
    const rest = Object.fromEntries(
      Object.entries(good.fields).filter(([name]) => name !== "amount-in"),
    );
    const journal: JournalEvent[] = [
      { ...good, event: "request-approval" },
      { ...good, fields: rest },
      { index: 2, burnHeight: 100n, txId: null, event: "pause", fields: {} },
    ];
    expect(kinds(journal, trade(1_000n, 100n))).toStrictEqual([
      "FIRST_TRADE_IN_DIRECTION",
    ]);
  });

  it("does not change its inputs", () => {
    const journal = [swapAt(10n, 300n), swapAt(11n, 100n)];
    const before = structuredClone(journal);
    const thresholds = { sizeMultiple: 1n };
    tradeWarnings(journal, trade(500n, 12n), thresholds);
    expect(journal).toStrictEqual(before);
    expect(thresholds).toStrictEqual({ sizeMultiple: 1n });
  });
});

describe("tradeWarnings on the contract's own journal", () => {
  const config: VaultConfig = {
    vault: "keelio-vault",
    tokens: [sbtc, usd],
    adapters: [dex],
    oracle: "mock-oracle",
    sbtcToken: sbtc,
    priceScale: PRICE_SCALE,
  };

  it("warns about a trade the contract and checkIntent both accept", async () => {
    h.fundDex();
    h.setUpOwner({
      owner: alice,
      agent: bob,
      deposit: 1_000_000n,
      maxPerTrade: 100_000n,
      maxPerDay: 500_000n,
    });
    const now = () => BigInt(simnet.burnBlockHeight);
    const journal = () => parseJournal(h.records);
    const big = 50_000n;

    // Before any trade: a first in this direction.
    expect(kinds(journal(), trade(1_000n, now()))).toStrictEqual([
      "FIRST_TRADE_IN_DIRECTION",
    ]);
    expect(h.swap(bob, alice, 1_000n).result.type).toBe("ok");
    expect(h.swap(bob, alice, 1_000n).result.type).toBe("ok");

    // The third trade in one burn block, and 50 times the median.
    const warnings = tradeWarnings(journal(), trade(big, now()));
    expect(warnings.map((w) => w.kind)).toStrictEqual(["LARGE_TRADE", "BURST"]);
    expect(warnings[0]).toMatchObject({ baseline: 1_000n, pastTrades: 2n });

    // Advisory: checkIntent says ok, and the contract runs the trade.
    const read = await readVault(simnetClient(simnet, alice), config, alice);
    const verdict = checkIntent(
      {
        ...read,
        burnHeight: now(),
        nowMs: BigInt(simnet.getBlockTime()) * 1000n,
      },
      {
        caller: bob,
        adapter: dex,
        tokenIn: sbtc,
        tokenOut: usd,
        amountIn: big,
        minOut: floorOf(big, PRICE_90K, SLIPPAGE_BPS, true),
      },
    );
    expect(verdict).toStrictEqual({ ok: true });
    expect(h.swap(bob, alice, big).result.type).toBe("ok");

    // A quiet week later the same size is no longer large against a median
    // of 1000, 1000, 50000, but the gap is flagged.
    simnet.mineEmptyBurnBlocks(1008);
    expect(kinds(journal(), trade(3_000n, now()))).toStrictEqual([
      "QUIET_PERIOD",
    ]);
  });
});
