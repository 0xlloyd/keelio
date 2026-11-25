import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Cl } from "@stacks/transactions";
import { beforeEach, describe, expect, it } from "vitest";
import {
  digest,
  readDigest,
  renderDigest,
  type Alert,
  type DigestInput,
  type OwnerDigest,
  type RefusedCall,
} from "../packages/monitor/src/index.js";
import {
  APPROVAL_WINDOW,
  MAX_PER_DAY,
  monitorFixture,
  type MonitorFixture,
} from "./monitor-fixture.js";

// R6 of docs/requirements-trustshift.md: the owner digest. `digest` is pure;
// `readDigest` reads the chain for it. The stories run on the simnet through
// the real contract unless a test says its input is written by hand.

const THRESHOLD = 20_000n;

let f: MonitorFixture;

beforeEach(async () => {
  f = await monitorFixture();
});

const read = (range = {}) =>
  readDigest({ chain: f.chain, read: f.read }, range);

function owner(owners: readonly OwnerDigest[], who: string): OwnerDigest {
  const found = owners.find((o) => o.owner === who);
  if (found === undefined) throw new Error(`no digest for ${who}`);
  return found;
}

const EMPTY: DigestInput = {
  fromHeight: 0n,
  toHeight: 100n,
  burnHeight: 100n,
  events: [],
  refusals: [],
  vaults: {},
  alerts: [],
};

describe("the empty digest", () => {
  it("has no owner when no vault was read and nothing happened", () => {
    const d = digest(EMPTY);
    expect(d).toStrictEqual({
      fromHeight: "0",
      toHeight: "100",
      burnHeight: "100",
      owners: [],
      vaultAlerts: { critical: [], warning: [], info: [] },
    });
    expect(renderDigest(d)).toBe(
      "Keelio vault digest: burn heights 0 to 100. Vaults read at burn height 100. " +
        "Amounts are base units.\n\n" +
        "No vault to report on: nothing happened in this range.\n",
    );
  });

  it("is the same from an untouched vault contract on the simnet", async () => {
    const d = await read();
    expect(d.owners).toStrictEqual([]);
    expect(d.burnHeight).toBe(f.height().toString());
  });

  it("a quiet range: an open vault with nothing in it still reports where it stands", async () => {
    f.open(f.alice, 1_000n);
    f.mine(10);
    const from = f.height();
    f.mine(5);
    const d = await read({ fromHeight: from });
    expect(d.owners).toHaveLength(1);
    const alice = d.owners[0]!;
    expect(alice).toMatchObject({
      owner: f.alice,
      trades: { count: 0, approved: 0, sold: [], bought: [] },
      requests: { made: 0, approved: 0, rejected: 0, withdrawn: 0 },
      request: null,
      refused: { count: 0, reasons: [] },
      alerts: { critical: [], warning: [], info: [] },
    });
    expect(alice.lines).toStrictEqual([
      "Trades: none.",
      "Waiting for the owner's approval: nothing.",
      "Calls refused: none.",
      "Day caps, over the last 144 burn blocks:",
      `  ${f.sbtc}: 0 of 250000 used, 250000 left.`,
      `  ${f.usd}: no cap set, so the agent cannot sell it.`,
      `Agent: ${f.bob}.`,
      "The vault is not paused.",
      `Policy: expires at burn height 1000, ${1_000n - f.height()} burn blocks from now.`,
      "Alerts: none.",
    ]);
  });
});

describe("the digest of a busy vault", () => {
  /**
   * Alice's vault: two swaps by the agent alone, one refused over the cap
   * per trade, a threshold, one request approved, one left waiting.
   */
  function story() {
    f.open();
    f.swap(10_000n);
    f.swap(15_000n);
    f.refused(f.bob, "execute-swap", f.agentArgs({ amount: 100_001n }), 114);
    f.setThreshold(THRESHOLD);
    f.refused(f.bob, "execute-swap", f.agentArgs({ amount: 50_000n }), 126);
    f.refused(f.bob, "execute-swap", f.agentArgs({ amount: 60_000n }), 126);
    f.request(50_000n);
    f.approve(50_000n);
    f.mine(2);
    f.request(30_000n);
  }

  it("counts trades, approvals, requests, refusals, caps and alerts", async () => {
    story();
    const requestedAt = f.height();
    f.mine(1);
    const d = await read();
    expect(d.owners).toHaveLength(1);
    const alice = d.owners[0]!;
    expect(alice.owner).toBe(f.alice);
    expect(alice.trades).toStrictEqual({
      count: 3,
      approved: 1,
      sold: [{ token: f.sbtc, trades: 3, amount: "75000" }],
      // 900 base units a sat.
      bought: [{ token: f.usd, amount: "67500000" }],
    });
    expect(alice.requests).toStrictEqual({
      made: 2,
      approved: 1,
      rejected: 0,
      withdrawn: 0,
    });
    expect(alice.request).toStrictEqual({
      agent: f.bob,
      adapter: f.dex,
      tokenIn: f.sbtc,
      tokenOut: f.usd,
      amountIn: "30000",
      minOut: "26730000",
      requestedAt: requestedAt.toString(),
      expiresAt: (requestedAt + APPROVAL_WINDOW).toString(),
      status: "waiting",
      blocksLeft: (APPROVAL_WINDOW - 1n).toString(),
    });
    expect(alice.refused).toStrictEqual({
      count: 3,
      reasons: [
        {
          errorCode: "114",
          errorName: "ERR-TRADE-CAP-EXCEEDED",
          words: "Over the per-trade cap",
          count: 1,
          functions: ["execute-swap"],
        },
        {
          errorCode: "126",
          errorName: "ERR-APPROVAL-REQUIRED",
          words: "This trade needs the owner's approval",
          count: 2,
          functions: ["execute-swap"],
        },
      ],
    });
    expect(alice.vault).toStrictEqual({
      agent: f.bob,
      paused: false,
      caps: [
        {
          token: f.sbtc,
          maxPerDay: MAX_PER_DAY.toString(),
          used: "75000",
          left: "175000",
        },
        { token: f.usd, maxPerDay: "0", used: "0", left: "0" },
      ],
      policy: {
        expiresAt: "1000000",
        expired: false,
        blocksLeft: (1_000_000n - f.height()).toString(),
      },
    });
    // Grouped by severity. The two u126 refusals are info, the u114 a warning.
    expect(alice.alerts.critical).toStrictEqual([]);
    expect(alice.alerts.warning.map((a) => a.code)).toStrictEqual([
      "AGENT_SET",
      "TOKEN_CAPS_SET",
      "POLICY_SET",
      "TOKEN_ALLOW_CHANGED",
      "TOKEN_ALLOW_CHANGED",
      "ADAPTER_ALLOW_CHANGED",
      "PRICE_BOUNDS_SET",
      "SWAP_REQUESTED",
      "SWAP_REQUESTED",
      "CALL_REFUSED",
    ]);
    expect(alice.alerts.info.map((a) => a.code)).toStrictEqual([
      "DEPOSIT",
      "SWAP",
      "TRADE_FIRST_IN_DIRECTION",
      "SWAP",
      "APPROVAL_THRESHOLD_SET",
      "SWAP",
      "TRADE_LARGE",
      "TRADE_BURST",
      "CALL_REFUSED",
      "CALL_REFUSED",
    ]);
    expect(alice.alerts.warning[7]).toStrictEqual({
      code: "SWAP_REQUESTED",
      burnHeight: (requestedAt - 2n).toString(),
      message: expect.stringContaining("asks to sell 50000") as string,
    });
  });

  it("says it in plain words", async () => {
    story();
    const requestedAt = f.height();
    const text = renderDigest(await read());
    const lines = text.split("\n");
    expect(lines.slice(0, 3)).toStrictEqual([
      `Keelio vault digest: burn heights 0 to ${requestedAt}. Vaults read at burn height ${requestedAt}. Amounts are base units.`,
      "",
      `Owner ${f.alice}`,
    ]);
    expect(lines.slice(3, 16)).toStrictEqual([
      "  Trades: 3, of which 1 approved by the owner.",
      `    Sold 75000 of ${f.sbtc} in 3 trades.`,
      `    Bought 67500000 of ${f.usd}.`,
      "  Approval requests: 2 made, 1 approved, 0 rejected, 0 withdrawn by the agent.",
      `  Waiting for the owner's approval: agent ${f.bob} asks to sell 30000 of ${f.sbtc} ` +
        `for at least 26730000 of ${f.usd}. It can be approved up to burn height ` +
        `${requestedAt + APPROVAL_WINDOW}, 6 burn blocks from now.`,
      "  Calls refused: 3.",
      "    1 × Over the per-trade cap (u114 ERR-TRADE-CAP-EXCEEDED): execute-swap.",
      "    2 × This trade needs the owner's approval (u126 ERR-APPROVAL-REQUIRED): execute-swap.",
      "  Day caps, over the last 144 burn blocks:",
      `    ${f.sbtc}: 75000 of 250000 used, 175000 left.`,
      `    ${f.usd}: no cap set, so the agent cannot sell it.`,
      `  Agent: ${f.bob}.`,
      "  The vault is not paused.",
    ]);
    expect(lines[17]).toBe("  Alerts: 0 critical, 10 warning, 10 info.");
    expect(lines.at(-2)).toBe(
      "    info: 1 APPROVAL_THRESHOLD_SET, 2 CALL_REFUSED, 1 DEPOSIT, 3 SWAP, " +
        "1 TRADE_BURST, 1 TRADE_FIRST_IN_DIRECTION, 1 TRADE_LARGE.",
    );
    expect(text.endsWith("\n")).toBe(true);
  });

  it("keeps to the range: an earlier trade is not counted, an earlier request still waits", async () => {
    story();
    const requestedAt = f.height();
    f.mine(1);
    const later = owner(
      (await read({ fromHeight: f.height() })).owners,
      f.alice,
    );
    expect(later.trades.count).toBe(0);
    expect(later.requests.made).toBe(0);
    expect(later.refused.count).toBe(0);
    expect(later.alerts).toStrictEqual({ critical: [], warning: [], info: [] });
    expect(later.request).toMatchObject({
      requestedAt: requestedAt.toString(),
      status: "waiting",
    });
    // The first two swaps and the approved one, not the request two blocks on.
    const early = owner(
      (await read({ toHeight: requestedAt - 1n })).owners,
      f.alice,
    );
    expect(early.trades.count).toBe(3);
    expect(early.requests).toMatchObject({ made: 1, approved: 1 });
  });

  it("reports an expired request, a paused vault, no agent and an expired policy", async () => {
    f.open(f.alice, 0n);
    f.vault(f.alice, "set-policy", [Cl.uint(0), Cl.uint(f.height() + 20n)]);
    f.setThreshold(THRESHOLD);
    f.request(30_000n);
    const requestedAt = f.height();
    f.vault(f.alice, "pause");
    f.vault(f.alice, "remove-agent");
    f.mine(23);
    const alice = owner((await read()).owners, f.alice);
    expect(alice.request).toMatchObject({ status: "expired", blocksLeft: "0" });
    expect(alice.vault).toMatchObject({
      agent: null,
      paused: true,
      policy: {
        expiresAt: (requestedAt + 20n).toString(),
        expired: true,
        blocksLeft: "0",
      },
    });
    expect(alice.lines).toContain(
      `Expired without an answer: agent ${f.bob} asks to sell 30000 of ${f.sbtc} ` +
        `for at least 26730000 of ${f.usd}. It could be approved up to burn height ` +
        `${requestedAt + APPROVAL_WINDOW} and can no longer run.`,
    );
    expect(alice.lines).toContain("Agent: none. No one can trade.");
    expect(alice.lines).toContain("The vault is paused.");
    expect(alice.lines).toContain(
      `Policy: expired at burn height ${requestedAt + 20n}, 3 burn blocks ago. The agent cannot trade.`,
    );
    expect(alice.alerts.warning.map((a) => a.code)).toContain(
      "SWAP_REQUEST_EXPIRED",
    );
  });

  it("counts rejected and withdrawn requests, after which nothing waits", async () => {
    f.open();
    f.setThreshold(THRESHOLD);
    f.request(30_000n);
    f.vault(f.alice, "reject-swap");
    f.request(30_000n);
    f.vault(f.bob, "cancel-swap-request", [Cl.principal(f.alice)]);
    const alice = owner((await read()).owners, f.alice);
    expect(alice.requests).toStrictEqual({
      made: 2,
      approved: 0,
      rejected: 1,
      withdrawn: 1,
    });
    expect(alice.request).toBeNull();
    expect(alice.trades.count).toBe(0);
  });

  it("gives each owner their own entry, sorted, and files a stranger's refused call under the stranger", async () => {
    f.open(f.alice);
    f.open(f.carol);
    f.swap(10_000n, f.carol);
    f.refused(f.bob, "withdraw", [Cl.principal(f.sbtc), Cl.uint(1)], 101);
    const d = await read();
    expect(d.owners.map((o) => o.owner)).toStrictEqual(
      [f.alice, f.bob, f.carol].sort(),
    );
    expect(owner(d.owners, f.alice).trades.count).toBe(0);
    expect(owner(d.owners, f.carol).trades.count).toBe(1);
    const bob = owner(d.owners, f.bob);
    expect(bob.vault).toBeNull();
    expect(bob.refused.reasons[0]).toMatchObject({
      words: "More than the vault holds",
      functions: ["withdraw"],
    });
    expect(bob.lines).toContain(
      "The vault was not read: no caps, agent or policy to report.",
    );
  });

  it("reads only: a running monitor's cursor and alerts are not moved by it", async () => {
    story();
    const before = JSON.stringify(await f.monitor.state());
    await read();
    expect(JSON.stringify(await f.monitor.state())).toBe(before);
    expect((await f.monitor.poll()).length).toBeGreaterThan(10);
  });
});

describe("digest, with input written by hand", () => {
  const alert = (extra: Partial<Alert>): Alert => ({
    id: "x",
    code: "LEDGER_SHORTFALL",
    severity: "critical",
    owner: null,
    burnHeight: "50",
    message: "the vault holds 1 of T but its ledgers owe 2",
    details: {},
    ...extra,
  });

  it("is deterministic, JSON-safe, and does not change its input", async () => {
    f.open();
    f.swap(10_000n);
    const input: DigestInput = {
      fromHeight: 0n,
      toHeight: f.height(),
      burnHeight: f.height(),
      events: await f.chain.vaultEvents(),
      refusals: [],
      vaults: {},
      alerts: [alert({ owner: f.alice, burnHeight: "1" })],
    };
    const frozen = structuredClone(input);
    const first = digest(input);
    expect(digest(input)).toStrictEqual(first);
    expect(input).toStrictEqual(frozen);
    expect(JSON.parse(JSON.stringify(first))).toStrictEqual(first);
    expect(renderDigest(first)).toBe(renderDigest(digest(input)));
  });

  it("puts an alert that names no owner under the vault contract, and drops one outside the range", () => {
    const d = digest({
      ...EMPTY,
      fromHeight: 40n,
      toHeight: 60n,
      alerts: [
        alert({}),
        alert({ burnHeight: "39" }),
        alert({ burnHeight: "61" }),
        alert({
          code: "UNKNOWN_EVENT",
          severity: "warning",
          burnHeight: "60",
          message: "journal record 3 could not be read",
        }),
      ],
    });
    expect(d.owners).toStrictEqual([]);
    expect(d.vaultAlerts.critical).toHaveLength(1);
    expect(d.vaultAlerts.warning).toHaveLength(1);
    expect(renderDigest(d).split("\n").slice(-5)).toStrictEqual([
      "The vault contract as a whole",
      "  Alerts: 1 critical, 1 warning, 0 info.",
      "    critical, burn height 50, LEDGER_SHORTFALL: the vault holds 1 of T but its ledgers owe 2",
      "    warning, burn height 60, UNKNOWN_EVENT: journal record 3 could not be read",
      "",
    ]);
  });

  it("names a refusal with no known code by what happened", () => {
    const refusal = (extra: Partial<RefusedCall>): RefusedCall => ({
      burnHeight: 5n,
      sender: f.bob,
      functionName: "execute-swap",
      args: [Cl.principal(f.alice)],
      reason: "response",
      result: Cl.error(Cl.uint(999)),
      txId: null,
      ...extra,
    });
    const d = digest({
      ...EMPTY,
      refusals: [
        refusal({}),
        refusal({ reason: "post-condition", result: Cl.ok(Cl.uint(1)) }),
        refusal({
          result: Cl.error(Cl.uint(123)),
          functionName: "approve-swap",
        }),
        refusal({ result: Cl.error(Cl.uint(123)) }),
        refusal({ burnHeight: 101n }),
      ],
    });
    // approve-swap acts on the sender's own vault; execute-swap names Alice.
    expect(d.owners.map((o) => [o.owner, o.refused.count])).toStrictEqual(
      [
        [f.alice, 3],
        [f.bob, 1],
      ].sort(),
    );
    expect(
      owner(d.owners, f.alice).refused.reasons.map((r) => [r.words, r.count]),
    ).toStrictEqual([
      ["Refused with an unknown code", 1],
      ["Stopped by a post-condition", 1],
      ["The oracle price is too old", 1],
    ]);
    expect(owner(d.owners, f.alice).lines).toContain(
      "  1 × Refused with an unknown code (u999): execute-swap.",
    );
    expect(owner(d.owners, f.alice).lines).toContain(
      "  1 × Stopped by a post-condition: execute-swap.",
    );
  });
});

describe("the runner's --digest", () => {
  const run = (...args: string[]) =>
    execFileSync(
      process.execPath,
      [
        "--import",
        "./scripts/resolve-ts.mjs",
        "scripts/monitor.ts",
        "--simnet-demo",
        "--digest",
        ...args,
      ],
      {
        cwd: join(import.meta.dirname, ".."),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );

  it("writes the digest to stdout and no alert lines, the same every run", () => {
    const text = run();
    expect(text).toMatch(/^Keelio vault digest: burn heights 0 to \d+\. /);
    expect(text).toContain("Trades: 3, of which 1 approved by the owner.");
    expect(text).toContain("Expired without an answer: agent ");
    expect(text).not.toContain('{"id"');
    expect(run()).toBe(text);
  });

  it("writes it to --out instead, as JSON with --json, for the range asked for", () => {
    const path = join(mkdtempSync(join(tmpdir(), "keelio-digest-")), "d.json");
    expect(run("--from", "4", "--to", "10", "--out", path, "--json")).toBe("");
    const d = JSON.parse(readFileSync(path, "utf8")) as {
      fromHeight: string;
      toHeight: string;
      owners: OwnerDigest[];
    };
    expect([d.fromHeight, d.toHeight]).toStrictEqual(["4", "10"]);
    expect(d.owners.length).toBeGreaterThan(0);
    // The demo's trades are all at burn height 3.
    for (const o of d.owners) expect(o.trades.count).toBe(0);
  });
});
