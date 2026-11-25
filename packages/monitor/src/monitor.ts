import { readVault, type VaultConfig, type VaultRead } from "@keelio/sdk";
import { Cl, type ClarityValue } from "@stacks/transactions";
import {
  DEFAULT_THRESHOLDS,
  LEVEL_CODES,
  type Alert,
  type LevelCode,
  type Thresholds,
} from "./alerts.js";
import type { MonitorChain } from "./chain.js";
import { digest, type Digest } from "./digest.js";
import {
  evaluate,
  initialState,
  ownersToRead,
  type LedgerReading,
  type MonitorState,
  type OwnerState,
  type PendingRequest,
} from "./evaluate.js";

// The I/O around the pure core: read the chain, call `evaluate`, hand the
// alerts on, save the state. It only reads; it signs and sends nothing.

/** Where the state lives between polls and across restarts. */
export interface StateStore {
  /** The saved state, or `null` when there is none yet. */
  load(): MonitorState | null | Promise<MonitorState | null>;
  save(state: MonitorState): void | Promise<void>;
}

/** A store that forgets on exit. For tests and the simnet demo. */
export function memoryStore(saved: MonitorState | null = null): StateStore {
  let state = saved;
  return {
    load: () => state,
    save: (next) => {
      state = next;
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function amounts(value: unknown, what: string): Record<string, string> {
  if (!isRecord(value)) throw new Error(`${what} is not an object`);
  const out: Record<string, string> = {};
  for (const [key, amount] of Object.entries(value)) {
    if (typeof amount !== "string" || !/^(0|[1-9][0-9]*)$/.test(amount)) {
      throw new Error(`${what}.${key} is not a base-unit amount`);
    }
    out[key] = amount;
  }
  return out;
}

const REQUEST_TEXT = ["agent", "adapter", "tokenIn", "tokenOut"] as const;
const REQUEST_AMOUNTS = [
  "amountIn",
  "minOut",
  "requestedAt",
  "expiresAt",
] as const;

function pendingRequest(value: unknown, what: string): PendingRequest | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new Error(`${what} is not an object`);
  for (const key of REQUEST_TEXT) {
    if (typeof value[key] !== "string") {
      throw new Error(`${what}.${key} is not a principal`);
    }
  }
  const numbers = amounts(
    Object.fromEntries(REQUEST_AMOUNTS.map((key) => [key, value[key]])),
    what,
  );
  if (typeof value.expiryReported !== "boolean") {
    throw new Error(`${what}.expiryReported is not a boolean`);
  }
  return {
    agent: value.agent as string,
    adapter: value.adapter as string,
    tokenIn: value.tokenIn as string,
    tokenOut: value.tokenOut as string,
    amountIn: numbers.amountIn!,
    minOut: numbers.minOut!,
    requestedAt: numbers.requestedAt!,
    expiresAt: numbers.expiresAt!,
    expiryReported: value.expiryReported,
  };
}

function count(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${what} is not a count`);
  }
  return value;
}

/**
 * Checks a saved state, which is read from a file a person can edit. Throws
 * on anything that is not a state this version wrote.
 */
export function parseState(value: unknown): MonitorState {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error("state is not a version 1 monitor state");
  }
  if (!isRecord(value.cursor)) throw new Error("state.cursor is missing");
  if (!isRecord(value.owners)) throw new Error("state.owners is missing");
  const owners: Record<string, OwnerState> = {};
  for (const [owner, o] of Object.entries(value.owners)) {
    const what = `state.owners.${owner}`;
    if (!isRecord(o)) throw new Error(`${what} is not an object`);
    if (
      !Array.isArray(o.active) ||
      !o.active.every((c): c is LevelCode =>
        (LEVEL_CODES as readonly unknown[]).includes(c),
      )
    ) {
      throw new Error(`${what}.active is not a list of level codes`);
    }
    owners[owner] = {
      balances: amounts(o.balances, `${what}.balances`),
      dayCaps: amounts(o.dayCaps, `${what}.dayCaps`),
      active: [...o.active],
      // Both absent from a state written before the approval band existed.
      approvalThresholds: amounts(
        o.approvalThresholds ?? {},
        `${what}.approvalThresholds`,
      ),
      pending: pendingRequest(o.pending ?? null, `${what}.pending`),
    };
  }
  // Absent from a state written before LEDGER_SHORTFALL existed.
  const shortTokens = value.shortTokens ?? [];
  if (
    !Array.isArray(shortTokens) ||
    !shortTokens.every((t): t is string => typeof t === "string")
  ) {
    throw new Error("state.shortTokens is not a list of token ids");
  }
  return {
    version: 1,
    cursor: {
      events: count(value.cursor.events, "state.cursor.events"),
      refusals: count(value.cursor.refusals, "state.cursor.refusals"),
    },
    owners,
    shortTokens: [...shortTokens],
  };
}

function uintOf(value: ClarityValue, what: string): bigint {
  if (value.type !== "uint") {
    throw new Error(`${what} is not a uint: ${Cl.prettyPrint(value)}`);
  }
  return BigInt(value.value);
}

/**
 * What the vault contract holds of `token`, and what its ledgers owe. On an
 * API the reads are separate requests, so a block can land between them: a
 * withdrawal after the ledger read makes the vault look short by its amount,
 * and a deposit after the balance read does the same. The ledger total is
 * read before and after the balance, and the lower of the two is compared,
 * so one block landing anywhere in the reads raises nothing. A real shortfall
 * lasts, so a poll that misses it this way reports it at the next one.
 */
async function ledgerReading(
  chain: MonitorChain,
  vault: string,
  token: string,
): Promise<LedgerReading> {
  const readOwed = async (): Promise<bigint> =>
    uintOf(
      await chain.callReadOnly(vault, "get-ledger-total", [
        Cl.principal(token),
      ]),
      `${vault} get-ledger-total of ${token}`,
    );
  const owedBefore = await readOwed();
  const balance = await chain.callReadOnly(token, "get-balance", [
    Cl.principal(chain.vault),
  ]);
  if (balance.type !== "ok") {
    throw new Error(
      `${token} get-balance of the vault failed: ${Cl.prettyPrint(balance)}`,
    );
  }
  const held = uintOf(balance.value, `${token} get-balance`);
  const owedAfter = await readOwed();
  return { held, owed: owedBefore < owedAfter ? owedBefore : owedAfter };
}

export interface MonitorDeps {
  /** The chain to read; the monitor never builds one of its own. */
  chain: MonitorChain;
  /** The vault id and the tokens, adapters and oracle `readVault` reads. */
  read: VaultConfig;
  store: StateStore;
  /** Defaults to `DEFAULT_THRESHOLDS`, field by field. */
  thresholds?: Partial<Thresholds>;
  /**
   * Called once per alert, in order, before the state is saved. If the
   * process dies between the two, the next start raises the same alerts
   * again, with the same ids: an alert can repeat but is never skipped.
   */
  emit?: (alert: Alert) => void | Promise<void>;
}

export interface Monitor {
  /** Reads the chain once and returns the alerts it raised. */
  poll(): Promise<Alert[]>;
  /** The state after the last poll, or the saved one before the first. */
  state(): Promise<MonitorState>;
}

export function createMonitor(deps: MonitorDeps): Monitor {
  const { chain, read, store, emit } = deps;
  const thresholds = { ...DEFAULT_THRESHOLDS, ...deps.thresholds };
  let current: MonitorState | null = null;
  const state = async () =>
    (current ??= (await store.load()) ?? initialState());

  return {
    state,
    async poll() {
      const before = await state();
      const allEvents = await chain.vaultEvents();
      const allRefusals = await chain.vaultRefusals();
      if (
        allEvents.length < before.cursor.events ||
        allRefusals.length < before.cursor.refusals
      ) {
        // A state file from another vault or network, or a reorg that
        // removed entries. Guessing here would skip or repeat alerts.
        throw new Error(
          `the saved cursor (${before.cursor.events} events, ${before.cursor.refusals} refusals) ` +
            `is past the chain (${allEvents.length} events, ${allRefusals.length} refusals)`,
        );
      }
      const events = allEvents.slice(before.cursor.events);
      const refusals = allRefusals.slice(before.cursor.refusals);
      const burnHeight = await chain.burnHeight();
      const blockTimeMs = await chain.blockTimeMs();
      const vaults: Record<string, VaultRead> = {};
      for (const owner of ownersToRead(before, events)) {
        vaults[owner] = await readVault(chain, read, owner);
      }
      const ledgers: Record<string, LedgerReading> = {};
      for (const token of read.tokens) {
        ledgers[token] = await ledgerReading(chain, read.vault, token);
      }
      const result = evaluate({
        state: before,
        thresholds,
        events,
        refusals,
        vaults,
        burnHeight,
        blockTimeMs,
        ledgers,
        history: allEvents.slice(0, before.cursor.events),
      });
      if (emit !== undefined) {
        for (const alert of result.alerts) await emit(alert);
      }
      await store.save(result.state);
      current = result.state;
      return result.alerts;
    },
  };
}

/** The burn heights a digest covers, both included. */
export interface DigestRange {
  /** Defaults to 0: from the start of the journal. */
  fromHeight?: bigint;
  /** Defaults to the burn height at the read. */
  toHeight?: bigint;
}

/**
 * Reads the chain once and returns the owner digest for `range`. The alerts
 * in it are the ones a monitor started with no state would raise now: every
 * journal and refused-call alert at its own burn height, and the lasting
 * conditions that hold at this read. It loads and saves no state and emits
 * nothing, so it never moves a running monitor's cursor.
 */
export async function readDigest(
  deps: Pick<MonitorDeps, "chain" | "read" | "thresholds">,
  range: DigestRange = {},
): Promise<Digest> {
  const { chain, read } = deps;
  const events = await chain.vaultEvents();
  const refusals = await chain.vaultRefusals();
  const burnHeight = await chain.burnHeight();
  const blockTimeMs = await chain.blockTimeMs();
  const state = initialState();
  const vaults: Record<string, VaultRead> = {};
  for (const owner of ownersToRead(state, events)) {
    vaults[owner] = await readVault(chain, read, owner);
  }
  const ledgers: Record<string, LedgerReading> = {};
  for (const token of read.tokens) {
    ledgers[token] = await ledgerReading(chain, read.vault, token);
  }
  const { alerts } = evaluate({
    state,
    thresholds: { ...DEFAULT_THRESHOLDS, ...deps.thresholds },
    events,
    refusals,
    vaults,
    burnHeight,
    blockTimeMs,
    ledgers,
    history: [],
  });
  return digest({
    fromHeight: range.fromHeight ?? 0n,
    toHeight: range.toHeight ?? burnHeight,
    burnHeight,
    events,
    refusals,
    vaults,
    alerts,
  });
}
