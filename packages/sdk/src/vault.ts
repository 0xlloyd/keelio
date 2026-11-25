import { suggestSize, type SizeSuggestion } from "./suggest.js";

/** The vault fields `checkIntent` reads. */
export interface Vault {
  /** The owner's agent, or `null` when none is set. */
  agent: string | null;
  paused: boolean;
}

/** One token's caps, in that token's base units. */
export interface TokenCaps {
  maxPerTrade: bigint;
  maxPerDay: bigint;
}

export interface Policy {
  /** Minimum burn blocks between two trades in either token. */
  cooldownBlocks: bigint;
  /** Last burn height at which the agent may trade. */
  expiresAt: bigint;
  /**
   * Caps by input token id. A token with no entry reads as `0n` caps, so it
   * may not be sold, as in the contract.
   */
  caps: Readonly<Record<string, TokenCaps>>;
  allowedTokens: readonly string[];
  allowedAdapters: readonly string[];
}

export interface VaultUsage {
  /**
   * Each input token's amount traded over the last 144 burn blocks, by token
   * id. A token with no entry reads as `0n`.
   */
  dayTotals: Readonly<Record<string, bigint>>;
  /** Burn height of the last trade in either token, or `null` before any. */
  lastTradeHeight: bigint | null;
}

/**
 * The owner's oracle bounds, from `get-price-bounds`. An owner who never set
 * them reads `0n`/`0n`, and either at `0n` means the agent may not trade.
 */
export interface PriceBounds {
  /** How far below the oracle's price a trade may settle, in basis points. */
  maxSlippageBps: bigint;
  /** How far the oracle's timestamp may be from the block's time, in ms. */
  maxPriceAge: bigint;
}

/** The oracle's BTC/USD answer: 8 decimals, and a timestamp in ms. */
export interface OraclePrice {
  value: bigint;
  timestamp: bigint;
}

/** What the vault's oracle floor needs besides the owner's bounds. */
export interface OracleTerms {
  /** The vault's `ALLOWED-TOKEN`: selling it prices the floor in quote units. */
  sbtcToken: string;
  /** The vault's `PRICE-SCALE`. */
  priceScale: bigint;
  /** The oracle's price, or `null` when its `get-value` returned `(err …)`. */
  price: OraclePrice | null;
}

/**
 * The contract's `APPROVAL-WINDOW`: a request made at burn height H can be
 * approved at H to H + 6 inclusive.
 */
export const APPROVAL_WINDOW_BLOCKS = 6n;

/**
 * Each token's approval threshold, from `get-approval-threshold`, by input
 * token id. `null`, or no entry, is the contract's `none`: no band, so no
 * amount of that token needs the owner's approval. `0n` means every trade
 * selling that token needs it.
 */
export type ApprovalThresholds = Readonly<Record<string, bigint | null>>;

/** The owner's stored swap request, from `get-pending-swap`. */
export interface PendingSwap {
  /** The agent that made the request. */
  agent: string;
  adapter: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  minOut: bigint;
  /** The burn height of the request. */
  requestedAt: bigint;
  /** The last burn height the owner can approve at: `requestedAt` + 6. */
  expiresAt: bigint;
  /**
   * Whether the request had expired at the burn height given to `readVault`:
   * that height is above `expiresAt`. `null` when `readVault` was given no
   * burn height. The contract keeps an expired request until it is
   * overwritten, rejected or withdrawn. `checkRequest` and `checkApproval`
   * do not read this flag: they compare `expiresAt` with `state.burnHeight`.
   */
  expired: boolean | null;
}

/** Whether `pending` can no longer be approved at `burnHeight`. */
export function pendingSwapExpired(
  pending: Pick<PendingSwap, "expiresAt">,
  burnHeight: bigint,
): boolean {
  return burnHeight > pending.expiresAt;
}

/** Ledger balance by token id. */
export type Balances = Readonly<Record<string, bigint>>;

export interface Intent {
  caller: string;
  adapter: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  /** The least amount of `tokenOut` the swap will accept, in base units. */
  minOut: bigint;
}

export interface VaultState {
  vault: Vault;
  policy: Policy;
  usage: VaultUsage;
  balances: Balances;
  /** The burn height the usage was read at. */
  burnHeight: bigint;
  priceBounds: PriceBounds;
  oracle: OracleTerms;
  /**
   * `stacks-block-time * 1000` of the block the swap runs in. The caller
   * supplies it: the SDK has no clock. Before that block exists it is a
   * prediction, so near `maxPriceAge` the answer can differ from the
   * contract's.
   */
  nowMs: bigint;
  /**
   * The owner's approval thresholds by input token id, as `readVault` reads
   * them. Left out, no token has a band, as in a vault that never set one.
   */
  approvalThresholds?: ApprovalThresholds;
  /**
   * The owner's stored request, expired or not, or `null` when there is
   * none. Left out reads as `null`.
   */
  pendingSwap?: PendingSwap | null;
}

/** The rules in the order `execute-swap` checks them, with its error code. */
export const RULES = [
  { rule: "NOT_AGENT", errorCode: 108 },
  { rule: "VAULT_PAUSED", errorCode: 109 },
  { rule: "POLICY_EXPIRED", errorCode: 110 },
  { rule: "TOKEN_NOT_ALLOWED", errorCode: 111 },
  { rule: "SAME_TOKEN", errorCode: 112 },
  { rule: "ADAPTER_NOT_ALLOWED", errorCode: 113 },
  { rule: "ZERO_AMOUNT", errorCode: 100 },
  { rule: "TRADE_CAP_EXCEEDED", errorCode: 114 },
  { rule: "APPROVAL_REQUIRED", errorCode: 126 },
  { rule: "DAY_CAP_EXCEEDED", errorCode: 115 },
  { rule: "COOLDOWN_ACTIVE", errorCode: 116 },
  { rule: "INSUFFICIENT_BALANCE", errorCode: 101 },
  { rule: "PRICE_BOUNDS_UNSET", errorCode: 119 },
  { rule: "ORACLE_FAILED", errorCode: 121 },
  { rule: "PRICE_ZERO", errorCode: 122 },
  { rule: "PRICE_STALE", errorCode: 123 },
  { rule: "PRICE_OVERFLOW", errorCode: 124 },
  { rule: "BELOW_ORACLE_FLOOR", errorCode: 125 },
] as const;

export type RuleName = (typeof RULES)[number]["rule"];

/**
 * The rules in the order `request-swap` checks them, with its error code. The
 * daily cap, the cooldown and the price are left to `approve-swap`.
 */
export const REQUEST_RULES = [
  { rule: "NOT_AGENT", errorCode: 108 },
  { rule: "VAULT_PAUSED", errorCode: 109 },
  { rule: "POLICY_EXPIRED", errorCode: 110 },
  { rule: "TOKEN_NOT_ALLOWED", errorCode: 111 },
  { rule: "SAME_TOKEN", errorCode: 112 },
  { rule: "ADAPTER_NOT_ALLOWED", errorCode: 113 },
  { rule: "ZERO_AMOUNT", errorCode: 100 },
  { rule: "TRADE_CAP_EXCEEDED", errorCode: 114 },
  { rule: "APPROVAL_NOT_NEEDED", errorCode: 127 },
  { rule: "INSUFFICIENT_BALANCE", errorCode: 101 },
  { rule: "REQUEST_PENDING", errorCode: 128 },
] as const;

/**
 * The rules `approve-swap` checks before the swap's own, in its order. After
 * them it runs every rule of `RULES` except `APPROVAL_REQUIRED`, with the
 * request's agent as the agent.
 */
export const APPROVAL_RULES = [
  { rule: "NO_PENDING_SWAP", errorCode: 129 },
  { rule: "REQUEST_EXPIRED", errorCode: 130 },
  { rule: "REQUEST_MISMATCH", errorCode: 131 },
  { rule: "REQUEST_AGENT_CHANGED", errorCode: 132 },
] as const;

/** The rules in the order `cancel-swap-request` checks them. */
export const CANCEL_RULES = [
  { rule: "NO_PENDING_SWAP", errorCode: 129 },
  { rule: "NOT_REQUESTER", errorCode: 133 },
] as const;

export type RequestRuleName = (typeof REQUEST_RULES)[number]["rule"];
export type ApprovalRuleName =
  | (typeof APPROVAL_RULES)[number]["rule"]
  | Exclude<RuleName, "APPROVAL_REQUIRED">;
export type CancelRuleName = (typeof CANCEL_RULES)[number]["rule"];

/** Every rule name the SDK's checks can refuse with. */
export type VaultRuleName =
  RuleName | RequestRuleName | ApprovalRuleName | CancelRuleName;

/**
 * The contract's error code for every rule name: one code per name, whichever
 * function refuses with it.
 */
export const RULE_CODES: Readonly<Record<VaultRuleName, number>> = {
  NOT_AGENT: 108,
  VAULT_PAUSED: 109,
  POLICY_EXPIRED: 110,
  TOKEN_NOT_ALLOWED: 111,
  SAME_TOKEN: 112,
  ADAPTER_NOT_ALLOWED: 113,
  ZERO_AMOUNT: 100,
  TRADE_CAP_EXCEEDED: 114,
  APPROVAL_REQUIRED: 126,
  DAY_CAP_EXCEEDED: 115,
  COOLDOWN_ACTIVE: 116,
  INSUFFICIENT_BALANCE: 101,
  PRICE_BOUNDS_UNSET: 119,
  ORACLE_FAILED: 121,
  PRICE_ZERO: 122,
  PRICE_STALE: 123,
  PRICE_OVERFLOW: 124,
  BELOW_ORACLE_FLOOR: 125,
  APPROVAL_NOT_NEEDED: 127,
  REQUEST_PENDING: 128,
  NO_PENDING_SWAP: 129,
  REQUEST_EXPIRED: 130,
  REQUEST_MISMATCH: 131,
  REQUEST_AGENT_CHANGED: 132,
  NOT_REQUESTER: 133,
};

/** A refusal by one of the SDK's checks, with the rule names it can carry. */
export interface Refusal<R extends VaultRuleName> {
  ok: false;
  rule: R;
  /** The code the contract returns for this rule. */
  errorCode: number;
  message: string;
  /**
   * Set for a size refusal (u114, u126, u115, u101) and a cooldown refusal
   * (u116), and for no other. See `IntentCheck`.
   */
  suggestion?: SizeSuggestion;
}

/** `checkRequest`'s answer. */
export type RequestCheck = { ok: true } | Refusal<RequestRuleName>;
/** `checkApproval`'s answer. */
export type ApprovalCheck = { ok: true } | Refusal<ApprovalRuleName>;
/** `checkCancelRequest`'s answer. */
export type CancelCheck = { ok: true } | Refusal<CancelRuleName>;

export type IntentCheck =
  | { ok: true }
  | {
      ok: false;
      rule: RuleName;
      errorCode: number;
      message: string;
      /**
       * Set for a size refusal (u114, u126, u115, u101) and a cooldown
       * refusal (u116), and for no other: the largest amount that would pass
       * the size rules now, the largest `execute-swap` takes without the
       * owner's approval, and the heights at which waiting helps. Advisory;
       * `rule` and `errorCode` are the prediction.
       */
      suggestion?: SizeSuggestion;
    };

/** A refusal: the `ok: false` side of `IntentCheck`. */
export type IntentRefusal = Extract<IntentCheck, { ok: false }>;

/** Basis points in a whole. Fixed in the contract, not deploy configuration. */
const BPS = 10_000n;
const MAX_UINT = 2n ** 128n - 1n;

const MESSAGES: Record<VaultRuleName, string> = {
  NOT_AGENT: "the caller is not the owner's agent",
  VAULT_PAUSED: "the vault is paused",
  POLICY_EXPIRED: "the policy has expired",
  TOKEN_NOT_ALLOWED: "a token is not on the owner's allow list",
  SAME_TOKEN: "token in and token out are the same",
  ADAPTER_NOT_ALLOWED: "the adapter is not on the owner's allow list",
  ZERO_AMOUNT: "the amount is zero",
  TRADE_CAP_EXCEEDED: "the amount is above the per-trade cap for token in",
  DAY_CAP_EXCEEDED:
    "the amount would take the day total above the daily cap for token in",
  COOLDOWN_ACTIVE: "the cooldown since the last trade has not passed",
  INSUFFICIENT_BALANCE: "the amount is above the owner's ledger balance",
  PRICE_BOUNDS_UNSET: "the owner has not set price bounds",
  ORACLE_FAILED: "the oracle did not return a price",
  PRICE_ZERO: "the oracle's price is zero",
  PRICE_STALE:
    "the oracle's price is further from now than the owner's max price age",
  PRICE_OVERFLOW: "the oracle floor for this amount is too large to compute",
  BELOW_ORACLE_FLOOR: "min-out is below the oracle floor",
  APPROVAL_REQUIRED:
    "the amount is above the owner's approval threshold for token in: " +
    "send it with request-swap instead, and it runs when the owner approves",
  APPROVAL_NOT_NEEDED:
    "the amount does not need the owner's approval: the owner set no " +
    "approval threshold for token in, or the amount is at or below it. " +
    "Send it with execute-swap instead",
  REQUEST_PENDING: "the owner already has a request that has not expired",
  NO_PENDING_SWAP: "the owner has no pending request",
  REQUEST_EXPIRED: "the request's last approvable burn height has passed",
  REQUEST_MISMATCH: "the trade is not the one the stored request names",
  REQUEST_AGENT_CHANGED:
    "the agent that made the request is no longer the owner's agent",
  NOT_REQUESTER: "the caller is not the agent that made the request",
};

function refuse<R extends VaultRuleName>(rule: R): Refusal<R> {
  return {
    ok: false,
    rule,
    errorCode: RULE_CODES[rule],
    message: MESSAGES[rule],
  };
}

/** x * y, or `null` past 2^128 - 1: the contract's `checked-mul`. */
function checkedMul(x: bigint, y: bigint): bigint | null {
  return x > 0n && y > MAX_UINT / x ? null : x * y;
}

/** ceil(n / d) as q + (r > 0), as the contract's `ceil-div`. */
function ceilDiv(n: bigint, d: bigint): bigint {
  return n / d + (n % d > 0n ? 1n : 0n);
}

/**
 * The least `minOut` the vault accepts for selling `amountIn` of `tokenIn`,
 * by the contract's `oracle-floor`, after its checks in its order: the bounds
 * are set (u119), the oracle answered (u121) with a price that is not zero
 * (u122) and is at most `maxPriceAge` ms from `nowMs`, before or after it
 * (u123), and no product passes 2^128 - 1 (u124). Returns the first refusal.
 *
 * Throws a `RangeError` for `maxSlippageBps` of 10000 or more, which the
 * contract can never hold. Does not check the policy rules: `checkIntent`
 * runs those first.
 */
export function minOutFloor(
  state: VaultState,
  tokenIn: string,
  amountIn: bigint,
): { ok: true; floor: bigint } | IntentRefusal {
  const { priceBounds, oracle, nowMs } = state;
  const { maxSlippageBps, maxPriceAge } = priceBounds;
  if (maxSlippageBps >= BPS) {
    throw new RangeError(`maxSlippageBps must be below ${BPS}`);
  }
  if (maxSlippageBps === 0n || maxPriceAge === 0n) {
    return refuse("PRICE_BOUNDS_UNSET");
  }
  const price = oracle.price;
  if (price === null) return refuse("ORACLE_FAILED");
  const p = price.value;
  if (p === 0n) return refuse("PRICE_ZERO");
  const age =
    price.timestamp <= nowMs
      ? nowMs - price.timestamp
      : price.timestamp - nowMs;
  if (age > maxPriceAge) return refuse("PRICE_STALE");

  const keep = BPS - maxSlippageBps;
  const mulThen = (x: bigint, y: bigint, z: bigint) => {
    const xy = checkedMul(x, y);
    return xy === null ? null : checkedMul(xy, z);
  };
  if (tokenIn === oracle.sbtcToken) {
    // Selling sBTC: the floor is in quote base units.
    const n = mulThen(amountIn, p, keep);
    if (n === null) return refuse("PRICE_OVERFLOW");
    return { ok: true, floor: ceilDiv(n, oracle.priceScale * BPS) };
  }
  // Buying sBTC: the floor is in sats.
  const n = mulThen(amountIn, oracle.priceScale, keep);
  if (n === null) return refuse("PRICE_OVERFLOW");
  const d = checkedMul(p, BPS);
  if (d === null) return refuse("PRICE_OVERFLOW");
  return { ok: true, floor: ceilDiv(n, d) };
}

/** The trade of a check, without its caller. */
export type SwapTerms = Omit<Intent, "caller">;

/**
 * What the owner approves: a trade and the burn height of the request the
 * owner read (`PendingSwap.requestedAt`), `approve-swap`'s six arguments.
 */
export type ApprovalTerms = SwapTerms & { requestedAt: bigint };

/** The owner's threshold for `tokenIn`, or `null` for no band. */
function thresholdOf(state: VaultState, tokenIn: string): bigint | null {
  const thresholds = state.approvalThresholds;
  if (thresholds === undefined || !Object.hasOwn(thresholds, tokenIn)) {
    return null;
  }
  return thresholds[tokenIn] ?? null;
}

/** The contract's `needs-approval`. */
function needsApproval(
  state: VaultState,
  tokenIn: string,
  amountIn: bigint,
): boolean {
  const threshold = thresholdOf(state, tokenIn);
  return threshold !== null && amountIn > threshold;
}

type PolicyRule = (typeof REQUEST_RULES)[number]["rule"] & RuleName;

/**
 * The contract's `check-trade`: the policy checks up to the per-trade cap
 * (u108 to u114), which `execute-swap`, `request-swap` and `approve-swap` all
 * run first. `agent` is the caller for the first two and the request's agent
 * for `approve-swap`.
 */
function checkTrade(
  state: VaultState,
  agent: string,
  trade: SwapTerms,
): Refusal<PolicyRule> | null {
  const { vault, policy, burnHeight } = state;
  const { adapter, tokenIn, tokenOut, amountIn } = trade;
  if (vault.agent === null || vault.agent !== agent) {
    return refuse("NOT_AGENT");
  }
  if (vault.paused) return refuse("VAULT_PAUSED");
  if (burnHeight > policy.expiresAt) return refuse("POLICY_EXPIRED");
  if (
    !policy.allowedTokens.includes(tokenIn) ||
    !policy.allowedTokens.includes(tokenOut)
  ) {
    return refuse("TOKEN_NOT_ALLOWED");
  }
  if (tokenIn === tokenOut) return refuse("SAME_TOKEN");
  if (!policy.allowedAdapters.includes(adapter)) {
    return refuse("ADAPTER_NOT_ALLOWED");
  }
  if (amountIn <= 0n) return refuse("ZERO_AMOUNT");
  // Only token-in's caps count. A missing entry is 0n, never unlimited,
  // matching the contract's default.
  const caps = policy.caps[tokenIn] ?? { maxPerTrade: 0n, maxPerDay: 0n };
  if (amountIn > caps.maxPerTrade) {
    return { ...refuse("TRADE_CAP_EXCEEDED"), ...sized(state, tokenIn) };
  }
  return null;
}

function sized(
  state: VaultState,
  tokenIn: string,
): { suggestion: SizeSuggestion } {
  return { suggestion: suggestSize(state, tokenIn) };
}

/**
 * The contract's `run-swap` up to the adapter call: `check-trade`, the
 * approval threshold unless `approved`, then the daily cap, the cooldown, the
 * ledger and the oracle floor.
 */
function checkSwap(
  state: VaultState,
  agent: string,
  trade: SwapTerms,
  approved: boolean,
): IntentCheck {
  const { policy, usage, balances, burnHeight } = state;
  const { tokenIn, amountIn, minOut } = trade;
  const refused = checkTrade(state, agent, trade);
  if (refused !== null) return refused;
  if (!approved && needsApproval(state, tokenIn, amountIn)) {
    return { ...refuse("APPROVAL_REQUIRED"), ...sized(state, tokenIn) };
  }
  const caps = policy.caps[tokenIn] ?? { maxPerTrade: 0n, maxPerDay: 0n };
  const dayTotal = usage.dayTotals[tokenIn] ?? 0n;
  if (dayTotal > caps.maxPerDay || amountIn > caps.maxPerDay - dayTotal) {
    return { ...refuse("DAY_CAP_EXCEEDED"), ...sized(state, tokenIn) };
  }
  if (
    usage.lastTradeHeight !== null &&
    burnHeight - usage.lastTradeHeight < policy.cooldownBlocks
  ) {
    return { ...refuse("COOLDOWN_ACTIVE"), ...sized(state, tokenIn) };
  }
  if ((balances[tokenIn] ?? 0n) < amountIn) {
    return { ...refuse("INSUFFICIENT_BALANCE"), ...sized(state, tokenIn) };
  }
  const floor = minOutFloor(state, tokenIn, amountIn);
  if (!floor.ok) return floor;
  if (minOut < floor.floor) return refuse("BELOW_ORACLE_FLOOR");
  return { ok: true };
}

/**
 * Runs the checks of `execute-swap`, in its order, and returns the first one
 * that refuses: the policy rules (u108 to u114), the owner's approval
 * threshold (u126), the daily cap, the cooldown and the ledger (u115, u116,
 * u101), then the oracle floor (u119 to u125, see `minOutFloor`). `ok: true`
 * means no rule refuses; the allowance (u104), the adapter (u117) and its
 * output against `min-out` (u118) are decided after the adapter call, and
 * none is predicted here. The price's age is measured against `state.nowMs`,
 * which the caller supplies. A size or cooldown refusal (u114, u126, u115,
 * u116, u101) also carries `suggestion`, from `suggestSize`. Does not change
 * its inputs.
 *
 * A trade refused with `APPROVAL_REQUIRED` (u126) is inside the per-trade
 * cap and above the owner's threshold: the agent sends it with
 * `request-swap` instead (`checkRequest`, `buildRequestSwap`).
 */
export function checkIntent(state: VaultState, intent: Intent): IntentCheck {
  return checkSwap(state, intent.caller, intent, false);
}

/**
 * Runs the checks of `request-swap`, in its order, with `intent.caller` as
 * the agent: the policy rules up to the per-trade cap (u108 to u114), the
 * amount is above the owner's threshold for `tokenIn` (u127: otherwise send
 * `execute-swap`), the ledger covers it (u101), and no request that has not
 * expired at `state.burnHeight` is pending (u128; an expired one is
 * overwritten). `ok: true` means the request would be stored, not that the
 * trade will run: the daily cap, the cooldown and the oracle floor are
 * checked when the owner approves (`checkApproval`), and `minOut` is not
 * checked against the oracle until then. Does not change its inputs.
 */
export function checkRequest(state: VaultState, intent: Intent): RequestCheck {
  const { tokenIn, amountIn } = intent;
  const refused = checkTrade(state, intent.caller, intent);
  if (refused !== null) return refused;
  if (!needsApproval(state, tokenIn, amountIn)) {
    return refuse("APPROVAL_NOT_NEEDED");
  }
  if ((state.balances[tokenIn] ?? 0n) < amountIn) {
    return { ...refuse("INSUFFICIENT_BALANCE"), ...sized(state, tokenIn) };
  }
  const pending = state.pendingSwap ?? null;
  if (pending !== null && !pendingSwapExpired(pending, state.burnHeight)) {
    return refuse("REQUEST_PENDING");
  }
  return { ok: true };
}

/**
 * Runs the checks of `approve-swap` for the owner whose vault `state` is, in
 * the contract's order: there is a request (u129), it has not expired at
 * `state.burnHeight` (u130), `trade` is exactly the stored request, made at
 * `trade.requestedAt` (u131), and the agent that made it is still the
 * vault's agent (u132). `requestedAt` is the height of the request the owner
 * read; a caller that copies it from `state.pendingSwap` in the same breath
 * checks nothing by it. Then every
 * check of `execute-swap` as `checkIntent` runs them, with the request's
 * agent as the caller, except the approval threshold (u126). As there,
 * `ok: true` does not predict u104, u117 or u118. Does not change its inputs.
 */
export function checkApproval(
  state: VaultState,
  trade: ApprovalTerms,
): ApprovalCheck {
  const pending = state.pendingSwap ?? null;
  if (pending === null) return refuse("NO_PENDING_SWAP");
  if (pendingSwapExpired(pending, state.burnHeight)) {
    return refuse("REQUEST_EXPIRED");
  }
  if (
    trade.adapter !== pending.adapter ||
    trade.tokenIn !== pending.tokenIn ||
    trade.tokenOut !== pending.tokenOut ||
    trade.amountIn !== pending.amountIn ||
    trade.minOut !== pending.minOut ||
    trade.requestedAt !== pending.requestedAt
  ) {
    return refuse("REQUEST_MISMATCH");
  }
  if (state.vault.agent === null || state.vault.agent !== pending.agent) {
    return refuse("REQUEST_AGENT_CHANGED");
  }
  // Never APPROVAL_REQUIRED: `approved` skips that rule alone.
  return checkSwap(state, pending.agent, trade, true) as ApprovalCheck;
}

/**
 * Runs the checks of `cancel-swap-request` with `caller` as the sender: the
 * owner has a stored request, expired or not (u129), and `caller` is the
 * agent that made it, whether or not it is still the vault's agent (u133).
 * `reject-swap`, the owner's call, has the first check only.
 */
export function checkCancelRequest(
  state: Pick<VaultState, "pendingSwap">,
  caller: string,
): CancelCheck {
  const pending = state.pendingSwap ?? null;
  if (pending === null) return refuse("NO_PENDING_SWAP");
  if (pending.agent !== caller) return refuse("NOT_REQUESTER");
  return { ok: true };
}
