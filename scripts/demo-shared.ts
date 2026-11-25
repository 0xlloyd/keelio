// What `pnpm run demo` (scripts/demo.ts) and `pnpm run demo:bitflow`
// (scripts/demo-bitflow.ts) both need: sending SDK-built calls to keelio-vault
// and journalling its events, the checkIntent-then-execute-swap attempt, and
// the lines that render a check, a refusal and a journal event.
import { pathToFileURL } from "node:url";
import type { initSimnet } from "@stacks/clarinet-sdk";
import { Cl, type ClarityValue } from "@stacks/transactions";
import { vaultPrints } from "../packages/mcp/src/chain.js";
import {
  buildExecuteSwap,
  checkIntent,
  readVault,
  type IntentCheck,
  type ReadOnlyClient,
  type TxConfig,
  type VaultCall,
  type VaultConfig,
  type VaultState,
} from "../packages/sdk/src/index.js";

export type Simnet = Awaited<ReturnType<typeof initSimnet>>;

/** The constant names of the codes the demos show, copied from docs/errors.md. */
const ERROR_NAMES: Readonly<Record<string, string>> = {
  "101": "ERR-INSUFFICIENT-BALANCE",
  "109": "ERR-VAULT-PAUSED",
  "114": "ERR-TRADE-CAP-EXCEEDED",
};

export interface SwapAttempt {
  check: IntentCheck;
  result: ClarityValue;
}

export function uintOf(value: ClarityValue): bigint {
  if (value.type !== "uint")
    throw new Error(`expected uint, got ${value.type}`);
  return BigInt(value.value);
}

export function okValue(value: ClarityValue): ClarityValue {
  if (value.type !== "ok") throw new Error(`expected ok, got ${value.type}`);
  return value.value;
}

/**
 * `send` runs an SDK-built call on the simnet as `sender` and appends every
 * print event of the vault `vaultId` to `journal`.
 */
export function vaultSender(
  simnet: Simnet,
  vaultId: string,
): {
  journal: ClarityValue[];
  send: (call: VaultCall, sender: string) => ClarityValue;
} {
  const journal: ClarityValue[] = [];
  const send = (call: VaultCall, sender: string): ClarityValue => {
    const response = simnet.callPublicFn(
      `${call.contractAddress}.${call.contractName}`,
      call.functionName,
      call.functionArgs,
      sender,
    );
    journal.push(...vaultPrints(response.events, vaultId));
    return response.result;
  };
  return { journal, send };
}

export interface SwapContext {
  simnet: Simnet;
  client: ReadOnlyClient;
  readConfig: VaultConfig;
  tx: TxConfig;
  send: (call: VaultCall, sender: string) => ClarityValue;
  owner: string;
  agent: string;
  adapter: string;
}

export interface Trade {
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  /** A fixed min-out, or one worked out from the state checkIntent will see. */
  minOut: bigint | ((state: VaultState) => bigint);
}

/**
 * Reads the vault, asks `checkIntent` about the trade, then sends the
 * SDK-built `execute-swap` as the agent whatever the check said, so the two
 * answers can be shown side by side.
 */
export async function attemptSwap(
  ctx: SwapContext,
  trade: Trade,
): Promise<SwapAttempt & { minOut: bigint }> {
  const { simnet, owner, agent, adapter } = ctx;
  const { tokenIn, tokenOut, amountIn } = trade;
  const read = await readVault(ctx.client, ctx.readConfig, owner);
  const state: VaultState = {
    ...read,
    burnHeight: BigInt(simnet.burnBlockHeight),
    nowMs: BigInt(simnet.getBlockTime()) * 1000n,
  };
  const minOut =
    typeof trade.minOut === "bigint" ? trade.minOut : trade.minOut(state);
  const check = checkIntent(state, {
    caller: agent,
    adapter,
    tokenIn,
    tokenOut,
    amountIn,
    minOut,
  });
  const result = ctx.send(
    buildExecuteSwap(ctx.tx, {
      owner,
      adapter,
      tokenIn,
      tokenOut,
      amountIn,
      minOut,
    }),
    agent,
  );
  return { check, result, minOut };
}

export const show = (value: ClarityValue): string => Cl.prettyPrint(value);

/** An `(err uN)` with its constant name, when the demos know it. */
export function showRefusal(value: ClarityValue): string {
  const code =
    value.type === "err" && value.value.type === "uint"
      ? ERROR_NAMES[value.value.value.toString()]
      : undefined;
  return code === undefined ? show(value) : `${show(value)} ${code}`;
}

export const showCheck = (c: IntentCheck): string =>
  c.ok
    ? "ok, no policy rule refuses"
    : `${c.rule} (u${c.errorCode}): ${c.message}`;

type Fields = Record<string, ClarityValue>;

/** One readable line for a keelio-vault print event (see docs/events.md). */
export function journalLine(
  event: ClarityValue,
  label: (principal: string) => string,
  amount: (token: string, value: bigint) => string | bigint,
  policyHeight: bigint,
): string {
  if (event.type !== "tuple") return Cl.prettyPrint(event);
  const f: Fields = event.value;
  const get = (name: string): ClarityValue => {
    const value = f[name];
    if (value === undefined) throw new Error(`event has no ${name}`);
    return value;
  };
  const text = (name: string): string => {
    const value = get(name);
    if (value.type !== "ascii" && value.type !== "utf8") {
      throw new Error(`${name} is not a string`);
    }
    return value.value;
  };
  const who = (name: string): string => {
    const value = get(name);
    if (value.type === "none") return "none";
    const inner = value.type === "some" ? value.value : value;
    return label(Cl.prettyPrint(inner).replace(/^'/, ""));
  };
  const num = (name: string): bigint => uintOf(get(name));
  const flag = (name: string): string => Cl.prettyPrint(get(name));
  const name = text("event");
  const head = `${name.padEnd(16)} ${who("owner")}`;

  switch (name) {
    case "deposit":
    case "withdraw": {
      const token = Cl.prettyPrint(get("token")).replace(/^'/, "");
      return `${head}: ${amount(token, num("amount"))}, ledger ${amount(token, num("balance"))}`;
    }
    case "set-agent":
    case "remove-agent":
    case "pause":
    case "unpause":
      return `${head}: agent=${who("agent")} paused=${flag("paused")}`;
    case "set-token-caps": {
      const token = Cl.prettyPrint(get("token")).replace(/^'/, "");
      return (
        `${head}: token=${who("token")} max-per-trade=${amount(token, num("max-per-trade"))}` +
        ` max-per-day=${amount(token, num("max-per-day"))}`
      );
    }
    case "set-policy":
      return (
        `${head}: cooldown-blocks=${num("cooldown-blocks")},` +
        ` expires ${num("expires-at") - policyHeight} burn blocks after it was set`
      );
    case "allow-token":
      return `${head}: token=${who("token")} allowed=${flag("allowed")}`;
    case "allow-adapter":
      return `${head}: adapter=${who("adapter")} allowed=${flag("allowed")}`;
    case "set-price-bounds":
      return `${head}: max-slippage-bps=${num("max-slippage-bps")} max-price-age=${num("max-price-age")} ms`;
    case "execute-swap": {
      const tokenIn = Cl.prettyPrint(get("token-in")).replace(/^'/, "");
      const tokenOut = Cl.prettyPrint(get("token-out")).replace(/^'/, "");
      return (
        `${head}: ${who("agent")} sold ${amount(tokenIn, num("amount-in"))}` +
        ` for ${amount(tokenOut, num("amount-out"))} on ${who("adapter")}` +
        ` (min ${amount(tokenOut, num("min-out"))}),` +
        ` ledger ${amount(tokenIn, num("balance-in"))} and ${amount(tokenOut, num("balance-out"))},` +
        ` day total ${amount(tokenIn, num("day-total"))}`
      );
    }
    default:
      return `${head}: ${Cl.prettyPrint(event)}`;
  }
}

/**
 * Runs `story` and writes what it returns to stdout, but only when the module
 * at `moduleUrl` is the script Node was started with.
 */
export async function runAsScript(
  moduleUrl: string,
  story: () => Promise<string>,
): Promise<void> {
  const entry = process.argv[1];
  if (entry === undefined || moduleUrl !== pathToFileURL(entry).href) return;
  // The simnet echoes every contract `print` with console.log, raw addresses
  // and all. Send that to stderr, next to Clarinet's warnings, so stdout holds
  // only the story.
  console.log = (...args: unknown[]) => console.error(...args);
  try {
    process.stdout.write(await story());
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
