import { DEFAULT_WARNING_THRESHOLDS } from "@keelio/sdk";

// The alert vocabulary. Codes are stable: a code never changes meaning once
// it is listed in docs/monitoring.md.

export type Severity = "info" | "warning" | "critical";

/**
 * Every alert code, with its default severity. `CALL_REFUSED`,
 * `TOKEN_ALLOW_CHANGED`, `ADAPTER_ALLOW_CHANGED` and
 * `APPROVAL_THRESHOLD_SET` can be raised at another severity; see `evaluate`.
 */
export const ALERT_CODES = {
  DEPOSIT: "info",
  WITHDRAWAL: "info",
  AGENT_SET: "warning",
  AGENT_REMOVED: "info",
  VAULT_PAUSED: "info",
  VAULT_UNPAUSED: "warning",
  POLICY_SET: "warning",
  TOKEN_CAPS_SET: "warning",
  PRICE_BOUNDS_SET: "warning",
  TOKEN_ALLOW_CHANGED: "warning",
  ADAPTER_ALLOW_CHANGED: "warning",
  SWAP: "info",
  SWAP_NEAR_FLOOR: "warning",
  SWAP_BELOW_FLOOR: "critical",
  DAY_CAP_NEAR: "warning",
  APPROVAL_THRESHOLD_SET: "warning",
  SWAP_REQUESTED: "warning",
  SWAP_REQUEST_REJECTED: "info",
  SWAP_REQUEST_CANCELLED: "info",
  TRADE_FIRST_IN_DIRECTION: "info",
  TRADE_LARGE: "info",
  TRADE_BURST: "info",
  TRADE_AFTER_QUIET: "info",
  CALL_REFUSED: "warning",
  ORACLE_AGING: "warning",
  ORACLE_STALE: "critical",
  ORACLE_UNAVAILABLE: "critical",
  POLICY_EXPIRING: "warning",
  POLICY_EXPIRED: "warning",
  SWAP_REQUEST_EXPIRED: "warning",
  LEDGER_SHORTFALL: "critical",
  UNKNOWN_EVENT: "warning",
} as const satisfies Record<string, Severity>;

export type AlertCode = keyof typeof ALERT_CODES;

/** The codes that describe a condition that lasts, not one journal entry. */
export const LEVEL_CODES = [
  "ORACLE_AGING",
  "ORACLE_STALE",
  "ORACLE_UNAVAILABLE",
  "POLICY_EXPIRING",
  "POLICY_EXPIRED",
] as const satisfies readonly AlertCode[];

export type LevelCode = (typeof LEVEL_CODES)[number];

/** JSON-safe: every amount and height is a decimal string of base units. */
export interface Alert {
  /**
   * Stable for the same journal entry, refused call or condition, so a
   * consumer can drop a repeat after a crash between output and save.
   */
  id: string;
  code: AlertCode;
  severity: Severity;
  /**
   * The vault owner, or `null` for a journal entry that names none and for
   * `LEDGER_SHORTFALL`, which is about the whole vault contract.
   */
  owner: string | null;
  /** The burn height of the entry, or of the poll for a lasting condition. */
  burnHeight: string;
  /** One line. Amounts are base units. */
  message: string;
  details: Readonly<Record<string, string | boolean | null>>;
}

/** `keelio-vault`'s error constants by code, copied from docs/errors.md. */
export const VAULT_ERROR_NAMES: Readonly<Record<string, string>> = {
  "100": "ERR-ZERO-AMOUNT",
  "101": "ERR-INSUFFICIENT-BALANCE",
  "102": "ERR-TOKEN-NOT-ALLOWED",
  "103": "ERR-AGENT-IS-OWNER",
  "104": "ERR-ALLOWANCE-EXCEEDED",
  "105": "ERR-INVALID-POLICY",
  "106": "ERR-TOKEN-NOT-SUPPORTED",
  "107": "ERR-ADAPTER-NOT-SUPPORTED",
  "108": "ERR-NOT-AGENT",
  "109": "ERR-VAULT-PAUSED",
  "110": "ERR-POLICY-EXPIRED",
  "111": "ERR-SWAP-TOKEN-NOT-ALLOWED",
  "112": "ERR-SAME-TOKEN",
  "113": "ERR-SWAP-ADAPTER-NOT-ALLOWED",
  "114": "ERR-TRADE-CAP-EXCEEDED",
  "115": "ERR-DAY-CAP-EXCEEDED",
  "116": "ERR-COOLDOWN-ACTIVE",
  "117": "ERR-ADAPTER-FAILED",
  "118": "ERR-BELOW-MIN-OUT",
  "119": "ERR-PRICE-BOUNDS-UNSET",
  "120": "ERR-INVALID-PRICE-BOUNDS",
  "121": "ERR-ORACLE-FAILED",
  "122": "ERR-PRICE-ZERO",
  "123": "ERR-PRICE-STALE",
  "124": "ERR-PRICE-OVERFLOW",
  "125": "ERR-BELOW-ORACLE-FLOOR",
  "126": "ERR-APPROVAL-REQUIRED",
  "127": "ERR-APPROVAL-NOT-NEEDED",
  "128": "ERR-REQUEST-PENDING",
  "129": "ERR-NO-PENDING-SWAP",
  "130": "ERR-REQUEST-EXPIRED",
  "131": "ERR-REQUEST-MISMATCH",
  "132": "ERR-REQUEST-AGENT-CHANGED",
  "133": "ERR-NOT-REQUESTER",
};

/**
 * Each `keelio-vault` refusal in plain words, by code, copied from the second
 * table of docs/errors.md. The digest leads with these.
 */
export const VAULT_ERROR_WORDS: Readonly<Record<string, string>> = {
  "100": "The amount is zero",
  "101": "More than the vault holds",
  "102": "This vault does not accept that token",
  "103": "The agent cannot be the owner",
  "104": "Tried to move more than the call allows",
  "105": "The day cap is below the trade cap",
  "106": "This vault does not support that token",
  "107": "This vault does not support that adapter",
  "108": "The caller is not the named agent",
  "109": "The vault is paused",
  "110": "The policy has expired",
  "111": "A token is not on your swap list",
  "112": "Token in and token out are the same",
  "113": "The adapter is not on your list",
  "114": "Over the per-trade cap",
  "115": "Over the day cap",
  "116": "The cooldown is still running",
  "117": "The swap adapter failed",
  "118": "Received less than the minimum out",
  "119": "The price bounds are not set",
  "120": "The slippage bound is too high",
  "121": "The price oracle failed",
  "122": "The oracle price is zero",
  "123": "The oracle price is too old",
  "124": "The price calculation overflowed",
  "125": "The minimum out is below the oracle floor",
  "126": "This trade needs the owner's approval",
  "127": "This trade does not need approval",
  "128": "A request is already waiting",
  "129": "There is no request waiting",
  "130": "The request has expired",
  "131": "This is not the request that is waiting",
  "132": "The agent that asked has been replaced",
  "133": "The caller did not make this request",
};

/**
 * Refusals that mean the adapter did something the vault had to stop, not
 * that the agent asked for too much: it tried to move more than its allowance
 * (u104), or reported success and delivered less than `min-out` (u118).
 */
export const CRITICAL_REFUSALS: readonly string[] = ["104", "118"];

/**
 * Refusals that are the approval band sending a trade to the right function:
 * `execute-swap` for an amount above the owner's threshold (u126: the agent
 * calls `request-swap` instead), and `request-swap` for one at or below it
 * (u127). Nothing was attempted that the owner's limits forbid.
 */
export const ROUTINE_REFUSALS: readonly string[] = ["126", "127"];

export interface Thresholds {
  /**
   * `SWAP_NEAR_FLOOR` when `amount-out` is at most this many basis points
   * above `min-out-floor`.
   */
  nearFloorBps: bigint;
  /**
   * `DAY_CAP_NEAR` when a swap leaves `day-total` at or above this share of
   * the input token's `max-per-day`, in basis points.
   */
  dayCapWarnBps: bigint;
  /**
   * `ORACLE_AGING` when the price's age is at or above this share of the
   * owner's `max-price-age`, in basis points, and not yet past it.
   */
  oracleAgeWarnBps: bigint;
  /** `POLICY_EXPIRING` when at most this many burn blocks are left. */
  expiryWarnBlocks: bigint;
  /**
   * `TRADE_LARGE` when a trade's `amount-in` is more than this many times
   * the median of the owner's earlier trades in the same direction.
   */
  tradeSizeMultiple: bigint;
  /**
   * `TRADE_BURST` when a trade is at least the `tradeBurstTrades`-th of the
   * owner's trades within `tradeBurstBlocks` burn blocks. `1` or less for
   * `tradeBurstTrades` turns it off.
   */
  tradeBurstTrades: bigint;
  tradeBurstBlocks: bigint;
  /**
   * `TRADE_AFTER_QUIET` when the owner's trade before this one is at least
   * this many burn blocks back. `0` turns it off.
   */
  tradeQuietBlocks: bigint;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  nearFloorBps: 50n,
  dayCapWarnBps: 8000n,
  oracleAgeWarnBps: 8000n,
  expiryWarnBlocks: 144n,
  // The SDK's pre-trade warnings use the same rules and the same numbers.
  tradeSizeMultiple: DEFAULT_WARNING_THRESHOLDS.sizeMultiple,
  tradeBurstTrades: DEFAULT_WARNING_THRESHOLDS.burstTrades,
  tradeBurstBlocks: DEFAULT_WARNING_THRESHOLDS.burstBlocks,
  tradeQuietBlocks: DEFAULT_WARNING_THRESHOLDS.quietBlocks,
};
