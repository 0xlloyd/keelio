import type { JournalRecord } from "@keelio/mcp";
import {
  parseJournalRecord,
  tradeWarnings,
  type JournalEvent,
  type VaultRead,
} from "@keelio/sdk";
import { Cl, type ClarityValue } from "@stacks/transactions";
import {
  ALERT_CODES,
  CRITICAL_REFUSALS,
  LEVEL_CODES,
  ROUTINE_REFUSALS,
  VAULT_ERROR_NAMES,
  type Alert,
  type AlertCode,
  type LevelCode,
  type Severity,
  type Thresholds,
} from "./alerts.js";
import type { RefusedCall } from "./chain.js";

// The monitor's core. Pure: no clock, no network, no file. Given what one
// poll read, it returns the alerts to raise and the state for the next poll.

const BPS = 10_000n;

/** The journal events that are a completed trade (docs/events.md). */
export const TRADE_EVENTS: readonly string[] = ["execute-swap", "approve-swap"];

/**
 * A `request-swap` the journal has not yet shown approved, rejected,
 * withdrawn or replaced. Amounts and heights are decimal strings.
 */
export interface PendingRequest {
  agent: string;
  adapter: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  minOut: string;
  requestedAt: string;
  /** The last burn height the owner can approve at. */
  expiresAt: string;
  /** `SWAP_REQUEST_EXPIRED` has been raised for this request. */
  expiryReported: boolean;
}

/** What the monitor remembers about one owner. JSON-safe. */
export interface OwnerState {
  /** Ledger balance by token id, from the journal's `balance` fields. */
  balances: Record<string, string>;
  /** `max-per-day` by token id, from the journal's `set-token-caps`. */
  dayCaps: Record<string, string>;
  /** The lasting conditions already alerted on and still true. */
  active: LevelCode[];
  /**
   * The approval threshold by input token id, from the journal's
   * `set-approval-threshold`. A token with no entry has none.
   */
  approvalThresholds: Record<string, string>;
  /** The owner's open request, or `null`. The vault stores at most one. */
  pending: PendingRequest | null;
}

/** Everything the monitor carries from one poll to the next. JSON-safe. */
export interface MonitorState {
  version: 1;
  /** How many journal records and refused calls have been processed. */
  cursor: { events: number; refusals: number };
  owners: Record<string, OwnerState>;
  /** Tokens whose `LEDGER_SHORTFALL` was alerted and is still true. */
  shortTokens: string[];
}

export function initialState(): MonitorState {
  return {
    version: 1,
    cursor: { events: 0, refusals: 0 },
    owners: {},
    shortTokens: [],
  };
}

/** One token, vault-wide: what the vault contract holds and what it owes. */
export interface LedgerReading {
  /** The token's `get-balance` of the vault contract. */
  held: bigint;
  /** The vault's `get-ledger-total` of the token: every owner's ledger. */
  owed: bigint;
}

export interface EvaluateInput {
  state: MonitorState;
  thresholds: Thresholds;
  /** The journal records after `state.cursor.events`, oldest first. */
  events: readonly JournalRecord[];
  /** The refused calls after `state.cursor.refusals`, oldest first. */
  refusals: readonly RefusedCall[];
  /**
   * Each owner's vault, read after those events. An owner with no entry gets
   * no alert for a lasting condition in this poll.
   */
  vaults: Readonly<Record<string, VaultRead>>;
  burnHeight: bigint;
  /** `stacks-block-time * 1000` of the latest block. */
  blockTimeMs: bigint;
  /**
   * Each token's reading, by token id. Left out, `LEDGER_SHORTFALL` is not
   * checked this poll and what was active stays active.
   */
  ledgers?: Readonly<Record<string, LedgerReading>>;
  /**
   * The journal records before `state.cursor.events`, oldest first: what
   * each new trade is compared with for the `TRADE_…` alerts. Left out, those
   * alerts are not checked this poll.
   */
  history?: readonly JournalRecord[];
}

export interface EvaluateResult {
  alerts: Alert[];
  state: MonitorState;
}

type Fields = Record<string, ClarityValue>;
type Details = Record<string, string | boolean | null>;

function principalOf(value: ClarityValue): string {
  if (value.type !== "address" && value.type !== "contract") {
    throw new Error(`expected principal, got ${value.type}`);
  }
  return Cl.prettyPrint(value).replace(/^'/, "");
}

/** Typed reads of one print tuple. Each throws on a missing or wrong field. */
function reader(fields: Fields) {
  const get = (name: string): ClarityValue => {
    const value = fields[name];
    if (value === undefined) throw new Error(`missing field ${name}`);
    return value;
  };
  return {
    text(name: string): string {
      const value = get(name);
      if (value.type !== "ascii" && value.type !== "utf8") {
        throw new Error(`${name} is not a string`);
      }
      return value.value;
    },
    uint(name: string): bigint {
      const value = get(name);
      if (value.type !== "uint") throw new Error(`${name} is not a uint`);
      return BigInt(value.value);
    },
    bool(name: string): boolean {
      const value = get(name);
      if (value.type === "true") return true;
      if (value.type === "false") return false;
      throw new Error(`${name} is not a bool`);
    },
    optionalUint(name: string): bigint | null {
      const value = get(name);
      if (value.type === "none") return null;
      if (value.type === "some" && value.value.type === "uint") {
        return BigInt(value.value.value);
      }
      throw new Error(`${name} is not an optional uint`);
    },
    principal: (name: string): string => principalOf(get(name)),
    optionalPrincipal(name: string): string | null {
      const value = get(name);
      if (value.type === "none") return null;
      if (value.type === "some") return principalOf(value.value);
      throw new Error(`${name} is not an optional`);
    },
  };
}

/**
 * The owner a journal record names, or `null` if it is not a tuple with a
 * principal `owner`.
 */
export function recordOwner(record: JournalRecord): string | null {
  if (record.value.type !== "tuple") return null;
  const owner = record.value.value["owner"];
  if (owner === undefined) return null;
  try {
    return principalOf(owner);
  } catch {
    return null;
  }
}

/**
 * The owners whose vaults `evaluate` wants read: every owner already in
 * `state` and every owner the new `events` name. Sorted, without repeats.
 */
export function ownersToRead(
  state: MonitorState,
  events: readonly JournalRecord[],
): string[] {
  const owners = new Set(Object.keys(state.owners));
  for (const record of events) {
    const owner = recordOwner(record);
    if (owner !== null) owners.add(owner);
  }
  return [...owners].sort();
}

/**
 * The owners whose ledger held a balance at the last journal entry the
 * monitor processed, with those balances in base units. This is the list the
 * withdrawal plan in docs/monitoring.md starts from.
 */
export function ownersWithBalance(
  state: MonitorState,
): { owner: string; balances: Record<string, string> }[] {
  const out: { owner: string; balances: Record<string, string> }[] = [];
  for (const owner of Object.keys(state.owners).sort()) {
    const balances: Record<string, string> = {};
    for (const [token, amount] of Object.entries(
      state.owners[owner]!.balances,
    )) {
      if (BigInt(amount) > 0n) balances[token] = amount;
    }
    if (Object.keys(balances).length > 0) out.push({ owner, balances });
  }
  return out;
}

function copyState(state: MonitorState): MonitorState {
  const owners: Record<string, OwnerState> = {};
  for (const [owner, o] of Object.entries(state.owners)) {
    owners[owner] = {
      balances: { ...o.balances },
      dayCaps: { ...o.dayCaps },
      active: [...o.active],
      approvalThresholds: { ...o.approvalThresholds },
      pending: o.pending === null ? null : { ...o.pending },
    };
  }
  return {
    version: 1,
    cursor: { ...state.cursor },
    owners,
    shortTokens: [...state.shortTokens],
  };
}

function ownerState(state: MonitorState, owner: string): OwnerState {
  return (state.owners[owner] ??= {
    balances: {},
    dayCaps: {},
    active: [],
    approvalThresholds: {},
    pending: null,
  });
}

interface Raise {
  code: AlertCode;
  severity?: Severity;
  message: string;
  details: Details;
}

/**
 * Each owner's completed trades so far, oldest first, as the SDK's
 * `tradeWarnings` reads them. An approved trade is filed under
 * `execute-swap`'s name: it carries the same fields and counts the same.
 */
type TradeHistory = Map<string, JournalEvent[]>;

function fileTrade(
  trades: TradeHistory,
  record: JournalRecord,
  index: number,
): void {
  const event = parseJournalRecord(record, index);
  if (event === null || !TRADE_EVENTS.includes(event.event)) return;
  const owner = event.fields["owner"];
  if (typeof owner !== "string") return;
  const list = trades.get(owner) ?? [];
  list.push({ ...event, event: "execute-swap" });
  trades.set(owner, list);
}

/**
 * The advisory alerts for one trade against the owner's earlier ones: the
 * SDK's pre-trade warnings, asked after the fact.
 */
function unusualTrade(
  past: readonly JournalEvent[],
  trade: {
    owner: string;
    tokenIn: string;
    tokenOut: string;
    amountIn: bigint;
    burnHeight: bigint;
  },
  thresholds: Thresholds,
): Raise[] {
  const { tokenIn, tokenOut, amountIn } = trade;
  return tradeWarnings(past, trade, {
    sizeMultiple: thresholds.tradeSizeMultiple,
    sizeBaseline: "median",
    burstTrades: thresholds.tradeBurstTrades,
    burstBlocks: thresholds.tradeBurstBlocks,
    quietBlocks: thresholds.tradeQuietBlocks,
  }).map((w): Raise => {
    switch (w.kind) {
      case "FIRST_TRADE_IN_DIRECTION":
        return {
          code: "TRADE_FIRST_IN_DIRECTION",
          message: `this vault's first trade selling ${tokenIn} for ${tokenOut}: ${amountIn} sold`,
          details: { tokenIn, tokenOut, amountIn: amountIn.toString() },
        };
      case "LARGE_TRADE":
        return {
          code: "TRADE_LARGE",
          message:
            `${amountIn} of ${tokenIn} sold, more than ${w.sizeMultiple} times the median ${w.baseline} ` +
            `of this vault's ${w.pastTrades} earlier trades in this direction`,
          details: {
            tokenIn,
            tokenOut,
            amountIn: amountIn.toString(),
            median: w.baseline.toString(),
            sizeMultiple: w.sizeMultiple.toString(),
            pastTrades: w.pastTrades.toString(),
          },
        };
      case "BURST":
        return {
          code: "TRADE_BURST",
          message: `trade ${w.trades} of this vault within ${w.burstBlocks} burn blocks`,
          details: {
            trades: w.trades.toString(),
            burstBlocks: w.burstBlocks.toString(),
          },
        };
      case "QUIET_PERIOD":
        return {
          code: "TRADE_AFTER_QUIET",
          message: `this vault's first trade in ${w.blocksSince} burn blocks; the one before was at burn height ${w.lastTradeHeight}`,
          details: {
            lastTradeHeight: w.lastTradeHeight.toString(),
            blocksSince: w.blocksSince.toString(),
            quietBlocks: w.quietBlocks.toString(),
          },
        };
    }
  });
}

/** The alerts for one journal record. Updates `owner`'s tracked state. */
function eventAlerts(
  fields: Fields,
  thresholds: Thresholds,
  state: MonitorState,
  vaults: Readonly<Record<string, VaultRead>>,
  /** The record's burn height. */
  at: bigint,
  /** The owners' earlier trades, or `null` to skip the `TRADE_…` alerts. */
  trades: TradeHistory | null,
): { owner: string; raised: Raise[] } {
  const r = reader(fields);
  const event = r.text("event");
  const owner = r.principal("owner");
  const tracked = ownerState(state, owner);
  const one = (code: AlertCode, message: string, details: Details) => ({
    owner,
    raised: [{ code, message, details }],
  });

  switch (event) {
    case "deposit":
    case "withdraw": {
      const token = r.principal("token");
      const amount = r.uint("amount");
      const balance = r.uint("balance");
      tracked.balances[token] = balance.toString();
      return one(
        event === "deposit" ? "DEPOSIT" : "WITHDRAWAL",
        event === "deposit"
          ? `deposited ${amount} of ${token}; ledger balance ${balance}`
          : `withdrew ${amount} of ${token}; ledger balance ${balance}`,
        { token, amount: amount.toString(), balance: balance.toString() },
      );
    }
    case "set-agent":
    case "remove-agent":
    case "pause":
    case "unpause": {
      const agent = r.optionalPrincipal("agent");
      const paused = r.bool("paused");
      const details = { agent, paused };
      const flag = paused ? "paused" : "not paused";
      if (event === "set-agent") {
        return one(
          "AGENT_SET",
          `agent set to ${agent}; the vault is ${flag}`,
          details,
        );
      }
      if (event === "remove-agent") {
        return one("AGENT_REMOVED", "agent removed; no one can trade", details);
      }
      return event === "pause"
        ? one(
            "VAULT_PAUSED",
            `vault paused; agent ${agent} cannot trade`,
            details,
          )
        : one(
            "VAULT_UNPAUSED",
            `vault unpaused; agent ${agent} can trade`,
            details,
          );
    }
    case "set-policy": {
      const cooldown = r.uint("cooldown-blocks");
      const expiresAt = r.uint("expires-at");
      return one(
        "POLICY_SET",
        `policy set: cooldown ${cooldown} burn blocks, expires at burn height ${expiresAt}`,
        {
          cooldownBlocks: cooldown.toString(),
          expiresAt: expiresAt.toString(),
        },
      );
    }
    case "set-token-caps": {
      const token = r.principal("token");
      const maxPerTrade = r.uint("max-per-trade");
      const maxPerDay = r.uint("max-per-day");
      tracked.dayCaps[token] = maxPerDay.toString();
      return one(
        "TOKEN_CAPS_SET",
        `caps set for ${token}: ${maxPerTrade} per trade, ${maxPerDay} per 144 burn blocks`,
        {
          token,
          maxPerTrade: maxPerTrade.toString(),
          maxPerDay: maxPerDay.toString(),
        },
      );
    }
    case "set-price-bounds": {
      const slippage = r.uint("max-slippage-bps");
      const age = r.uint("max-price-age");
      return one(
        "PRICE_BOUNDS_SET",
        `price bounds set: at most ${slippage} bps below the oracle price, price at most ${age} ms old`,
        { maxSlippageBps: slippage.toString(), maxPriceAge: age.toString() },
      );
    }
    case "allow-token":
    case "allow-adapter": {
      const what = event === "allow-token" ? "token" : "adapter";
      const id = r.principal(what);
      const allowed = r.bool("allowed");
      return {
        owner,
        raised: [
          {
            code:
              what === "token"
                ? "TOKEN_ALLOW_CHANGED"
                : "ADAPTER_ALLOW_CHANGED",
            // Revoking narrows what the agent may do.
            severity: allowed ? "warning" : "info",
            message: `${what} ${id} ${allowed ? "allowed" : "revoked"}`,
            details: { [what]: id, allowed },
          },
        ],
      };
    }
    case "set-approval-threshold": {
      const token = r.principal("token");
      const threshold = r.optionalUint("threshold");
      const before = tracked.approvalThresholds[token];
      const previous = before === undefined ? null : BigInt(before);
      if (threshold === null) delete tracked.approvalThresholds[token];
      else tracked.approvalThresholds[token] = threshold.toString();
      // More of the agent's trades run without the owner: the band is gone,
      // or starts higher. Anything else narrows what the agent does alone.
      const change =
        threshold === null
          ? previous === null
            ? "unchanged"
            : "cleared"
          : previous === null
            ? "set"
            : threshold > previous
              ? "raised"
              : threshold < previous
                ? "lowered"
                : "unchanged";
      const loosened = change === "cleared" || change === "raised";
      const was = previous === null ? "none" : previous.toString();
      return {
        owner,
        raised: [
          {
            code: "APPROVAL_THRESHOLD_SET",
            severity: loosened ? "warning" : "info",
            message:
              threshold === null
                ? change === "cleared"
                  ? `approval threshold for ${token} cleared (was ${was}): the agent can sell any amount inside its caps without the owner`
                  : `approval threshold for ${token} cleared; none was set`
                : `approval threshold for ${token} ${change === "unchanged" ? "set again" : change} to ${threshold} (was ${was}): ` +
                  `a trade selling more needs the owner's approval`,
            details: {
              token,
              threshold: threshold === null ? null : threshold.toString(),
              previous: previous === null ? null : previous.toString(),
              change,
            },
          },
        ],
      };
    }
    case "request-swap":
    case "reject-swap":
    case "cancel-swap-request": {
      const agent = r.principal("agent");
      const adapter = r.principal("adapter");
      const tokenIn = r.principal("token-in");
      const tokenOut = r.principal("token-out");
      const amountIn = r.uint("amount-in");
      const minOut = r.uint("min-out");
      const requestedAt = r.uint("requested-at");
      const expiresAt = r.uint("expires-at");
      const details: Details = {
        agent,
        adapter,
        tokenIn,
        tokenOut,
        amountIn: amountIn.toString(),
        minOut: minOut.toString(),
        requestedAt: requestedAt.toString(),
        expiresAt: expiresAt.toString(),
      };
      const trade = `sell ${amountIn} of ${tokenIn} for at least ${minOut} of ${tokenOut} on ${adapter}`;
      if (event === "request-swap") {
        // The vault lets a new request overwrite only an expired one.
        const replaced = tracked.pending;
        tracked.pending = {
          agent,
          adapter,
          tokenIn,
          tokenOut,
          amountIn: amountIn.toString(),
          minOut: minOut.toString(),
          requestedAt: requestedAt.toString(),
          expiresAt: expiresAt.toString(),
          expiryReported: false,
        };
        return one(
          "SWAP_REQUESTED",
          `agent ${agent} asks to ${trade}: above the approval threshold, so it runs only ` +
            `if the owner approves by burn height ${expiresAt}` +
            (replaced === null
              ? ""
              : `; it replaces the request of burn height ${replaced.requestedAt}, which expired unanswered`),
          {
            ...details,
            replacedRequestedAt:
              replaced === null ? null : replaced.requestedAt,
          },
        );
      }
      tracked.pending = null;
      const expired = at > expiresAt;
      const which = `the request of burn height ${requestedAt} to ${trade}`;
      return event === "reject-swap"
        ? one(
            "SWAP_REQUEST_REJECTED",
            `the owner rejected ${which}${expired ? ", which had expired" : ""}`,
            { ...details, expired },
          )
        : one(
            "SWAP_REQUEST_CANCELLED",
            `agent ${agent} withdrew ${which}${expired ? ", which had expired" : ""}`,
            { ...details, expired },
          );
    }
    case "execute-swap":
    case "approve-swap": {
      const approved = event === "approve-swap";
      const requestedAt = approved ? r.uint("requested-at") : null;
      const agent = r.principal("agent");
      const adapter = r.principal("adapter");
      const tokenIn = r.principal("token-in");
      const tokenOut = r.principal("token-out");
      const amountIn = r.uint("amount-in");
      const minOut = r.uint("min-out");
      const amountOut = r.uint("amount-out");
      const dayTotal = r.uint("day-total");
      const floor = r.uint("min-out-floor");
      const oraclePrice = r.uint("oracle-price");
      const oracleTimestamp = r.uint("oracle-timestamp");
      tracked.balances[tokenIn] = r.uint("balance-in").toString();
      tracked.balances[tokenOut] = r.uint("balance-out").toString();
      // Approving runs the request and deletes it.
      if (approved) tracked.pending = null;

      const belowFloor = amountOut < floor || amountOut < minOut;
      // Whole basis points above the floor, rounded down. The contract never
      // computes a floor of zero.
      const aboveFloorBps =
        belowFloor || floor === 0n ? null : ((amountOut - floor) * BPS) / floor;
      const details: Details = {
        agent,
        adapter,
        tokenIn,
        tokenOut,
        amountIn: amountIn.toString(),
        minOut: minOut.toString(),
        amountOut: amountOut.toString(),
        minOutFloor: floor.toString(),
        aboveFloorBps: aboveFloorBps === null ? null : aboveFloorBps.toString(),
        dayTotal: dayTotal.toString(),
        oraclePrice: oraclePrice.toString(),
        oracleTimestamp: oracleTimestamp.toString(),
        approved,
        requestedAt: requestedAt === null ? null : requestedAt.toString(),
      };
      const sold = `${amountIn} of ${tokenIn} for ${amountOut} of ${tokenOut}`;
      const raised: Raise[] = [
        {
          code: "SWAP",
          message:
            (approved
              ? `the owner approved agent ${agent}'s request of burn height ${requestedAt}: sold ${sold} on ${adapter}; `
              : `agent ${agent} sold ${sold} on ${adapter}; `) +
            (aboveFloorBps === null
              ? `the floor was ${floor}`
              : `${aboveFloorBps} bps above the floor ${floor}`),
          details,
        },
      ];
      if (belowFloor) {
        raised.push({
          code: "SWAP_BELOW_FLOOR",
          message:
            `a swap settled at ${amountOut} of ${tokenOut}, below its min-out ${minOut} ` +
            `or the oracle floor ${floor}: the contract should have refused it`,
          details,
        });
      } else if (
        floor > 0n &&
        (amountOut - floor) * BPS <= thresholds.nearFloorBps * floor
      ) {
        raised.push({
          code: "SWAP_NEAR_FLOOR",
          message:
            `a swap of ${sold} settled ${aboveFloorBps} bps above the floor ${floor}, ` +
            `within ${thresholds.nearFloorBps} bps of it`,
          details,
        });
      }
      // The cap the journal last showed; the vault read only if the monitor
      // never saw it set.
      const cap =
        tracked.dayCaps[tokenIn] !== undefined
          ? BigInt(tracked.dayCaps[tokenIn])
          : (vaults[owner]?.policy.caps[tokenIn]?.maxPerDay ?? 0n);
      if (cap > 0n && dayTotal * BPS >= cap * thresholds.dayCapWarnBps) {
        raised.push({
          code: "DAY_CAP_NEAR",
          message:
            `${dayTotal} of ${tokenIn} sold in the current 144-block window, ` +
            `${(dayTotal * BPS) / cap} bps of the cap ${cap}`,
          details: {
            token: tokenIn,
            dayTotal: dayTotal.toString(),
            maxPerDay: cap.toString(),
            usedBps: ((dayTotal * BPS) / cap).toString(),
          },
        });
      }
      if (trades !== null) {
        raised.push(
          ...unusualTrade(
            trades.get(owner) ?? [],
            { owner, tokenIn, tokenOut, amountIn, burnHeight: at },
            thresholds,
          ),
        );
      }
      return { owner, raised };
    }
    default:
      return one(
        "UNKNOWN_EVENT",
        `journal event "${event}" is not one the monitor knows`,
        { event },
      );
  }
}

/** The functions an agent calls about an owner's vault, named first. */
const OWNER_FIRST: readonly string[] = [
  "execute-swap",
  "request-swap",
  "cancel-swap-request",
];

/**
 * Whose vault a refused call was about, and the vault's error code and its
 * constant when the refusal was an `(err uN)`.
 */
export function refusalFacts(call: RefusedCall): {
  owner: string;
  errorCode: string | null;
  errorName: string | null;
} {
  // The agent's functions name the owner in their first argument; every
  // other function acts on the sender's own vault.
  let owner = call.sender;
  const first = call.args[0];
  if (OWNER_FIRST.includes(call.functionName) && first !== undefined) {
    try {
      owner = principalOf(first);
    } catch {
      // Keep the sender.
    }
  }
  const errorCode =
    call.reason === "response" &&
    call.result.type === "err" &&
    call.result.value.type === "uint"
      ? BigInt(call.result.value.value).toString()
      : null;
  return {
    owner,
    errorCode,
    errorName:
      errorCode === null ? null : (VAULT_ERROR_NAMES[errorCode] ?? null),
  };
}

/** The one alert for a refused call. */
function refusalAlert(call: RefusedCall, index: number): Alert {
  const { owner, errorCode: error, errorName: name } = refusalFacts(call);
  const what =
    call.reason === "post-condition"
      ? "was aborted by a post-condition"
      : error === null
        ? `was refused with ${Cl.prettyPrint(call.result)}`
        : `was refused with (err u${error}) ${name ?? "unknown code"}`;
  return {
    id: `refusal:${index}`,
    code: "CALL_REFUSED",
    severity:
      error === null
        ? ALERT_CODES.CALL_REFUSED
        : CRITICAL_REFUSALS.includes(error)
          ? "critical"
          : ROUTINE_REFUSALS.includes(error)
            ? "info"
            : ALERT_CODES.CALL_REFUSED,
    owner,
    burnHeight: call.burnHeight.toString(),
    message: `${call.functionName} by ${call.sender} ${what}`,
    details: {
      function: call.functionName,
      sender: call.sender,
      reason: call.reason,
      errorCode: error,
      errorName: name,
      txId: call.txId,
    },
  };
}

/** The lasting conditions true of one owner's vault now, with their text. */
function levels(
  read: VaultRead,
  thresholds: Thresholds,
  burnHeight: bigint,
  blockTimeMs: bigint,
): Map<LevelCode, { message: string; details: Details }> {
  const out = new Map<LevelCode, { message: string; details: Details }>();
  const agent = read.vault.agent;
  const funded = Object.values(read.balances).some((b) => b > 0n);
  // Nothing can be traded: no agent, a paused vault or an empty ledger.
  if (agent === null || read.vault.paused || !funded) return out;

  const { expiresAt } = read.policy;
  const policy = {
    expiresAt: expiresAt.toString(),
    burnHeight: burnHeight.toString(),
  };
  if (burnHeight > expiresAt) {
    out.set("POLICY_EXPIRED", {
      message:
        expiresAt === 0n
          ? `agent ${agent} is set but no policy is: it cannot trade`
          : `the policy expired at burn height ${expiresAt}: agent ${agent} cannot trade`,
      details: policy,
    });
  } else if (expiresAt - burnHeight <= thresholds.expiryWarnBlocks) {
    out.set("POLICY_EXPIRING", {
      message: `the policy expires in ${expiresAt - burnHeight} burn blocks, at burn height ${expiresAt}`,
      details: { ...policy, blocksLeft: (expiresAt - burnHeight).toString() },
    });
  }

  const { maxPriceAge, maxSlippageBps } = read.priceBounds;
  // Unset bounds already stop the agent, whatever the oracle says.
  if (maxPriceAge === 0n || maxSlippageBps === 0n) return out;
  const price = read.oracle.price;
  if (price === null || price.value === 0n) {
    out.set("ORACLE_UNAVAILABLE", {
      message:
        price === null
          ? `the oracle returned an error: agent ${agent} cannot trade`
          : `the oracle's price is 0: agent ${agent} cannot trade`,
      details: { reason: price === null ? "error" : "zero" },
    });
    return out;
  }
  // The contract counts a timestamp ahead of the block the same way.
  const age =
    price.timestamp <= blockTimeMs
      ? blockTimeMs - price.timestamp
      : price.timestamp - blockTimeMs;
  const details = {
    oraclePrice: price.value.toString(),
    oracleTimestamp: price.timestamp.toString(),
    ageMs: age.toString(),
    maxPriceAge: maxPriceAge.toString(),
  };
  if (age > maxPriceAge) {
    out.set("ORACLE_STALE", {
      message: `the oracle price is ${age} ms from block time, past max-price-age ${maxPriceAge}: agent ${agent} cannot trade`,
      details,
    });
  } else if (age * BPS >= maxPriceAge * thresholds.oracleAgeWarnBps) {
    out.set("ORACLE_AGING", {
      message: `the oracle price is ${age} ms from block time, ${(age * BPS) / maxPriceAge} bps of max-price-age ${maxPriceAge}`,
      details,
    });
  }
  return out;
}

/**
 * One poll's alerts and the next state. Journal alerts come first, in
 * journal order, then refusals, then lasting conditions by owner. A lasting
 * condition is alerted once when it becomes true and again only after it has
 * been false at a poll. Does not change its inputs.
 */
export function evaluate(input: EvaluateInput): EvaluateResult {
  const { thresholds, events, refusals, vaults, burnHeight, blockTimeMs } =
    input;
  const state = copyState(input.state);
  const alerts: Alert[] = [];
  let trades: TradeHistory | null = null;
  if (input.history !== undefined) {
    trades = new Map();
    for (const [i, record] of input.history.entries()) {
      fileTrade(trades, record, i);
    }
  }

  events.forEach((record, k) => {
    const index = input.state.cursor.events + k;
    const at = record.burnHeight.toString();
    let owner: string | null;
    let raised: Raise[];
    try {
      if (record.value.type !== "tuple") {
        throw new Error(`a ${record.value.type}, not a tuple`);
      }
      ({ owner, raised } = eventAlerts(
        record.value.value,
        thresholds,
        state,
        vaults,
        record.burnHeight,
        trades,
      ));
    } catch (e) {
      owner = recordOwner(record);
      raised = [
        {
          code: "UNKNOWN_EVENT",
          message: `journal record ${index} could not be read: ${e instanceof Error ? e.message : String(e)}`,
          details: { event: null },
        },
      ];
    }
    for (const r of raised) {
      alerts.push({
        id: `event:${index}:${r.code}`,
        code: r.code,
        severity: r.severity ?? ALERT_CODES[r.code],
        owner,
        burnHeight: at,
        message: r.message,
        details: r.details,
      });
    }
    // After its own alerts: a trade is compared with the ones before it.
    if (trades !== null) fileTrade(trades, record, index);
  });
  state.cursor.events += events.length;

  refusals.forEach((call, k) => {
    alerts.push(refusalAlert(call, input.state.cursor.refusals + k));
  });
  state.cursor.refusals += refusals.length;

  for (const owner of Object.keys(state.owners).sort()) {
    const tracked = state.owners[owner]!;
    // From the journal alone, so for every vault, read or not, and whether
    // or not an agent can trade: once for each request left unanswered.
    const request = tracked.pending;
    if (
      request !== null &&
      !request.expiryReported &&
      burnHeight > BigInt(request.expiresAt)
    ) {
      request.expiryReported = true;
      alerts.push({
        id: `level:${owner}:SWAP_REQUEST_EXPIRED:${request.requestedAt}`,
        code: "SWAP_REQUEST_EXPIRED",
        severity: ALERT_CODES.SWAP_REQUEST_EXPIRED,
        owner,
        burnHeight: burnHeight.toString(),
        message:
          `agent ${request.agent}'s request to sell ${request.amountIn} of ${request.tokenIn} ` +
          `expired unanswered at burn height ${request.expiresAt}: it can no longer be approved`,
        details: {
          agent: request.agent,
          adapter: request.adapter,
          tokenIn: request.tokenIn,
          tokenOut: request.tokenOut,
          amountIn: request.amountIn,
          minOut: request.minOut,
          requestedAt: request.requestedAt,
          expiresAt: request.expiresAt,
        },
      });
    }
    const read = vaults[owner];
    // Not read this poll: leave what was active as it was.
    if (read === undefined) continue;
    const now = levels(read, thresholds, burnHeight, blockTimeMs);
    for (const code of LEVEL_CODES) {
      const level = now.get(code);
      if (level === undefined || tracked.active.includes(code)) continue;
      alerts.push({
        id: `level:${owner}:${code}:${burnHeight}`,
        code,
        severity: ALERT_CODES[code],
        owner,
        burnHeight: burnHeight.toString(),
        message: level.message,
        details: level.details,
      });
    }
    tracked.active = LEVEL_CODES.filter((code) => now.has(code));
  }

  if (input.ledgers !== undefined) {
    // Checked for every vault, traded or not: a shortfall means some owner's
    // withdraw will fail, which pausing does not change.
    const short: string[] = [];
    for (const token of Object.keys(input.ledgers).sort()) {
      const { held, owed } = input.ledgers[token]!;
      if (held >= owed) continue;
      short.push(token);
      if (state.shortTokens.includes(token)) continue;
      alerts.push({
        id: `level:vault:LEDGER_SHORTFALL:${token}:${burnHeight}`,
        code: "LEDGER_SHORTFALL",
        severity: ALERT_CODES.LEDGER_SHORTFALL,
        owner: null,
        burnHeight: burnHeight.toString(),
        message: `the vault holds ${held} of ${token} but its ledgers owe ${owed}: ${owed - held} short, so not every owner can withdraw`,
        details: {
          token,
          held: held.toString(),
          owed: owed.toString(),
          shortBy: (owed - held).toString(),
        },
      });
    }
    state.shortTokens = short;
  }

  return { alerts, state };
}
