import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cl } from "@stacks/transactions";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ALERT_CODES,
  createMonitor,
  DEFAULT_THRESHOLDS,
  evaluate,
  fileStore,
  initialState,
  memoryStore,
  parseConfig,
  type Alert,
} from "../packages/monitor/src/index.js";
import { DEFAULT_WARNING_THRESHOLDS } from "../packages/sdk/src/index.js";
import {
  codes,
  monitorFixture,
  only,
  type MonitorFixture,
} from "./monitor-fixture.js";
import { PRICE_90K } from "./oracle-fixture.js";

// R2 of docs/requirements-trustshift.md: the advisory alerts raised with a
// trade that is unlike the vault's earlier ones. Trades are made by the real
// contract on the simnet unless a test says its records are written by hand.

const UNUSUAL = [
  "TRADE_FIRST_IN_DIRECTION",
  "TRADE_LARGE",
  "TRADE_BURST",
  "TRADE_AFTER_QUIET",
] as const;

let f: MonitorFixture;

function unusual(alerts: readonly Alert[]) {
  return codes(alerts).filter((c) =>
    (UNUSUAL as readonly string[]).includes(c),
  );
}

/** Alice's vault, open and polled once. */
async function opened() {
  f.open();
  await f.monitor.poll();
}

/** Alice's vault with one sale of `amount` sats behind it, 10 blocks ago. */
async function traded(amount = 10_000n) {
  await opened();
  f.swap(amount);
  f.mine(10);
  await f.monitor.poll();
}

beforeEach(async () => {
  f = await monitorFixture();
});

describe("the unusual-trade alerts", () => {
  it("are advisory: info, with the SDK's default thresholds", () => {
    for (const code of UNUSUAL) expect(ALERT_CODES[code]).toBe("info");
    expect(DEFAULT_THRESHOLDS).toMatchObject({
      tradeSizeMultiple: DEFAULT_WARNING_THRESHOLDS.sizeMultiple,
      tradeBurstTrades: DEFAULT_WARNING_THRESHOLDS.burstTrades,
      tradeBurstBlocks: DEFAULT_WARNING_THRESHOLDS.burstBlocks,
      tradeQuietBlocks: DEFAULT_WARNING_THRESHOLDS.quietBlocks,
    });
  });

  it("raise nothing for a trade like the ones before it", async () => {
    await traded();
    f.swap(10_000n);
    expect(codes(await f.monitor.poll())).toStrictEqual(["SWAP"]);
  });

  it("TRADE_FIRST_IN_DIRECTION: raised once, with the vault's first sale of a token for another", async () => {
    await opened();
    f.swap(10_000n);
    const alerts = await f.monitor.poll();
    expect(codes(alerts)).toStrictEqual(["SWAP", "TRADE_FIRST_IN_DIRECTION"]);
    expect(alerts[1]).toStrictEqual({
      id: "event:8:TRADE_FIRST_IN_DIRECTION",
      code: "TRADE_FIRST_IN_DIRECTION",
      severity: "info",
      owner: f.alice,
      burnHeight: f.height().toString(),
      message: `this vault's first trade selling ${f.sbtc} for ${f.usd}: 10000 sold`,
      details: { tokenIn: f.sbtc, tokenOut: f.usd, amountIn: "10000" },
    });
    f.mine(10);
    f.swap(10_000n);
    expect(codes(await f.monitor.poll())).toStrictEqual(["SWAP"]);
  });

  it("TRADE_FIRST_IN_DIRECTION: each owner has their own history", async () => {
    f.open(f.alice);
    f.open(f.carol);
    f.swap(10_000n, f.alice);
    await f.monitor.poll();
    f.mine(10);
    f.swap(10_000n, f.carol);
    const first = only(await f.monitor.poll(), "TRADE_FIRST_IN_DIRECTION");
    expect(first.owner).toBe(f.carol);
  });

  it("TRADE_LARGE: not raised at exactly 3 times the median, raised one sat above it", async () => {
    await traded(10_000n);
    f.swap(10_000n);
    f.mine(10);
    f.swap(30_000n);
    f.mine(10);
    // The median of 10_000, 10_000 and 30_000 is still 10_000.
    expect(unusual(await f.monitor.poll())).toStrictEqual([]);
    f.swap(30_001n);
    const alerts = await f.monitor.poll();
    expect(codes(alerts)).toStrictEqual(["SWAP", "TRADE_LARGE"]);
    expect(alerts[1]).toMatchObject({
      severity: "info",
      owner: f.alice,
      message:
        `30001 of ${f.sbtc} sold, more than 3 times the median 10000 ` +
        "of this vault's 3 earlier trades in this direction",
      details: {
        tokenIn: f.sbtc,
        tokenOut: f.usd,
        amountIn: "30001",
        median: "10000",
        sizeMultiple: "3",
        pastTrades: "3",
      },
    });
  });

  it("TRADE_LARGE: the multiple is a threshold", async () => {
    await traded(10_000n);
    f.swap(20_001n);
    const state = await f.monitor.state();
    const at = (tradeSizeMultiple: bigint) =>
      f.watch({ tradeSizeMultiple }, memoryStore(state)).poll();
    expect(unusual(await at(3n))).toStrictEqual([]);
    expect(unusual(await at(2n))).toStrictEqual(["TRADE_LARGE"]);
  });

  it("TRADE_BURST: raised with the third trade inside 6 burn blocks, not with one a block later", async () => {
    await opened();
    f.swap(10_000n);
    f.mine(3);
    f.swap(10_000n);
    f.mine(2);
    // Heights h, h + 3 and h + 5: three within 6 burn blocks.
    f.swap(10_000n);
    const alerts = await f.monitor.poll();
    expect(codes(alerts)).toStrictEqual([
      "SWAP",
      "TRADE_FIRST_IN_DIRECTION",
      "SWAP",
      "SWAP",
      "TRADE_BURST",
    ]);
    expect(alerts[4]).toMatchObject({
      id: "event:10:TRADE_BURST",
      severity: "info",
      message: "trade 3 of this vault within 6 burn blocks",
      details: { trades: "3", burstBlocks: "6" },
    });
    // h + 3, h + 5 and h + 9 are three within 7 burn blocks, not 6.
    f.mine(4);
    f.swap(10_000n);
    expect(codes(await f.monitor.poll())).toStrictEqual(["SWAP"]);
  });

  it("TRADE_BURST: 1 for tradeBurstTrades turns it off", async () => {
    await opened();
    f.swap(10_000n);
    f.swap(10_000n);
    f.swap(10_000n);
    expect(
      unusual(await f.watch({ tradeBurstTrades: 1n }).poll()),
    ).toStrictEqual(["TRADE_FIRST_IN_DIRECTION"]);
  });

  it("TRADE_AFTER_QUIET: not raised 1007 burn blocks after the last trade, raised at 1008", async () => {
    await opened();
    f.swap(10_000n);
    const first = f.height();
    f.mine(1007);
    f.swap(10_000n);
    expect(codes(await f.monitor.poll())).toStrictEqual([
      "SWAP",
      "TRADE_FIRST_IN_DIRECTION",
      "SWAP",
    ]);
    f.mine(1008);
    f.swap(10_000n);
    const alerts = await f.monitor.poll();
    expect(codes(alerts)).toStrictEqual(["SWAP", "TRADE_AFTER_QUIET"]);
    expect(alerts[1]).toMatchObject({
      severity: "info",
      message:
        "this vault's first trade in 1008 burn blocks; " +
        `the one before was at burn height ${first + 1007n}`,
      details: {
        lastTradeHeight: (first + 1007n).toString(),
        blocksSince: "1008",
        quietBlocks: "1008",
      },
    });
  });

  it("TRADE_AFTER_QUIET: 0 for tradeQuietBlocks turns it off", async () => {
    await opened();
    f.swap(10_000n);
    f.mine(1008);
    f.swap(10_000n);
    expect(
      unusual(await f.watch({ tradeQuietBlocks: 0n }).poll()),
    ).toStrictEqual(["TRADE_FIRST_IN_DIRECTION"]);
  });
});

describe("an owner-approved trade is a trade", () => {
  const THRESHOLD = 20_000n;

  it("raises the alerts itself, and is history for the trades after it", async () => {
    await opened();
    f.setThreshold(THRESHOLD);
    f.request(30_000n);
    f.approve(30_000n);
    const approved = await f.monitor.poll();
    expect(codes(approved)).toStrictEqual([
      "APPROVAL_THRESHOLD_SET",
      "SWAP_REQUESTED",
      "SWAP",
      "TRADE_FIRST_IN_DIRECTION",
    ]);
    expect(approved[3]!.id).toBe("event:10:TRADE_FIRST_IN_DIRECTION");
    // The agent's own swap is not the first in this direction: the approved
    // one was. With it, and the next, there are three inside 6 burn blocks.
    f.swap(10_000n);
    expect(codes(await f.monitor.poll())).toStrictEqual(["SWAP"]);
    f.request(30_000n);
    f.approve(30_000n);
    expect(unusual(await f.monitor.poll())).toStrictEqual(["TRADE_BURST"]);
  });

  it("is measured against the median, and counts in it", async () => {
    await traded(5_000n);
    f.setThreshold(THRESHOLD);
    // More than 3 times 5_000.
    f.request(20_001n);
    f.approve(20_001n);
    const large = only(await f.monitor.poll(), "TRADE_LARGE");
    expect(large.details).toMatchObject({ amountIn: "20001", median: "5000" });
    f.mine(10);
    // The median of 5_000 and 20_001 is 12_500, so 37_500 is exactly 3 times.
    f.request(37_500n);
    f.approve(37_500n);
    expect(unusual(await f.monitor.poll())).toStrictEqual([]);
  });

  it("a request alone is not a trade", async () => {
    await opened();
    f.setThreshold(THRESHOLD);
    f.request(30_000n);
    f.vault(f.alice, "reject-swap");
    expect(unusual(await f.monitor.poll())).toStrictEqual([]);
    f.swap(10_000n);
    expect(unusual(await f.monitor.poll())).toStrictEqual([
      "TRADE_FIRST_IN_DIRECTION",
    ]);
  });
});

describe("restarts", () => {
  it("a restart neither repeats an unusual-trade alert nor raises one for old history", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "keelio-monitor-")), "s.json");
    const start = () =>
      createMonitor({ chain: f.chain, read: f.read, store: fileStore(path) });

    f.open();
    f.swap(10_000n);
    f.swap(10_000n);
    const first = await start().poll();
    expect(unusual(first)).toStrictEqual(["TRADE_FIRST_IN_DIRECTION"]);

    // A new process with the saved cursor: the old trades raise nothing.
    expect(await start().poll()).toStrictEqual([]);

    // The trades before the restart are still the history: this one is the
    // third in the burst and far above their median, and is not a first.
    f.swap(30_001n);
    const second = await start().poll();
    expect(second.map((a) => a.id)).toStrictEqual([
      "event:10:SWAP",
      "event:10:TRADE_LARGE",
      "event:10:TRADE_BURST",
    ]);
    expect(await start().poll()).toStrictEqual([]);

    // A monitor that never restarted raises exactly the same.
    const whole = await createMonitor({
      chain: f.chain,
      read: f.read,
      store: memoryStore(),
    }).poll();
    expect([...first, ...second].map((a) => a.id)).toStrictEqual(
      whole.map((a) => a.id),
    );
  });
});

describe("evaluate, with records written by hand", () => {
  const sale = (
    amountIn: bigint,
    burnHeight: bigint,
    event = "execute-swap",
    tokens?: { tokenIn: string; tokenOut: string },
  ) => ({
    burnHeight,
    value: Cl.tuple({
      event: Cl.stringAscii(event),
      owner: Cl.principal(f.alice),
      agent: Cl.principal(f.bob),
      adapter: Cl.principal(f.dex),
      "token-in": Cl.principal(tokens?.tokenIn ?? f.sbtc),
      "token-out": Cl.principal(tokens?.tokenOut ?? f.usd),
      "amount-in": Cl.uint(amountIn),
      "min-out": Cl.uint(1),
      "amount-out": Cl.uint(2),
      "balance-in": Cl.uint(0),
      "balance-out": Cl.uint(2),
      "day-total": Cl.uint(amountIn),
      "oracle-price": Cl.uint(PRICE_90K),
      "oracle-timestamp": Cl.uint(1),
      "min-out-floor": Cl.uint(1),
      ...(event === "approve-swap" ? { "requested-at": Cl.uint(1) } : {}),
    }),
  });
  const base = {
    thresholds: DEFAULT_THRESHOLDS,
    refusals: [],
    vaults: {},
    burnHeight: 5000n,
    blockTimeMs: 0n,
  };
  const after = (
    history: ReturnType<typeof sale>[],
    event: ReturnType<typeof sale>,
  ) => {
    const state = initialState();
    state.cursor.events = history.length;
    return evaluate({ ...base, state, history, events: [event] }).alerts;
  };

  it("checks nothing when the earlier journal is not handed over", () => {
    const { alerts } = evaluate({
      ...base,
      state: initialState(),
      events: [sale(10n, 100n), sale(10n, 100n), sale(1000n, 100n)],
    });
    expect(codes(alerts)).toStrictEqual(["SWAP", "SWAP", "SWAP"]);
  });

  it("compares a trade with the records before it in the same poll", () => {
    const { alerts } = evaluate({
      ...base,
      state: initialState(),
      history: [],
      events: [sale(10n, 100n), sale(10n, 200n), sale(31n, 300n)],
    });
    expect(alerts.map((a) => a.id)).toStrictEqual([
      "event:0:SWAP",
      "event:0:TRADE_FIRST_IN_DIRECTION",
      "event:1:SWAP",
      "event:2:SWAP",
      "event:2:TRADE_LARGE",
    ]);
  });

  it("the other direction is a first of its own, and has its own median", () => {
    const back = { tokenIn: f.usd, tokenOut: f.sbtc };
    const history = [sale(10n, 100n), sale(10n, 200n)];
    expect(
      unusual(after(history, sale(9000n, 300n, "execute-swap", back))),
    ).toStrictEqual(["TRADE_FIRST_IN_DIRECTION"]);
    expect(
      unusual(
        after(
          [...history, sale(9000n, 300n, "execute-swap", back)],
          sale(9000n, 400n, "execute-swap", back),
        ),
      ),
    ).toStrictEqual([]);
  });

  it("counts an approve-swap in the history under either name", () => {
    const history = [sale(10n, 100n, "approve-swap")];
    expect(unusual(after(history, sale(10n, 200n)))).toStrictEqual([]);
    expect(
      unusual(after(history, sale(31n, 200n, "approve-swap"))),
    ).toStrictEqual(["TRADE_LARGE"]);
  });

  it("an even count's median is the mean of the middle two, rounded down, in whole base units", () => {
    // Far past 2^53: the median of 10^30 and 10^30 + 3 is 10^30 + 1.
    const big = 10n ** 30n;
    const history = [sale(big, 100n), sale(big + 3n, 200n)];
    const limit = 3n * (big + 1n);
    expect(unusual(after(history, sale(limit, 300n)))).toStrictEqual([]);
    const alert = only(after(history, sale(limit + 1n, 300n)), "TRADE_LARGE");
    expect(alert.details).toMatchObject({
      amountIn: (limit + 1n).toString(),
      median: (big + 1n).toString(),
    });
  });

  it("another owner's trades are not this owner's history", () => {
    const carols = sale(10n, 100n);
    const value = Cl.tuple({
      ...carols.value.value,
      owner: Cl.principal(f.carol),
    });
    expect(
      unusual(after([{ burnHeight: 100n, value }], sale(10n, 200n))),
    ).toStrictEqual(["TRADE_FIRST_IN_DIRECTION"]);
  });
});

describe("the config", () => {
  it("takes the four thresholds as decimal strings", () => {
    const config = {
      apiUrl: "https://api.example",
      sender: f.alice,
      vault: `${f.deployer}.keelio-vault`,
      tokens: [f.sbtc, f.usd],
      adapters: [f.dex],
      oracle: `${f.deployer}.mock-oracle`,
      sbtcToken: f.sbtc,
      priceScale: "10000000000",
    };
    expect(parseConfig(config).thresholds).toStrictEqual(DEFAULT_THRESHOLDS);
    expect(
      parseConfig({
        ...config,
        thresholds: {
          tradeSizeMultiple: "5",
          tradeBurstTrades: "4",
          tradeBurstBlocks: "12",
          tradeQuietBlocks: "2016",
        },
      }).thresholds,
    ).toStrictEqual({
      ...DEFAULT_THRESHOLDS,
      tradeSizeMultiple: 5n,
      tradeBurstTrades: 4n,
      tradeBurstBlocks: 12n,
      tradeQuietBlocks: 2016n,
    });
    expect(() =>
      parseConfig({ ...config, thresholds: { tradeSizeMultiple: 5 } }),
    ).toThrow("thresholds.tradeSizeMultiple");
  });
});
