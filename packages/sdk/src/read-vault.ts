import { Cl, type ClarityValue } from "@stacks/transactions";
import { StacksApiError } from "./stacks-api-error.js";
import type {
  ApprovalThresholds,
  Balances,
  OraclePrice,
  OracleTerms,
  PendingSwap,
  Policy,
  PriceBounds,
  TokenCaps,
  Vault,
  VaultUsage,
} from "./vault.js";

/** The oracle key the vault reads. Fixed in the contract, not deploy config. */
const ORACLE_KEY = "BTC/USD";

/** Calls a read-only contract function. A Stacks API client can implement it later. */
export interface ReadOnlyClient {
  callReadOnly(
    contract: string,
    fn: string,
    args: ClarityValue[],
  ): ClarityValue | Promise<ClarityValue>;
}

/** The part of the Clarinet simnet that `simnetClient` uses. */
export interface SimnetLike {
  callReadOnlyFn(
    contract: string,
    fn: string,
    args: ClarityValue[],
    sender: string,
  ): { result: ClarityValue };
}

export function simnetClient(
  simnet: SimnetLike,
  sender: string,
): ReadOnlyClient {
  return {
    callReadOnly: (contract, fn, args) =>
      simnet.callReadOnlyFn(contract, fn, args, sender).result,
  };
}

/**
 * The vault's deploy constants. The contract has no getter for them, so the
 * caller passes them, and a wrong value makes `checkIntent` disagree with the
 * contract without any error.
 */
export interface VaultConfig {
  /** The vault contract id (or name on the simnet). */
  vault: string;
  tokens: readonly string[];
  adapters: readonly string[];
  /**
   * The oracle contract id (or name on the simnet). Must equal the vault's
   * `ORACLE`.
   */
  oracle: string;
  /** The sBTC token id. Must equal the vault's `ALLOWED-TOKEN`. */
  sbtcToken: string;
  /** Must equal the vault's `PRICE-SCALE`. */
  priceScale: bigint;
}

export interface VaultRead {
  vault: Vault;
  policy: Policy;
  usage: VaultUsage;
  balances: Balances;
  priceBounds: PriceBounds;
  oracle: OracleTerms;
  /**
   * Each `config.tokens` entry's approval threshold, from
   * `get-approval-threshold`: `null` when the owner set none.
   */
  approvalThresholds: ApprovalThresholds;
  /**
   * The owner's stored request from `get-pending-swap`, expired or not, or
   * `null` when there is none.
   */
  pendingSwap: PendingSwap | null;
}

/** What `readVault` may be told besides the owner. */
export interface ReadVaultOptions {
  /**
   * The burn height the read is taken at. With it, `pendingSwap.expired`
   * says whether the request had expired at that height; without it the
   * flag is `null`. The SDK has no call for the burn height.
   */
  burnHeight?: bigint;
}

function tuple(value: ClarityValue): Record<string, ClarityValue> {
  if (value.type !== "tuple")
    throw new Error(`expected tuple, got ${value.type}`);
  return value.value;
}

function field(t: Record<string, ClarityValue>, name: string): ClarityValue {
  const v = t[name];
  if (v === undefined) throw new Error(`missing field ${name}`);
  return v;
}

function uint(value: ClarityValue): bigint {
  if (value.type !== "uint")
    throw new Error(`expected uint, got ${value.type}`);
  return BigInt(value.value);
}

function bool(value: ClarityValue): boolean {
  if (value.type === "true") return true;
  if (value.type === "false") return false;
  throw new Error(`expected bool, got ${value.type}`);
}

function optional(value: ClarityValue): ClarityValue | null {
  if (value.type === "none") return null;
  if (value.type === "some") return value.value;
  throw new Error(`expected optional, got ${value.type}`);
}

function principal(value: ClarityValue): string {
  if (value.type !== "address" && value.type !== "contract") {
    throw new Error(`expected principal, got ${value.type}`);
  }
  return Cl.prettyPrint(value).replace(/^'/, "");
}

/**
 * The oracle's `get-value` answer: `null` for `(err …)`, whether the client
 * returns it (`simnetClient`) or throws it as a `CLARITY_ERROR`
 * (`stacksApiClient`). Any other failure propagates.
 */
async function readOraclePrice(
  client: ReadOnlyClient,
  oracle: string,
): Promise<OraclePrice | null> {
  let answer: ClarityValue;
  try {
    answer = await client.callReadOnly(oracle, "get-value", [
      Cl.stringAscii(ORACLE_KEY),
    ]);
  } catch (e) {
    if (e instanceof StacksApiError && e.code === "CLARITY_ERROR") return null;
    throw e;
  }
  if (answer.type === "err") return null;
  if (answer.type !== "ok") {
    throw new Error(`expected response, got ${answer.type}`);
  }
  const price = tuple(answer.value);
  return {
    value: uint(field(price, "value")),
    timestamp: uint(field(price, "timestamp")),
  };
}

/**
 * Reads one owner's vault from the contract's read-only functions. Caps and
 * day totals are read for every `config.tokens` entry; the owner-wide
 * cooldown, expiry and last trade come from the first token's reads, and are
 * the same for every token. The price bounds come from `get-price-bounds`,
 * and the oracle's price from its `get-value "BTC/USD"`. Each token's
 * approval threshold comes from `get-approval-threshold` and the stored
 * request from `get-pending-swap`; `options.burnHeight` sets its `expired`
 * flag.
 */
export async function readVault(
  client: ReadOnlyClient,
  config: VaultConfig,
  owner: string,
  options: ReadVaultOptions = {},
): Promise<VaultRead> {
  const call = async (fn: string, ...args: ClarityValue[]) =>
    client.callReadOnly(config.vault, fn, args);
  const who = Cl.principal(owner);

  const caps: Record<string, TokenCaps> = {};
  const dayTotals: Record<string, bigint> = {};
  type Fields = Record<string, ClarityValue>;
  const reads: [policy: Fields, state: Fields][] = [];
  for (const token of config.tokens) {
    const id = Cl.principal(token);
    const p = tuple(await call("get-policy", who, id));
    const s = tuple(await call("get-trade-state", who, id));
    caps[token] = {
      maxPerTrade: uint(field(p, "max-per-trade")),
      maxPerDay: uint(field(p, "max-per-day")),
    };
    dayTotals[token] = uint(field(s, "day-total"));
    reads.push([p, s]);
  }
  // No read, no owner-wide fields: refuse rather than invent zeros.
  const first = reads[0];
  if (first === undefined) throw new Error("config.tokens is empty");
  const [shared, state] = first;

  const vaultTuple = tuple(await call("get-vault", who));

  const allowed = async (fn: string, ids: readonly string[]) => {
    const flags = await Promise.all(
      ids.map(async (id) => bool(await call(fn, who, Cl.principal(id)))),
    );
    return ids.filter((_, i) => flags[i]);
  };
  const allowedTokens = await allowed("is-token-allowed", config.tokens);
  const allowedAdapters = await allowed("is-adapter-allowed", config.adapters);

  const balances: Record<string, bigint> = {};
  for (const token of config.tokens) {
    balances[token] = uint(await call("get-balance", who, Cl.principal(token)));
  }

  const bounds = tuple(await call("get-price-bounds", who));
  // Read even when the bounds are unset: checkIntent decides what matters.
  const price = await readOraclePrice(client, config.oracle);

  const approvalThresholds: Record<string, bigint | null> = {};
  for (const token of config.tokens) {
    const threshold = optional(
      await call("get-approval-threshold", who, Cl.principal(token)),
    );
    approvalThresholds[token] = threshold === null ? null : uint(threshold);
  }
  const stored = optional(await call("get-pending-swap", who));
  let pendingSwap: PendingSwap | null = null;
  if (stored !== null) {
    const request = tuple(stored);
    const expiresAt = uint(field(request, "expires-at"));
    pendingSwap = {
      agent: principal(field(request, "agent")),
      adapter: principal(field(request, "adapter")),
      tokenIn: principal(field(request, "token-in")),
      tokenOut: principal(field(request, "token-out")),
      amountIn: uint(field(request, "amount-in")),
      minOut: uint(field(request, "min-out")),
      requestedAt: uint(field(request, "requested-at")),
      expiresAt,
      expired:
        options.burnHeight === undefined
          ? null
          : options.burnHeight > expiresAt,
    };
  }

  const agent = optional(field(vaultTuple, "agent"));
  const lastTrade = optional(field(state, "last-trade"));

  return {
    vault: {
      agent: agent === null ? null : principal(agent),
      paused: bool(field(vaultTuple, "paused")),
    },
    policy: {
      cooldownBlocks: uint(field(shared, "cooldown-blocks")),
      expiresAt: uint(field(shared, "expires-at")),
      caps,
      allowedTokens,
      allowedAdapters,
    },
    usage: {
      dayTotals,
      lastTradeHeight: lastTrade === null ? null : uint(lastTrade),
    },
    balances,
    priceBounds: {
      maxSlippageBps: uint(field(bounds, "max-slippage-bps")),
      maxPriceAge: uint(field(bounds, "max-price-age")),
    },
    oracle: {
      sbtcToken: config.sbtcToken,
      priceScale: config.priceScale,
      price,
    },
    approvalThresholds,
    pendingSwap,
  };
}
