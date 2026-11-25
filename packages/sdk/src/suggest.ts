import type { RuleName, VaultState } from "./vault.js";

// What an agent can do about a size or timing refusal: the largest amount
// that would pass now, and the heights at which waiting helps. Computed from
// the same state `checkIntent` reads, by the contract's own rules.

/** The contract's `DAY-BLOCKS`: the rolling window of the daily cap. */
export const DAY_WINDOW_BLOCKS = 144n;

/** The three size rules of `execute-swap`, in the order it checks them. */
export type SizeRule = Extract<
  RuleName,
  "TRADE_CAP_EXCEEDED" | "DAY_CAP_EXCEEDED" | "INSUFFICIENT_BALANCE"
>;

export interface SizeSuggestion {
  /**
   * The largest `amountIn` of the input token that passes the per-trade cap
   * (u114), the daily cap (u115) and the ledger balance (u101) at
   * `state.burnHeight`. `0n` when no amount passes. One more is refused.
   * It does not count the owner's approval threshold: with one below it,
   * this is the largest amount that passes with the owner's approval, and
   * `maxDirectAmountIn` is the largest the agent can send alone.
   *
   * It says nothing about the other rules: the cooldown (see
   * `cooldownEndsAt`), and the oracle floor, which rises with the amount, so
   * set `minOut` again from `minOutFloor` for this amount.
   */
  maxAmountIn: bigint;
  /**
   * The size rule that refuses `maxAmountIn + 1n`: the first, in the
   * contract's order, of the limits that equal `maxAmountIn`.
   */
  limitedBy: SizeRule;
  /** The three limits `maxAmountIn` is the smallest of, in base units. */
  limits: {
    /** The input token's `max-per-trade`. */
    perTrade: bigint;
    /** `max-per-day` less the window total, or `0n` when the total is above it. */
    dayRoom: bigint;
    /** The owner's ledger balance of the input token. */
    balance: bigint;
  };
  /**
   * The first burn height at which the cooldown (u116) no longer refuses:
   * the last trade's height plus `cooldownBlocks`. `null` when the cooldown
   * does not refuse at `state.burnHeight`. It is not checked against the
   * policy's expiry.
   */
  cooldownEndsAt: bigint | null;
  /**
   * A burn height by which the input token's whole daily window is free
   * again, if nobody trades in between: the owner's last trade plus 144.
   * `null` when the window total is `0n` or no trade is known.
   *
   * The state holds the window's total and the last trade's height, not each
   * trade's height, so room can come back earlier and the SDK cannot say
   * when. It is exact when the last trade is the only one in the window.
   */
  dayWindowClearBy: bigint | null;
  /**
   * The owner's approval threshold for the input token, or `null` when the
   * owner set none (no band). `execute-swap` refuses an amount above it with
   * u126; `request-swap` takes such an amount for the owner to approve.
   */
  approvalThreshold: bigint | null;
  /**
   * The largest `amountIn` `execute-swap` accepts from the agent alone by
   * the size rules and the threshold: the smaller of `maxAmountIn` and
   * `approvalThreshold`, or `maxAmountIn` when there is no threshold. `0n`
   * when no amount passes. One more is refused, with `directLimitedBy`.
   *
   * An amount above it, up to `maxAmountIn`, passes only with the owner's
   * approval: `request-swap`, then `approve-swap`. With no threshold, or one
   * at or above `maxAmountIn`, the two are equal and no amount can be
   * requested.
   */
  maxDirectAmountIn: bigint;
  /**
   * The rule by which `execute-swap` refuses `maxDirectAmountIn + 1n`: the
   * first, in the contract's order (u114, u126, u115, u101), of the limits
   * that equal `maxDirectAmountIn`.
   */
  directLimitedBy: SizeRule | "APPROVAL_REQUIRED";
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);

/**
 * The size and timing limits for selling `tokenIn` from this vault now. Pure,
 * and independent of whether a trade was refused: `checkIntent` attaches its
 * result to a size or cooldown refusal, and an agent can also call it before
 * choosing an amount. A token with no caps or balance entry reads `0n`, as in
 * the contract.
 */
export function suggestSize(
  state: VaultState,
  tokenIn: string,
): SizeSuggestion {
  const { policy, usage, balances, burnHeight } = state;
  const own = <T>(record: Readonly<Record<string, T>>, key: string) =>
    Object.hasOwn(record, key) ? record[key] : undefined;
  const caps = own(policy.caps, tokenIn) ?? { maxPerTrade: 0n, maxPerDay: 0n };
  const dayTotal = own(usage.dayTotals, tokenIn) ?? 0n;
  const limits = {
    perTrade: caps.maxPerTrade,
    dayRoom: dayTotal > caps.maxPerDay ? 0n : caps.maxPerDay - dayTotal,
    balance: own(balances, tokenIn) ?? 0n,
  };
  const maxAmountIn = min(limits.perTrade, min(limits.dayRoom, limits.balance));
  const limitedBy: SizeRule =
    maxAmountIn === limits.perTrade
      ? "TRADE_CAP_EXCEEDED"
      : maxAmountIn === limits.dayRoom
        ? "DAY_CAP_EXCEEDED"
        : "INSUFFICIENT_BALANCE";

  const thresholds = state.approvalThresholds ?? {};
  const approvalThreshold = own(thresholds, tokenIn) ?? null;
  const maxDirectAmountIn =
    approvalThreshold === null
      ? maxAmountIn
      : min(maxAmountIn, approvalThreshold);
  const directLimitedBy: SizeSuggestion["directLimitedBy"] =
    maxDirectAmountIn === limits.perTrade
      ? "TRADE_CAP_EXCEEDED"
      : maxDirectAmountIn === approvalThreshold
        ? "APPROVAL_REQUIRED"
        : limitedBy;

  const last = usage.lastTradeHeight;
  const cooldownActive =
    last !== null && burnHeight - last < policy.cooldownBlocks;
  return {
    maxAmountIn,
    limitedBy,
    limits,
    cooldownEndsAt: cooldownActive ? last + policy.cooldownBlocks : null,
    dayWindowClearBy:
      last !== null && dayTotal > 0n ? last + DAY_WINDOW_BLOCKS : null,
    approvalThreshold,
    maxDirectAmountIn,
    directLimitedBy,
  };
}
