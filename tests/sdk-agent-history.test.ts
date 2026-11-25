import { initSimnet } from "@stacks/clarinet-sdk";
import { Cl } from "@stacks/transactions";
import { describe, expect, it } from "vitest";
import {
  agentHistory,
  parseJournal,
  toJsonSafe,
  type JournalEvent,
} from "../packages/sdk/src/index.js";
import { vaultHarness } from "./sdk-fixture.js";

const simnet = await initSimnet();
const accounts = simnet.getAccounts();
const alice = accounts.get("wallet_1")!;
const bob = accounts.get("wallet_2")!;
const carol = accounts.get("wallet_3")!;
const dave = accounts.get("wallet_4")!;
const erin = accounts.get("wallet_5")!;
const h = vaultHarness(simnet);
const { sbtc, usd } = h;

// Two owners name Bob. He trades for both, in both directions; Alice then
// replaces him with Dave, who never trades. All on the real contract.
h.fundDex();
h.setUpOwner({
  owner: alice,
  agent: bob,
  deposit: 1_000_000n,
  maxPerTrade: 100_000n,
  maxPerDay: 500_000n,
}); // events 0 to 7; set-agent is 1
h.setUpOwner({
  owner: carol,
  agent: bob,
  deposit: 50_000n,
  maxPerTrade: 2_000n,
  maxPerDay: 4_000n,
}); // events 8 to 15; set-agent is 9
h.ok(alice, "set-token-caps", [
  Cl.principal(usd),
  Cl.uint(10n ** 9n),
  Cl.uint(10n ** 10n),
]); // 16
expect(h.swap(bob, alice, 10_000n).result.type).toBe("ok"); // 17
expect(h.swap(bob, carol, 2_000n).result.type).toBe("ok"); // 18
simnet.mineEmptyBurnBlocks(5);
expect(h.swap(bob, alice, 900_000n, "buy").result.type).toBe("ok"); // 19
expect(h.swap(bob, alice, 30_000n).result.type).toBe("ok"); // 20
const lastTradeHeight = BigInt(simnet.burnBlockHeight);
simnet.mineEmptyBurnBlocks(2);
h.ok(alice, "pause"); // 21: prints the current agent, Bob
h.ok(alice, "set-agent", [Cl.principal(dave)]); // 22
// Refused: Bob is no longer Alice's agent. Nothing is journalled.
expect(h.swap(bob, alice, 1_000n).result).toStrictEqual(Cl.error(Cl.uint(108)));

const events = parseJournal(h.records);
const ref = (index: number) => ({
  index,
  burnHeight: h.records[index]!.burnHeight,
  txId: null,
});

describe("agentHistory", () => {
  it("reports an agent's owners, swaps, volume and last trade", () => {
    expect(h.records).toHaveLength(23);
    expect(agentHistory(events, bob)).toStrictEqual({
      known: true,
      agent: bob,
      firstSeen: ref(1),
      owners: [
        {
          owner: alice,
          firstNamedAt: ref(1),
          current: false,
          endedAt: ref(22),
        },
        { owner: carol, firstNamedAt: ref(9), current: true, endedAt: null },
      ],
      swaps: 4n,
      volume: [
        { tokenIn: sbtc, swaps: 3n, amountIn: 42_000n },
        { tokenIn: usd, swaps: 1n, amountIn: 900_000n },
      ],
      lastTrade: { index: 20, burnHeight: lastTradeHeight, txId: null },
      approvedSwaps: 0n,
      requests: { made: 0n, approved: 0n, rejected: 0n, cancelled: 0n },
    });
  });

  it("reports a named agent that has not traded", () => {
    expect(agentHistory(events, dave)).toStrictEqual({
      known: true,
      agent: dave,
      firstSeen: ref(22),
      owners: [
        { owner: alice, firstNamedAt: ref(22), current: true, endedAt: null },
      ],
      swaps: 0n,
      volume: [],
      lastTrade: null,
      approvedSwaps: 0n,
      requests: { made: 0n, approved: 0n, rejected: 0n, cancelled: 0n },
    });
  });

  it("returns an explicit no-history result for a fresh principal", () => {
    expect(agentHistory(events, erin)).toStrictEqual({
      known: false,
      agent: erin,
    });
    expect(agentHistory([], bob)).toStrictEqual({ known: false, agent: bob });
    // An owner is not an agent, however many events name it as owner.
    expect(agentHistory(events, alice)).toStrictEqual({
      known: false,
      agent: alice,
    });
  });

  it("sees a removal, and a second naming by the same owner", () => {
    const at = (upTo: number) => agentHistory(events.slice(0, upTo), bob);
    // Before Alice's set-agent to Dave, she still names Bob.
    expect(at(22)).toMatchObject({
      owners: [
        { owner: alice, current: true, endedAt: null },
        { owner: carol },
      ],
    });
    const again: JournalEvent[] = [
      ...events,
      { ...events[1]!, index: 23, burnHeight: 9_000n },
    ];
    expect(agentHistory(again, bob)).toMatchObject({
      firstSeen: ref(1),
      owners: [
        { owner: alice, firstNamedAt: ref(1), current: true, endedAt: null },
        { owner: carol, current: true },
      ],
    });
    const removed: JournalEvent[] = [
      ...events,
      {
        index: 23,
        burnHeight: 9_000n,
        txId: "0x01",
        event: "remove-agent",
        fields: { owner: carol, agent: null, paused: false },
      },
    ];
    expect(agentHistory(removed, bob)).toMatchObject({
      owners: [
        { owner: alice, current: false },
        {
          owner: carol,
          current: false,
          endedAt: { index: 23, burnHeight: 9_000n, txId: "0x01" },
        },
      ],
    });
  });

  it("first sees an agent in a swap or a pause when the set-agent is missing", () => {
    // A journal that starts after the naming: the swap at 17 is the first sight.
    const late = agentHistory(events.slice(17), bob);
    expect(late).toMatchObject({
      known: true,
      firstSeen: ref(17),
      owners: [],
      swaps: 4n,
    });
    expect(agentHistory(events.slice(21, 22), bob)).toStrictEqual({
      known: true,
      agent: bob,
      firstSeen: ref(21),
      owners: [],
      swaps: 0n,
      volume: [],
      lastTrade: null,
      approvedSwaps: 0n,
      requests: { made: 0n, approved: 0n, rejected: 0n, cancelled: 0n },
    });
  });

  it("skips unknown events and damaged ones", () => {
    const swap = events[17]!;
    const rest = Object.fromEntries(
      Object.entries(swap.fields).filter(([name]) => name !== "amount-in"),
    );
    const noise: JournalEvent[] = [
      { ...swap, index: 90, event: "request-approval" },
      { ...swap, index: 91, fields: rest },
      {
        index: 92,
        burnHeight: 1n,
        txId: null,
        event: "set-agent",
        fields: { agent: erin },
      },
      {
        index: 93,
        burnHeight: 1n,
        txId: null,
        event: "approve-trade",
        fields: { owner: alice, agent: erin },
      },
    ];
    expect(agentHistory([...noise, ...events], bob)).toStrictEqual(
      agentHistory(events, bob),
    );
    expect(agentHistory(noise, erin)).toStrictEqual({
      known: false,
      agent: erin,
    });
  });

  it("serialises with toJsonSafe", () => {
    const json = toJsonSafe(agentHistory(events, bob));
    expect(JSON.parse(JSON.stringify(json))).toStrictEqual(json);
    expect(json).toMatchObject({
      known: true,
      swaps: "4",
      volume: [
        { tokenIn: sbtc, swaps: "3", amountIn: "42000" },
        { tokenIn: usd, swaps: "1", amountIn: "900000" },
      ],
      lastTrade: { index: 20, burnHeight: lastTradeHeight.toString() },
    });
  });

  it("does not change the events it reads", () => {
    const before = structuredClone(events);
    agentHistory(events, bob);
    expect(events).toStrictEqual(before);
  });
});
