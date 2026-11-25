import { Cl, type ClarityValue } from "@stacks/transactions";

// The vault's journal as plain values. A chain reader (the MCP server's
// `KeelioChain.vaultEvents`, the dashboard's `journal`) hands over print tuples
// as Clarity values; everything in the SDK that replays the journal works on
// the parsed form below. Nothing here reads a chain.

/**
 * One print event of the vault contract, as a chain reader returns it. The
 * `JournalRecord` of `@keelio/mcp`, the dashboard and the example agent are all
 * assignable to it.
 */
export interface JournalRecord {
  burnHeight: bigint;
  /** The print tuple. */
  value: ClarityValue;
  /** The transaction that printed it, when the reader knows it. */
  txId?: string | null;
}

/**
 * A journal field as a plain value: a `uint` or `int` is a `bigint`, a
 * principal or string is a `string`, an optional is its inner value or
 * `null` for `none`.
 */
export type JournalField = bigint | string | boolean | null;

/** One journal event, parsed. */
export interface JournalEvent {
  /** The record's position in the array given to `parseJournal`. */
  index: number;
  burnHeight: bigint;
  /** The transaction id, or `null` when the reader gave none. */
  txId: string | null;
  /** The contract's event name, for example `"execute-swap"`. */
  event: string;
  /**
   * The tuple's other fields under the contract's kebab-case names. A field
   * of a type `JournalField` cannot hold (a list, a tuple, a buffer) is left
   * out.
   */
  fields: Readonly<Record<string, JournalField>>;
}

/** Where an event sits in the journal: enough to find it again. */
export interface EventRef {
  /** `JournalEvent.index`. */
  index: number;
  burnHeight: bigint;
  txId: string | null;
}

/**
 * The fields of one trade: an `execute-swap` event, or an `approve-swap`
 * event, which carries the same fields for a trade the owner approved
 * (docs/events.md). An approved trade prints no `execute-swap`.
 */
export interface SwapEvent {
  ref: EventRef;
  owner: string;
  agent: string;
  adapter: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  minOut: bigint;
  amountOut: bigint;
  balanceIn: bigint;
  balanceOut: bigint;
  dayTotal: bigint;
  oraclePrice: bigint;
  oracleTimestamp: bigint;
  minOutFloor: bigint;
  /**
   * `true` for an `approve-swap`: the agent requested the trade and the
   * owner approved it. `false` for an `execute-swap`, sent by the agent
   * alone.
   */
  approved: boolean;
  /**
   * The burn height of the request an approved trade ran, or `null` for a
   * trade the agent sent alone.
   */
  requestedAt: bigint | null;
}

/** The fields of one `request-swap`, `reject-swap` or `cancel-swap-request`. */
export interface SwapRequestEvent {
  ref: EventRef;
  /** What happened to the request at `ref`. */
  kind: "requested" | "rejected" | "cancelled";
  owner: string;
  /** The agent that made the request. */
  agent: string;
  adapter: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  minOut: bigint;
  requestedAt: bigint;
  expiresAt: bigint;
}

function decodeField(value: ClarityValue): JournalField | undefined {
  switch (value.type) {
    case "uint":
    case "int":
      return BigInt(value.value);
    case "address":
    case "contract":
      return Cl.prettyPrint(value).replace(/^'/, "");
    case "true":
      return true;
    case "false":
      return false;
    case "none":
      return null;
    case "some":
      return decodeField(value.value);
    case "ascii":
    case "utf8":
      return value.value;
    default:
      return undefined;
  }
}

/**
 * Parses one record, or returns `null` for a value that is not a tuple with a
 * string `event` field. Never throws.
 */
export function parseJournalRecord(
  record: JournalRecord,
  index: number,
): JournalEvent | null {
  const { value, burnHeight } = record;
  if (value.type !== "tuple") return null;
  const name = value.value.event;
  if (name === undefined || (name.type !== "ascii" && name.type !== "utf8")) {
    return null;
  }
  const fields: Record<string, JournalField> = {};
  for (const [key, v] of Object.entries(value.value)) {
    if (key === "event") continue;
    const decoded = decodeField(v);
    if (decoded !== undefined) fields[key] = decoded;
  }
  return {
    index,
    burnHeight,
    txId: record.txId ?? null,
    event: name.value,
    fields,
  };
}

/**
 * Parses the journal, keeping its order. A record that is not an event tuple
 * is skipped, and each event keeps the index its record had, so an index
 * always points back into `records`.
 */
export function parseJournal(
  records: readonly JournalRecord[],
): JournalEvent[] {
  const events: JournalEvent[] = [];
  records.forEach((record, index) => {
    const event = parseJournalRecord(record, index);
    if (event !== null) events.push(event);
  });
  return events;
}

export function eventRef(event: JournalEvent): EventRef {
  return { index: event.index, burnHeight: event.burnHeight, txId: event.txId };
}

/** The field as a `bigint`, or `undefined` when it is missing or not one. */
export function uintField(
  event: JournalEvent,
  name: string,
): bigint | undefined {
  const v = Object.hasOwn(event.fields, name) ? event.fields[name] : undefined;
  return typeof v === "bigint" ? v : undefined;
}

/** The field as a string, or `undefined` when it is missing or not one. */
export function textField(
  event: JournalEvent,
  name: string,
): string | undefined {
  const v = Object.hasOwn(event.fields, name) ? event.fields[name] : undefined;
  return typeof v === "string" ? v : undefined;
}

/** The field as a boolean, or `undefined` when it is missing or not one. */
export function boolField(
  event: JournalEvent,
  name: string,
): boolean | undefined {
  const v = Object.hasOwn(event.fields, name) ? event.fields[name] : undefined;
  return typeof v === "boolean" ? v : undefined;
}

/**
 * The event as a trade, or `null` when it is neither an `execute-swap` nor
 * an `approve-swap`, or lacks one of that event's fields.
 */
export function swapEvent(event: JournalEvent): SwapEvent | null {
  const approved = event.event === "approve-swap";
  if (!approved && event.event !== "execute-swap") return null;
  const text = (name: string) => textField(event, name);
  const uint = (name: string) => uintField(event, name);
  const swap = {
    ref: eventRef(event),
    owner: text("owner"),
    agent: text("agent"),
    adapter: text("adapter"),
    tokenIn: text("token-in"),
    tokenOut: text("token-out"),
    amountIn: uint("amount-in"),
    minOut: uint("min-out"),
    amountOut: uint("amount-out"),
    balanceIn: uint("balance-in"),
    balanceOut: uint("balance-out"),
    dayTotal: uint("day-total"),
    oraclePrice: uint("oracle-price"),
    oracleTimestamp: uint("oracle-timestamp"),
    minOutFloor: uint("min-out-floor"),
    approved,
    requestedAt: approved ? uint("requested-at") : null,
  };
  if (Object.values(swap).some((v) => v === undefined)) return null;
  return swap as SwapEvent;
}

const REQUEST_KINDS: Readonly<Record<string, SwapRequestEvent["kind"]>> = {
  "request-swap": "requested",
  "reject-swap": "rejected",
  "cancel-swap-request": "cancelled",
};

/**
 * The event as a `request-swap`, `reject-swap` or `cancel-swap-request`, or
 * `null` when it has another name or lacks one of the request's fields. An
 * approved request is a trade: see `swapEvent`.
 */
export function swapRequestEvent(event: JournalEvent): SwapRequestEvent | null {
  const kind = Object.hasOwn(REQUEST_KINDS, event.event)
    ? REQUEST_KINDS[event.event]
    : undefined;
  if (kind === undefined) return null;
  const text = (name: string) => textField(event, name);
  const uint = (name: string) => uintField(event, name);
  const request = {
    ref: eventRef(event),
    kind,
    owner: text("owner"),
    agent: text("agent"),
    adapter: text("adapter"),
    tokenIn: text("token-in"),
    tokenOut: text("token-out"),
    amountIn: uint("amount-in"),
    minOut: uint("min-out"),
    requestedAt: uint("requested-at"),
    expiresAt: uint("expires-at"),
  };
  if (Object.values(request).some((v) => v === undefined)) return null;
  return request as SwapRequestEvent;
}

/** `T` with every `bigint` turned into its decimal string. */
export type Jsonified<T> = T extends bigint
  ? string
  : T extends readonly (infer U)[]
    ? Jsonified<U>[]
    : T extends object
      ? { [K in keyof T]: Jsonified<T[K]> }
      : T;

/**
 * A deep copy of `value` that `JSON.stringify` accepts: every `bigint`
 * becomes its decimal string, as in a built `VaultCall`. Arrays and plain
 * objects are copied; other values are returned as they are.
 */
export function toJsonSafe<T>(value: T): Jsonified<T> {
  const walk = (v: unknown): unknown => {
    if (typeof v === "bigint") return v.toString();
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === "object" && v !== null) {
      return Object.fromEntries(
        Object.entries(v).map(([key, inner]) => [key, walk(inner)]),
      );
    }
    return v;
  };
  return walk(value) as Jsonified<T>;
}
