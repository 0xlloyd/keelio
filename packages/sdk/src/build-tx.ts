import {
  Cl,
  ClarityType,
  isClarityName,
  type AssetString,
  type ClarityValue,
  type FungibleComparator,
  type FungiblePostCondition,
  type PostCondition,
} from "@stacks/transactions";
import { principalProblem } from "./principal.js";

// Builds unsigned `keelio-vault` contract calls. Nothing here signs or
// broadcasts a transaction, reads a key or touches the network: the caller
// hands the result to a wallet or to @stacks/transactions.

/**
 * Who moves tokens during one adapter's swap, besides the vault and the
 * adapter itself.
 */
export interface AdapterRoute {
  /**
   * `null`: the adapter pays out from its own balance and moves nothing else
   * (mock-dex). A contract id: the adapter sends the input to this pool, and
   * the pool sends the output back to the adapter (bitflow-adapter).
   */
  pool: string | null;
}

/** Where the vault lives and how to name each token's fungible asset. */
export interface TxConfig {
  /** The vault's full contract id, `ADDR.keelio-vault`. */
  vault: string;
  /**
   * Token contract id to its `define-fungible-token` name, for example
   * `{ "ST….mock-sbtc": "mock-sbtc" }`. Post-conditions need the name and the
   * SDK never guesses it.
   */
  assetNames: Readonly<Record<string, string>>;
  /**
   * Adapter contract id to its route: who moves tokens during its swap, so
   * the swap's post-conditions cover every transfer. The SDK never guesses a
   * route. Only `buildExecuteSwap` and `buildApproveSwap` read it, and
   * refuse an adapter without one.
   */
  adapters?: Readonly<Record<string, AdapterRoute>>;
}

/**
 * A contract call ready for a wallet: the subset of `ContractCallOptions`
 * from @stacks/transactions with no network, key, fee or nonce.
 *
 * It is JSON-safe: `JSON.parse(JSON.stringify(call))` deep-equals it. Each
 * post-condition `amount` and each `uint` argument's `value` is a base-10
 * string, which @stacks/transactions accepts in both places.
 */
export interface VaultCall {
  contractAddress: string;
  contractName: string;
  functionName: string;
  functionArgs: ClarityValue[];
  postConditions: PostCondition[];
  postConditionMode: "deny";
}

export type TxBuildErrorCode =
  | "INVALID_AMOUNT"
  | "INVALID_PRICE_BOUNDS"
  | "INVALID_PRINCIPAL"
  | "UNKNOWN_ADAPTER"
  | "UNKNOWN_ASSET";

export class TxBuildError extends Error {
  readonly code: TxBuildErrorCode;

  constructor(code: TxBuildErrorCode, message: string) {
    super(message);
    this.name = "TxBuildError";
    this.code = code;
  }
}

export interface DepositInput {
  /** The owner sending the tokens, used only for the post-condition. */
  owner: string;
  token: string;
  amount: bigint;
}

export interface WithdrawInput {
  token: string;
  amount: bigint;
}

export interface SetAgentInput {
  agent: string;
}

/** The owner-wide cooldown and expiry, shared by both tokens. */
export interface SetPolicyInput {
  cooldownBlocks: bigint;
  expiresAt: bigint;
}

/** One token's caps. Never touches the owner-wide cooldown or expiry. */
export interface SetTokenCapsInput {
  token: string;
  maxPerTrade: bigint;
  maxPerDay: bigint;
}

/**
 * The owner's oracle bounds. 0 in either field is valid and means "may not
 * trade", as in the contract.
 */
export interface SetPriceBoundsInput {
  /** How far below the oracle's price a trade may settle, in basis points. */
  maxSlippageBps: bigint;
  /** How far the oracle's timestamp may be from the block's time, in ms. */
  maxPriceAge: bigint;
}

export interface AllowTokenInput {
  token: string;
  allowed: boolean;
}

export interface AllowAdapterInput {
  adapter: string;
  allowed: boolean;
}

export interface ExecuteSwapInput {
  owner: string;
  adapter: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  minOut: bigint;
}

/**
 * One input token's approval threshold. `null` clears it (no band); `0n`
 * means every trade selling the token needs the owner's approval.
 */
export interface SetApprovalThresholdInput {
  token: string;
  threshold: bigint | null;
}

/** The same trade `buildExecuteSwap` takes, sent by the agent as a request. */
export type RequestSwapInput = ExecuteSwapInput;

/** The five fields every swap call shares. */
interface SwapTermsInput {
  adapter: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  minOut: bigint;
}

/**
 * The request the owner approves: its trade and the burn height it was made
 * at. All six must equal the stored request, or the contract refuses with
 * u131. The owner is the sender, so there is no `owner` field.
 */
export interface ApproveSwapInput extends SwapTermsInput {
  /**
   * The `requestedAt` of the pending request the owner read and means to
   * approve. It binds the transaction to that one request: a later request
   * with the same trade does not match. Take it from the read the owner
   * reviewed, never from a fresh read made when signing.
   */
  requestedAt: bigint;
}

export interface CancelSwapRequestInput {
  /** The owner whose pending request the agent withdraws. */
  owner: string;
}

const MAX_UINT = 2n ** 128n - 1n;
const BPS = 10_000n;
/**
 * The largest amount a post-condition can carry: the Stacks wire format
 * stores it as a u64, so a larger one could never be signed.
 */
export const MAX_POST_CONDITION_AMOUNT = 2n ** 64n - 1n;

const BOUND_LABEL = new Map<bigint, string>([
  [MAX_UINT, "2^128 - 1"],
  [MAX_POST_CONDITION_AMOUNT, "2^64 - 1"],
]);

/** Throws unless `value` is a bigint in `[min, max]`. */
function checkUint(
  name: string,
  value: bigint,
  min = 0n,
  max = MAX_UINT,
): void {
  if (typeof value !== "bigint") {
    throw new TxBuildError("INVALID_AMOUNT", `${name} must be a bigint`);
  }
  if (value < min || value > max) {
    const label = BOUND_LABEL.get(max) ?? max.toString();
    throw new TxBuildError(
      "INVALID_AMOUNT",
      `${name} must be between ${min} and ${label}`,
    );
  }
}

/** Throws unless `value` is a principal (see `principalProblem`). */
function checkPrincipal(
  name: string,
  value: string,
  contractOnly: boolean,
): void {
  const problem =
    typeof value === "string"
      ? principalProblem(value, contractOnly)
      : "must be a string";
  if (problem !== null) {
    throw new TxBuildError("INVALID_PRINCIPAL", `${name} ${problem}`);
  }
}

type Target = Pick<VaultCall, "contractAddress" | "contractName">;

/** Validates `config.vault` and splits it at the first `.`. */
function splitVault(config: TxConfig): Target {
  checkPrincipal("config.vault", config.vault, true);
  const dot = config.vault.indexOf(".");
  return {
    contractAddress: config.vault.slice(0, dot),
    contractName: config.vault.slice(dot + 1),
  };
}

/** The `ADDR.contract::asset` string for a token, from `config.assetNames` only. */
function ftAsset(config: TxConfig, token: string): AssetString {
  const names = config.assetNames;
  const name = Object.hasOwn(names, token) ? names[token] : undefined;
  if (typeof name !== "string" || !isClarityName(name)) {
    throw new TxBuildError(
      "UNKNOWN_ASSET",
      `config.assetNames has no valid asset name for ${token}`,
    );
  }
  // `token` passed checkPrincipal as a contract id, so this is ADDR.name::asset.
  return `${token}::${name}` as AssetString;
}

/**
 * The pool named in `config.adapters` for `adapter`, or `null` when the
 * adapter pays out from its own balance. Reads own keys only.
 */
function adapterRoute(config: TxConfig, adapter: string): string | null {
  const routes = config.adapters;
  const route: unknown =
    routes !== undefined && routes !== null && Object.hasOwn(routes, adapter)
      ? routes[adapter]
      : undefined;
  if (typeof route !== "object" || route === null) {
    throw new TxBuildError(
      "UNKNOWN_ADAPTER",
      `config.adapters has no route for ${adapter}`,
    );
  }
  const pool = (route as { pool?: unknown }).pool;
  if (pool === null) return null;
  if (typeof pool !== "string") {
    throw new TxBuildError(
      "UNKNOWN_ADAPTER",
      `config.adapters[${adapter}].pool must be a contract id or null`,
    );
  }
  const name = `config.adapters[${adapter}].pool`;
  checkPrincipal(name, pool, true);
  if (pool === config.vault || pool === adapter) {
    throw new TxBuildError(
      "INVALID_PRINCIPAL",
      `${name} must differ from the vault and the adapter`,
    );
  }
  return pool;
}

/**
 * Exactly the object `Pc.principal(address).willSend…(amount).ft(asset)`
 * builds: the amount as its base-10 string.
 */
function ftPostCondition(
  address: string,
  condition: FungibleComparator,
  amount: bigint,
  asset: AssetString,
): FungiblePostCondition {
  return {
    type: "ft-postcondition",
    address,
    condition,
    amount: amount.toString(),
    asset,
  };
}

/**
 * A `uint` or `int` with a bigint value, at the top level or inside `some`,
 * becomes the same value with a base-10 string, which serialises to the same
 * bytes and survives JSON. Anything else is returned unchanged.
 */
function jsonSafeArg(arg: ClarityValue): ClarityValue {
  if (
    (arg.type === ClarityType.UInt || arg.type === ClarityType.Int) &&
    typeof arg.value === "bigint"
  ) {
    return { type: arg.type, value: arg.value.toString() };
  }
  if (arg.type === ClarityType.OptionalSome) {
    return { type: arg.type, value: jsonSafeArg(arg.value) };
  }
  return arg;
}

function call(
  target: Target,
  functionName: string,
  functionArgs: ClarityValue[] = [],
  postConditions: FungiblePostCondition[] = [],
): VaultCall {
  return {
    ...target,
    functionName,
    functionArgs: functionArgs.map(jsonSafeArg),
    postConditions,
    postConditionMode: "deny",
  };
}

/** Deposit: the owner sends exactly `amount` of `token` to the vault. */
export function buildDeposit(config: TxConfig, input: DepositInput): VaultCall {
  const target = splitVault(config);
  checkPrincipal("owner", input.owner, false);
  checkPrincipal("token", input.token, true);
  checkUint("amount", input.amount, 1n, MAX_POST_CONDITION_AMOUNT);
  const asset = ftAsset(config, input.token);
  return call(
    target,
    "deposit",
    [Cl.principal(input.token), Cl.uint(input.amount)],
    [ftPostCondition(input.owner, "eq", input.amount, asset)],
  );
}

/** Withdraw: the vault sends exactly `amount` of `token` to the caller. */
export function buildWithdraw(
  config: TxConfig,
  input: WithdrawInput,
): VaultCall {
  const target = splitVault(config);
  checkPrincipal("token", input.token, true);
  checkUint("amount", input.amount, 1n, MAX_POST_CONDITION_AMOUNT);
  const asset = ftAsset(config, input.token);
  return call(
    target,
    "withdraw",
    [Cl.principal(input.token), Cl.uint(input.amount)],
    [ftPostCondition(config.vault, "eq", input.amount, asset)],
  );
}

export function buildSetAgent(
  config: TxConfig,
  input: SetAgentInput,
): VaultCall {
  const target = splitVault(config);
  checkPrincipal("agent", input.agent, false);
  return call(target, "set-agent", [Cl.principal(input.agent)]);
}

export function buildRemoveAgent(config: TxConfig): VaultCall {
  return call(splitVault(config), "remove-agent");
}

export function buildPause(config: TxConfig): VaultCall {
  return call(splitVault(config), "pause");
}

export function buildUnpause(config: TxConfig): VaultCall {
  return call(splitVault(config), "unpause");
}

export function buildSetPolicy(
  config: TxConfig,
  input: SetPolicyInput,
): VaultCall {
  const target = splitVault(config);
  checkUint("cooldownBlocks", input.cooldownBlocks);
  checkUint("expiresAt", input.expiresAt);
  return call(target, "set-policy", [
    Cl.uint(input.cooldownBlocks),
    Cl.uint(input.expiresAt),
  ]);
}

export function buildSetTokenCaps(
  config: TxConfig,
  input: SetTokenCapsInput,
): VaultCall {
  const target = splitVault(config);
  checkPrincipal("token", input.token, true);
  checkUint("maxPerTrade", input.maxPerTrade);
  checkUint("maxPerDay", input.maxPerDay);
  return call(target, "set-token-caps", [
    Cl.principal(input.token),
    Cl.uint(input.maxPerTrade),
    Cl.uint(input.maxPerDay),
  ]);
}

/**
 * Set-price-bounds, sent by the owner. A `maxSlippageBps` of 10000 or more is
 * refused with `INVALID_PRICE_BOUNDS`, as the contract refuses it with u120.
 */
export function buildSetPriceBounds(
  config: TxConfig,
  input: SetPriceBoundsInput,
): VaultCall {
  const target = splitVault(config);
  checkUint("maxSlippageBps", input.maxSlippageBps);
  checkUint("maxPriceAge", input.maxPriceAge);
  if (input.maxSlippageBps >= BPS) {
    throw new TxBuildError(
      "INVALID_PRICE_BOUNDS",
      `maxSlippageBps must be below ${BPS}`,
    );
  }
  return call(target, "set-price-bounds", [
    Cl.uint(input.maxSlippageBps),
    Cl.uint(input.maxPriceAge),
  ]);
}

export function buildAllowToken(
  config: TxConfig,
  input: AllowTokenInput,
): VaultCall {
  const target = splitVault(config);
  checkPrincipal("token", input.token, true);
  return call(target, "allow-token", [
    Cl.principal(input.token),
    Cl.bool(input.allowed),
  ]);
}

export function buildAllowAdapter(
  config: TxConfig,
  input: AllowAdapterInput,
): VaultCall {
  const target = splitVault(config);
  checkPrincipal("adapter", input.adapter, true);
  return call(target, "allow-adapter", [
    Cl.principal(input.adapter),
    Cl.bool(input.allowed),
  ]);
}

/** Validates the five fields every swap call shares. */
function checkSwapTerms(input: SwapTermsInput): void {
  checkPrincipal("adapter", input.adapter, true);
  checkPrincipal("tokenIn", input.tokenIn, true);
  checkPrincipal("tokenOut", input.tokenOut, true);
  checkUint("amountIn", input.amountIn, 1n, MAX_POST_CONDITION_AMOUNT);
  checkUint("minOut", input.minOut, 0n, MAX_POST_CONDITION_AMOUNT);
}

/**
 * The five arguments every swap call shares: `execute-swap` and
 * `request-swap` end with them, and `approve-swap` adds `requested-at`.
 */
function swapArgs(input: SwapTermsInput): ClarityValue[] {
  return [
    Cl.principal(input.adapter),
    Cl.principal(input.tokenIn),
    Cl.principal(input.tokenOut),
    Cl.uint(input.amountIn),
    Cl.uint(input.minOut),
  ];
}

/**
 * The post-conditions of a swap the vault runs, for `execute-swap` and
 * `approve-swap` alike: the two move tokens through the same contract code.
 */
function swapPostConditions(
  config: TxConfig,
  input: SwapTermsInput,
): FungiblePostCondition[] {
  const assetIn = ftAsset(config, input.tokenIn);
  const assetOut = ftAsset(config, input.tokenOut);
  const pool = adapterRoute(config, input.adapter);
  const { amountIn, minOut } = input;
  return pool === null
    ? [
        ftPostCondition(config.vault, "lte", amountIn, assetIn),
        ftPostCondition(input.adapter, "gte", minOut, assetOut),
      ]
    : [
        ftPostCondition(config.vault, "lte", amountIn, assetIn),
        ftPostCondition(input.adapter, "lte", amountIn, assetIn),
        ftPostCondition(pool, "gte", minOut, assetOut),
        ftPostCondition(input.adapter, "gte", minOut, assetOut),
      ];
}

/**
 * Execute-swap, sent by the agent. The vault sends at most `amountIn` of
 * `tokenIn`, and the adapter sends at least `minOut` of `tokenOut`. When the
 * adapter's route in `config.adapters` names a pool, two more entries cover
 * the pool leg: the adapter sends at most `amountIn` of `tokenIn`, and the
 * pool sends at least `minOut` of `tokenOut`. A route with `pool: null`
 * (mock-dex pays out from its own balance) adds nothing. No entry names the
 * agent, so in Deny mode any transfer out of the agent aborts the transaction.
 */
export function buildExecuteSwap(
  config: TxConfig,
  input: ExecuteSwapInput,
): VaultCall {
  const target = splitVault(config);
  checkPrincipal("owner", input.owner, false);
  checkSwapTerms(input);
  const postConditions = swapPostConditions(config, input);
  return call(
    target,
    "execute-swap",
    [Cl.principal(input.owner), ...swapArgs(input)],
    postConditions,
  );
}

/**
 * Set-approval-threshold, sent by the owner: a trade selling more than
 * `threshold` of `token` then needs the owner's approval. `null` clears the
 * threshold. Moves nothing: deny mode with no post-conditions.
 */
export function buildSetApprovalThreshold(
  config: TxConfig,
  input: SetApprovalThresholdInput,
): VaultCall {
  const target = splitVault(config);
  checkPrincipal("token", input.token, true);
  if (input.threshold !== null) checkUint("threshold", input.threshold);
  return call(target, "set-approval-threshold", [
    Cl.principal(input.token),
    input.threshold === null ? Cl.none() : Cl.some(Cl.uint(input.threshold)),
  ]);
}

/**
 * Request-swap, sent by the agent for a trade above the owner's approval
 * threshold. It takes `buildExecuteSwap`'s input and moves nothing: the call
 * is in deny mode with no post-conditions, so any transfer aborts it. The
 * amounts are held to the same bounds as `buildExecuteSwap`'s, because the
 * owner's `approve-swap` carries them in post-conditions. It needs no asset
 * name and no adapter route.
 */
export function buildRequestSwap(
  config: TxConfig,
  input: RequestSwapInput,
): VaultCall {
  const target = splitVault(config);
  checkPrincipal("owner", input.owner, false);
  checkSwapTerms(input);
  return call(target, "request-swap", [
    Cl.principal(input.owner),
    ...swapArgs(input),
  ]);
}

/**
 * Approve-swap, sent by the owner for their pending request. The swap moves
 * tokens exactly as `execute-swap` does, so the post-conditions are
 * `buildExecuteSwap`'s for the same trade: the vault sends at most
 * `amountIn` of `tokenIn`, the adapter sends at least `minOut` of
 * `tokenOut`, and a route with a pool adds its two entries. No entry names
 * the owner or the agent. `requestedAt` is the burn height of the request
 * the owner read: the contract refuses with u131 unless the stored request
 * was made at that height, so the signed transaction cannot run a later
 * request with the same trade.
 */
export function buildApproveSwap(
  config: TxConfig,
  input: ApproveSwapInput,
): VaultCall {
  const target = splitVault(config);
  checkSwapTerms(input);
  checkUint("requestedAt", input.requestedAt);
  const postConditions = swapPostConditions(config, input);
  return call(
    target,
    "approve-swap",
    [...swapArgs(input), Cl.uint(input.requestedAt)],
    postConditions,
  );
}

/**
 * Reject-swap, sent by the owner: removes their pending request, expired or
 * not, without running it. Moves nothing: deny mode with no post-conditions.
 */
export function buildRejectSwap(config: TxConfig): VaultCall {
  return call(splitVault(config), "reject-swap");
}

/**
 * Cancel-swap-request, sent by the agent that made `owner`'s pending
 * request. Moves nothing: deny mode with no post-conditions.
 */
export function buildCancelSwapRequest(
  config: TxConfig,
  input: CancelSwapRequestInput,
): VaultCall {
  const target = splitVault(config);
  checkPrincipal("owner", input.owner, false);
  return call(target, "cancel-swap-request", [Cl.principal(input.owner)]);
}
