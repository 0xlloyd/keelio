// `pnpm run example:agent`: the worked example from docs/integration-guide.md.
// Part 1 runs the rebalancer in `agent.ts` through the SDK; part 2 runs one
// buy through the MCP server's tools. Each part gets a fresh in-process
// simnet. Nothing is signed or broadcast, and nothing touches the network.
import { pathToFileURL } from "node:url";
import { initSimnet } from "@stacks/clarinet-sdk";
import { Cl, type ClarityValue } from "@stacks/transactions";
import {
  createServer,
  type KeelioChain,
} from "../../packages/mcp/src/index.js";
import { Client, InMemoryTransport } from "../../packages/mcp/testing.js";
import { readVault, type VaultCall } from "../../packages/sdk/src/index.js";
import { formatBtc, formatUnits } from "../../scripts/format-amount.js";
import { tick, type AgentConfig, type TickOutcome } from "./agent.js";
import { buyThroughMcp, type McpBuyConfig, type McpRun } from "./mcp-agent.js";
import {
  agentConfig,
  openVault,
  OWNER_SETUP,
  type Harness,
  type Simnet,
} from "./simnet-harness.js";

/** BTC/USD with the oracle's 8 decimals. */
const PRICE_80K = 8_000_000_000_000n;
const PRICE_90K = 9_000_000_000_000n;
const PRICE_100K = 10_000_000_000_000n;

/**
 * The market and the owner, tick by tick: how many burn blocks pass first,
 * the oracle price, and whether the owner's pause is mined just ahead of the
 * agent's transaction.
 */
const SCRIPT: readonly {
  blocks: number;
  price: bigint;
  ownerPauses?: true;
}[] = [
  { blocks: 1, price: PRICE_90K },
  { blocks: 1, price: PRICE_100K },
  { blocks: 1, price: PRICE_80K },
  { blocks: 2, price: PRICE_80K },
  { blocks: 3, price: PRICE_90K, ownerPauses: true },
  { blocks: 1, price: PRICE_90K },
];

export interface Ledger {
  sbtc: bigint;
  usd: bigint;
}

export interface TickRecord {
  price: bigint;
  /** Burn blocks mined since the tick before. */
  blocks: number;
  /** The owner's ledger before the tick. */
  before: Ledger;
  ownerPauses: boolean;
  outcome: TickOutcome;
}

export interface SdkRun {
  config: AgentConfig;
  ticks: TickRecord[];
  final: Ledger;
  paused: boolean;
  /** The agent's own wallet balances at the end: it never holds the tokens. */
  agentWallet: Ledger;
  /** Every vault print event of the run, as `(event, burn height)`. */
  journal: { event: string; burnHeight: bigint }[];
}

async function ledger(harness: Harness): Promise<Ledger> {
  const { balances } = await readVault(
    harness.chain.client,
    harness.read,
    harness.owner,
  );
  return {
    sbtc: balances[harness.ids.sbtc] ?? 0n,
    usd: balances[harness.ids.usd] ?? 0n,
  };
}

/** Part 1: the rebalancer through the SDK. Prints nothing. */
export async function runSdkExample(simnet: Simnet): Promise<SdkRun> {
  const harness = openVault(simnet);
  const config = agentConfig(harness);
  const ticks: TickRecord[] = [];
  for (const step of SCRIPT) {
    harness.mineBurnBlocks(step.blocks);
    harness.setPrice(step.price);
    if (step.ownerPauses) harness.beforeNextSubmit(() => harness.pause());
    const before = await ledger(harness);
    const outcome = await tick(harness.chain, harness.wallet, config);
    ticks.push({
      price: step.price,
      blocks: step.blocks,
      before,
      ownerPauses: step.ownerPauses ?? false,
      outcome,
    });
  }
  const read = await readVault(
    harness.chain.client,
    harness.read,
    harness.owner,
  );
  const events = await harness.chain.journal();
  return {
    config,
    ticks,
    final: await ledger(harness),
    paused: read.vault.paused,
    agentWallet: {
      sbtc: harness.walletBalance(harness.ids.sbtc, harness.agent),
      usd: harness.walletBalance(harness.ids.usd, harness.agent),
    },
    journal: events.map(({ burnHeight, value }) => {
      const name = value.type === "tuple" ? value.value.event : undefined;
      return {
        event: name?.type === "ascii" ? name.value : Cl.prettyPrint(value),
        burnHeight,
      };
    }),
  };
}

export interface McpExample {
  config: McpBuyConfig;
  run: McpRun;
  final: Ledger;
}

/** Part 2: one buy through the MCP tools, over an in-memory transport. */
export async function runMcpExample(simnet: Simnet): Promise<McpExample> {
  const harness = openVault(simnet);
  harness.mineBurnBlocks(1);
  harness.setPrice(PRICE_90K);

  // The server reads through a `KeelioChain`. The harness's chain already has
  // every part of one.
  const chain: KeelioChain = {
    callReadOnly: harness.chain.client.callReadOnly,
    burnHeight: harness.chain.burnHeight,
    blockTimeMs: harness.chain.blockTimeMs,
    vaultEvents: harness.chain.journal,
  };
  const server = createServer({ chain, read: harness.read, tx: harness.tx });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "example-agent", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

  const config: McpBuyConfig = {
    owner: harness.owner,
    agent: harness.agent,
    adapter: harness.ids.dex,
    sbtc: harness.ids.sbtc,
    quote: harness.ids.usd,
    // $90,000 in USD base units (6 decimals): the agent's own price.
    price: 90_000_000_000n,
    riskBps: 50n,
    stopBps: 1_000n,
    lotSize: 1_000n,
    tolerancesBps: [300n, 100n],
  };
  try {
    const run = await buyThroughMcp(client, harness.wallet, config);
    return { config, run, final: await ledger(harness) };
  } finally {
    await client.close();
  }
}

const usd = (amount: bigint) => `${formatUnits(amount, 6)} USD`;
const btc = (amount: bigint) => `${formatBtc(amount)} sBTC`;
const percent = (bps: bigint) => `${formatUnits(bps, 2)}%`;
const show = (value: ClarityValue) => Cl.prettyPrint(value);

const COMPARATORS = {
  eq: "exactly",
  gt: "more than",
  gte: "at least",
  lt: "less than",
  lte: "at most",
} as const;

function postConditions(call: VaultCall, indent: string): string[] {
  return call.postConditions.map((pc) =>
    pc.type === "ft-postcondition"
      ? `${indent}${pc.address.split(".")[1] ?? pc.address} sends ${COMPARATORS[pc.condition]} ${pc.amount} base units of ${pc.asset.split("::")[1]}`
      : `${indent}${pc.type}`,
  );
}

function tickLines(record: TickRecord, index: number, config: AgentConfig) {
  const { outcome, before } = record;
  const lines = [
    `Tick ${index + 1}: ${record.blocks} burn block${record.blocks === 1 ? "" : "s"} later, BTC/USD ${formatUnits(record.price, 8)}`,
    `  read:    ledger ${btc(before.sbtc)} and ${usd(before.usd)}`,
  ];
  if (outcome.kind === "hold") {
    const share =
      outcome.sbtcShareBps === null
        ? ""
        : `sBTC is ${percent(outcome.sbtcShareBps)} of the vault's value; `;
    lines.push(`  decide:  hold. ${share}${outcome.reason}`);
    return lines;
  }
  const { plan, minOut } = outcome;
  const amount = (token: string, value: bigint) =>
    token === config.sbtc ? btc(value) : usd(value);
  lines.push(
    `  decide:  sBTC is ${percent(plan.sbtcShareBps)} of the vault's value, target ${percent(config.targetSbtcBps)}: ${plan.side} sBTC`,
  );
  if (plan.sized !== null) {
    lines.push(
      `  size:    sizePosition allows ${btc(plan.sized.quantity)} (a ${percent(config.stopBps)} fall would lose ${usd(plan.sized.riskAmount)})`,
    );
  }
  lines.push(
    `  size:    ${plan.side === "sell" ? "sell" : "spend"} ${amount(plan.tokenIn, plan.amountIn)}`,
    `  min-out: ${amount(plan.tokenOut, minOut)}`,
  );
  if (outcome.kind === "predicted-refusal") {
    const { refusal } = outcome;
    lines.push(
      `  check:   refused, ${refusal.rule} (u${refusal.errorCode} ${outcome.errorName}): ${refusal.message}`,
      "  send:    nothing. No call was built and no fee was paid.",
    );
  } else if (outcome.kind === "requested") {
    lines.push(
      "  check:   above the owner's approval threshold (u126 ERR-APPROVAL-REQUIRED)",
      "  build:   request-swap, deny mode, no post-conditions: nothing moves",
      `  send:    (ok). The owner can approve until burn height ${outcome.expiresAt}.`,
    );
    return lines;
  } else {
    lines.push(
      "  check:   ok, no policy or oracle rule refuses",
      `  build:   ${outcome.call.functionName}, deny mode, ${outcome.call.postConditions.length === 0 ? "no post-conditions" : "with post-conditions:"}`,
      ...postConditions(outcome.call, "             "),
    );
    if (record.ownerPauses) {
      lines.push(
        "  (the owner's pause is mined just ahead of the agent's transaction)",
      );
    }
    if (outcome.kind === "contract-refusal") {
      const code = outcome.errorCode === null ? "?" : `u${outcome.errorCode}`;
      lines.push(
        `  send:    (err ${code}) ${outcome.errorName}. The contract refused; nothing moved.`,
      );
    } else {
      const { fill } = outcome;
      lines.push(
        "  send:    (ok)",
        `  journal: execute-swap at burn height ${fill.burnHeight}: sold ${amount(plan.tokenIn, fill.amountIn)} for ${amount(plan.tokenOut, fill.amountOut)},`,
        `           ledger now ${amount(plan.tokenIn, fill.balanceIn)} and ${amount(plan.tokenOut, fill.balanceOut)}, day total ${amount(plan.tokenIn, fill.dayTotal)}`,
      );
    }
  }
  if (outcome.kind !== "traded" && outcome.standDown) {
    lines.push(
      "  The owner has stopped the agent. It stands down until a read shows otherwise.",
    );
  }
  return lines;
}

/** The stdout of part 1. Pure. */
export function renderSdkExample(run: SdkRun): string {
  const { config } = run;
  const o = OWNER_SETUP;
  const trades = run.ticks.filter((t) => t.outcome.kind === "traded").length;
  const predicted = run.ticks.filter(
    (t) => t.outcome.kind === "predicted-refusal",
  ).length;
  const refused = run.ticks.filter(
    (t) => t.outcome.kind === "contract-refusal",
  ).length;
  const lines = [
    "Keelio example agent, part 1: a rebalancer on the SDK",
    "A fresh in-process simnet with its throwaway accounts. Nothing is signed or broadcast.",
    "",
    "Setup (the harness, not the agent)",
    `  The owner deposits ${btc(o.sbtcDeposit)} and ${usd(o.usdDeposit)} and names the agent.`,
    `  Caps: ${btc(o.sbtcMaxPerTrade)} per trade and ${btc(o.sbtcMaxPerDay)} per day; ${usd(o.usdMaxPerTrade)} per trade and ${usd(o.usdMaxPerDay)} per day.`,
    `  Cooldown ${o.cooldownBlocks} burn blocks. Min-out at most ${percent(o.maxSlippageBps)} below the oracle price.`,
    `  The agent holds ${percent(config.targetSbtcBps)} of the vault's value in sBTC, give or take ${percent(config.bandBps)},`,
    `  asks for the oracle price less ${percent(config.toleranceBps)}, and sizes a buy so a ${percent(config.stopBps)} fall loses at most ${percent(config.riskBps)}.`,
    "",
    ...run.ticks.flatMap((record, i) => [...tickLines(record, i, config), ""]),
    "Result",
    `  ${trades} trades, ${predicted} refusals predicted off-chain (no call made), ${refused} refused by the contract.`,
    `  owner's ledger: ${btc(run.final.sbtc)} and ${usd(run.final.usd)}, paused: ${run.paused}`,
    `  agent's wallet: ${btc(run.agentWallet.sbtc)} and ${usd(run.agentWallet.usd)}. The tokens never pass through it.`,
    `  journal: ${run.journal.map((e) => e.event).join(", ")}`,
    "  A refused call prints no event, so the journal holds only what happened.",
  ];
  return `${lines.join("\n")}\n`;
}

/** The stdout of part 2. Pure. */
export function renderMcpExample(example: McpExample): string {
  const { run, config } = example;
  const lines = [
    "Keelio example agent, part 2: one buy through the MCP tools",
    "A second fresh simnet, the same owner setup, BTC/USD 90000.00000000.",
    "",
    `  keelio_get_vault:     ledger ${btc(run.balances.sbtc)} and ${usd(run.balances.quote)}`,
    `  keelio_size_position: ${btc(run.sized.quantity)} (a ${percent(config.stopBps)} fall would lose ${usd(run.sized.riskAmount)})`,
    `  The agent will spend ${usd(run.amountIn)}.`,
  ];
  for (const attempt of run.attempts) {
    const asked = `min-out ${btc(attempt.minOut)} (${percent(attempt.toleranceBps)} below the agent's price)`;
    lines.push(
      attempt.refusal === null
        ? `  keelio_build_swap:    ${asked}: ok, an unsigned call`
        : `  keelio_build_swap:    ${asked}: refused, ${attempt.refusal.rule} (u${attempt.refusal.errorCode} ${attempt.refusal.errorName}), no call`,
    );
  }
  if (run.call !== null) {
    lines.push(
      "  The call's post-conditions:",
      ...postConditions(run.call, "    "),
    );
  }
  if (run.result !== null) {
    lines.push(`  wallet (simnet):    ${show(run.result)}`);
  }
  if (run.event !== null) {
    const e = run.event as Record<string, string>;
    lines.push(
      `  keelio_journal:       ${e.event} at burn height ${e.burnHeight}: sold ${usd(BigInt(e["amount-in"]!))} for ${btc(BigInt(e["amount-out"]!))}`,
    );
  }
  lines.push(
    `  owner's ledger: ${btc(example.final.sbtc)} and ${usd(example.final.usd)}`,
  );
  return `${lines.join("\n")}\n`;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  // The simnet echoes every contract `print` with console.log. Send that to
  // stderr so stdout holds only the run below.
  console.log = (...args: unknown[]) => console.error(...args);
  try {
    const sdk = await runSdkExample(await initSimnet());
    const mcp = await runMcpExample(await initSimnet());
    process.stdout.write(`${renderSdkExample(sdk)}\n${renderMcpExample(mcp)}`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
