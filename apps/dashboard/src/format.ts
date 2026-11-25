// Plain-word rendering shared by the review step, the panels and the journal.
// Integer maths only: no amount ever passes through a float.
import { Cl, type ClarityValue } from "@stacks/transactions";
import { formatUnits } from "../../../scripts/format-amount.js";
import type {
  ChainConfig,
  ChainRead,
  ChainSession,
  Receipt,
  SubmitProgress,
  TokenInfo,
} from "./chain.js";

/** "0.10000000 sBTC" */
export function human(token: TokenInfo, amount: bigint): string {
  return `${formatUnits(amount, token.decimals)} ${token.symbol}`;
}

/**
 * The amount for a headline, without its symbol: "0.10" for 10000000 sats.
 * Only trailing zeros are dropped, down to two decimals, so it is exact.
 */
export function compact(token: TokenInfo, amount: bigint): string {
  const [whole, fraction = ""] = formatUnits(amount, token.decimals).split(".");
  return `${whole}.${fraction.replace(/0+$/, "").padEnd(2, "0")}`;
}

/** "10000000 sats of mock sBTC (0.10000000 sBTC)" */
export function amountWords(token: TokenInfo, amount: bigint): string {
  return `${amount} ${token.unit} of ${token.name} (${human(token, amount)})`;
}

export function tokenOf(config: ChainConfig, id: string): TokenInfo | null {
  return config.tokens.find((t) => t.id === id) ?? null;
}

/** An amount of the token `id`, or bare base units when the token is unknown. */
export function amountOf(
  config: ChainConfig,
  id: string,
  amount: bigint,
): string {
  const token = tokenOf(config, id);
  return token === null
    ? `${amount} base units of ${id}`
    : amountWords(token, amount);
}

/** The short name of a principal ("the vault"), or the principal itself. */
export function label(config: ChainConfig, principal: string): string {
  return Object.hasOwn(config.labels, principal)
    ? config.labels[principal]!
    : principal;
}

export function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A principal Clarity value as its address or contract id, without the quote. */
export function principalText(value: ClarityValue): string {
  return Cl.prettyPrint(value).replace(/^'/, "");
}

const plural = (n: bigint, word: string): string =>
  `${n} ${word}${n === 1n ? "" : "s"}`;

/** Burn blocks as rough time, at 10 minutes a block: "about 6 days 22 hours". */
export function blocksAsTime(blocks: bigint): string {
  const minutes = blocks * 10n;
  const days = minutes / 1440n;
  const hours = (minutes % 1440n) / 60n;
  const rest = minutes % 60n;
  if (days > 0n) {
    return hours === 0n
      ? `about ${plural(days, "day")}`
      : `about ${plural(days, "day")} ${plural(hours, "hour")}`;
  }
  if (hours > 0n) {
    return rest === 0n
      ? `about ${plural(hours, "hour")}`
      : `about ${plural(hours, "hour")} ${plural(rest, "minute")}`;
  }
  return `about ${plural(rest, "minute")}`;
}

/** "5 burn blocks (about 50 minutes)" */
export function blocksWords(blocks: bigint): string {
  return blocks === 0n
    ? "0 burn blocks (none)"
    : `${plural(blocks, "burn block")} (${blocksAsTime(blocks)})`;
}

/** Basis points as a percentage: 100n → "1.00%". */
export function bpsWords(bps: bigint): string {
  return `${bps} bps (${formatUnits(bps, 2)}%)`;
}

/** Milliseconds: whole minutes when exact, else seconds to the millisecond. */
export function msWords(ms: bigint): string {
  if (ms > 0n && ms % 60_000n === 0n) {
    return `${ms} ms (${plural(ms / 60_000n, "minute")})`;
  }
  return `${ms} ms (${formatUnits(ms, 3)} s)`;
}

/** The oracle's BTC/USD value, 8 decimals. */
export function oraclePriceWords(value: bigint): string {
  return `${formatUnits(value, 8)} USD per BTC`;
}

/** Where an expiry height sits against the current burn height. */
export function expiryWords(expiresAt: bigint, burnHeight: bigint): string {
  if (expiresAt === 0n) {
    return "not set (burn height 0): the agent may not trade";
  }
  if (expiresAt < burnHeight) {
    const ago = burnHeight - expiresAt;
    return `burn height ${expiresAt}: expired ${plural(ago, "burn block")} ago, the agent may not trade`;
  }
  const left = expiresAt - burnHeight;
  return left === 0n
    ? `burn height ${expiresAt}: this is the last block the agent may trade in`
    : `burn height ${expiresAt}: ${plural(left, "burn block")} from now (${blocksAsTime(left)})`;
}

/** How much of a day cap is used: "10000000 of 30000000 sats (33%), 20000000 left". */
export function capUseWords(
  token: TokenInfo,
  used: bigint,
  cap: bigint,
): string {
  if (cap === 0n) return `no cap set: the agent may not sell ${token.name}`;
  const left = used >= cap ? 0n : cap - used;
  const percent = (used * 100n) / cap;
  return `${used} of ${cap} ${token.unit} used (${percent}%), ${left} left (${human(token, left)})`;
}

/** What a token's approval threshold means, `null` being none. */
export function thresholdWords(
  token: TokenInfo,
  threshold: bigint | null,
): string {
  if (threshold === null) {
    return "none: the agent trades alone up to the per-trade cap";
  }
  if (threshold === 0n) {
    return `0: every trade selling ${token.name} needs your approval`;
  }
  return `a trade selling more than ${amountWords(token, threshold)} needs your approval`;
}

export interface VaultError {
  code: string;
  name: string;
  meaning: string;
  /** The refusal in plain words, for example "Over the per-trade cap". */
  plain: string;
}

export type ErrorTable = ReadonlyMap<string, VaultError>;

/**
 * The `keelio-vault` rows of docs/errors.md, by code without the `u`, each with
 * its line from that file's plain-words table. That file is the one list of
 * error codes, so the dashboard reads it instead of keeping a copy.
 */
export function parseErrorTable(markdown: string): ErrorTable {
  const plain = new Map<string, string>();
  for (const match of markdown.matchAll(/^\| `u(\d+)`\s*\| (.*?)\s*\|$/gm)) {
    plain.set(match[1]!, match[2]!);
  }
  const table = new Map<string, VaultError>();
  for (const match of markdown.matchAll(
    /^\| `keelio-vault`\s+\| `u(\d+)`\s*\| `([A-Z-]+)`\s*\| (.*?)\s*\|$/gm,
  )) {
    const [, code, name, meaning] = match;
    const words = plain.get(code!);
    if (words === undefined) {
      throw new Error(`docs/errors.md has no plain words for u${code}`);
    }
    table.set(code!, {
      code: code!,
      name: name!,
      meaning: meaning!.replaceAll("`", ""),
      plain: words,
    });
  }
  return table;
}

export interface ReceiptText {
  kind: "ok" | "refused" | "aborted";
  /** What happened, in a few plain words: "Refused: over the per-trade cap". */
  headline: string;
  /** What the contract returned: "(ok true)" or "(err u114)". */
  returned?: string;
  /** The error's constant, when the code is a keelio-vault one. */
  name?: string;
  /** More lines, each a full sentence. */
  details: string[];
}

const lowerFirst = (text: string): string =>
  text.charAt(0).toLowerCase() + text.slice(1);

/**
 * A receipt in words. A refusal leads with the plain words for its code and
 * carries the code and its name beside them. `chain` is the session's kind:
 * the two chains report a refusal that also failed a post-condition
 * differently.
 */
export function describeReceipt(
  receipt: Receipt,
  errors: ErrorTable,
  chain: ChainSession["kind"] = "simulation",
): ReceiptText {
  if (receipt.status === "ok") {
    return {
      kind: "ok",
      headline: "Done",
      returned: Cl.prettyPrint(receipt.result),
      details: [],
    };
  }
  if (receipt.status === "aborted") {
    return {
      kind: "aborted",
      headline: "Rolled back by a post-condition",
      details: [
        "The transaction was rolled back and nothing changed.",
        receipt.reason,
      ],
    };
  }
  const text: ReceiptText = {
    kind: "refused",
    headline: "Refused by the contract",
    returned: Cl.prettyPrint(receipt.result),
    details: ["Nothing changed."],
  };
  if (receipt.result.type === "err" && receipt.result.value.type === "uint") {
    const code = receipt.result.value.value.toString();
    const known = errors.get(code);
    if (known !== undefined) {
      text.headline = `Refused: ${lowerFirst(known.plain)}`;
      text.name = known.name;
      text.details.push(`${known.name}: ${known.meaning}.`);
    } else {
      text.details.push(
        code === "1"
          ? "u1 is not a keelio-vault code. It came from the token contract: the sender does not hold that many tokens."
          : `u${code} is not a keelio-vault code. It came from a contract the vault called.`,
      );
    }
  }
  if (receipt.postCondition !== undefined) {
    text.details.push(
      chain === "simulation"
        ? "Because nothing moved, the call's post-condition also failed, and the simnet reports only that. The simulation ran the call again with no post-conditions, in Deny mode, to read the contract's own code."
        : `Because nothing moved, the call's post-condition also failed. The chain reported: ${receipt.postCondition}`,
    );
  }
  return text;
}

/** "0.50 sBTC": an amount for a sentence, exact, without trailing zeros. */
const brief = (token: TokenInfo, amount: bigint): string =>
  `${compact(token, amount)} ${token.symbol}`;

/** One agent trade, as the simulation sends it. */
export interface TradeAsk {
  tokenIn: string;
  amountIn: bigint;
}

/**
 * Why the vault refused an agent's trade, with the owner's own numbers, for
 * the refusals a number explains. `null` for any other code.
 */
export function refusalReason(
  code: bigint,
  ask: TradeAsk,
  read: ChainRead,
  config: ChainConfig,
): string | null {
  const token = tokenOf(config, ask.tokenIn);
  const { policy, usage } = read.vault;
  const caps = policy.caps[ask.tokenIn] ?? { maxPerTrade: 0n, maxPerDay: 0n };
  const asked =
    token === null
      ? ""
      : `The agent asked to sell ${brief(token, ask.amountIn)}. `;
  switch (code) {
    case 109n:
      return "You paused the vault. Unpause it to let the agent trade again.";
    case 110n:
      return policy.expiresAt === 0n
        ? "No expiry is set, so the agent may not trade."
        : `The policy expired at burn height ${policy.expiresAt}. It is now ${read.burnHeight}.`;
    case 114n:
      if (token === null) return null;
      return caps.maxPerTrade === 0n
        ? `${asked}You have set no cap for ${token.name}, so the agent may not sell it.`
        : `${asked}Your cap is ${brief(token, caps.maxPerTrade)} per trade.`;
    case 115n: {
      if (token === null) return null;
      const used = usage.dayTotals[ask.tokenIn] ?? 0n;
      const left = used >= caps.maxPerDay ? 0n : caps.maxPerDay - used;
      return `${asked}Only ${brief(token, left)} of your ${brief(token, caps.maxPerDay)} day cap is left.`;
    }
    case 116n:
      return usage.lastTradeHeight === null
        ? null
        : `The last trade was at burn height ${usage.lastTradeHeight} and the cooldown is ${blocksWords(policy.cooldownBlocks)}. It is now ${read.burnHeight}.`;
    default:
      return null;
  }
}

/** Where a submitted call is, in a sentence the form shows while it waits. */
export function progressWords(progress: SubmitProgress): string {
  if (progress.stage === "wallet") {
    return "Waiting for your wallet. Check that it shows the same post-conditions, in Deny mode, before you approve.";
  }
  const seconds = Math.floor(progress.waitedMs / 1000);
  return `Broadcast by your wallet as ${progress.txId}. Pending: not in a block yet (${seconds} seconds).`;
}
