import { initSimnet } from "@stacks/clarinet-sdk";
import { Cl } from "@stacks/transactions";
import { describe, expect, it } from "vitest";
import {
  eventRef,
  parseJournal,
  parseJournalRecord,
  swapEvent,
  toJsonSafe,
  type JournalRecord,
} from "../packages/sdk/src/index.js";
import { PRICE_90K, floorOf } from "./oracle-fixture.js";
import { SLIPPAGE_BPS, vaultHarness } from "./sdk-fixture.js";

const simnet = await initSimnet();
const accounts = simnet.getAccounts();
const alice = accounts.get("wallet_1")!;
const bob = accounts.get("wallet_2")!;
const h = vaultHarness(simnet);
const { sbtc, usd, dex } = h;

h.fundDex();
h.setUpOwner({
  owner: alice,
  agent: bob,
  deposit: 1_000_000n,
  maxPerTrade: 100_000n,
  maxPerDay: 500_000n,
});

describe("parseJournal", () => {
  it("parses the contract's own events into plain values", () => {
    const events = parseJournal(h.records);
    expect(events.map((e) => e.event)).toStrictEqual([
      "deposit",
      "set-agent",
      "allow-token",
      "allow-token",
      "allow-adapter",
      "set-token-caps",
      "set-policy",
      "set-price-bounds",
    ]);
    expect(events[0]).toStrictEqual({
      index: 0,
      burnHeight: h.records[0]!.burnHeight,
      txId: null,
      event: "deposit",
      fields: {
        owner: alice,
        token: sbtc,
        amount: 1_000_000n,
        balance: 1_000_000n,
      },
    });
    // An optional principal is its inner value; a bool is a boolean.
    expect(events[1]!.fields).toStrictEqual({
      owner: alice,
      agent: bob,
      paused: false,
    });
  });

  it("reads `none` as null and keeps a record's transaction id", () => {
    h.ok(alice, "remove-agent");
    const record = { ...h.records.at(-1)!, txId: "0xabc" };
    const event = parseJournalRecord(record, 41);
    expect(event).toMatchObject({
      index: 41,
      txId: "0xabc",
      event: "remove-agent",
      fields: { owner: alice, agent: null, paused: false },
    });
    expect(eventRef(event!)).toStrictEqual({
      index: 41,
      burnHeight: record.burnHeight,
      txId: "0xabc",
    });
    h.ok(alice, "set-agent", [Cl.principal(bob)]);
  });

  it("skips what is not an event tuple, and keeps each record's index", () => {
    const burnHeight = 7n;
    const records: JournalRecord[] = [
      { burnHeight, value: Cl.uint(1) },
      { burnHeight, value: Cl.tuple({ owner: Cl.principal(alice) }) },
      { burnHeight, value: Cl.tuple({ event: Cl.uint(3) }) },
      { burnHeight, value: Cl.tuple({ event: Cl.stringAscii("pause") }) },
    ];
    expect(parseJournal(records)).toStrictEqual([
      { index: 3, burnHeight, txId: null, event: "pause", fields: {} },
    ]);
    expect(parseJournal([])).toStrictEqual([]);
    expect(parseJournalRecord(records[0]!, 0)).toBeNull();
  });

  it("keeps an unknown event, leaving out fields it cannot hold", () => {
    const [event] = parseJournal([
      {
        burnHeight: 9n,
        value: Cl.tuple({
          event: Cl.stringAscii("request-approval"),
          owner: Cl.principal(alice),
          amounts: Cl.list([Cl.uint(1)]),
          memo: Cl.bufferFromHex("00"),
          nested: Cl.tuple({ a: Cl.uint(1) }),
          delta: Cl.int(-5),
          note: Cl.stringUtf8("hi"),
        }),
      },
    ]);
    expect(event).toStrictEqual({
      index: 0,
      burnHeight: 9n,
      txId: null,
      event: "request-approval",
      fields: { owner: alice, delta: -5n, note: "hi" },
    });
  });
});

describe("swapEvent", () => {
  it("reads every field of a real execute-swap event", () => {
    const amountIn = 10_000n;
    const burnHeight = BigInt(simnet.burnBlockHeight);
    expect(h.swap(bob, alice, amountIn).result.type).toBe("ok");
    const event = parseJournal(h.records).at(-1)!;
    const floor = floorOf(amountIn, PRICE_90K, SLIPPAGE_BPS, true);
    expect(swapEvent(event)).toStrictEqual({
      ref: { index: h.records.length - 1, burnHeight, txId: null },
      owner: alice,
      agent: bob,
      adapter: dex,
      tokenIn: sbtc,
      tokenOut: usd,
      amountIn,
      minOut: floor,
      amountOut: amountIn * 900n,
      balanceIn: 1_000_000n - amountIn,
      balanceOut: amountIn * 900n,
      dayTotal: amountIn,
      oraclePrice: PRICE_90K,
      oracleTimestamp: event.fields["oracle-timestamp"],
      minOutFloor: floor,
      // Sent by the agent alone: not an approval.
      approved: false,
      requestedAt: null,
    });
  });

  it("returns null for another event, or a swap with a field missing", () => {
    const events = parseJournal(h.records);
    expect(swapEvent(events[0]!)).toBeNull();
    const swap = events.at(-1)!;
    const rest = Object.fromEntries(
      Object.entries(swap.fields).filter(([name]) => name !== "amount-in"),
    );
    expect(swapEvent({ ...swap, fields: rest })).toBeNull();
    expect(
      swapEvent({ ...swap, fields: { ...swap.fields, agent: null } }),
    ).toBeNull();
  });
});

describe("toJsonSafe", () => {
  it("turns every bigint into its decimal string, at any depth", () => {
    const value = {
      a: 2n ** 100n,
      list: [1n, { b: 0n, c: "x", d: null, e: true }],
      n: 3,
    };
    const safe = toJsonSafe(value);
    expect(safe).toStrictEqual({
      a: "1267650600228229401496703205376",
      list: ["1", { b: "0", c: "x", d: null, e: true }],
      n: 3,
    });
    expect(JSON.parse(JSON.stringify(safe))).toStrictEqual(safe);
    // The input is copied, not changed.
    expect(value.a).toBe(2n ** 100n);
  });

  it("serialises a parsed journal", () => {
    const events = parseJournal(h.records);
    const text = JSON.stringify(toJsonSafe(events));
    expect(JSON.parse(text)[0]).toStrictEqual({
      index: 0,
      burnHeight: h.records[0]!.burnHeight.toString(),
      txId: null,
      event: "deposit",
      fields: {
        owner: alice,
        token: sbtc,
        amount: "1000000",
        balance: "1000000",
      },
    });
  });
});
