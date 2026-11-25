// The same loop through the MCP server's tools instead of the SDK. An agent
// that speaks MCP (usually a model) makes these tool calls itself; this file
// scripts the sequence so the run is deterministic and needs no model.
//
// The tools take and return decimal strings of base units. Nothing here
// imports the simnet or the MCP SDK: `ToolCaller` is the one method of an MCP
// client the loop uses.
import {
  Cl,
  type ClarityValue,
  type PostCondition,
} from "@stacks/transactions";
import type { VaultCall } from "../../packages/sdk/src/index.js";
import type { Wallet } from "./agent.js";
import { vaultErrorName } from "./vault-errors.js";

const BPS = 10_000n;
/** sBTC base units per whole sBTC. */
const SATS = 100_000_000n;

type Json = Record<string, unknown>;

/** The part of an MCP client this loop uses. `Client.callTool` satisfies it. */
export interface ToolCaller {
  callTool(request: { name: string; arguments: Json }): Promise<unknown>;
}

export interface McpBuyConfig {
  owner: string;
  agent: string;
  adapter: string;
  sbtc: string;
  quote: string;
  /**
   * BTC price in quote base units per whole sBTC, from the agent's own price
   * source. The tools do not return the vault's oracle price.
   */
  price: bigint;
  /** The most a fall to the stop may lose, in bps of the vault's value. */
  riskBps: bigint;
  /** How far below `price` the stop sits, in bps. */
  stopBps: bigint;
  lotSize: bigint;
  /** Tolerances to try for min-out, loosest first, in bps below `price`. */
  tolerancesBps: readonly bigint[];
}

/** One `keelio_build_swap` call and what it answered. */
export interface McpAttempt {
  toleranceBps: bigint;
  minOut: bigint;
  /** `null` when the tool built a call. */
  refusal: { rule: string; errorCode: number; errorName: string } | null;
}

export interface McpRun {
  /** The owner's ledger from `keelio_get_vault`, before the trade. */
  balances: { sbtc: bigint; quote: bigint };
  /** From `keelio_size_position`, in sats and quote base units. */
  sized: { quantity: bigint; riskAmount: bigint };
  amountIn: bigint;
  attempts: McpAttempt[];
  /** The decoded call, or `null` when every attempt was refused. */
  call: VaultCall | null;
  /** The transaction's result, or `null` when nothing was sent. */
  result: ClarityValue | null;
  /** The `keelio_journal` event of the swap, after a successful send. */
  event: Json | null;
}

/**
 * Calls one tool and returns its structured result. A tool error
 * (`isError: true`, a malformed input or a failed chain read) is thrown; a
 * refused trade is a normal result with `ok: false`.
 */
export async function callKeelioTool(
  tools: ToolCaller,
  name: string,
  args: Json,
): Promise<Json> {
  const res = (await tools.callTool({ name, arguments: args })) as {
    isError?: boolean;
    structuredContent?: Json;
  };
  const body = res.structuredContent ?? {};
  if (res.isError === true) {
    throw new Error(`${name} failed: ${JSON.stringify(body.error ?? body)}`);
  }
  return body;
}

/** Turns the `call` of `keelio_build_swap` back into a `VaultCall` for a wallet. */
export function decodeCall(call: Json): VaultCall {
  const functionArgs = (call.functionArgs as string[]).map((hex) =>
    Cl.deserialize(hex),
  );
  return {
    contractAddress: call.contractAddress as string,
    contractName: call.contractName as string,
    functionName: call.functionName as string,
    functionArgs,
    postConditions: call.postConditions as PostCondition[],
    postConditionMode: "deny",
  };
}

function record(value: unknown): Record<string, string> {
  return (value ?? {}) as Record<string, string>;
}

function smallest(...values: bigint[]): bigint {
  return values.reduce((a, b) => (b < a ? b : a));
}

/**
 * Buys sBTC through the tools: read the vault, size the buy, ask
 * `keelio_build_swap` for a call (it runs the policy check on every call), have
 * the wallet send it, and read the journal.
 */
export async function buyThroughMcp(
  tools: ToolCaller,
  wallet: Wallet,
  config: McpBuyConfig,
): Promise<McpRun> {
  const { owner, sbtc, quote, price } = config;

  // Read: balances, caps and what is left of today's cap, as decimal strings.
  const vault = await callKeelioTool(tools, "keelio_get_vault", { owner });
  const balances = {
    sbtc: BigInt(record(vault.balances)[sbtc] ?? "0"),
    quote: BigInt(record(vault.balances)[quote] ?? "0"),
  };
  // The swap sent below cannot be older than this read.
  const sinceBurnHeight = BigInt(vault.burnHeight as string);
  const policy = vault.policy as { caps: Record<string, Json> };
  const maxPerTrade = BigInt(
    (policy.caps[quote]?.maxPerTrade as string) ?? "0",
  );
  const dayLeft = BigInt(record(vault.dayRemaining)[quote] ?? "0");

  // Size: the tool only computes; it does not read the vault or the policy.
  const capital = balances.quote + (balances.sbtc * price) / SATS;
  const size = await callKeelioTool(tools, "keelio_size_position", {
    capital: capital.toString(),
    riskBps: config.riskBps.toString(),
    entry: price.toString(),
    stop: ((price * (BPS - config.stopBps)) / BPS).toString(),
    lotSize: config.lotSize.toString(),
  });
  if (size.ok !== true) {
    throw new Error(`keelio_size_position refused: ${String(size.code)}`);
  }
  const sized = {
    quantity: BigInt(size.quantity as string),
    riskAmount: BigInt(size.riskAmount as string),
  };
  const amountIn = smallest(
    (sized.quantity * price) / SATS,
    maxPerTrade,
    dayLeft,
    balances.quote,
  );

  const run: McpRun = {
    balances,
    sized,
    amountIn,
    attempts: [],
    call: null,
    result: null,
    event: null,
  };

  // Check and build in one call. A refusal comes back with no `call`, so
  // there is nothing to send. BELOW_ORACLE_FLOOR means the agent asked for
  // less than the owner allows: ask for more and try again.
  let built: Json | null = null;
  for (const toleranceBps of config.tolerancesBps) {
    const atPrice = (amountIn * SATS) / price;
    const minOut = (atPrice * (BPS - toleranceBps) + BPS - 1n) / BPS;
    const answer = await callKeelioTool(tools, "keelio_build_swap", {
      owner,
      agent: config.agent,
      adapter: config.adapter,
      tokenIn: quote,
      tokenOut: sbtc,
      amountIn: amountIn.toString(),
      minOut: minOut.toString(),
    });
    if (answer.ok === true) {
      run.attempts.push({ toleranceBps, minOut, refusal: null });
      built = answer.call as Json;
      break;
    }
    const errorCode = answer.errorCode as number;
    const rule = answer.rule as string;
    const errorName = vaultErrorName(errorCode);
    run.attempts.push({
      toleranceBps,
      minOut,
      refusal: { rule, errorCode, errorName },
    });
    if (rule !== "BELOW_ORACLE_FLOOR") break;
  }
  if (built === null) return run;
  const sent = run.attempts[run.attempts.length - 1]!;

  // Send: the tool's call is unsigned. The agent's own wallet signs it.
  run.call = decodeCall(built);
  run.result = await wallet.submit(run.call);
  if (run.result.type !== "ok") return run;

  // Journal: newest first. Take only the event of the swap just sent (an
  // execute-swap with the same input token and min-out, at or after the
  // height read first), as `lastFill` does in agent.ts: the owner's own
  // calls print events too, and on a network the event index can lag.
  const journal = await callKeelioTool(tools, "keelio_journal", { owner });
  const event = (journal.events as Json[]).find(
    (e) =>
      e.event === "execute-swap" &&
      e["token-in"] === quote &&
      e["min-out"] === sent.minOut.toString() &&
      BigInt(e.burnHeight as string) >= sinceBurnHeight,
  );
  if (event === undefined) {
    throw new Error(
      `keelio_journal does not show the swap just sent for ${owner} yet`,
    );
  }
  run.event = event;
  return run;
}
