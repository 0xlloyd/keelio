import type { JournalRecord } from "@keelio/mcp";
import {
  parseJournalRecord,
  type JournalEvent,
  type VaultRead,
} from "@keelio/sdk";
import { Cl } from "@stacks/transactions";
import { VAULT_ERROR_WORDS, type Alert, type Severity } from "./alerts.js";
import type { RefusedCall } from "./chain.js";
import { TRADE_EVENTS, refusalFacts } from "./evaluate.js";

// The owner digest: what happened in each owner's vault over a range of burn
// heights, and where the vault stands now, in plain words. Pure, like
// `evaluate`: no clock, no network, no file. The same input always gives the
// same digest. The monitor writes it out; it sends it nowhere.

export interface DigestInput {
  /** The first and last burn height of the range, both included. */
  fromHeight: bigint;
  toHeight: bigint;
  /** The burn height the vaults were read at. */
  burnHeight: bigint;
  /**
   * The journal, oldest first. Trades and requests are counted from the
   * records inside the range. Records outside it are used only to find the
   * request that is still stored, so pass the whole journal.
   */
  events: readonly JournalRecord[];
  /** The refused calls, oldest first. Those outside the range are ignored. */
  refusals: readonly RefusedCall[];
  /**
   * Each owner's vault as `readVault` returned it at `burnHeight`. An owner
   * with no entry gets no caps, agent, pause or policy lines.
   */
  vaults: Readonly<Record<string, VaultRead>>;
  /** The alerts raised. Those outside the range are ignored. */
  alerts: readonly Alert[];
}

/** One alert, as the digest repeats it. */
export interface DigestAlert {
  code: Alert["code"];
  burnHeight: string;
  message: string;
}

export type AlertsBySeverity = Record<Severity, DigestAlert[]>;

/** The request the vault still stores for an owner. */
export interface DigestRequest {
  agent: string;
  adapter: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  minOut: string;
  requestedAt: string;
  /** The last burn height the owner can approve at. */
  expiresAt: string;
  /** `waiting` while it can still be approved at `burnHeight`. */
  status: "waiting" | "expired";
  /** Burn blocks from `burnHeight` to `expiresAt`; `"0"` once expired. */
  blocksLeft: string;
}

export interface DigestRefusal {
  /** The vault's code without its `u`, or `null` when there was none. */
  errorCode: string | null;
  /** The code's constant in docs/errors.md, or `null`. */
  errorName: string | null;
  /** The code in plain words, as docs/errors.md gives it. */
  words: string;
  count: number;
  /** The functions refused for this reason, sorted, without repeats. */
  functions: string[];
}

export interface DigestCap {
  token: string;
  /** `"0"` when the owner set no cap: the agent cannot sell this token. */
  maxPerDay: string;
  /** Sold in the 144 burn blocks up to `burnHeight`. */
  used: string;
  left: string;
}

/** JSON-safe. Amounts and heights are decimal strings of base units. */
export interface OwnerDigest {
  owner: string;
  trades: {
    count: number;
    /** How many of them the owner approved (`approve-swap`). */
    approved: number;
    /** Totals by input token, sorted by token id. */
    sold: { token: string; trades: number; amount: string }[];
    /** Totals by output token, sorted by token id. */
    bought: { token: string; amount: string }[];
  };
  /** Approval requests in the range, by how the journal shows them. */
  requests: {
    made: number;
    approved: number;
    rejected: number;
    withdrawn: number;
  };
  /** The request the vault stores now, or `null`. */
  request: DigestRequest | null;
  refused: { count: number; reasons: DigestRefusal[] };
  /** Where the vault stands at `burnHeight`, or `null` when it was not read. */
  vault: {
    agent: string | null;
    paused: boolean;
    /** One entry per token read, in the order of the monitor's config. */
    caps: DigestCap[];
    policy: {
      /** `"0"` when no policy was ever set. */
      expiresAt: string;
      expired: boolean;
      /** Burn blocks the agent can still trade in after this one. */
      blocksLeft: string;
    };
  } | null;
  alerts: AlertsBySeverity;
  /** The same facts in plain words, one line each. */
  lines: string[];
}

export interface Digest {
  fromHeight: string;
  toHeight: string;
  burnHeight: string;
  /** Sorted by owner. Empty when no vault was read and nothing happened. */
  owners: OwnerDigest[];
  /** Alerts in the range that name no owner, such as `LEDGER_SHORTFALL`. */
  vaultAlerts: AlertsBySeverity;
}

function text(event: JournalEvent, name: string): string | null {
  const v = Object.hasOwn(event.fields, name) ? event.fields[name] : undefined;
  return typeof v === "string" ? v : null;
}

function uint(event: JournalEvent, name: string): bigint | null {
  const v = Object.hasOwn(event.fields, name) ? event.fields[name] : undefined;
  return typeof v === "bigint" ? v : null;
}

function plural(n: number | bigint, one: string, many = `${one}s`): string {
  return `${n} ${BigInt(n) === 1n ? one : many}`;
}

function bySeverity(): AlertsBySeverity {
  return { critical: [], warning: [], info: [] };
}

interface StoredRequest {
  agent: string;
  adapter: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  minOut: bigint;
  requestedAt: bigint;
  expiresAt: bigint;
}

function storedRequest(event: JournalEvent): StoredRequest | null {
  const request = {
    agent: text(event, "agent"),
    adapter: text(event, "adapter"),
    tokenIn: text(event, "token-in"),
    tokenOut: text(event, "token-out"),
    amountIn: uint(event, "amount-in"),
    minOut: uint(event, "min-out"),
    requestedAt: uint(event, "requested-at"),
    expiresAt: uint(event, "expires-at"),
  };
  return Object.values(request).some((v) => v === null)
    ? null
    : (request as StoredRequest);
}

interface Working {
  trades: number;
  approved: number;
  sold: Map<string, { trades: number; amount: bigint }>;
  bought: Map<string, bigint>;
  requests: OwnerDigest["requests"];
  stored: StoredRequest | null;
  refusals: number;
  reasons: Map<string, DigestRefusal>;
  alerts: AlertsBySeverity;
}

function refusalWords(call: RefusedCall, code: string | null): string {
  if (call.reason === "post-condition") return "Stopped by a post-condition";
  if (code === null) return `Refused with ${Cl.prettyPrint(call.result)}`;
  return VAULT_ERROR_WORDS[code] ?? `Refused with an unknown code`;
}

/** The plain-words lines for one owner, from the digest's own fields. */
function ownerLines(
  d: Omit<OwnerDigest, "lines">,
  burnHeight: bigint,
): string[] {
  const lines: string[] = [];
  const { trades, requests, request, refused, vault, alerts } = d;

  if (trades.count === 0) {
    lines.push("Trades: none.");
  } else {
    lines.push(
      `Trades: ${trades.count}, of which ${trades.approved} approved by the owner.`,
    );
    for (const s of trades.sold) {
      lines.push(
        `  Sold ${s.amount} of ${s.token} in ${plural(s.trades, "trade")}.`,
      );
    }
    for (const b of trades.bought) {
      lines.push(`  Bought ${b.amount} of ${b.token}.`);
    }
  }

  if (
    requests.made + requests.approved + requests.rejected + requests.withdrawn >
    0
  ) {
    lines.push(
      `Approval requests: ${requests.made} made, ${requests.approved} approved, ` +
        `${requests.rejected} rejected, ${requests.withdrawn} withdrawn by the agent.`,
    );
  }
  if (request !== null) {
    const ask =
      `agent ${request.agent} asks to sell ${request.amountIn} of ${request.tokenIn} ` +
      `for at least ${request.minOut} of ${request.tokenOut}`;
    lines.push(
      request.status === "waiting"
        ? `Waiting for the owner's approval: ${ask}. It can be approved up to burn height ` +
            `${request.expiresAt}, ${plural(BigInt(request.blocksLeft), "burn block")} from now.`
        : `Expired without an answer: ${ask}. It could be approved up to burn height ` +
            `${request.expiresAt} and can no longer run.`,
    );
  } else {
    lines.push("Waiting for the owner's approval: nothing.");
  }

  if (refused.count === 0) {
    lines.push("Calls refused: none.");
  } else {
    lines.push(`Calls refused: ${refused.count}.`);
    for (const r of refused.reasons) {
      const code =
        r.errorCode === null
          ? ""
          : ` (u${r.errorCode}${r.errorName === null ? "" : ` ${r.errorName}`})`;
      lines.push(
        `  ${r.count} × ${r.words}${code}: ${r.functions.join(", ")}.`,
      );
    }
  }

  if (vault === null) {
    lines.push("The vault was not read: no caps, agent or policy to report.");
  } else {
    lines.push("Day caps, over the last 144 burn blocks:");
    for (const cap of vault.caps) {
      lines.push(
        cap.maxPerDay === "0"
          ? `  ${cap.token}: no cap set, so the agent cannot sell it.`
          : `  ${cap.token}: ${cap.used} of ${cap.maxPerDay} used, ${cap.left} left.`,
      );
    }
    lines.push(
      vault.agent === null
        ? "Agent: none. No one can trade."
        : `Agent: ${vault.agent}.`,
    );
    lines.push(
      vault.paused ? "The vault is paused." : "The vault is not paused.",
    );
    const { expiresAt, expired, blocksLeft } = vault.policy;
    lines.push(
      expiresAt === "0"
        ? "Policy: none set. The agent cannot trade."
        : expired
          ? `Policy: expired at burn height ${expiresAt}, ` +
            `${plural(burnHeight - BigInt(expiresAt), "burn block")} ago. The agent cannot trade.`
          : `Policy: expires at burn height ${expiresAt}, ${plural(BigInt(blocksLeft), "burn block")} from now.`,
    );
  }

  lines.push(...alertLines(alerts));
  return lines;
}

/** Critical and warning alerts in full; info alerts counted by code. */
function alertLines(alerts: AlertsBySeverity): string[] {
  const total =
    alerts.critical.length + alerts.warning.length + alerts.info.length;
  if (total === 0) return ["Alerts: none."];
  const lines = [
    `Alerts: ${alerts.critical.length} critical, ${alerts.warning.length} warning, ${alerts.info.length} info.`,
  ];
  for (const severity of ["critical", "warning"] as const) {
    for (const a of alerts[severity]) {
      lines.push(
        `  ${severity}, burn height ${a.burnHeight}, ${a.code}: ${a.message}`,
      );
    }
  }
  if (alerts.info.length > 0) {
    const counts = new Map<string, number>();
    for (const a of alerts.info) {
      counts.set(a.code, (counts.get(a.code) ?? 0) + 1);
    }
    lines.push(
      `  info: ${[...counts]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([code, n]) => `${n} ${code}`)
        .join(", ")}.`,
    );
  }
  return lines;
}

/**
 * The digest for a range of burn heights: one entry per owner that has a
 * vault read, a journal record, a refused call or an alert in the range, or
 * a request still stored. Does not change its inputs, reads no clock, and
 * gives the same digest for the same input.
 */
export function digest(input: DigestInput): Digest {
  const { fromHeight, toHeight, burnHeight, vaults } = input;
  const inRange = (height: bigint) =>
    height >= fromHeight && height <= toHeight;
  const working = new Map<string, Working>();
  const of = (owner: string): Working => {
    let w = working.get(owner);
    if (w === undefined) {
      w = {
        trades: 0,
        approved: 0,
        sold: new Map(),
        bought: new Map(),
        requests: { made: 0, approved: 0, rejected: 0, withdrawn: 0 },
        stored: null,
        refusals: 0,
        reasons: new Map(),
        alerts: bySeverity(),
      };
      working.set(owner, w);
    }
    return w;
  };
  for (const owner of Object.keys(vaults)) of(owner);

  // The stored request is followed through the whole journal: one made
  // before the range can still be waiting.
  const stored = new Map<string, StoredRequest | null>();
  input.events.forEach((record, index) => {
    const event = parseJournalRecord(record, index);
    if (event === null) return;
    const owner = text(event, "owner");
    if (owner === null) return;
    const counted = inRange(event.burnHeight);
    if (counted) of(owner);
    const setStored = (request: StoredRequest | null) => {
      stored.set(owner, request);
    };
    if (TRADE_EVENTS.includes(event.event)) {
      const approved = event.event === "approve-swap";
      if (approved) setStored(null);
      if (!counted) return;
      const w = of(owner);
      const tokenIn = text(event, "token-in");
      const tokenOut = text(event, "token-out");
      const amountIn = uint(event, "amount-in");
      const amountOut = uint(event, "amount-out");
      // A trade record the monitor cannot read raises UNKNOWN_EVENT instead.
      if (
        tokenIn === null ||
        tokenOut === null ||
        amountIn === null ||
        amountOut === null
      ) {
        return;
      }
      w.trades += 1;
      if (approved) {
        w.approved += 1;
        w.requests.approved += 1;
      }
      const sold = w.sold.get(tokenIn) ?? { trades: 0, amount: 0n };
      w.sold.set(tokenIn, {
        trades: sold.trades + 1,
        amount: sold.amount + amountIn,
      });
      w.bought.set(tokenOut, (w.bought.get(tokenOut) ?? 0n) + amountOut);
    } else if (event.event === "request-swap") {
      setStored(storedRequest(event));
      if (counted) of(owner).requests.made += 1;
    } else if (event.event === "reject-swap") {
      setStored(null);
      if (counted) of(owner).requests.rejected += 1;
    } else if (event.event === "cancel-swap-request") {
      setStored(null);
      if (counted) of(owner).requests.withdrawn += 1;
    }
  });
  for (const [owner, request] of stored) {
    if (request !== null) of(owner).stored = request;
  }

  for (const call of input.refusals) {
    if (!inRange(call.burnHeight)) continue;
    const { owner, errorCode, errorName } = refusalFacts(call);
    const w = of(owner);
    w.refusals += 1;
    const words = refusalWords(call, errorCode);
    const key = errorCode ?? words;
    const reason = w.reasons.get(key) ?? {
      errorCode,
      errorName,
      words,
      count: 0,
      functions: [],
    };
    reason.count += 1;
    if (!reason.functions.includes(call.functionName)) {
      reason.functions.push(call.functionName);
      reason.functions.sort();
    }
    w.reasons.set(key, reason);
  }

  const vaultAlerts = bySeverity();
  for (const alert of input.alerts) {
    if (!inRange(BigInt(alert.burnHeight))) continue;
    const entry: DigestAlert = {
      code: alert.code,
      burnHeight: alert.burnHeight,
      message: alert.message,
    };
    (alert.owner === null ? vaultAlerts : of(alert.owner).alerts)[
      alert.severity
    ].push(entry);
  }

  const sorted = <T>(map: Map<string, T>): [string, T][] =>
    [...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const owners = sorted(working).map(([owner, w]): OwnerDigest => {
    const read = vaults[owner];
    const request = w.stored;
    const body: Omit<OwnerDigest, "lines"> = {
      owner,
      trades: {
        count: w.trades,
        approved: w.approved,
        sold: sorted(w.sold).map(([token, s]) => ({
          token,
          trades: s.trades,
          amount: s.amount.toString(),
        })),
        bought: sorted(w.bought).map(([token, amount]) => ({
          token,
          amount: amount.toString(),
        })),
      },
      requests: w.requests,
      request:
        request === null
          ? null
          : {
              agent: request.agent,
              adapter: request.adapter,
              tokenIn: request.tokenIn,
              tokenOut: request.tokenOut,
              amountIn: request.amountIn.toString(),
              minOut: request.minOut.toString(),
              requestedAt: request.requestedAt.toString(),
              expiresAt: request.expiresAt.toString(),
              status: burnHeight <= request.expiresAt ? "waiting" : "expired",
              blocksLeft: (burnHeight <= request.expiresAt
                ? request.expiresAt - burnHeight
                : 0n
              ).toString(),
            },
      refused: { count: w.refusals, reasons: [...w.reasons.values()] },
      vault:
        read === undefined
          ? null
          : {
              agent: read.vault.agent,
              paused: read.vault.paused,
              caps: Object.keys(read.balances).map((token) => {
                const cap = read.policy.caps[token]?.maxPerDay ?? 0n;
                const used = read.usage.dayTotals[token] ?? 0n;
                return {
                  token,
                  maxPerDay: cap.toString(),
                  used: used.toString(),
                  left: (cap > used ? cap - used : 0n).toString(),
                };
              }),
              policy: {
                expiresAt: read.policy.expiresAt.toString(),
                expired: burnHeight > read.policy.expiresAt,
                blocksLeft: (burnHeight > read.policy.expiresAt
                  ? 0n
                  : read.policy.expiresAt - burnHeight
                ).toString(),
              },
            },
      alerts: w.alerts,
    };
    return { ...body, lines: ownerLines(body, burnHeight) };
  });

  return {
    fromHeight: fromHeight.toString(),
    toHeight: toHeight.toString(),
    burnHeight: burnHeight.toString(),
    owners,
    vaultAlerts,
  };
}

/**
 * The digest as text: a heading, then each owner's lines. Ends with a
 * newline. Amounts are base units.
 */
export function renderDigest(d: Digest): string {
  const out = [
    `Keelio vault digest: burn heights ${d.fromHeight} to ${d.toHeight}. ` +
      `Vaults read at burn height ${d.burnHeight}. Amounts are base units.`,
  ];
  if (d.owners.length === 0) {
    out.push("", "No vault to report on: nothing happened in this range.");
  }
  for (const owner of d.owners) {
    out.push("", `Owner ${owner.owner}`, ...owner.lines.map((l) => `  ${l}`));
  }
  const vaultWide =
    d.vaultAlerts.critical.length +
    d.vaultAlerts.warning.length +
    d.vaultAlerts.info.length;
  if (vaultWide > 0) {
    out.push(
      "",
      "The vault contract as a whole",
      ...alertLines(d.vaultAlerts).map((l) => `  ${l}`),
    );
  }
  return `${out.join("\n")}\n`;
}
