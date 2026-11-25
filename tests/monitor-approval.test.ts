import { Cl } from "@stacks/transactions";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_THRESHOLDS,
  evaluate,
  initialState,
  memoryStore,
  ownersWithBalance,
  parseState,
} from "../packages/monitor/src/index.js";
import {
  APPROVAL_WINDOW,
  codes,
  monitorFixture,
  only,
  type MonitorFixture,
} from "./monitor-fixture.js";
import { PRICE_90K } from "./oracle-fixture.js";

// The monitor and the owner-approval band (docs/events.md: the five events
// from `set-approval-threshold` to `cancel-swap-request`; docs/errors.md:
// u126 to u133). Every test drives the real contract on the simnet unless it
// says the record is written by hand.

const THRESHOLD = 20_000n;
/** Inside the agent's own authority. */
const SMALL = 10_000n;
/** In the band: above the threshold, inside the cap per trade. */
const BIG = 50_000n;

let f: MonitorFixture;

/** Alice's vault, open, with a threshold, and polled once. */
async function banded() {
  f.open();
  f.setThreshold(THRESHOLD);
  await f.monitor.poll();
}

beforeEach(async () => {
  f = await monitorFixture();
});

describe("APPROVAL_THRESHOLD_SET", () => {
  it("is info when the owner narrows what the agent does alone, warning when it widens", async () => {
    f.open();
    await f.monitor.poll();
    f.setThreshold(null);
    f.setThreshold(THRESHOLD);
    f.setThreshold(THRESHOLD);
    f.setThreshold(THRESHOLD - 1n);
    f.setThreshold(THRESHOLD);
    f.setThreshold(null);
    const alerts = await f.monitor.poll();
    expect(codes(alerts)).toStrictEqual(
      Array.from({ length: 6 }, () => "APPROVAL_THRESHOLD_SET"),
    );
    expect(
      alerts.map((a) => [
        a.severity,
        a.details.change,
        a.details.previous,
        a.details.threshold,
      ]),
    ).toStrictEqual([
      ["info", "unchanged", null, null],
      ["info", "set", null, "20000"],
      ["info", "unchanged", "20000", "20000"],
      ["info", "lowered", "20000", "19999"],
      ["warning", "raised", "19999", "20000"],
      ["warning", "cleared", "20000", null],
    ]);
    expect(alerts[5]).toMatchObject({
      id: "event:13:APPROVAL_THRESHOLD_SET",
      owner: f.alice,
      message:
        `approval threshold for ${f.sbtc} cleared (was 20000): ` +
        "the agent can sell any amount inside its caps without the owner",
      details: { token: f.sbtc },
    });
    expect(alerts[1]!.message).toBe(
      `approval threshold for ${f.sbtc} set to 20000 (was none): ` +
        "a trade selling more needs the owner's approval",
    );
  });

  it("keeps the threshold across a restart, so a later change is still compared", async () => {
    await banded();
    const state = parseState(
      JSON.parse(JSON.stringify(await f.monitor.state())),
    );
    expect(state.owners[f.alice]!.approvalThresholds).toStrictEqual({
      [f.sbtc]: "20000",
    });
    f.setThreshold(THRESHOLD + 1n);
    const alert = only(
      await f.watch({}, memoryStore(state)).poll(),
      "APPROVAL_THRESHOLD_SET",
    );
    expect([alert.severity, alert.details.change]).toStrictEqual([
      "warning",
      "raised",
    ]);
  });

  it("is not raised by any other owner action", async () => {
    f.open();
    expect(codes(await f.monitor.poll())).not.toContain(
      "APPROVAL_THRESHOLD_SET",
    );
  });
});

describe("SWAP_REQUESTED and the answers to it", () => {
  it("SWAP_REQUESTED: a warning that names the trade and the last height to approve at", async () => {
    await banded();
    f.request(BIG);
    const alerts = await f.monitor.poll();
    const expiresAt = f.height() + APPROVAL_WINDOW;
    expect(alerts).toStrictEqual([
      {
        id: "event:9:SWAP_REQUESTED",
        code: "SWAP_REQUESTED",
        severity: "warning",
        owner: f.alice,
        burnHeight: f.height().toString(),
        message:
          `agent ${f.bob} asks to sell 50000 of ${f.sbtc} for at least 44550000 of ${f.usd} on ${f.dex}: ` +
          `above the approval threshold, so it runs only if the owner approves by burn height ${expiresAt}`,
        details: {
          agent: f.bob,
          adapter: f.dex,
          tokenIn: f.sbtc,
          tokenOut: f.usd,
          amountIn: "50000",
          minOut: "44550000",
          requestedAt: f.height().toString(),
          expiresAt: expiresAt.toString(),
          replacedRequestedAt: null,
        },
      },
    ]);
    expect((await f.monitor.state()).owners[f.alice]!.pending).toMatchObject({
      amountIn: "50000",
      expiresAt: expiresAt.toString(),
      expiryReported: false,
    });
  });

  it("SWAP_REQUESTED: not raised by a swap the agent may make alone", async () => {
    await banded();
    f.swap(SMALL);
    const alerts = await f.monitor.poll();
    expect(codes(alerts)).toStrictEqual(["SWAP", "TRADE_FIRST_IN_DIRECTION"]);
    expect(alerts[0]!.details).toMatchObject({
      approved: false,
      requestedAt: null,
    });
    expect((await f.monitor.state()).owners[f.alice]!.pending).toBeNull();
  });

  it("approve-swap raises SWAP, as execute-swap does, and updates the same state", async () => {
    await banded();
    f.request(BIG);
    const requestedAt = f.height();
    f.mine(2);
    f.approve(BIG);
    const alerts = await f.monitor.poll();
    expect(codes(alerts)).toStrictEqual([
      "SWAP_REQUESTED",
      "SWAP",
      "TRADE_FIRST_IN_DIRECTION",
    ]);
    const swap = only(alerts, "SWAP");
    expect(swap).toMatchObject({
      id: "event:10:SWAP",
      severity: "info",
      owner: f.alice,
      burnHeight: (requestedAt + 2n).toString(),
      message:
        `the owner approved agent ${f.bob}'s request of burn height ${requestedAt}: ` +
        `sold 50000 of ${f.sbtc} for 45000000 of ${f.usd} on ${f.dex}; 101 bps above the floor 44550000`,
      details: {
        agent: f.bob,
        amountIn: "50000",
        amountOut: "45000000",
        minOutFloor: "44550000",
        dayTotal: "50000",
        oraclePrice: PRICE_90K.toString(),
        approved: true,
        requestedAt: requestedAt.toString(),
      },
    });
    // Balances, the stored request and solvency follow the approved trade.
    const state = await f.monitor.state();
    expect(ownersWithBalance(state)).toStrictEqual([
      {
        owner: f.alice,
        balances: { [f.sbtc]: "950000", [f.usd]: "45000000" },
      },
    ]);
    expect(state.owners[f.alice]!.pending).toBeNull();
    expect(state.shortTokens).toStrictEqual([]);
    // Answered in time: nothing expires later.
    f.mine(Number(APPROVAL_WINDOW) + 1);
    expect(await f.monitor.poll()).toStrictEqual([]);
  });

  it("an approved trade counts toward DAY_CAP_NEAR and SWAP_NEAR_FLOOR", async () => {
    await banded();
    // 100_000 + 50_000 alone, then 50_000 approved: 200_000 of 250_000.
    f.vault(f.alice, "set-approval-threshold", [
      Cl.principal(f.sbtc),
      Cl.some(Cl.uint(60_000)),
    ]);
    f.swap(50_000n);
    f.swap(50_000n);
    f.swap(50_000n);
    f.vault(f.alice, "set-approval-threshold", [
      Cl.principal(f.sbtc),
      Cl.some(Cl.uint(THRESHOLD)),
    ]);
    await f.monitor.poll();
    // 892 a sat is 11 bps above the floor of 891.
    f.ok("mock-dex", "set-rate", [Cl.uint(892), Cl.uint(1)], f.deployer);
    f.request(BIG);
    f.approve(BIG);
    const alerts = await f.monitor.poll();
    expect(codes(alerts)).toStrictEqual([
      "SWAP_REQUESTED",
      "SWAP",
      "SWAP_NEAR_FLOOR",
      "DAY_CAP_NEAR",
      "TRADE_BURST",
    ]);
    expect(only(alerts, "DAY_CAP_NEAR").details).toMatchObject({
      dayTotal: "200000",
      usedBps: "8000",
    });
  });

  it("SWAP_REQUEST_REJECTED and SWAP_REQUEST_CANCELLED: info, and the request is no longer waiting", async () => {
    await banded();
    f.request(BIG);
    f.vault(f.alice, "reject-swap");
    f.request(BIG);
    f.vault(f.bob, "cancel-swap-request", [Cl.principal(f.alice)]);
    const alerts = await f.monitor.poll();
    expect(alerts.map((a) => [a.code, a.severity, a.owner])).toStrictEqual([
      ["SWAP_REQUESTED", "warning", f.alice],
      ["SWAP_REQUEST_REJECTED", "info", f.alice],
      ["SWAP_REQUESTED", "warning", f.alice],
      ["SWAP_REQUEST_CANCELLED", "info", f.alice],
    ]);
    const at = f.height();
    const trade = `sell 50000 of ${f.sbtc} for at least 44550000 of ${f.usd} on ${f.dex}`;
    expect(alerts[1]!.message).toBe(
      `the owner rejected the request of burn height ${at} to ${trade}`,
    );
    expect(alerts[3]!.message).toBe(
      `agent ${f.bob} withdrew the request of burn height ${at} to ${trade}`,
    );
    expect(alerts[1]!.details).toMatchObject({
      amountIn: "50000",
      expired: false,
    });
    expect((await f.monitor.state()).owners[f.alice]!.pending).toBeNull();
    f.mine(Number(APPROVAL_WINDOW) + 1);
    expect(await f.monitor.poll()).toStrictEqual([]);
  });

  it("raises no UNKNOWN_EVENT for any event of the approval band", async () => {
    f.open();
    f.setThreshold(THRESHOLD);
    f.request(BIG);
    f.approve(BIG);
    f.request(BIG);
    f.vault(f.alice, "reject-swap");
    f.request(BIG);
    f.vault(f.bob, "cancel-swap-request", [Cl.principal(f.alice)]);
    f.setThreshold(null);
    expect(codes(await f.monitor.poll())).not.toContain("UNKNOWN_EVENT");
  });
});

describe("SWAP_REQUEST_EXPIRED", () => {
  it("not raised at the last height the owner can approve at, raised once one block later", async () => {
    await banded();
    f.request(BIG);
    const requestedAt = f.height();
    const expiresAt = requestedAt + APPROVAL_WINDOW;
    f.mine(Number(APPROVAL_WINDOW));
    expect(f.height()).toBe(expiresAt);
    expect(codes(await f.monitor.poll())).toStrictEqual(["SWAP_REQUESTED"]);
    f.mine(1);
    const alerts = await f.monitor.poll();
    expect(alerts).toStrictEqual([
      {
        id: `level:${f.alice}:SWAP_REQUEST_EXPIRED:${requestedAt}`,
        code: "SWAP_REQUEST_EXPIRED",
        severity: "warning",
        owner: f.alice,
        burnHeight: (expiresAt + 1n).toString(),
        message:
          `agent ${f.bob}'s request to sell 50000 of ${f.sbtc} expired unanswered ` +
          `at burn height ${expiresAt}: it can no longer be approved`,
        details: {
          agent: f.bob,
          adapter: f.dex,
          tokenIn: f.sbtc,
          tokenOut: f.usd,
          amountIn: "50000",
          minOut: "44550000",
          requestedAt: requestedAt.toString(),
          expiresAt: expiresAt.toString(),
        },
      },
    ]);
    // The contract agrees: the owner can no longer approve it.
    f.refused(f.alice, "approve-swap", f.approveArgs({ amount: BIG }), 130);
    // Once per request, here and after a restart from the saved state.
    expect(codes(await f.monitor.poll())).toStrictEqual(["CALL_REFUSED"]);
    f.mine(3);
    const saved = parseState(
      JSON.parse(JSON.stringify(await f.monitor.state())),
    );
    expect(await f.watch({}, memoryStore(saved)).poll()).toStrictEqual([]);
  });

  it("is raised again for the next request left unanswered, which replaced the first", async () => {
    await banded();
    f.request(BIG);
    const first = f.height();
    f.mine(Number(APPROVAL_WINDOW) + 1);
    expect(codes(await f.monitor.poll())).toStrictEqual([
      "SWAP_REQUESTED",
      "SWAP_REQUEST_EXPIRED",
    ]);
    // The vault lets a new request overwrite an expired one.
    f.request(BIG);
    const second = f.height();
    const asked = only(await f.monitor.poll(), "SWAP_REQUESTED");
    expect(asked.details.replacedRequestedAt).toBe(first.toString());
    expect(asked.message).toContain(
      `it replaces the request of burn height ${first}, which expired unanswered`,
    );
    f.mine(Number(APPROVAL_WINDOW) + 1);
    const again = await f.monitor.poll();
    expect(again.map((a) => a.id)).toStrictEqual([
      `level:${f.alice}:SWAP_REQUEST_EXPIRED:${second}`,
    ]);
  });

  it("is raised for a paused vault too, and a late rejection says the request had expired", async () => {
    await banded();
    f.request(BIG);
    f.vault(f.alice, "pause");
    f.mine(Number(APPROVAL_WINDOW) + 1);
    expect(codes(await f.monitor.poll())).toStrictEqual([
      "SWAP_REQUESTED",
      "VAULT_PAUSED",
      "SWAP_REQUEST_EXPIRED",
    ]);
    f.vault(f.alice, "reject-swap");
    const rejected = only(await f.monitor.poll(), "SWAP_REQUEST_REJECTED");
    expect(rejected.details.expired).toBe(true);
    expect(rejected.message).toMatch(/, which had expired$/);
  });

  it("evaluate: raised from the saved state alone, with no vault read", () => {
    const state = initialState();
    state.owners[f.alice] = {
      balances: {},
      dayCaps: {},
      active: [],
      approvalThresholds: {},
      pending: {
        agent: f.bob,
        adapter: f.dex,
        tokenIn: f.sbtc,
        tokenOut: f.usd,
        amountIn: "5",
        minOut: "1",
        requestedAt: "10",
        expiresAt: "16",
        expiryReported: false,
      },
    };
    const base = {
      thresholds: DEFAULT_THRESHOLDS,
      events: [],
      refusals: [],
      vaults: {},
      blockTimeMs: 0n,
    };
    const waiting = evaluate({ ...base, state, burnHeight: 16n });
    expect(waiting.alerts).toStrictEqual([]);
    const late = evaluate({ ...base, state: waiting.state, burnHeight: 17n });
    expect(codes(late.alerts)).toStrictEqual(["SWAP_REQUEST_EXPIRED"]);
    expect(late.state.owners[f.alice]!.pending!.expiryReported).toBe(true);
    // The input state is not changed.
    expect(state.owners[f.alice]!.pending!.expiryReported).toBe(false);
    expect(
      evaluate({ ...base, state: late.state, burnHeight: 99n }).alerts,
    ).toStrictEqual([]);
  });
});

describe("refused calls of the approval band", () => {
  it("u126 and u127 are info: the band sending a trade to the other function", async () => {
    await banded();
    f.refused(f.bob, "execute-swap", f.agentArgs({ amount: BIG }), 126);
    f.refused(f.bob, "request-swap", f.agentArgs({ amount: SMALL }), 127);
    const alerts = await f.monitor.poll();
    expect(
      alerts.map((a) => [
        a.code,
        a.severity,
        a.owner,
        a.details.function,
        a.details.errorName,
      ]),
    ).toStrictEqual([
      [
        "CALL_REFUSED",
        "info",
        f.alice,
        "execute-swap",
        "ERR-APPROVAL-REQUIRED",
      ],
      [
        "CALL_REFUSED",
        "info",
        f.alice,
        "request-swap",
        "ERR-APPROVAL-NOT-NEEDED",
      ],
    ]);
    expect(alerts[0]!.message).toBe(
      `execute-swap by ${f.bob} was refused with (err u126) ERR-APPROVAL-REQUIRED`,
    );
  });

  it("u128 to u133 are warnings, filed under the owner the call was about", async () => {
    await banded();
    // u129: nothing to reject yet. The caller is the owner.
    f.refused(f.alice, "reject-swap", [], 129);
    f.request(BIG);
    // u128: one request at a time.
    f.refused(f.bob, "request-swap", f.agentArgs({ amount: BIG }), 128);
    // u133: a stranger cannot withdraw Bob's request for Alice.
    f.refused(f.carol, "cancel-swap-request", [Cl.principal(f.alice)], 133);
    // u131: Alice signs an approval for another amount than the one stored.
    f.refused(
      f.alice,
      "approve-swap",
      f.approveArgs({ amount: BIG + 1n }),
      131,
    );
    // u131 again: the right trade, for a request made at another height.
    f.refused(
      f.alice,
      "approve-swap",
      [...f.tradeArgs({ amount: BIG }), Cl.uint(f.height() + 1n)],
      131,
    );
    // u132: the agent that asked has been replaced.
    f.vault(f.alice, "set-agent", [Cl.principal(f.carol)]);
    f.refused(f.alice, "approve-swap", f.approveArgs({ amount: BIG }), 132);
    // u130: too late.
    f.vault(f.alice, "set-agent", [Cl.principal(f.bob)]);
    f.mine(Number(APPROVAL_WINDOW) + 1);
    f.refused(f.alice, "approve-swap", f.approveArgs({ amount: BIG }), 130);

    const refusals = (await f.monitor.poll()).filter(
      (a) => a.code === "CALL_REFUSED",
    );
    expect(
      refusals.map((a) => [
        a.details.errorName,
        a.severity,
        a.owner,
        a.details.sender,
      ]),
    ).toStrictEqual([
      ["ERR-NO-PENDING-SWAP", "warning", f.alice, f.alice],
      ["ERR-REQUEST-PENDING", "warning", f.alice, f.bob],
      ["ERR-NOT-REQUESTER", "warning", f.alice, f.carol],
      ["ERR-REQUEST-MISMATCH", "warning", f.alice, f.alice],
      ["ERR-REQUEST-MISMATCH", "warning", f.alice, f.alice],
      ["ERR-REQUEST-AGENT-CHANGED", "warning", f.alice, f.alice],
      ["ERR-REQUEST-EXPIRED", "warning", f.alice, f.alice],
    ]);
  });

  it("raises no CALL_REFUSED when the band's calls succeed", async () => {
    await banded();
    f.swap(SMALL);
    f.request(BIG);
    f.approve(BIG);
    expect(codes(await f.monitor.poll())).not.toContain("CALL_REFUSED");
  });
});

describe("evaluate, with an approve-swap record written by hand", () => {
  // The contract refuses such a trade, so the simnet cannot journal one.
  const record = (amountOut: bigint, floor: bigint) => ({
    burnHeight: 7n,
    value: Cl.tuple({
      event: Cl.stringAscii("approve-swap"),
      owner: Cl.principal(f.alice),
      agent: Cl.principal(f.bob),
      adapter: Cl.principal(f.dex),
      "token-in": Cl.principal(f.sbtc),
      "token-out": Cl.principal(f.usd),
      "amount-in": Cl.uint(10),
      "min-out": Cl.uint(floor),
      "amount-out": Cl.uint(amountOut),
      "balance-in": Cl.uint(0),
      "balance-out": Cl.uint(amountOut),
      "day-total": Cl.uint(10),
      "oracle-price": Cl.uint(PRICE_90K),
      "oracle-timestamp": Cl.uint(1),
      "min-out-floor": Cl.uint(floor),
      "requested-at": Cl.uint(5),
    }),
  });
  const base = {
    thresholds: DEFAULT_THRESHOLDS,
    refusals: [],
    vaults: {},
    burnHeight: 10n,
    blockTimeMs: 0n,
  };

  it("SWAP_BELOW_FLOOR: raised for an approved trade below its floor, not for one above it", () => {
    const below = evaluate({
      ...base,
      state: initialState(),
      events: [record(8909n, 8910n)],
    });
    expect(codes(below.alerts)).toStrictEqual(["SWAP", "SWAP_BELOW_FLOOR"]);
    expect(below.alerts[1]!.severity).toBe("critical");
    const above = evaluate({
      ...base,
      state: initialState(),
      events: [record(9000n, 8910n)],
    });
    expect(codes(above.alerts)).toStrictEqual(["SWAP"]);
    expect(above.state.owners[f.alice]!.balances).toStrictEqual({
      [f.sbtc]: "0",
      [f.usd]: "9000",
    });
  });

  it("UNKNOWN_EVENT: an approve-swap without requested-at is not read as a trade", () => {
    const whole = record(9000n, 8910n);
    const fields = { ...whole.value.value };
    delete fields["requested-at"];
    const { alerts } = evaluate({
      ...base,
      state: initialState(),
      events: [{ burnHeight: 7n, value: Cl.tuple(fields) }],
    });
    expect(codes(alerts)).toStrictEqual(["UNKNOWN_EVENT"]);
    expect(alerts[0]!.message).toContain("missing field requested-at");
  });
});
