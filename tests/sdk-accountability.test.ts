import { initSimnet } from "@stacks/clarinet-sdk";
import { Cl, type ClarityValue } from "@stacks/transactions";
import { describe, expect, it } from "vitest";
import {
  accountabilityJson,
  accountabilityRecords,
  parseJournal,
  renderAccountabilityReport,
  type JournalEvent,
  type JournalRecord,
} from "../packages/sdk/src/index.js";
import { PRICE_90K, floorOf } from "./oracle-fixture.js";
import {
  EXPIRES_AT,
  MAX_AGE_MS,
  SLIPPAGE_BPS,
  vaultHarness,
} from "./sdk-fixture.js";

const simnet = await initSimnet();
const accounts = simnet.getAccounts();
const alice = accounts.get("wallet_1")!;
const bob = accounts.get("wallet_2")!;
const carol = accounts.get("wallet_3")!;
const dave = accounts.get("wallet_4")!;
const h = vaultHarness(simnet);
const { sbtc, usd, dex } = h;

// The story, all on the real contract. Alice's first eight events are her
// set-up (indexes 0 to 7), then Carol's (8 to 15). Bob trades for Alice,
// Alice tightens every limit and names Dave, Dave trades.
h.fundDex();
h.setUpOwner({
  owner: alice,
  agent: bob,
  deposit: 1_000_000n,
  maxPerTrade: 100_000n,
  maxPerDay: 500_000n,
});
h.setUpOwner({
  owner: carol,
  agent: bob,
  deposit: 50_000n,
  maxPerTrade: 2_000n,
  maxPerDay: 4_000n,
  cooldownBlocks: 2n,
});
const FIRST = 10_000n;
const firstHeight = BigInt(simnet.burnBlockHeight);
expect(h.swap(bob, alice, FIRST).result.type).toBe("ok"); // 16
expect(h.swap(bob, carol, 2_000n).result.type).toBe("ok"); // 17
// Past the day window, so the first trade does not count against the new cap.
simnet.mineEmptyBurnBlocks(144);
h.ok(alice, "set-token-caps", [
  Cl.principal(sbtc),
  Cl.uint(500n),
  Cl.uint(900n),
]); // 18
h.ok(alice, "set-policy", [Cl.uint(1n), Cl.uint(EXPIRES_AT - 1n)]); // 19
h.ok(alice, "set-price-bounds", [Cl.uint(50n), Cl.uint(MAX_AGE_MS)]); // 20
h.ok(alice, "allow-token", [Cl.principal(usd), Cl.bool(false)]); // 21
h.ok(alice, "allow-token", [Cl.principal(usd), Cl.bool(true)]); // 22
h.ok(alice, "pause"); // 23
h.ok(alice, "set-agent", [Cl.principal(dave)]); // 24
h.ok(alice, "unpause"); // 25
// A refused call prints nothing, so it never reaches the journal.
expect(h.swap(bob, alice, 500n).result).toStrictEqual(Cl.error(Cl.uint(108)));
const SECOND = 500n;
const secondHeight = BigInt(simnet.burnBlockHeight);
const secondFloor = floorOf(SECOND, PRICE_90K, 50n, true);
expect(
  h.call(dave, "execute-swap", [
    Cl.principal(alice),
    Cl.principal(dex),
    Cl.principal(sbtc),
    Cl.principal(usd),
    Cl.uint(SECOND),
    Cl.uint(secondFloor),
  ]).result.type,
).toBe("ok"); // 26

const ref = (index: number) => ({
  index,
  burnHeight: h.records[index]!.burnHeight,
  txId: null,
});

describe("accountabilityRecords", () => {
  const events = parseJournal(h.records);
  const records = accountabilityRecords(events);

  it("returns one record per execute-swap, in journal order", () => {
    expect(h.records).toHaveLength(27);
    expect(records.map((r) => [r.swap.ref.index, r.swap.owner])).toStrictEqual([
      [16, alice],
      [17, carol],
      [26, alice],
    ]);
  });

  it("gives the first trade the limits set before it, with their events", () => {
    const floor = floorOf(FIRST, PRICE_90K, SLIPPAGE_BPS, true);
    expect(records[0]).toStrictEqual({
      swap: {
        ref: { index: 16, burnHeight: firstHeight, txId: null },
        owner: alice,
        agent: bob,
        adapter: dex,
        tokenIn: sbtc,
        tokenOut: usd,
        amountIn: FIRST,
        minOut: floor,
        amountOut: FIRST * 900n,
        balanceIn: 1_000_000n - FIRST,
        balanceOut: FIRST * 900n,
        dayTotal: FIRST,
        oraclePrice: PRICE_90K,
        oracleTimestamp: events[16]!.fields["oracle-timestamp"],
        minOutFloor: floor,
        approved: false,
        requestedAt: null,
      },
      // Sent by the agent alone, so there is no request behind it.
      request: null,
      policy: {
        agent: { agent: bob, setBy: ref(1) },
        terms: { cooldownBlocks: 0n, expiresAt: EXPIRES_AT, setBy: ref(6) },
        caps: {
          token: sbtc,
          maxPerTrade: 100_000n,
          maxPerDay: 500_000n,
          setBy: ref(5),
        },
        priceBounds: {
          maxSlippageBps: SLIPPAGE_BPS,
          maxPriceAge: MAX_AGE_MS,
          setBy: ref(7),
        },
        // Alice never set an approval threshold: no band.
        approvalThreshold: null,
        tokens: [
          { id: sbtc, allowed: true, setBy: ref(2) },
          { id: usd, allowed: true, setBy: ref(3) },
        ],
        adapters: [{ id: dex, allowed: true, setBy: ref(4) }],
      },
      issues: [],
    });
  });

  it("gives a later trade the limits as changed, not the first ones", () => {
    const second = records[2]!;
    expect(second.swap).toMatchObject({
      ref: { index: 26, burnHeight: secondHeight },
      agent: dave,
      amountIn: SECOND,
      minOutFloor: secondFloor,
    });
    expect(second.policy).toStrictEqual({
      agent: { agent: dave, setBy: ref(24) },
      terms: { cooldownBlocks: 1n, expiresAt: EXPIRES_AT - 1n, setBy: ref(19) },
      caps: { token: sbtc, maxPerTrade: 500n, maxPerDay: 900n, setBy: ref(18) },
      priceBounds: {
        maxSlippageBps: 50n,
        maxPriceAge: MAX_AGE_MS,
        setBy: ref(20),
      },
      approvalThreshold: null,
      tokens: [
        { id: sbtc, allowed: true, setBy: ref(2) },
        // Revoked at 21 and allowed again at 22: the latest event wins.
        { id: usd, allowed: true, setBy: ref(22) },
      ],
      adapters: [{ id: dex, allowed: true, setBy: ref(4) }],
    });
    expect(second.issues).toStrictEqual([]);
  });

  it("keeps each owner's limits apart", () => {
    const carols = records[1]!;
    expect(carols.policy.agent).toStrictEqual({ agent: bob, setBy: ref(9) });
    expect(carols.policy.caps).toStrictEqual({
      token: sbtc,
      maxPerTrade: 2_000n,
      maxPerDay: 4_000n,
      setBy: ref(13),
    });
    expect(carols.policy.terms?.cooldownBlocks).toBe(2n);
    expect(accountabilityRecords(events, { owner: carol })).toStrictEqual([
      carols,
    ]);
    expect(accountabilityRecords(events, { owner: dave })).toStrictEqual([]);
  });

  it("returns nothing for an empty journal or one with no trades", () => {
    expect(accountabilityRecords([])).toStrictEqual([]);
    expect(accountabilityRecords(events.slice(0, 16))).toStrictEqual([]);
  });

  it("skips unknown events and known ones with a field missing", () => {
    const burnHeight = firstHeight;
    const extra = (fields: Record<string, ClarityValue>) => ({
      burnHeight,
      value: Cl.tuple({ owner: Cl.principal(alice), ...fields }),
    });
    const mixed: JournalRecord[] = [
      ...h.records.slice(0, 16),
      // A later contract's events, and damaged copies of today's.
      extra({ event: Cl.stringAscii("request-approval"), amount: Cl.uint(1) }),
      extra({
        event: Cl.stringAscii("approve-trade"),
        "max-per-trade": Cl.uint(1),
      }),
      extra({
        event: Cl.stringAscii("set-token-caps"),
        "max-per-trade": Cl.uint(1),
      }),
      extra({ event: Cl.stringAscii("set-policy") }),
      extra({
        event: Cl.stringAscii("set-price-bounds"),
        "max-price-age": Cl.uint(1),
      }),
      extra({ event: Cl.stringAscii("allow-token"), allowed: Cl.uint(1) }),
      extra({ event: Cl.stringAscii("execute-swap"), "amount-in": Cl.uint(1) }),
      { burnHeight, value: Cl.tuple({ event: Cl.stringAscii("no-owner") }) },
      { burnHeight, value: Cl.uint(5) },
      h.records[16]!,
    ];
    const [only, ...rest] = accountabilityRecords(parseJournal(mixed));
    expect(rest).toStrictEqual([]);
    // The same limits as without the noise; only the swap's index moved.
    expect(only!.policy).toStrictEqual(records[0]!.policy);
    expect(only!.issues).toStrictEqual([]);
    expect(only!.swap.ref.index).toBe(25);
  });

  it("names what a partial journal cannot account for", () => {
    // Only the trade itself: no limit can be traced.
    const [alone] = accountabilityRecords([events[16]!]);
    expect(alone!.policy).toStrictEqual({
      agent: null,
      terms: null,
      caps: null,
      priceBounds: null,
      approvalThreshold: null,
      tokens: [],
      adapters: [],
    });
    expect(alone!.issues.map((i) => i.code)).toStrictEqual([
      "NO_AGENT_EVENT",
      "NO_POLICY_EVENT",
      "TOKEN_IN_NOT_ALLOWED",
      "TOKEN_OUT_NOT_ALLOWED",
      "ADAPTER_NOT_ALLOWED",
      "NO_CAPS_EVENT",
      "NO_PRICE_BOUNDS_EVENT",
    ]);
    expect(alone!.issues[0]!.message).toBe(
      "the journal has no set-agent event before this trade",
    );
  });

  it("flags a trade the events replayed would not have allowed", () => {
    // Dave's trade replayed without the events that named him and changed the
    // limits, and with the journal's order broken.
    const without = (skip: number[]) =>
      accountabilityRecords(events.filter((e) => !skip.includes(e.index)))
        .at(-1)!
        .issues.map((i) => i.code);
    expect(without([24])).toStrictEqual(["AGENT_MISMATCH"]);
    expect(without([22])).toStrictEqual(["TOKEN_OUT_NOT_ALLOWED"]);
    const edit = (index: number, fields: JournalEvent["fields"]) =>
      accountabilityRecords(
        events.map((e) =>
          e.index === index ? { ...e, fields: { ...e.fields, ...fields } } : e,
        ),
      )
        .at(-1)!
        .issues.map((i) => i.code);
    expect(
      edit(18, { "max-per-trade": 499n, "max-per-day": 499n }),
    ).toStrictEqual(["OVER_TRADE_CAP", "OVER_DAY_CAP"]);
    expect(edit(19, { "expires-at": secondHeight - 1n })).toStrictEqual([
      "AFTER_EXPIRY",
    ]);
    expect(edit(26, { "min-out": secondFloor - 1n })).toStrictEqual([
      "BELOW_ORACLE_FLOOR",
    ]);
    expect(edit(24, { agent: null })).toStrictEqual(["AGENT_MISMATCH"]);
  });

  it("does not change the events it reads", () => {
    const before = structuredClone(events);
    accountabilityRecords(events);
    expect(events).toStrictEqual(before);
  });
});

describe("accountabilityJson", () => {
  const records = accountabilityRecords(parseJournal(h.records));

  it("is JSON-safe, with every amount and height a decimal string", () => {
    const json = accountabilityJson(records);
    expect(JSON.parse(JSON.stringify(json))).toStrictEqual(json);
    expect(json[2]!.swap).toMatchObject({
      ref: { index: 26, burnHeight: secondHeight.toString(), txId: null },
      amountIn: "500",
      oraclePrice: PRICE_90K.toString(),
    });
    expect(json[2]!.policy.caps).toStrictEqual({
      token: sbtc,
      maxPerTrade: "500",
      maxPerDay: "900",
      setBy: { index: 18, burnHeight: secondHeight.toString(), txId: null },
    });
    expect(json[2]!.issues).toStrictEqual([]);
  });

  it("is an empty list for no records", () => {
    expect(accountabilityJson([])).toStrictEqual([]);
  });
});

describe("renderAccountabilityReport", () => {
  const events = parseJournal(
    h.records.map((r, i) => ({
      ...r,
      txId: `0x${i.toString(16).padStart(64, "0")}`,
    })),
  );
  const records = accountabilityRecords(events, { owner: alice });
  const report = renderAccountabilityReport(records);

  it("has a section per trade with the trade, its limits and their events", () => {
    expect(
      report.startsWith(
        "# Keelio accountability record\n\n2 trades, oldest first.\n",
      ),
    ).toBe(true);
    const tx = (i: number) => `0x${i.toString(16).padStart(64, "0")}`;
    const second = report.slice(report.indexOf("## Trade 2"));
    for (const line of [
      `## Trade 2: journal event 26 at burn height ${secondHeight}, transaction ${tx(26)}`,
      `- Owner: \`${alice}\``,
      `- Agent that traded: \`${dave}\``,
      `- Sold: 500 of \`${sbtc}\``,
      `- Received: 450000 of \`${usd}\``,
      `- Adapter: \`${dex}\``,
      `- The agent's minimum out: ${secondFloor}. The least the vault would have accepted (its oracle floor): ${secondFloor}`,
      `- Oracle BTC/USD price the vault read: ${PRICE_90K} (8 decimals), timestamp ${events[26]!.fields["oracle-timestamp"]} ms`,
      `- Agent: \`${dave}\`, named by journal event 24 at burn height ${secondHeight}, transaction ${tx(24)}`,
      `- Cooldown: 1 burn blocks between trades. Expiry: burn height ${EXPIRES_AT - 1n}. Set by journal event 19 at burn height ${secondHeight}, transaction ${tx(19)}`,
      `- Caps for the token sold: 500 per trade, 900 per 144 burn blocks. Set by journal event 18 at burn height ${secondHeight}, transaction ${tx(18)}`,
      `- Price bounds: a trade may settle at most 50 basis points below the oracle price, and the price may be at most ${MAX_AGE_MS} ms old. Set by journal event 20 at burn height ${secondHeight}, transaction ${tx(20)}`,
      `  - \`${usd}\`: allowed (journal event 22 at burn height ${secondHeight}, transaction ${tx(22)})`,
      `  - \`${dex}\`: allowed (journal event 4 at burn height ${h.records[4]!.burnHeight}, transaction ${tx(4)})`,
      "Replay check: every limit above was found in the journal, and the trade is inside each one.",
    ]) {
      expect(second.split("\n"), line).toContain(line);
    }
    // Trade 1 ran under the first limits.
    const first = report.slice(
      report.indexOf("## Trade 1"),
      report.indexOf("## Trade 2"),
    );
    expect(first).toContain(`- Agent: \`${bob}\`, named by journal event 1 at`);
    expect(first).toContain(
      "- Caps for the token sold: 100000 per trade, 500000 per 144 burn blocks.",
    );
  });

  it("says so when there are no trades, and takes a title", () => {
    const empty = renderAccountabilityReport([], { title: "Alice's vault" });
    expect(
      empty.startsWith(
        "# Alice's vault\n\nThe journal given holds no trades.\n",
      ),
    ).toBe(true);
    expect(empty).not.toContain("## Trade");
  });

  it("lists the issues of a trade the journal does not account for", () => {
    const partial = renderAccountabilityReport(
      accountabilityRecords([parseJournal(h.records)[16]!]),
    );
    expect(partial).toContain("1 trade, oldest first.");
    expect(partial).toContain(
      "## Trade 1: journal event 16 at burn height " + firstHeight + "\n",
    );
    expect(partial).toContain("- Agent: not found in the journal");
    expect(partial).toContain("- Token list:\n  - none found in the journal");
    expect(partial).toContain(
      "Replay check: the journal given does not account for this trade.\n\n- NO_AGENT_EVENT: the journal has no set-agent event before this trade",
    );
    expect(partial).not.toContain("is inside each one");
  });

  it("names a removed agent", () => {
    const edited = parseJournal(h.records).map((e) =>
      e.index === 24
        ? { ...e, event: "remove-agent", fields: { ...e.fields, agent: null } }
        : e,
    );
    const text = renderAccountabilityReport(accountabilityRecords(edited));
    expect(text).toContain(
      "- Agent: none, removed by journal event 24 at burn height",
    );
  });
});
