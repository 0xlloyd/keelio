// What the journal says about a principal before the owner names it as the
// agent. Advisory only, and the view always says so. No DOM, so tests run it
// in Node.
import { agentHistory } from "../../../packages/sdk/src/agent-history.js";
import {
  parseJournal,
  type EventRef,
} from "../../../packages/sdk/src/journal.js";
import { principalProblem } from "../../../packages/sdk/src/principal.js";
import type { ChainConfig, ChainSession, JournalRecord } from "./chain.js";
import { amountOf } from "./format.js";
import type { Fact } from "./panel.js";

/** Shown with every history, known or not. */
export const HISTORY_CAUTION =
  "This is history, not a guarantee. A principal with a clean record can still misbehave, and a new one has no record at all. What protects you is the vault's limits: the caps, the price bounds, the approval threshold, the expiry and the kill switch.";

export const NO_HISTORY =
  "No history: this principal has never appeared in this vault contract's journal.";

export interface HistoryView {
  /** The principal the view is about. */
  agent: string;
  known: boolean;
  /** One line: what was found. */
  headline: string;
  /** The details, as label and value pairs. Empty when nothing is known. */
  facts: Fact[];
  /** What was read to produce this. */
  scope: string;
  /** `HISTORY_CAUTION`, always. */
  caution: string;
}

const count = (n: bigint, one: string, many: string): string =>
  `${n} ${n === 1n ? one : many}`;

const at = (ref: EventRef): string => `burn height ${ref.burnHeight}`;

/** What was read, in a sentence, for each kind of journal a session gives. */
export function scopeWords(
  scope: ChainSession["journalScope"],
  events: number,
): string {
  const read = count(BigInt(events), "event", "events");
  return scope === "contract"
    ? `Read: the whole journal of this vault contract, every owner's vault (${read}). Calls the contract refused are not in a journal.`
    : `Read: only your own vault's events on this vault contract (${read}). This mode does not read other owners' events, so trades this principal made for other vaults are not counted here. Calls the contract refused are not in a journal.`;
}

/**
 * `true` when `text` is a principal `set-agent` can take: a Stacks address or
 * a contract id.
 */
export function isPrincipal(text: string): boolean {
  return text !== "" && principalProblem(text, false) === null;
}

/**
 * The history of `agent` in `records` (the journal, oldest first), or `null`
 * when `agent` is not a valid principal: nothing is looked up for text that
 * is not one.
 */
export function agentHistoryView(
  records: readonly JournalRecord[],
  agent: string,
  config: ChainConfig,
  scope: ChainSession["journalScope"],
): HistoryView | null {
  const principal = agent.trim();
  if (!isPrincipal(principal)) return null;
  const events = parseJournal(records);
  const history = agentHistory(events, principal);
  const base = {
    agent: principal,
    scope: scopeWords(scope, events.length),
    caution: HISTORY_CAUTION,
  };
  if (!history.known) {
    return {
      ...base,
      known: false,
      headline:
        scope === "contract"
          ? NO_HISTORY
          : "No history: this principal has never appeared in your own vault's journal.",
      facts: [],
    };
  }
  const current = history.owners.filter((o) => o.current).length;
  const alone = history.swaps - history.approvedSwaps;
  const { requests } = history;
  // A request that is none of these expired, was replaced or is still waiting.
  const settled = requests.approved + requests.rejected + requests.cancelled;
  const open = requests.made > settled ? requests.made - settled : 0n;
  const facts: Fact[] = [
    ["First seen", at(history.firstSeen)],
    [
      "Vaults that name it now",
      `${current} of the ${count(BigInt(history.owners.length), "vault", "vaults")} that ever named it`,
    ],
    [
      "Trades",
      history.swaps === 0n
        ? "none"
        : `${history.swaps}: ${alone} sent alone, ${history.approvedSwaps} approved by an owner`,
    ],
    ...history.volume.map((sold): Fact => [
      `Sold, ${Object.hasOwn(config.labels, sold.tokenIn) ? config.labels[sold.tokenIn]! : sold.tokenIn}`,
      `${amountOf(config, sold.tokenIn, sold.amountIn)} in ${count(sold.swaps, "trade", "trades")}`,
    ]),
    [
      "Requests for approval",
      requests.made === 0n
        ? "none"
        : `${requests.made} made: ${requests.approved} approved, ${requests.rejected} rejected, ${requests.cancelled} withdrawn by the agent, ${open} expired, replaced or still waiting`,
    ],
    [
      "Last trade",
      history.lastTrade === null ? "none yet" : at(history.lastTrade),
    ],
  ];
  return {
    ...base,
    known: true,
    headline: `This principal appears in the journal, first at ${at(history.firstSeen)}.`,
    facts,
  };
}
