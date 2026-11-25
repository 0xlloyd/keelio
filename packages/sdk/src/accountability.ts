import {
  boolField,
  eventRef,
  swapEvent,
  swapRequestEvent,
  textField,
  toJsonSafe,
  uintField,
  type EventRef,
  type JournalEvent,
  type Jsonified,
  type SwapEvent,
} from "./journal.js";

// The accountability record: for each trade, the limits that were in force
// when it ran, rebuilt by replaying the journal. A trade is an `execute-swap`
// event or, when the owner approved it, an `approve-swap` event. Neither
// names its policy, so each limit is traced to the event that set it.

/** One entry of an owner's token or adapter list. */
export interface AllowEntry {
  /** The token or adapter contract. */
  id: string;
  allowed: boolean;
  /** The latest `allow-token` or `allow-adapter` event for `id`. */
  setBy: EventRef;
}

/** What the replay found wrong or missing for one trade. */
export type AccountIssueCode =
  | "NO_AGENT_EVENT"
  | "AGENT_MISMATCH"
  | "NO_POLICY_EVENT"
  | "NO_CAPS_EVENT"
  | "NO_PRICE_BOUNDS_EVENT"
  | "TOKEN_IN_NOT_ALLOWED"
  | "TOKEN_OUT_NOT_ALLOWED"
  | "ADAPTER_NOT_ALLOWED"
  | "AFTER_EXPIRY"
  | "OVER_TRADE_CAP"
  | "OVER_DAY_CAP"
  | "BELOW_ORACLE_FLOOR"
  | "OVER_APPROVAL_THRESHOLD"
  | "NO_REQUEST_EVENT";

export interface AccountIssue {
  code: AccountIssueCode;
  message: string;
}

/** The limits in force for one trade, each with the event that set it. */
export interface PolicyInForce {
  /**
   * The owner's agent by the latest `set-agent` or `remove-agent`, or `null`
   * when the journal given has neither before the trade.
   */
  agent: { agent: string | null; setBy: EventRef } | null;
  /** The cooldown and expiry by the latest `set-policy`. */
  terms: { cooldownBlocks: bigint; expiresAt: bigint; setBy: EventRef } | null;
  /** The input token's caps by the latest `set-token-caps` for it. */
  caps: {
    token: string;
    maxPerTrade: bigint;
    maxPerDay: bigint;
    setBy: EventRef;
  } | null;
  /** The price bounds by the latest `set-price-bounds`. */
  priceBounds: {
    maxSlippageBps: bigint;
    maxPriceAge: bigint;
    setBy: EventRef;
  } | null;
  /**
   * The input token's approval threshold by the latest
   * `set-approval-threshold` for it: `threshold` is `null` when that event
   * cleared it. The whole entry is `null` when the journal has no such event
   * before the trade, which is how a vault that never set a threshold reads:
   * no band, and no issue.
   */
  approvalThreshold: {
    token: string;
    threshold: bigint | null;
    setBy: EventRef;
  } | null;
  /** Every token the owner has allowed or revoked, in first-seen order. */
  tokens: AllowEntry[];
  /** Every adapter the owner has allowed or revoked, in first-seen order. */
  adapters: AllowEntry[];
}

/** One trade and the limits it ran under. */
export interface TradeAccount {
  /**
   * The trade event's own fields, oracle values included. `swap.approved`
   * says whether the owner approved it (`approve-swap`) or the agent sent it
   * alone (`execute-swap`).
   */
  swap: SwapEvent;
  /**
   * For an approved trade, the `request-swap` event it ran: the owner's
   * latest one, when its `requested-at` is the trade's. `null` for a trade
   * the agent sent alone, and for an approved trade whose request the
   * journal given does not hold (see `NO_REQUEST_EVENT`).
   */
  request: EventRef | null;
  policy: PolicyInForce;
  /**
   * Empty when every limit was found in the journal and the trade is inside
   * each one. The contract cannot accept a trade outside its limits, so an
   * entry here means the journal given is incomplete or out of order.
   */
  issues: AccountIssue[];
}

interface OwnerState {
  agent: PolicyInForce["agent"];
  terms: PolicyInForce["terms"];
  caps: Map<string, NonNullable<PolicyInForce["caps"]>>;
  priceBounds: PolicyInForce["priceBounds"];
  thresholds: Map<string, NonNullable<PolicyInForce["approvalThreshold"]>>;
  /** The owner's latest `request-swap`, until it is approved or removed. */
  request: { requestedAt: bigint; ref: EventRef } | null;
  tokens: Map<string, AllowEntry>;
  adapters: Map<string, AllowEntry>;
}

const ISSUE_MESSAGES: Record<AccountIssueCode, string> = {
  NO_AGENT_EVENT: "the journal has no set-agent event before this trade",
  AGENT_MISMATCH:
    "the agent that traded is not the agent the latest set-agent event named",
  NO_POLICY_EVENT: "the journal has no set-policy event before this trade",
  NO_CAPS_EVENT:
    "the journal has no set-token-caps event for the token sold before this trade",
  NO_PRICE_BOUNDS_EVENT:
    "the journal has no set-price-bounds event before this trade",
  TOKEN_IN_NOT_ALLOWED: "the token sold is not allowed by the events replayed",
  TOKEN_OUT_NOT_ALLOWED:
    "the token bought is not allowed by the events replayed",
  ADAPTER_NOT_ALLOWED: "the adapter is not allowed by the events replayed",
  AFTER_EXPIRY: "the trade ran after the expiry replayed",
  OVER_TRADE_CAP: "the amount sold is above the per-trade cap replayed",
  OVER_DAY_CAP: "the window total is above the daily cap replayed",
  BELOW_ORACLE_FLOOR:
    "the minimum out is below the oracle floor, or less than the minimum arrived",
  OVER_APPROVAL_THRESHOLD:
    "the agent sent this trade alone, and the amount sold is above the approval threshold replayed",
  NO_REQUEST_EVENT:
    "the journal has no request-swap event for the request this approval ran",
};

function issuesOf(
  swap: SwapEvent,
  policy: PolicyInForce,
  request: EventRef | null,
): AccountIssue[] {
  const codes: AccountIssueCode[] = [];
  const allowed = (list: AllowEntry[], id: string) =>
    list.some((entry) => entry.id === id && entry.allowed);
  if (policy.agent === null) codes.push("NO_AGENT_EVENT");
  else if (policy.agent.agent !== swap.agent) codes.push("AGENT_MISMATCH");
  if (policy.terms === null) codes.push("NO_POLICY_EVENT");
  else if (swap.ref.burnHeight > policy.terms.expiresAt) {
    codes.push("AFTER_EXPIRY");
  }
  if (!allowed(policy.tokens, swap.tokenIn)) codes.push("TOKEN_IN_NOT_ALLOWED");
  if (!allowed(policy.tokens, swap.tokenOut)) {
    codes.push("TOKEN_OUT_NOT_ALLOWED");
  }
  if (!allowed(policy.adapters, swap.adapter))
    codes.push("ADAPTER_NOT_ALLOWED");
  if (policy.caps === null) codes.push("NO_CAPS_EVENT");
  else {
    if (swap.amountIn > policy.caps.maxPerTrade) codes.push("OVER_TRADE_CAP");
    if (swap.dayTotal > policy.caps.maxPerDay) codes.push("OVER_DAY_CAP");
  }
  if (policy.priceBounds === null) codes.push("NO_PRICE_BOUNDS_EVENT");
  if (swap.minOut < swap.minOutFloor || swap.amountOut < swap.minOut) {
    codes.push("BELOW_ORACLE_FLOOR");
  }
  const threshold = policy.approvalThreshold?.threshold ?? null;
  if (!swap.approved && threshold !== null && swap.amountIn > threshold) {
    codes.push("OVER_APPROVAL_THRESHOLD");
  }
  if (swap.approved && request === null) codes.push("NO_REQUEST_EVENT");
  return codes.map((code) => ({ code, message: ISSUE_MESSAGES[code] }));
}

/**
 * Replays the journal, oldest first, and returns one record per trade, which
 * is an `execute-swap` event or an `approve-swap` event (a trade the agent
 * requested and the owner approved): the trade's own fields and the limits
 * in force when it ran, each with the event that set it. Events of every owner may be
 * mixed; each trade is matched to its own owner's limits. `options.owner`
 * keeps only that owner's trades.
 *
 * An event with a name this function does not know, or a known name with a
 * field missing, is skipped. Never throws.
 */
export function accountabilityRecords(
  events: readonly JournalEvent[],
  options: { owner?: string } = {},
): TradeAccount[] {
  const owners = new Map<string, OwnerState>();
  const stateOf = (owner: string): OwnerState => {
    let state = owners.get(owner);
    if (state === undefined) {
      state = {
        agent: null,
        terms: null,
        caps: new Map(),
        priceBounds: null,
        thresholds: new Map(),
        request: null,
        tokens: new Map(),
        adapters: new Map(),
      };
      owners.set(owner, state);
    }
    return state;
  };

  const records: TradeAccount[] = [];
  for (const event of events) {
    const owner = textField(event, "owner");
    if (owner === undefined) continue;
    const state = stateOf(owner);
    const setBy = eventRef(event);
    switch (event.event) {
      case "set-agent":
      case "remove-agent": {
        const agent = event.fields.agent;
        if (typeof agent === "string" || agent === null) {
          state.agent = { agent, setBy };
        }
        break;
      }
      case "set-policy": {
        const cooldownBlocks = uintField(event, "cooldown-blocks");
        const expiresAt = uintField(event, "expires-at");
        if (cooldownBlocks !== undefined && expiresAt !== undefined) {
          state.terms = { cooldownBlocks, expiresAt, setBy };
        }
        break;
      }
      case "set-token-caps": {
        const token = textField(event, "token");
        const maxPerTrade = uintField(event, "max-per-trade");
        const maxPerDay = uintField(event, "max-per-day");
        if (
          token !== undefined &&
          maxPerTrade !== undefined &&
          maxPerDay !== undefined
        ) {
          state.caps.set(token, { token, maxPerTrade, maxPerDay, setBy });
        }
        break;
      }
      case "set-price-bounds": {
        const maxSlippageBps = uintField(event, "max-slippage-bps");
        const maxPriceAge = uintField(event, "max-price-age");
        if (maxSlippageBps !== undefined && maxPriceAge !== undefined) {
          state.priceBounds = { maxSlippageBps, maxPriceAge, setBy };
        }
        break;
      }
      case "allow-token":
      case "allow-adapter": {
        const isToken = event.event === "allow-token";
        const id = textField(event, isToken ? "token" : "adapter");
        const allowed = boolField(event, "allowed");
        if (id !== undefined && allowed !== undefined) {
          (isToken ? state.tokens : state.adapters).set(id, {
            id,
            allowed,
            setBy,
          });
        }
        break;
      }
      case "set-approval-threshold": {
        const token = textField(event, "token");
        const threshold = event.fields.threshold;
        if (
          token !== undefined &&
          (typeof threshold === "bigint" || threshold === null)
        ) {
          state.thresholds.set(token, { token, threshold, setBy });
        }
        break;
      }
      case "request-swap": {
        const made = swapRequestEvent(event);
        if (made !== null) {
          state.request = { requestedAt: made.requestedAt, ref: setBy };
        }
        break;
      }
      case "reject-swap":
      case "cancel-swap-request":
        state.request = null;
        break;
      case "execute-swap":
      case "approve-swap": {
        const swap = swapEvent(event);
        if (swap === null) break;
        // An approval uses up the stored request, whoever's record is kept.
        const stored = state.request;
        const request =
          swap.approved &&
          stored !== null &&
          stored.requestedAt === swap.requestedAt
            ? stored.ref
            : null;
        if (swap.approved) state.request = null;
        if (options.owner !== undefined && swap.owner !== options.owner) break;
        const policy: PolicyInForce = {
          agent: state.agent,
          terms: state.terms,
          caps: state.caps.get(swap.tokenIn) ?? null,
          priceBounds: state.priceBounds,
          approvalThreshold: state.thresholds.get(swap.tokenIn) ?? null,
          tokens: [...state.tokens.values()],
          adapters: [...state.adapters.values()],
        };
        records.push({
          swap,
          request,
          policy,
          issues: issuesOf(swap, policy, request),
        });
        break;
      }
      default:
        // Any other event, a later contract's new ones included, sets none
        // of these limits.
        break;
    }
  }
  return records;
}

/** The records with every `bigint` as a decimal string, for `JSON.stringify`. */
export function accountabilityJson(
  records: readonly TradeAccount[],
): Jsonified<TradeAccount>[] {
  return toJsonSafe(records) as Jsonified<TradeAccount>[];
}

function refText(ref: EventRef): string {
  const tx = ref.txId === null ? "" : `, transaction ${ref.txId}`;
  return `journal event ${ref.index} at burn height ${ref.burnHeight}${tx}`;
}

function allowText(entries: AllowEntry[]): string[] {
  if (entries.length === 0) return ["  - none found in the journal"];
  return entries.map(
    (entry) =>
      `  - \`${entry.id}\`: ${entry.allowed ? "allowed" : "revoked"} (${refText(entry.setBy)})`,
  );
}

function tradeSection(record: TradeAccount, number: number): string[] {
  const { swap, request, policy, issues } = record;
  const missing = "not found in the journal";
  const authority = !swap.approved
    ? "- Authority: sent by the agent alone (`execute-swap`)"
    : `- Authority: approved by the owner (\`approve-swap\`). The agent requested it at burn height ${swap.requestedAt}${
        request === null
          ? "; its request-swap event was not found in the journal"
          : `, ${refText(request)}`
      }`;
  const threshold = policy.approvalThreshold;
  const lines = [
    `## Trade ${number}: ${refText(swap.ref)}`,
    "",
    `- Owner: \`${swap.owner}\``,
    swap.approved
      ? `- Agent that requested the trade: \`${swap.agent}\``
      : `- Agent that traded: \`${swap.agent}\``,
    authority,
    `- Sold: ${swap.amountIn} of \`${swap.tokenIn}\``,
    `- Received: ${swap.amountOut} of \`${swap.tokenOut}\``,
    `- Adapter: \`${swap.adapter}\``,
    `- The agent's minimum out: ${swap.minOut}. The least the vault would have accepted (its oracle floor): ${swap.minOutFloor}`,
    `- Oracle BTC/USD price the vault read: ${swap.oraclePrice} (8 decimals), timestamp ${swap.oracleTimestamp} ms`,
    `- Owner's ledger after the trade: ${swap.balanceIn} of the token sold, ${swap.balanceOut} of the token bought`,
    `- Sold in the 144-block window, this trade included: ${swap.dayTotal}`,
    "",
    "Limits in force when it ran:",
    "",
    policy.agent === null
      ? `- Agent: ${missing}`
      : policy.agent.agent === null
        ? `- Agent: none, removed by ${refText(policy.agent.setBy)}`
        : `- Agent: \`${policy.agent.agent}\`, named by ${refText(policy.agent.setBy)}`,
    policy.terms === null
      ? `- Cooldown and expiry: ${missing}`
      : `- Cooldown: ${policy.terms.cooldownBlocks} burn blocks between trades. Expiry: burn height ${policy.terms.expiresAt}. Set by ${refText(policy.terms.setBy)}`,
    policy.caps === null
      ? `- Caps for the token sold: ${missing}`
      : `- Caps for the token sold: ${policy.caps.maxPerTrade} per trade, ${policy.caps.maxPerDay} per 144 burn blocks. Set by ${refText(policy.caps.setBy)}`,
    policy.priceBounds === null
      ? `- Price bounds: ${missing}`
      : `- Price bounds: a trade may settle at most ${policy.priceBounds.maxSlippageBps} basis points below the oracle price, and the price may be at most ${policy.priceBounds.maxPriceAge} ms old. Set by ${refText(policy.priceBounds.setBy)}`,
    threshold === null
      ? "- Approval threshold for the token sold: none set in the journal, so no trade needed the owner's approval"
      : threshold.threshold === null
        ? `- Approval threshold for the token sold: none, cleared by ${refText(threshold.setBy)}`
        : `- Approval threshold for the token sold: a trade selling more than ${threshold.threshold} needs the owner's approval. Set by ${refText(threshold.setBy)}`,
    "- Token list:",
    ...allowText(policy.tokens),
    "- Adapter list:",
    ...allowText(policy.adapters),
    "",
  ];
  if (issues.length === 0) {
    lines.push(
      "Replay check: every limit above was found in the journal, and the trade is inside each one.",
    );
  } else {
    lines.push(
      "Replay check: the journal given does not account for this trade.",
      "",
      ...issues.map((issue) => `- ${issue.code}: ${issue.message}`),
    );
  }
  return lines;
}

/**
 * The records as a Markdown report that also reads as plain text: one
 * section per trade, with the trade's fields, the limits in force and the
 * journal event behind each. Amounts are printed in base units, because the
 * SDK does not know a token's decimals.
 */
export function renderAccountabilityReport(
  records: readonly TradeAccount[],
  options: { title?: string } = {},
): string {
  const lines = [
    `# ${options.title ?? "Keelio accountability record"}`,
    "",
    records.length === 0
      ? "The journal given holds no trades."
      : `${records.length} ${records.length === 1 ? "trade" : "trades"}, oldest first.`,
    "",
    "Each trade is an `execute-swap` event the vault contract printed, or an `approve-swap` event",
    "for a trade the agent requested and the owner approved. The limits beside it are rebuilt by",
    "replaying the earlier events of the same owner, and each names the event that set it.",
    "Amounts are in each token's base units. Heights are Bitcoin (burn) block heights. An",
    "event's number is its position in the journal this report was built from, counted from 0.",
  ];
  records.forEach((record, i) => {
    lines.push("", ...tradeSection(record, i + 1));
  });
  return lines.join("\n") + "\n";
}
