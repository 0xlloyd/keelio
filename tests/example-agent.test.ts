import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initSimnet } from "@stacks/clarinet-sdk";
import { Cl } from "@stacks/transactions";
import { describe, expect, it } from "vitest";
import {
  decide,
  lastFill,
  minOutFor,
  readState,
  shouldStandDown,
  tick,
  type AgentConfig,
  type TickOutcome,
} from "../examples/agent/agent.js";
import { buyThroughMcp } from "../examples/agent/mcp-agent.js";
import { networkChain } from "../examples/agent/network.js";
import {
  renderMcpExample,
  renderSdkExample,
  runMcpExample,
  runSdkExample,
} from "../examples/agent/run.js";
import {
  agentConfig,
  openVault,
  PRICE_SCALE,
} from "../examples/agent/simnet-harness.js";
import {
  EXECUTE_SWAP_ERRORS,
  vaultErrorName,
} from "../examples/agent/vault-errors.js";
import {
  buildApproveSwap,
  buildSetApprovalThreshold,
  minOutFloor,
  readVault,
  RULE_CODES,
  RULES,
  type FetchLike,
  type VaultState,
} from "../packages/sdk/src/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const exampleDir = join(root, "examples", "agent");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const PRICE_90K = 9_000_000_000_000n;

type Outcome<K extends TickOutcome["kind"]> = Extract<TickOutcome, { kind: K }>;

function as<K extends TickOutcome["kind"]>(
  outcome: TickOutcome | undefined,
  kind: K,
): Outcome<K> {
  if (outcome?.kind !== kind) {
    throw new Error(`expected ${kind}, got ${outcome?.kind}`);
  }
  return outcome as Outcome<K>;
}

describe("the example agent on the SDK", async () => {
  const run = await runSdkExample(await initSimnet());
  const { config } = run;
  const outcomes = run.ticks.map((t) => t.outcome);

  it("holds while the vault is inside the band", () => {
    expect(outcomes[0]).toStrictEqual({
      kind: "hold",
      action: "hold",
      reason: "inside the band",
      sbtcShareBps: 5_000n,
    });
  });

  it("sells sBTC when its share is above the band", () => {
    const sell = as(outcomes[1], "traded");
    expect(sell.plan).toStrictEqual({
      side: "sell",
      tokenIn: config.sbtc,
      tokenOut: config.quote,
      amountIn: 2_500_000n,
      sbtcShareBps: 5_263n,
      sized: null,
    });
    // The oracle value less the agent's 30 bps, above the 100 bps floor.
    expect(sell.minOut).toBe(2_492_500_000n);
    expect(sell.fill).toMatchObject({
      amountIn: 2_500_000n,
      amountOut: 2_500_000_000n,
      balanceIn: 47_500_000n,
      balanceOut: 47_500_000_000n,
      dayTotal: 2_500_000n,
    });
  });

  it("builds the swap in deny mode with the vault's and the adapter's post-conditions", () => {
    const { call } = as(outcomes[1], "traded");
    expect(call.functionName).toBe("execute-swap");
    expect(call.postConditionMode).toBe("deny");
    expect(call.postConditions).toStrictEqual([
      {
        type: "ft-postcondition",
        address: config.tx.vault,
        condition: "lte",
        amount: "2500000",
        asset: `${config.sbtc}::mock-sbtc`,
      },
      {
        type: "ft-postcondition",
        address: config.adapter,
        condition: "gte",
        amount: "2492500000",
        asset: `${config.quote}::mock-usd`,
      },
    ]);
  });

  it("predicts the cooldown refusal and sends nothing", () => {
    const refused = as(outcomes[2], "predicted-refusal");
    expect(refused.refusal.rule).toBe("COOLDOWN_ACTIVE");
    expect(refused.refusal.errorCode).toBe(116);
    expect(refused.errorName).toBe("ERR-COOLDOWN-ACTIVE");
    expect(refused.standDown).toBe(false);
    // Nothing was sent: the ledger is what the sell left.
    expect(run.ticks[3]!.before).toStrictEqual(run.ticks[2]!.before);
  });

  it("buys sBTC after the cooldown, capped by sizePosition", () => {
    const buy = as(outcomes[3], "traded");
    expect(buy.plan.side).toBe("buy");
    expect(buy.plan.sized).toStrictEqual({
      quantity: 5_343_000n,
      riskAmount: 427_440_000n,
    });
    // Back to target would take 4_750_000_000; the risk size allows less.
    expect(buy.plan.amountIn).toBe(4_274_400_000n);
    expect(buy.minOut).toBe(5_326_971n);
    expect(buy.fill).toMatchObject({
      amountIn: 4_274_400_000n,
      amountOut: 5_343_000n,
      balanceIn: 43_225_600_000n,
      balanceOut: 52_843_000n,
      dayTotal: 4_274_400_000n,
    });
  });

  it("maps the contract's refusal after the owner's pause to its name", () => {
    expect(run.ticks[4]!.ownerPauses).toBe(true);
    const refused = as(outcomes[4], "contract-refusal");
    expect(refused.errorCode).toBe(109);
    expect(refused.errorName).toBe("ERR-VAULT-PAUSED");
    expect(refused.standDown).toBe(true);
    expect(refused.plan.amountIn).toBe(2_407_000n);
  });

  it("predicts the pause on the next tick and sends nothing", () => {
    const refused = as(outcomes[5], "predicted-refusal");
    expect(refused.refusal.rule).toBe("VAULT_PAUSED");
    expect(refused.refusal.errorCode).toBe(109);
    expect(refused.errorName).toBe("ERR-VAULT-PAUSED");
    expect(refused.standDown).toBe(true);
  });

  it("ends with two trades in the ledger and nothing in the agent's wallet", () => {
    expect(outcomes.map((o) => o.kind)).toStrictEqual([
      "hold",
      "traded",
      "predicted-refusal",
      "traded",
      "contract-refusal",
      "predicted-refusal",
    ]);
    expect(run.final).toStrictEqual({
      sbtc: 52_843_000n,
      usd: 43_225_600_000n,
    });
    expect(run.paused).toBe(true);
    expect(run.agentWallet).toStrictEqual({ sbtc: 0n, usd: 0n });
  });

  it("journals only the calls that succeeded", () => {
    const events = run.journal.map((e) => e.event);
    expect(events.filter((e) => e === "execute-swap")).toHaveLength(2);
    expect(events.at(-1)).toBe("pause");
    expect(events).toHaveLength(13);
  });
});

describe("the agent's steps", async () => {
  const simnet = await initSimnet();
  const harness = openVault(simnet);
  harness.setPrice(PRICE_90K);
  const config = agentConfig(harness);
  const state = await readState(harness.chain, config);
  const { sbtc, quote } = config;

  const withBalances = (s: bigint, q: bigint): VaultState => ({
    ...state,
    balances: { [sbtc]: s, [quote]: q },
  });

  it("holds with no oracle price or an empty vault", () => {
    const noPrice = { ...state, oracle: { ...state.oracle, price: null } };
    expect(decide(noPrice, config)).toStrictEqual({
      action: "hold",
      reason: "no oracle price",
      sbtcShareBps: null,
    });
    expect(decide(withBalances(0n, 0n), config)).toMatchObject({
      action: "hold",
      reason: "the vault is empty",
    });
  });

  it("cuts a sell to the per-trade cap, the day's remainder and a lot", () => {
    // All sBTC: back to target would sell half, far above the 5_000_000 cap.
    const all = withBalances(100_000_000n, 0n);
    expect(decide(all, config)).toMatchObject({
      action: "trade",
      plan: { side: "sell", amountIn: 5_000_000n, sized: null },
    });
    const used = (dayTotal: bigint): VaultState => ({
      ...all,
      usage: { ...all.usage, dayTotals: { [sbtc]: dayTotal } },
    });
    expect(decide(used(12_345_678n), config)).toMatchObject({
      plan: { amountIn: 2_654_000n },
    });
    expect(decide(used(15_000_000n), config)).toMatchObject({
      action: "hold",
      reason: "nothing tradable inside the caps, the balance and a lot",
    });
  });

  it("cuts a buy to the quote token's cap when that is below the risk size", () => {
    const tight: AgentConfig = { ...config, riskBps: 200n };
    const decision = decide(withBalances(0n, 90_000_000_000n), tight);
    // The risk size allows 0.2 sBTC; the USD cap allows 5_000 USD.
    expect(decision).toMatchObject({
      plan: { side: "buy", amountIn: 4_999_500_000n },
    });
  });

  it("never sets min-out below the vault's floor", () => {
    const plan = {
      side: "sell" as const,
      tokenIn: sbtc,
      tokenOut: quote,
      amountIn: 1_000_000n,
      sbtcShareBps: 6_000n,
      sized: null,
    };
    const floor = minOutFloor(state, sbtc, plan.amountIn);
    expect(floor).toStrictEqual({ ok: true, floor: 891_000_000n });
    expect(minOutFor(state, plan, config)).toBe(897_300_000n);
    // An agent more tolerant than the owner still asks for the floor.
    const loose = { ...config, toleranceBps: 500n };
    expect(minOutFor(state, plan, loose)).toBe(891_000_000n);
    // No floor, no min-out: checkIntent refuses the trade.
    const unset = {
      ...state,
      priceBounds: { maxSlippageBps: 0n, maxPriceAge: 0n },
    };
    expect(minOutFor(unset, plan, config)).toBe(0n);
  });

  it("refuses off-chain, with no call, when the owner never set price bounds", async () => {
    const freshSimnet = await initSimnet();
    const fresh = openVault(freshSimnet);
    const { result } = freshSimnet.callPublicFn(
      "keelio-vault",
      "set-price-bounds",
      [Cl.uint(0), Cl.uint(0)],
      fresh.owner,
    );
    expect(result).toStrictEqual(Cl.ok(Cl.bool(true)));
    // Off target, so the agent wants to trade.
    fresh.setPrice(10_000_000_000_000n);
    let sent = 0;
    const wallet = {
      submit: async () => {
        sent += 1;
        return Cl.error(Cl.uint(0));
      },
    };
    const outcome = await tick(fresh.chain, wallet, agentConfig(fresh));
    const refused = as(outcome, "predicted-refusal");
    expect(refused.refusal.rule).toBe("PRICE_BOUNDS_UNSET");
    expect(refused.errorName).toBe("ERR-PRICE-BOUNDS-UNSET");
    expect(refused.minOut).toBe(0n);
    expect(sent).toBe(0);
  });

  it("reads only the fill of the swap just sent from the journal", () => {
    const swapEvent = (minOut: bigint, amountOut: bigint) =>
      Cl.tuple({
        event: Cl.stringAscii("execute-swap"),
        owner: Cl.principal(config.owner),
        "token-in": Cl.principal(sbtc),
        "amount-in": Cl.uint(1_000_000n),
        "min-out": Cl.uint(minOut),
        "amount-out": Cl.uint(amountOut),
        "balance-in": Cl.uint(1n),
        "balance-out": Cl.uint(2n),
        "day-total": Cl.uint(1_000_000n),
      });
    const older = { burnHeight: 5n, value: swapEvent(897_300_000n, 1n) };
    const sent = {
      owner: config.owner,
      tokenIn: sbtc,
      minOut: 900_000_000n,
      sinceBurnHeight: 5n,
    };
    // The journal has not caught up with the swap just sent.
    expect(() => lastFill([older], sent)).toThrow(/does not show/);
    expect(() =>
      lastFill([older], { ...sent, minOut: 897_300_000n, sinceBurnHeight: 6n }),
    ).toThrow(/does not show/);
    const newer = { burnHeight: 6n, value: swapEvent(900_000_000n, 2n) };
    expect(lastFill([older, newer], sent)).toMatchObject({
      burnHeight: 6n,
      amountOut: 2n,
    });
  });

  it("stands down only when the owner has stopped the agent", () => {
    for (const { errorCode } of RULES) {
      expect(shouldStandDown(errorCode)).toBe(
        errorCode === 108 || errorCode === 109 || errorCode === 110,
      );
    }
    expect(shouldStandDown(null)).toBe(false);
  });
});

describe("the agent asks for a trade above the owner's approval threshold", () => {
  const PRICE_100K = 10_000_000_000_000n;
  /** Below the 2,500,000 sats the agent sells at $100,000. */
  const THRESHOLD = 1_000_000n;

  /** A fresh vault whose owner set an sBTC approval threshold. */
  async function open() {
    const simnet = await initSimnet();
    const harness = openVault(simnet);
    const config = agentConfig(harness);
    harness.setPrice(PRICE_100K);
    const ownerSends = (call: {
      functionName: string;
      functionArgs: Parameters<typeof simnet.callPublicFn>[2];
    }) =>
      simnet.callPublicFn(
        "keelio-vault",
        call.functionName,
        call.functionArgs,
        harness.owner,
      ).result;
    expect(
      ownerSends(
        buildSetApprovalThreshold(config.tx, {
          token: config.sbtc,
          threshold: THRESHOLD,
        }),
      ),
    ).toStrictEqual(Cl.ok(Cl.bool(true)));
    const vault = () =>
      readVault(harness.chain.client, config.read, config.owner);
    return { simnet, harness, config, ownerSends, vault };
  }

  it("sends request-swap instead of giving up, and the owner's approval runs it", async () => {
    const { simnet, harness, config, ownerSends, vault } = await open();
    const at = BigInt(simnet.burnBlockHeight);
    const before = (await vault()).balances;
    const asked = as(
      await tick(harness.chain, harness.wallet, config),
      "requested",
    );
    expect(asked.plan).toMatchObject({ side: "sell", amountIn: 2_500_000n });
    expect(asked.expiresAt).toBe(at + 6n);
    // A request moves nothing, and its call says so.
    expect(asked.call.functionName).toBe("request-swap");
    expect(asked.call.postConditionMode).toBe("deny");
    expect(asked.call.postConditions).toStrictEqual([]);
    expect((await vault()).balances).toStrictEqual(before);
    expect((await vault()).pendingSwap).toMatchObject({
      agent: config.agent,
      amountIn: 2_500_000n,
      minOut: asked.minOut,
      expiresAt: at + 6n,
    });

    // While the request waits, the agent sends nothing more.
    const waiting = as(
      await tick(harness.chain, harness.wallet, config),
      "predicted-refusal",
    );
    expect(waiting.refusal).toMatchObject({
      rule: "REQUEST_PENDING",
      errorCode: 128,
    });
    expect(waiting.errorName).toBe("ERR-REQUEST-PENDING");
    expect(waiting.standDown).toBe(false);

    // The owner reads the request and approves exactly it: the trade that
    // was asked for, and the burn height it was asked at.
    const seen = (await vault()).pendingSwap!;
    expect(seen.requestedAt).toBe(at);
    const approval = buildApproveSwap(config.tx, {
      adapter: config.adapter,
      tokenIn: asked.plan.tokenIn,
      tokenOut: asked.plan.tokenOut,
      amountIn: asked.plan.amountIn,
      minOut: asked.minOut,
      requestedAt: seen.requestedAt,
    });
    expect(ownerSends(approval)).toStrictEqual(Cl.ok(Cl.uint(2_500_000_000n)));
    const after = await vault();
    expect(after.pendingSwap).toBeNull();
    expect(after.balances).toStrictEqual({
      [config.sbtc]: before[config.sbtc]! - 2_500_000n,
      [config.quote]: before[config.quote]! + 2_500_000_000n,
    });
  });

  it("a trade at or below the threshold still goes straight through", async () => {
    const { harness, config, ownerSends } = await open();
    expect(
      ownerSends(
        buildSetApprovalThreshold(config.tx, {
          token: config.sbtc,
          threshold: 2_500_000n,
        }),
      ),
    ).toStrictEqual(Cl.ok(Cl.bool(true)));
    const traded = as(
      await tick(harness.chain, harness.wallet, config),
      "traded",
    );
    expect(traded.call.functionName).toBe("execute-swap");
    expect(traded.fill.amountIn).toBe(2_500_000n);
  });

  it("reports the contract's refusal of a request, and stands down on a pause", async () => {
    const { harness, config, vault } = await open();
    harness.beforeNextSubmit(() => {
      harness.pause();
    });
    const refused = as(
      await tick(harness.chain, harness.wallet, config),
      "contract-refusal",
    );
    expect(refused.call.functionName).toBe("request-swap");
    expect(refused.errorCode).toBe(109);
    expect(refused.errorName).toBe("ERR-VAULT-PAUSED");
    expect(refused.standDown).toBe(true);
    expect((await vault()).pendingSwap).toBeNull();
    // On the next tick the pause is predicted before the threshold is.
    const next = as(
      await tick(harness.chain, harness.wallet, config),
      "predicted-refusal",
    );
    expect(next.refusal.rule).toBe("VAULT_PAUSED");
  });
});

describe("the agent's reads over a node", async () => {
  const simnet = await initSimnet();
  const harness = openVault(simnet);
  harness.setPrice(PRICE_90K);
  const config = agentConfig(harness);

  // A node stand-in that speaks the call-read wire format and answers from
  // the simnet. It opens no socket.
  const simnetFetch: FetchLike = async (url, init) => {
    const match =
      /^\/v2\/contracts\/call-read\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(
        new URL(url).pathname,
      );
    if (match === null) throw new Error(`unexpected path ${url}`);
    const [addr, name, fn] = match.slice(1).map(decodeURIComponent);
    const body = JSON.parse(init.body) as {
      sender: string;
      arguments: string[];
    };
    const { result } = simnet.callReadOnlyFn(
      `${addr}.${name}`,
      fn!,
      body.arguments.map((hex) => Cl.deserialize(hex)),
      body.sender,
    );
    return {
      ok: true,
      status: 200,
      json: async () => ({ okay: true, result: "0x" + Cl.serialize(result) }),
    };
  };

  it("reads the same state through networkChain as through the simnet", async () => {
    const chain = networkChain({
      baseUrl: "https://node.invalid",
      sender: harness.owner,
      fetch: simnetFetch,
      burnHeight: harness.chain.burnHeight,
      blockTimeMs: harness.chain.blockTimeMs,
      journal: harness.chain.journal,
    });
    const viaNode = await readState(chain, config);
    expect(viaNode).toStrictEqual(await readState(harness.chain, config));
    expect(viaNode.oracle.priceScale).toBe(PRICE_SCALE);
    expect(viaNode.balances[config.sbtc]).toBe(50_000_000n);
  });
});

describe("the example agent on the MCP tools", async () => {
  const example = await runMcpExample(await initSimnet());
  const { run, config } = example;

  it("reads the vault and sizes the buy with the tools", () => {
    expect(run.balances).toStrictEqual({
      sbtc: 50_000_000n,
      quote: 45_000_000_000n,
    });
    expect(run.sized).toStrictEqual({
      quantity: 5_000_000n,
      riskAmount: 450_000_000n,
    });
    expect(run.amountIn).toBe(4_500_000_000n);
  });

  it("gets no call for a min-out below the oracle floor, then one at the floor", () => {
    expect(run.attempts).toStrictEqual([
      {
        toleranceBps: 300n,
        minOut: 4_850_000n,
        refusal: {
          rule: "BELOW_ORACLE_FLOOR",
          errorCode: 125,
          errorName: "ERR-BELOW-ORACLE-FLOOR",
        },
      },
      { toleranceBps: 100n, minOut: 4_950_000n, refusal: null },
    ]);
  });

  it("decodes the tool's call, sends it and reads the journal", () => {
    expect(run.call?.functionName).toBe("execute-swap");
    expect(run.call?.functionArgs).toStrictEqual([
      Cl.principal(config.owner),
      Cl.principal(config.adapter),
      Cl.principal(config.quote),
      Cl.principal(config.sbtc),
      Cl.uint(4_500_000_000n),
      Cl.uint(4_950_000n),
    ]);
    expect(run.call?.postConditions).toHaveLength(2);
    expect(run.result).toStrictEqual(Cl.ok(Cl.uint(5_000_000n)));
    expect(run.event).toMatchObject({
      event: "execute-swap",
      owner: config.owner,
      agent: config.agent,
      "amount-in": "4500000000",
      "amount-out": "5000000",
      "min-out": "4950000",
    });
    expect(example.final).toStrictEqual({
      sbtc: 55_000_000n,
      usd: 40_500_000_000n,
    });
  });

  it("reads only the event of the swap just sent from keelio_journal", async () => {
    const swap = {
      event: "execute-swap",
      burnHeight: "4",
      "token-in": config.quote,
      "min-out": "4850000",
      "amount-out": "1",
    };
    const pause = { event: "pause", burnHeight: "9" };
    const through = (events: Record<string, unknown>[]) =>
      buyThroughMcp(
        {
          callTool: ({ name }) =>
            Promise.resolve({
              structuredContent: {
                keelio_get_vault: {
                  burnHeight: "9",
                  balances: { [config.quote]: "45000000000" },
                  policy: {
                    caps: { [config.quote]: { maxPerTrade: "5000000000" } },
                  },
                  dayRemaining: { [config.quote]: "15000000000" },
                },
                keelio_size_position: {
                  ok: true,
                  quantity: "5000000",
                  riskAmount: "1",
                },
                keelio_build_swap: {
                  ok: true,
                  call: { functionArgs: [], postConditions: [] },
                },
                keelio_journal: { events },
              }[name],
            }),
        },
        { submit: () => Promise.resolve(Cl.ok(Cl.uint(1))) },
        config,
      );
    // The owner's pause is newer than the swap, and the swap's own event has
    // not arrived: an older swap at another height must not pass for it.
    await expect(through([pause, swap])).rejects.toThrow(/does not show/);
    const mine = { ...swap, burnHeight: "9", "amount-out": "2" };
    expect((await through([pause, mine, swap])).event).toStrictEqual(mine);
  });
});

describe("vault-errors.ts", () => {
  it("names every execute-swap code as docs/errors.md does", () => {
    const listed = new Map<number, string>();
    for (const line of read("docs/errors.md").split("\n")) {
      const row = /^\| `keelio-vault`\s*\| `u(\d+)`\s*\| `([A-Z-]+)`/.exec(
        line,
      );
      if (row !== null) listed.set(Number(row[1]), row[2]!);
    }
    expect(listed.size).toBeGreaterThan(20);
    for (const [code, name] of Object.entries(EXECUTE_SWAP_ERRORS)) {
      expect(listed.get(Number(code)), `u${code}`).toBe(name);
    }
  });

  it("covers every rule the SDK's checks predict and the three codes none does", () => {
    // checkIntent's rules, and those of the request, approval and cancel
    // checks (u126 to u133).
    for (const { rule, errorCode } of RULES) {
      expect(RULE_CODES[rule]).toBe(errorCode);
    }
    const codes = [...Object.values(RULE_CODES), 104, 117, 118];
    expect(
      Object.keys(EXECUTE_SWAP_ERRORS)
        .map(Number)
        .sort((a, b) => a - b),
    ).toStrictEqual([...codes].sort((a, b) => a - b));
    expect(vaultErrorName(999)).toBe("unlisted code u999");
  });
});

/** The fenced blocks of one language in a Markdown file. */
function fenced(markdown: string, language: string): string[] {
  const blocks: string[] = [];
  let open: string[] | null = null;
  for (const line of markdown.split("\n")) {
    if (open === null) {
      if (line === "```" + language) open = [];
    } else if (line === "```") {
      blocks.push(open.join("\n"));
      open = null;
    } else {
      open.push(line);
    }
  }
  return blocks;
}

/**
 * The excerpts not found in any source. Whitespace is ignored, because an
 * excerpt from inside a function is shown without its indentation; every
 * other character must match.
 */
function missingExcerpts(excerpts: string[], sources: string[]): string[] {
  const squash = (text: string) => text.replace(/\s+/g, "");
  const squashed = sources.map(squash);
  return excerpts.filter((excerpt) => {
    const needle = squash(excerpt);
    return needle === "" || !squashed.some((s) => s.includes(needle));
  });
}

describe("docs/integration-guide.md", async () => {
  const guide = read("docs/integration-guide.md");
  const sources = readdirSync(exampleDir)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => readFileSync(join(exampleDir, name), "utf8"));
  const output =
    renderSdkExample(await runSdkExample(await initSimnet())) +
    "\n" +
    renderMcpExample(await runMcpExample(await initSimnet()));

  it("takes every ts excerpt from the example's source", () => {
    const excerpts = fenced(guide, "ts");
    expect(excerpts.length).toBeGreaterThanOrEqual(10);
    expect(missingExcerpts(excerpts, sources)).toStrictEqual([]);
  });

  it("the excerpt check catches a changed excerpt", () => {
    const [first] = fenced(guide, "ts");
    const changed = first!.replace("burnHeight", "height");
    expect(changed).not.toBe(first);
    expect(missingExcerpts([first!, changed], sources)).toStrictEqual([
      changed,
    ]);
    expect(missingExcerpts([""], sources)).toStrictEqual([""]);
  });

  it("shows the example's real output", () => {
    const blocks = fenced(guide, "text");
    expect(blocks).toHaveLength(1);
    expect(blocks[0] + "\n").toBe(output);
  });

  it("links only to docs that exist", () => {
    const links = [...guide.matchAll(/\]\(([\w-]+\.md)(#[\w-]+)?\)/g)];
    expect(links.length).toBeGreaterThan(5);
    for (const [, file] of links) {
      expect(() => read(`docs/${file}`), file).not.toThrow();
    }
  });

  it("pnpm run example:agent prints that output and exits 0", async () => {
    const script = JSON.parse(read("package.json")).scripts["example:agent"];
    expect(script).toBe(
      "node --import ./scripts/resolve-ts.mjs examples/agent/run.ts",
    );
    const child = spawn(
      process.execPath,
      ["--import", "./scripts/resolve-ts.mjs", "examples/agent/run.ts"],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.resume();
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    expect(code).toBe(0);
    expect(stdout).toBe(output);
  });
});

describe("the agent keeps to its side of the seam", () => {
  it("agent.ts and mcp-agent.ts import nothing from the simnet or the harness", () => {
    for (const name of ["agent.ts", "mcp-agent.ts", "vault-errors.ts"]) {
      const source = readFileSync(join(exampleDir, name), "utf8");
      const imports = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
      for (const specifier of imports) {
        expect(specifier, name).not.toMatch(/clarinet|simnet|harness|run\.js/);
      }
    }
  });

  it("no example file signs, broadcasts or reads a key", () => {
    for (const name of readdirSync(exampleDir)) {
      const source = readFileSync(join(exampleDir, name), "utf8");
      expect(source, name).not.toMatch(
        /makeContractCall|broadcastTransaction|senderKey|privateKey|mnemonic/i,
      );
    }
  });
});
