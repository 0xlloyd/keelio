// The journal in plain words: one entry per keelio-vault print event
// (docs/events.md), with amounts in base units.
import { Cl, type ClarityValue } from "@stacks/transactions";
import type { ChainConfig, JournalRecord } from "./chain.js";
import {
  amountOf,
  blocksWords,
  bpsWords,
  capitalise,
  label,
  msWords,
  principalText,
  thresholdWords,
  tokenOf,
} from "./format.js";

/** The events that are a trade: the agent's own, and one the owner approved. */
export const TRADE_EVENTS: ReadonlySet<string> = new Set([
  "execute-swap",
  "approve-swap",
]);

export interface JournalEntry {
  burnHeight: bigint;
  /** The contract's event name, for example "execute-swap". */
  event: string;
  /** What happened, in sentences. */
  text: string;
}

type Fields = Readonly<Record<string, ClarityValue>>;

function reader(fields: Fields, config: ChainConfig) {
  const get = (name: string): ClarityValue => {
    const value = fields[name];
    if (value === undefined) throw new Error(`event has no ${name}`);
    return value;
  };
  const num = (name: string): bigint => {
    const value = get(name);
    if (value.type !== "uint") throw new Error(`${name} is not a uint`);
    return BigInt(value.value);
  };
  const id = (name: string): string => {
    const value = get(name);
    return principalText(value.type === "some" ? value.value : value);
  };
  return {
    get,
    num,
    id,
    who: (name: string): string => label(config, id(name)),
    flag: (name: string): boolean => get(name).type === "true",
    amount: (token: string, name: string): string =>
      amountOf(config, id(token), num(name)),
  };
}

function sentence(event: string, fields: Fields, config: ChainConfig): string {
  const f = reader(fields, config);
  // Read only by the known events below, so an event with no `owner` field
  // still prints as Clarity instead of throwing.
  const owner = (): string => capitalise(f.who("owner"));
  const paused = () =>
    f.flag("paused") ? "The vault is paused." : "The vault is not paused.";
  switch (event) {
    case "deposit":
      return `${owner()} deposited ${f.amount("token", "amount")}. Vault balance after: ${f.amount("token", "balance")}.`;
    case "withdraw":
      return `${owner()} withdrew ${f.amount("token", "amount")}. Vault balance after: ${f.amount("token", "balance")}.`;
    case "set-agent":
      return `${owner()} named ${f.id("agent")} (${f.who("agent")}) as the agent. ${paused()}`;
    case "remove-agent":
      return `${owner()} removed the agent. No one can trade for this vault. ${paused()}`;
    case "pause":
      return `${owner()} paused the vault. The agent cannot trade; withdrawals still work.`;
    case "unpause":
      return `${owner()} unpaused the vault. The agent may trade again.`;
    case "set-policy":
      return `${owner()} set the cooldown to ${blocksWords(f.num("cooldown-blocks"))} and the expiry to burn height ${f.num("expires-at")}.`;
    case "set-token-caps":
      return `${owner()} set the caps for ${f.who("token")}: ${f.amount("token", "max-per-trade")} per trade, ${f.amount("token", "max-per-day")} per day (144 burn blocks).`;
    case "allow-token":
      return f.flag("allowed")
        ? `${owner()} allowed ${f.who("token")} for swaps.`
        : `${owner()} revoked ${f.who("token")} for swaps.`;
    case "allow-adapter":
      return f.flag("allowed")
        ? `${owner()} allowed the adapter ${f.who("adapter")}.`
        : `${owner()} revoked the adapter ${f.who("adapter")}.`;
    case "set-price-bounds":
      return `${owner()} set the price bounds: a swap may settle at most ${bpsWords(f.num("max-slippage-bps"))} below the oracle price, and the price may be at most ${msWords(f.num("max-price-age"))} old.`;
    case "set-approval-threshold": {
      const token = tokenOf(config, f.id("token"));
      const value = f.get("threshold");
      const threshold =
        value.type === "some" && value.value.type === "uint"
          ? BigInt(value.value.value)
          : null;
      if (threshold === null) {
        return `${owner()} cleared the approval threshold for ${f.who("token")}. The agent trades alone up to the per-trade cap.`;
      }
      return token === null
        ? `${owner()} set the approval threshold for ${f.who("token")} to ${threshold} base units.`
        : `${owner()} set the approval threshold for ${f.who("token")}: ${thresholdWords(token, threshold)}.`;
    }
    case "request-swap":
      return (
        `${capitalise(f.who("agent"))} asked for your approval to sell ${f.amount("token-in", "amount-in")}` +
        ` for at least ${f.amount("token-out", "min-out")} on ${f.who("adapter")}.` +
        ` Nothing moved. You can approve it up to burn height ${f.num("expires-at")}.`
      );
    case "approve-swap":
      return (
        `${owner()} approved the request ${f.who("agent")} made at burn height ${f.num("requested-at")}:` +
        ` the vault sold ${f.amount("token-in", "amount-in")}` +
        ` for ${f.amount("token-out", "amount-out")} on ${f.who("adapter")}.` +
        ` The least the request would accept was ${f.amount("token-out", "min-out")}.` +
        ` Vault balances after: ${f.amount("token-in", "balance-in")} and ${f.amount("token-out", "balance-out")}.` +
        ` Sold in this day window: ${f.amount("token-in", "day-total")}.`
      );
    case "reject-swap":
      return (
        `${owner()} rejected the request ${f.who("agent")} made at burn height ${f.num("requested-at")}` +
        ` to sell ${f.amount("token-in", "amount-in")} for at least ${f.amount("token-out", "min-out")}. Nothing moved.`
      );
    case "cancel-swap-request":
      return (
        `${capitalise(f.who("agent"))} withdrew the request it made at burn height ${f.num("requested-at")}` +
        ` to sell ${f.amount("token-in", "amount-in")} for at least ${f.amount("token-out", "min-out")}. Nothing moved.`
      );
    case "execute-swap":
      return (
        `${capitalise(f.who("agent"))} sold ${f.amount("token-in", "amount-in")}` +
        ` for ${f.amount("token-out", "amount-out")} on ${f.who("adapter")}.` +
        ` The least it would accept was ${f.amount("token-out", "min-out")}.` +
        ` Vault balances after: ${f.amount("token-in", "balance-in")} and ${f.amount("token-out", "balance-out")}.` +
        ` Sold in this day window: ${f.amount("token-in", "day-total")}.`
      );
    default:
      return Cl.prettyPrint(Cl.tuple({ ...fields }));
  }
}

/** One record in words. An event this page does not know prints as Clarity. */
export function describeEvent(
  record: JournalRecord,
  config: ChainConfig,
): JournalEntry {
  const { value, burnHeight } = record;
  if (value.type !== "tuple") {
    return { burnHeight, event: "unknown", text: Cl.prettyPrint(value) };
  }
  const name = value.value.event;
  const event =
    name !== undefined && (name.type === "ascii" || name.type === "utf8")
      ? name.value
      : "unknown";
  return { burnHeight, event, text: sentence(event, value.value, config) };
}

/** The owner's entries, newest first. */
export function journalEntries(
  records: readonly JournalRecord[],
  config: ChainConfig,
  owner: string,
): JournalEntry[] {
  const entries: JournalEntry[] = [];
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i]!;
    const value = record.value;
    if (value.type === "tuple") {
      const who = value.value.owner;
      if (who !== undefined && principalText(who) !== owner) continue;
    }
    entries.push(describeEvent(record, config));
  }
  return entries;
}
