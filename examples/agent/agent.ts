// The agent: the part of this example you would keep on a real network.
//
// It is a rule-based rebalancer with no model call and no network access. It
// holds a target share of the vault's value in sBTC, priced at the vault's
// oracle, and trades back towards the target when the share drifts out of a
// band. Everything it knows about the chain comes through `Chain`, and the one
// thing it cannot do itself, signing and sending, goes through `Wallet`.
// Nothing in this file imports the simnet.
import type { ClarityValue } from "@stacks/transactions";
import {
  ASSET_SCALE,
  buildExecuteSwap,
  buildRequestSwap,
  checkIntent,
  checkRequest,
  minOutFloor,
  readVault,
  sizePosition,
  type ReadOnlyClient,
  type Refusal,
  type SizedPosition,
  type SwapTerms,
  type TxConfig,
  type VaultCall,
  type VaultConfig,
  type VaultRuleName,
  type VaultState,
} from "../../packages/sdk/src/index.js";
import { vaultErrorName } from "./vault-errors.js";

const BPS = 10_000n;

/** One print event of the vault contract, with the burn height it printed at. */
export interface JournalRecord {
  burnHeight: bigint;
  /** The print tuple, as in docs/events.md. */
  value: ClarityValue;
}

/**
 * What the agent reads from a chain. `simnet-harness.ts` implements it over
 * the in-process simnet and `network.ts` over a Stacks node.
 */
export interface Chain {
  /** Read-only contract calls: the SDK's `simnetClient` or `stacksApiClient`. */
  client: ReadOnlyClient;
  /** The current burn (Bitcoin) block height. */
  burnHeight(): bigint | Promise<bigint>;
  /** `stacks-block-time * 1000` of the latest block. */
  blockTimeMs(): bigint | Promise<bigint>;
  /** The vault contract's print events, oldest first. */
  journal(): readonly JournalRecord[] | Promise<readonly JournalRecord[]>;
}

/**
 * The agent's own wallet. Keelio never signs or broadcasts: the SDK hands over
 * an unsigned call, and the wallet that holds the agent's key does the rest.
 */
export interface Wallet {
  /**
   * Signs `call` as the agent, sends it, waits for it to be mined and returns
   * the transaction's result: `(ok …)` or `(err uN)`.
   */
  submit(call: VaultCall): Promise<ClarityValue>;
}

export interface AgentConfig {
  /** The vault owner whose ledger the agent trades. */
  owner: string;
  /** The agent's own principal: the one the owner named with `set-agent`. */
  agent: string;
  /** The sBTC token id. Must equal the vault's `ALLOWED-TOKEN`. */
  sbtc: string;
  /** The quote token id. Must equal the vault's `QUOTE-TOKEN`. */
  quote: string;
  /** The swap adapter id. Must equal the vault's `ALLOWED-ADAPTER`. */
  adapter: string;
  /** What `readVault` reads: the vault's deploy constants. */
  read: VaultConfig;
  /** What `buildExecuteSwap` needs: asset names and adapter routes. */
  tx: TxConfig;
  /** The share of the vault's value to hold in sBTC, in basis points. */
  targetSbtcBps: bigint;
  /** How far the share may drift from the target before the agent trades. */
  bandBps: bigint;
  /** How far below the oracle price the agent itself will accept a fill. */
  toleranceBps: bigint;
  /** Buys only: the most a fall to the stop may lose, in bps of the vault's value. */
  riskBps: bigint;
  /** Buys only: how far below the entry price the stop sits, in bps. */
  stopBps: bigint;
  /** sBTC amounts are rounded down to a multiple of this many sats. */
  lotSize: bigint;
}

/** A trade the agent has decided on and sized, before any check. */
export interface Plan {
  side: "sell" | "buy";
  tokenIn: string;
  tokenOut: string;
  /** In `tokenIn` base units. */
  amountIn: bigint;
  /** The sBTC share of the vault's value when the plan was made. */
  sbtcShareBps: bigint;
  /** Buys only: the risk-based size that capped the buy. */
  sized: SizedPosition | null;
}

export type Decision =
  | { action: "hold"; reason: string; sbtcShareBps: bigint | null }
  | { action: "trade"; plan: Plan };

/** What the journal says a swap did (the `execute-swap` event). */
export interface Fill {
  burnHeight: bigint;
  amountIn: bigint;
  amountOut: bigint;
  /** The owner's ledger of the token sold, after the swap. */
  balanceIn: bigint;
  /** The owner's ledger of the token bought, after the swap. */
  balanceOut: bigint;
  /** The token sold in the current 144-block window, this swap included. */
  dayTotal: bigint;
}

export type TickOutcome =
  | { kind: "hold"; reason: string; sbtcShareBps: bigint | null }
  | {
      /**
       * `checkIntent` refused the trade, or `checkRequest` refused the
       * request for it, so no call was built or sent.
       */
      kind: "predicted-refusal";
      plan: Plan;
      minOut: bigint;
      refusal: Refusal<VaultRuleName>;
      errorName: string;
      standDown: boolean;
    }
  | {
      /** The call was sent and the vault contract refused it. */
      kind: "contract-refusal";
      plan: Plan;
      minOut: bigint;
      call: VaultCall;
      /** The `N` of `(err uN)`, or `null` for any other result. */
      errorCode: number | null;
      errorName: string;
      standDown: boolean;
    }
  | {
      /**
       * The trade is above the owner's approval threshold, so the agent sent
       * `request-swap`. Nothing has moved: the swap runs only if the owner
       * approves it by `expiresAt`.
       */
      kind: "requested";
      plan: Plan;
      minOut: bigint;
      call: VaultCall;
      /** The last burn height the owner can approve at. */
      expiresAt: bigint;
    }
  | { kind: "traded"; plan: Plan; minOut: bigint; call: VaultCall; fill: Fill };

function min(...values: bigint[]): bigint {
  return values.reduce((a, b) => (b < a ? b : a));
}

function ceilDiv(n: bigint, d: bigint): bigint {
  return n / d + (n % d > 0n ? 1n : 0n);
}

/**
 * Step 1: read the owner's vault, with the burn height and block time the
 * check needs. A block that arrives during the reads can make the check
 * disagree with the contract (the cooldown passes, the policy expires); the
 * send handles that as a `contract-refusal`.
 */
export async function readState(
  chain: Chain,
  config: AgentConfig,
): Promise<VaultState> {
  const burnHeight = await chain.burnHeight();
  const read = await readVault(chain.client, config.read, config.owner);
  const nowMs = await chain.blockTimeMs();
  return { ...read, burnHeight, nowMs };
}

/**
 * The largest buy, in sats, that loses at most `riskBps` of `capital` if the
 * price falls from the oracle price to the stop `stopBps` below it. This is
 * the agent's own rule, on top of the owner's caps. `capital` is the vault's
 * value in quote base units.
 */
export function riskSizedBuy(
  capital: bigint,
  oraclePrice: bigint,
  config: AgentConfig,
): SizedPosition {
  // Quote base units per whole sBTC, the unit `sizePosition` prices in.
  const entry = (oraclePrice * ASSET_SCALE) / config.read.priceScale;
  const stop = (entry * (BPS - config.stopBps)) / BPS;
  return sizePosition({
    capital,
    riskBps: config.riskBps,
    entry,
    stop,
    lotSize: config.lotSize,
  });
}

/**
 * Step 2: decide whether to trade, and size the trade. Pure: it reads only
 * `state` and `config`. It keeps the amount inside the per-trade cap, what is
 * left of the day's cap and the ledger balance, so the only refusals left for
 * `checkIntent` are the ones sizing cannot fix (paused, expired, cooldown, a
 * stale price).
 */
export function decide(state: VaultState, config: AgentConfig): Decision {
  const price = state.oracle.price?.value ?? 0n;
  if (price === 0n) {
    return { action: "hold", reason: "no oracle price", sbtcShareBps: null };
  }
  const scale = state.oracle.priceScale;
  const sbtc = state.balances[config.sbtc] ?? 0n;
  const quote = state.balances[config.quote] ?? 0n;
  // Everything is valued in quote base units at the oracle price.
  const sbtcValue = (sbtc * price) / scale;
  const total = sbtcValue + quote;
  if (total === 0n) {
    return { action: "hold", reason: "the vault is empty", sbtcShareBps: null };
  }
  const sbtcShareBps = (sbtcValue * BPS) / total;
  const drift =
    sbtcShareBps > config.targetSbtcBps
      ? sbtcShareBps - config.targetSbtcBps
      : config.targetSbtcBps - sbtcShareBps;
  if (drift <= config.bandBps) {
    return { action: "hold", reason: "inside the band", sbtcShareBps };
  }

  const side = sbtcShareBps > config.targetSbtcBps ? "sell" : "buy";
  const tokenIn = side === "sell" ? config.sbtc : config.quote;
  const tokenOut = side === "sell" ? config.quote : config.sbtc;
  const caps = state.policy.caps[tokenIn] ?? { maxPerTrade: 0n, maxPerDay: 0n };
  const dayTotal = state.usage.dayTotals[tokenIn] ?? 0n;
  const dayLeft = dayTotal >= caps.maxPerDay ? 0n : caps.maxPerDay - dayTotal;
  const targetValue = (total * config.targetSbtcBps) / BPS;

  let amountIn: bigint;
  let sized: SizedPosition | null = null;
  if (side === "sell") {
    const excessSats = ((sbtcValue - targetValue) * scale) / price;
    const sats = min(excessSats, caps.maxPerTrade, dayLeft, sbtc);
    amountIn = sats - (sats % config.lotSize);
  } else {
    const budget = min(
      targetValue - sbtcValue,
      caps.maxPerTrade,
      dayLeft,
      quote,
    );
    sized = riskSizedBuy(total, price, config);
    const sats = min((budget * scale) / price, sized.quantity);
    amountIn = ((sats - (sats % config.lotSize)) * price) / scale;
  }
  if (amountIn === 0n) {
    const reason = "nothing tradable inside the caps, the balance and a lot";
    return { action: "hold", reason, sbtcShareBps };
  }
  return {
    action: "trade",
    plan: { side, tokenIn, tokenOut, amountIn, sbtcShareBps, sized },
  };
}

/**
 * Step 3: the least output to accept. The agent wants the oracle's value less
 * its own tolerance, and never asks for less than the vault's floor (the
 * oracle price less the owner's `max-slippage-bps`), because the vault refuses
 * anything below it with u125.
 *
 * Returns `0n` when no floor can be worked out (no price bounds, no oracle
 * answer, a stale price). `checkIntent` refuses that trade for the same
 * reason, so a `0n` is never sent.
 */
export function minOutFor(
  state: VaultState,
  plan: Plan,
  config: AgentConfig,
): bigint {
  const floor = minOutFloor(state, plan.tokenIn, plan.amountIn);
  const price = state.oracle.price?.value ?? 0n;
  if (!floor.ok || price === 0n) return 0n;
  const scale = state.oracle.priceScale;
  const atOracle =
    plan.side === "sell"
      ? (plan.amountIn * price) / scale
      : (plan.amountIn * scale) / price;
  const wanted = ceilDiv(atOracle * (BPS - config.toleranceBps), BPS);
  return wanted > floor.floor ? wanted : floor.floor;
}

/** Which swap `lastFill` looks for: the one the agent just sent. */
export interface SentSwap {
  owner: string;
  tokenIn: string;
  minOut: bigint;
  /** The burn height read before sending: the swap cannot be older. */
  sinceBurnHeight: bigint;
}

/**
 * The newest `execute-swap` event in the journal that matches `sent`, as a
 * `Fill`. Throws when there is none: on a network the event index can lag the
 * transaction's result, and an older swap must not pass for this one.
 */
export function lastFill(
  journal: readonly JournalRecord[],
  sent: SentSwap,
): Fill {
  for (let i = journal.length - 1; i >= 0; i--) {
    const record = journal[i]!;
    if (record.value.type !== "tuple") continue;
    const fields = record.value.value;
    const text = (name: string): string | null => {
      const v = fields[name];
      if (v?.type === "ascii") return v.value;
      if (v?.type === "address" || v?.type === "contract") return v.value;
      return null;
    };
    if (text("event") !== "execute-swap") continue;
    const uint = (name: string): bigint => {
      const v = fields[name];
      if (v?.type !== "uint") throw new Error(`event has no uint ${name}`);
      return BigInt(v.value);
    };
    if (
      text("owner") !== sent.owner ||
      text("token-in") !== sent.tokenIn ||
      uint("min-out") !== sent.minOut ||
      record.burnHeight < sent.sinceBurnHeight
    ) {
      continue;
    }
    return {
      burnHeight: record.burnHeight,
      amountIn: uint("amount-in"),
      amountOut: uint("amount-out"),
      balanceIn: uint("balance-in"),
      balanceOut: uint("balance-out"),
      dayTotal: uint("day-total"),
    };
  }
  throw new Error(
    `the journal does not show the swap just sent for ${sent.owner} yet`,
  );
}

/**
 * Whether a refusal means the owner has taken the agent's permission away
 * (not the agent, paused, expired). Retrying cannot help: the agent stops
 * trading until a read shows the owner has changed it back. Every other
 * refusal (cooldown, caps, a stale price) can pass on a later tick.
 */
export function shouldStandDown(errorCode: number | null): boolean {
  return errorCode === 108 || errorCode === 109 || errorCode === 110;
}

/** The `N` of a transaction result `(err uN)`, or `null` for any other. */
function errorCodeOf(result: ClarityValue): number | null {
  return result.type === "err" && result.value.type === "uint"
    ? Number(result.value.value)
    : null;
}

/**
 * The trade is inside the per-trade cap and above the owner's approval
 * threshold (u126), so the agent cannot run it alone. It records the trade
 * with `request-swap`, which moves nothing, and the owner decides: the swap
 * runs only if the owner approves within 6 burn blocks, with the day cap,
 * the cooldown and the price checked again at that moment.
 */
async function requestApproval(
  chain: Chain,
  wallet: Wallet,
  config: AgentConfig,
  state: VaultState,
  plan: Plan,
  swap: SwapTerms,
): Promise<TickOutcome> {
  const { minOut } = swap;
  // The request has its own checks: a request that is still pending refuses
  // a second one (u128), so the agent waits for the owner or for it to expire.
  const check = checkRequest(state, { caller: config.agent, ...swap });
  if (!check.ok) {
    return {
      kind: "predicted-refusal",
      plan,
      minOut,
      refusal: check,
      errorName: vaultErrorName(check.errorCode),
      standDown: shouldStandDown(check.errorCode),
    };
  }
  const call = buildRequestSwap(config.tx, { owner: config.owner, ...swap });
  const result = await wallet.submit(call);
  if (result.type !== "ok") {
    const errorCode = errorCodeOf(result);
    return {
      kind: "contract-refusal",
      plan,
      minOut,
      call,
      errorCode,
      errorName: errorCode === null ? "UNKNOWN" : vaultErrorName(errorCode),
      standDown: shouldStandDown(errorCode),
    };
  }
  // The vault, not the call's return value, says what is stored.
  const { pendingSwap } = await readVault(
    chain.client,
    config.read,
    config.owner,
  );
  if (
    pendingSwap === null ||
    pendingSwap.agent !== config.agent ||
    pendingSwap.amountIn !== swap.amountIn ||
    pendingSwap.requestedAt < state.burnHeight
  ) {
    throw new Error(
      `the vault does not show the request just sent for ${config.owner} yet`,
    );
  }
  return {
    kind: "requested",
    plan,
    minOut,
    call,
    expiresAt: pendingSwap.expiresAt,
  };
}

/**
 * One pass of the loop: read, decide and size, set min-out, check, build,
 * submit, read the journal. It sends at most one transaction, and none at all
 * when `checkIntent` refuses. A trade above the owner's approval threshold is
 * sent as a request instead (`requestApproval`).
 */
export async function tick(
  chain: Chain,
  wallet: Wallet,
  config: AgentConfig,
): Promise<TickOutcome> {
  const state = await readState(chain, config);
  const decision = decide(state, config);
  if (decision.action === "hold") return { kind: "hold", ...decision };
  const { plan } = decision;
  const minOut = minOutFor(state, plan, config);

  // Step 4: run the contract's own checks off-chain, before paying a fee.
  const swap = {
    adapter: config.adapter,
    tokenIn: plan.tokenIn,
    tokenOut: plan.tokenOut,
    amountIn: plan.amountIn,
    minOut,
  };
  const check = checkIntent(state, { caller: config.agent, ...swap });
  if (!check.ok && check.rule === "APPROVAL_REQUIRED") {
    // u126: only the owner can run a trade this size. Ask instead.
    return requestApproval(chain, wallet, config, state, plan, swap);
  }
  if (!check.ok) {
    return {
      kind: "predicted-refusal",
      plan,
      minOut,
      refusal: check,
      errorName: vaultErrorName(check.errorCode),
      standDown: shouldStandDown(check.errorCode),
    };
  }

  // Step 5: build the unsigned call, with its post-conditions.
  const call = buildExecuteSwap(config.tx, { owner: config.owner, ...swap });

  // Step 6: the agent's own wallet signs and sends it. The contract decides.
  const result = await wallet.submit(call);
  if (result.type !== "ok") {
    const errorCode = errorCodeOf(result);
    return {
      kind: "contract-refusal",
      plan,
      minOut,
      call,
      errorCode,
      errorName: errorCode === null ? "UNKNOWN" : vaultErrorName(errorCode),
      standDown: shouldStandDown(errorCode),
    };
  }

  // Step 7: the journal, not the call's return value, says what happened.
  const fill = lastFill(await chain.journal(), {
    owner: config.owner,
    tokenIn: plan.tokenIn,
    minOut,
    sinceBurnHeight: state.burnHeight,
  });
  return { kind: "traded", plan, minOut, call, fill };
}
