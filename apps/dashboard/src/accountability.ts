// The owner's accountability record for the page: each trade with who sent
// it, the limits in force and any issue the replay found, and the two files
// the owner can save. Built by the SDK's replay of the journal. No DOM and no
// network, so tests run it in Node.
import {
  accountabilityJson,
  accountabilityRecords,
  renderAccountabilityReport,
  type TradeAccount,
} from "../../../packages/sdk/src/accountability.js";
import { parseJournal } from "../../../packages/sdk/src/journal.js";
import type { ChainConfig, ChainSession, JournalRecord } from "./chain.js";
import {
  amountOf,
  blocksWords,
  bpsWords,
  label,
  msWords,
  tokenOf,
  thresholdWords,
} from "./format.js";

export interface TradeRow {
  /** "Trade 1, burn height 12". */
  title: string;
  /** Who sent it: the agent alone, or the agent's request the owner approved. */
  who: string;
  /** What was sold for what. */
  what: string;
  /** The limits in force when it ran, one sentence each. */
  limits: string[];
  /** What the replay could not account for. Empty when it found nothing. */
  issues: string[];
}

export interface SavedFile {
  name: string;
  /** The media type for the Blob. */
  type: string;
  text: string;
}

export interface AccountabilityView {
  /** One line: how many trades, or that there are none. */
  summary: string;
  /** Oldest first, as in the report. */
  rows: TradeRow[];
  markdown: SavedFile;
  json: SavedFile;
}

const NOT_FOUND = "not found in the journal";

function rowOf(
  record: TradeAccount,
  number: number,
  config: ChainConfig,
): TradeRow {
  const { swap, policy, issues } = record;
  const agent =
    label(config, swap.agent) === swap.agent
      ? swap.agent
      : `${swap.agent} (${label(config, swap.agent)})`;
  const tokenIn = tokenOf(config, swap.tokenIn);
  const threshold = policy.approvalThreshold;
  return {
    title: `Trade ${number}, burn height ${swap.ref.burnHeight}`,
    who: swap.approved
      ? `Approved by the owner (approve-swap). ${agent} requested it at burn height ${swap.requestedAt}.`
      : `Sent by the agent alone (execute-swap): ${agent}.`,
    what: `Sold ${amountOf(config, swap.tokenIn, swap.amountIn)} for ${amountOf(config, swap.tokenOut, swap.amountOut)} on ${label(config, swap.adapter)}. The least it would accept was ${amountOf(config, swap.tokenOut, swap.minOut)}; the vault's oracle floor was ${amountOf(config, swap.tokenOut, swap.minOutFloor)}.`,
    limits: [
      policy.caps === null
        ? `Caps for the token sold: ${NOT_FOUND}.`
        : `Caps for the token sold: ${amountOf(config, swap.tokenIn, policy.caps.maxPerTrade)} per trade, ${amountOf(config, swap.tokenIn, policy.caps.maxPerDay)} per day (144 burn blocks). Sold in the window, this trade included: ${amountOf(config, swap.tokenIn, swap.dayTotal)}.`,
      policy.terms === null
        ? `Cooldown and expiry: ${NOT_FOUND}.`
        : `Cooldown ${blocksWords(policy.terms.cooldownBlocks)}; expiry at burn height ${policy.terms.expiresAt}.`,
      policy.priceBounds === null
        ? `Price bounds: ${NOT_FOUND}.`
        : `Price bounds: at most ${bpsWords(policy.priceBounds.maxSlippageBps)} below the oracle price; price at most ${msWords(policy.priceBounds.maxPriceAge)} old.`,
      threshold === null || tokenIn === null
        ? `Approval threshold for the token sold: ${
            threshold === null
              ? "none set"
              : threshold.threshold === null
                ? "none"
                : `${threshold.threshold} base units`
          }.`
        : `Approval threshold for the token sold: ${thresholdWords(tokenIn, threshold.threshold)}.`,
      policy.agent === null
        ? `Agent named by the owner: ${NOT_FOUND}.`
        : policy.agent.agent === null
          ? "Agent named by the owner: none (removed)."
          : `Agent named by the owner: ${policy.agent.agent}.`,
    ],
    issues: issues.map((issue) => `${issue.code}: ${issue.message}.`),
  };
}

/** A principal as part of a file name: letters, digits, dots and dashes. */
function fileSafe(text: string): string {
  return text.replace(/[^A-Za-z0-9.-]/g, "-");
}

/**
 * The connected owner's record from the journal (oldest first). Records of
 * other owners in the journal are replayed for their own limits and left out.
 */
export function accountabilityView(
  journal: readonly JournalRecord[],
  config: ChainConfig,
  owner: string,
  kind: ChainSession["kind"],
): AccountabilityView {
  const records = accountabilityRecords(parseJournal(journal), { owner });
  const where =
    kind === "simulation"
      ? "a local simulation (simnet): mock tokens, nothing deployed"
      : "Stacks testnet";
  const title = `Keelio accountability record for ${owner}`;
  const markdown =
    renderAccountabilityReport(records, { title }) +
    `\nVault contract: \`${config.tx.vault}\`. Network: ${where}.\n`;
  const json = JSON.stringify(
    {
      title,
      owner,
      vault: config.tx.vault,
      network: kind === "simulation" ? "simnet" : "testnet",
      trades: accountabilityJson(records),
    },
    null,
    2,
  );
  const base = `keelio-accountability-${fileSafe(owner)}`;
  return {
    summary:
      records.length === 0
        ? "No trades yet: the journal holds no execute-swap or approve-swap event for this owner."
        : `${records.length} ${records.length === 1 ? "trade" : "trades"}, oldest first. ${
            records.some((r) => r.issues.length > 0)
              ? "The replay found issues: see the marked trades."
              : "Every limit was found in the journal, and each trade is inside each one."
          }`,
    rows: records.map((record, i) => rowOf(record, i + 1, config)),
    markdown: {
      name: `${base}.md`,
      type: "text/markdown;charset=utf-8",
      text: markdown,
    },
    json: {
      name: `${base}.json`,
      type: "application/json",
      text: json + "\n",
    },
  };
}
