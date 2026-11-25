import { swapEvent, type JournalEvent, type SwapEvent } from "./journal.js";

// Pre-trade warnings: how an intended trade compares with what this vault's
// agent has done before, read from the journal. Advisory only. The contract
// enforces none of this and `checkIntent` does not read it.

export interface WarningThresholds {
  /**
   * `LARGE_TRADE` when the amount is more than this many times the baseline
   * of the vault's past trades in the same direction.
   */
  sizeMultiple: bigint;
  /** The baseline: the median past amount, or the largest. */
  sizeBaseline: "median" | "largest";
  /**
   * `BURST` when this trade would be at least the `burstTrades`-th of the
   * vault's trades, in any direction, within `burstBlocks` burn blocks. `1n`
   * or less turns it off.
   */
  burstTrades: bigint;
  burstBlocks: bigint;
  /**
   * `QUIET_PERIOD` when the vault's last trade, in any direction, is at
   * least this many burn blocks back. `0n` turns it off.
   */
  quietBlocks: bigint;
}

/**
 * The defaults: over 3 times the median, 3 trades within 6 burn blocks
 * (about an hour), and a first trade after 1008 burn blocks (about a week).
 */
export const DEFAULT_WARNING_THRESHOLDS: WarningThresholds = {
  sizeMultiple: 3n,
  sizeBaseline: "median",
  burstTrades: 3n,
  burstBlocks: 6n,
  quietBlocks: 1008n,
};

/** The trade to compare with the journal. */
export interface IntendedTrade {
  owner: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  /** The burn height the trade would run at. */
  burnHeight: bigint;
}

export type TradeWarning =
  | {
      kind: "FIRST_TRADE_IN_DIRECTION";
      message: string;
      tokenIn: string;
      tokenOut: string;
    }
  | {
      kind: "LARGE_TRADE";
      message: string;
      amountIn: bigint;
      /** The median or largest past amount in this direction. */
      baseline: bigint;
      basis: "median" | "largest";
      sizeMultiple: bigint;
      /** How many past trades in this direction the baseline is from. */
      pastTrades: bigint;
    }
  | {
      kind: "BURST";
      message: string;
      /** The vault's trades in the last `burstBlocks`, this one included. */
      trades: bigint;
      burstBlocks: bigint;
    }
  | {
      kind: "QUIET_PERIOD";
      message: string;
      lastTradeHeight: bigint;
      /** Burn blocks from the last trade to this one. */
      blocksSince: bigint;
      quietBlocks: bigint;
    };

export type TradeWarningKind = TradeWarning["kind"];

/**
 * The median of a non-empty list. With an even count it is the mean of the
 * two middle amounts, rounded down.
 */
function medianOf(amounts: readonly bigint[]): bigint {
  const sorted = [...amounts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = sorted.length >> 1;
  const upper = sorted[mid]!;
  return sorted.length % 2 === 1 ? upper : (sorted[mid - 1]! + upper) / 2n;
}

/**
 * Compares an intended trade with the owner's past trades (`execute-swap`
 * events, and `approve-swap` events for trades the owner approved) and
 * returns the warnings that apply, in the order of `TradeWarning`'s kinds; an
 * empty list when none does. Only events of `trade.owner` at or before
 * `trade.burnHeight` count; other owners, other event names and later events
 * are ignored. Integer arithmetic only. Never throws for any journal.
 *
 * A warning is not a refusal: it never changes what `checkIntent` or the
 * contract answers.
 */
export function tradeWarnings(
  events: readonly JournalEvent[],
  trade: IntendedTrade,
  thresholds: Partial<WarningThresholds> = {},
): TradeWarning[] {
  const t = { ...DEFAULT_WARNING_THRESHOLDS, ...thresholds };
  const { owner, tokenIn, tokenOut, amountIn, burnHeight } = trade;
  const past: SwapEvent[] = [];
  for (const event of events) {
    const swap = swapEvent(event);
    if (
      swap !== null &&
      swap.owner === owner &&
      swap.ref.burnHeight <= burnHeight
    ) {
      past.push(swap);
    }
  }
  const sameDirection = past
    .filter((s) => s.tokenIn === tokenIn && s.tokenOut === tokenOut)
    .map((s) => s.amountIn);
  const warnings: TradeWarning[] = [];

  if (sameDirection.length === 0) {
    warnings.push({
      kind: "FIRST_TRADE_IN_DIRECTION",
      message: "this vault has never sold this token for that one before",
      tokenIn,
      tokenOut,
    });
  } else {
    const basis = t.sizeBaseline;
    const baseline =
      basis === "median"
        ? medianOf(sameDirection)
        : sameDirection.reduce((a, b) => (a > b ? a : b));
    if (amountIn > t.sizeMultiple * baseline) {
      warnings.push({
        kind: "LARGE_TRADE",
        message: `the amount is more than ${t.sizeMultiple} times the ${basis} of this vault's past trades in this direction`,
        amountIn,
        baseline,
        basis,
        sizeMultiple: t.sizeMultiple,
        pastTrades: BigInt(sameDirection.length),
      });
    }
  }

  // The same form as the contract's window: a trade at height H counts at
  // heights H to H + burstBlocks - 1.
  const recent = past.filter(
    (s) => s.ref.burnHeight + t.burstBlocks > burnHeight,
  );
  const trades = BigInt(recent.length) + 1n;
  if (t.burstTrades > 1n && trades >= t.burstTrades) {
    warnings.push({
      kind: "BURST",
      message: `this would be trade ${trades} of this vault within ${t.burstBlocks} burn blocks`,
      trades,
      burstBlocks: t.burstBlocks,
    });
  }

  let lastTradeHeight: bigint | null = null;
  for (const s of past) {
    if (lastTradeHeight === null || s.ref.burnHeight > lastTradeHeight) {
      lastTradeHeight = s.ref.burnHeight;
    }
  }
  if (lastTradeHeight !== null && t.quietBlocks > 0n) {
    const blocksSince = burnHeight - lastTradeHeight;
    if (blocksSince >= t.quietBlocks) {
      warnings.push({
        kind: "QUIET_PERIOD",
        message: `this vault's last trade was ${blocksSince} burn blocks ago`,
        lastTradeHeight,
        blocksSince,
        quietBlocks: t.quietBlocks,
      });
    }
  }
  return warnings;
}
