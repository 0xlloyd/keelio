// `ChainSession` on the in-page Clarinet simnet, with no DOM, so tests drive
// it in Node. It imports the SDK by file, not through its index, so the
// Stacks API client never reaches the page bundle. Nothing here signs or
// broadcasts: the simnet runs each call in memory.
import { Cl, type ClarityValue } from "@stacks/transactions";
import {
  buildAllowAdapter,
  buildAllowToken,
  buildCancelSwapRequest,
  buildDeposit,
  buildExecuteSwap,
  buildRequestSwap,
  buildSetAgent,
  buildSetPolicy,
  buildSetPriceBounds,
  buildSetTokenCaps,
  TxBuildError,
  type TxConfig,
  type VaultCall,
} from "../../../packages/sdk/src/build-tx.js";
import {
  readVault,
  simnetClient,
  type VaultConfig,
} from "../../../packages/sdk/src/read-vault.js";
import {
  checkCancelRequest,
  checkIntent,
  checkRequest,
  type CancelCheck,
  type IntentCheck,
  type RequestCheck,
} from "../../../packages/sdk/src/vault.js";
import type {
  ChainConfig,
  ChainRead,
  ChainSession,
  JournalRecord,
  Receipt,
} from "./chain.js";

/** Project files by repo-relative path, for example `"contracts/keelio-vault.clar"`. */
export type ProjectFiles = Readonly<Record<string, string>>;

/** The directory the simnet session treats as the project root. */
const PROJECT_DIR = "/project";

/** Writes each file to the simnet's virtual file store as `/project/<path>`. */
export function loadProject(
  store: Map<string, string>,
  files: ProjectFiles,
): void {
  for (const [path, content] of Object.entries(files)) {
    store.set(`${PROJECT_DIR}/${path}`, content);
  }
}

interface SimnetEvent {
  event: string;
  data: { contract_identifier?: string; value?: ClarityValue };
}

/** The part of the browser SDK's simnet the dashboard uses. */
export interface DashboardSimnet {
  /** The third argument is the remote-data API URL; the dashboard passes `null`. */
  initSession(
    cwd: string,
    manifestPath: string,
    apiBaseUrl: null,
  ): Promise<void>;
  getAccounts(): Map<string, string>;
  callPublicFn(
    contract: string,
    method: string,
    args: ClarityValue[],
    sender: string,
    options?: Pick<VaultCall, "postConditions" | "postConditionMode">,
  ): { result: ClarityValue; events: SimnetEvent[] };
  callReadOnlyFn(
    contract: string,
    method: string,
    args: ClarityValue[],
    sender: string,
  ): { result: ClarityValue };
  mineEmptyBurnBlocks(count?: number | null): number;
  readonly burnBlockHeight: number;
  /** The latest block's `stacks-block-time`, in seconds. */
  getBlockTime(): bigint | number;
}

export interface SwapInput {
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  minOut: bigint;
}

/** One agent trade: the SDK's prediction, then what the contract did. */
export type SwapOutcome = { check: IntentCheck } & (
  { call: VaultCall; receipt: Receipt } | { buildError: string }
);

/** One agent request for approval: the SDK's prediction, then the contract. */
export type RequestOutcome = { check: RequestCheck } & (
  { call: VaultCall; receipt: Receipt } | { buildError: string }
);

/** The agent withdrawing its request: the SDK's prediction, then the contract. */
export interface CancelOutcome {
  check: CancelCheck;
  call: VaultCall;
  receipt: Receipt;
}

/** One owner call of the example setup, and what the contract did. */
export interface SetupStep {
  call: VaultCall;
  receipt: Receipt;
}

/**
 * The simnet session: the owner's `ChainSession`, plus the parts that exist
 * only in a simulation. A testnet session has none of them.
 */
export interface SimulationSession extends ChainSession {
  /** A second simnet account that plays the trading agent. */
  readonly agent: string;
  /**
   * The agent calls `execute-swap` on mock-dex. The call is sent even when
   * `checkIntent` predicts a refusal, so the page shows the contract refusing.
   */
  agentSwap(input: SwapInput): Promise<SwapOutcome>;
  /**
   * The agent calls `request-swap`: it asks the owner to approve a trade
   * above the owner's approval threshold. Sent even when `checkRequest`
   * predicts a refusal, as `agentSwap` is.
   */
  agentRequest(input: SwapInput): Promise<RequestOutcome>;
  /** The agent calls `cancel-swap-request` to withdraw its request. */
  agentCancelRequest(): Promise<CancelOutcome>;
  /** Mines empty burn blocks and returns the new burn height. */
  advanceBurnBlocks(count: number): Promise<bigint>;
  /** Sets the mock oracle's BTC/USD price (8 decimals), timestamped now. */
  setOraclePrice(price: bigint): Promise<Receipt>;
  /**
   * The nine owner calls that open a working vault, each sent through
   * `submit`. Stops at the first call that is not `ok`.
   */
  runExampleSetup(): Promise<SetupStep[]>;
}

// Simnet-only mock state, as in scripts/demo.ts.
export const SBTC_MINTED = 100_000_000n;
const USD_RESERVES = 1_000_000_000_000n;
/** mock-dex pays this many USD base units per sat: $90,000 per BTC. */
const RATE = 900n;
export const ORACLE_PRICE = 9_000_000_000_000n;
// The vault's PRICE-SCALE: 10^(8 + 8 - 6) for the oracle's 8 decimals,
// sBTC's 8 and mock-usd's 6.
const PRICE_SCALE = 10_000_000_000n;

/** The example setup's values. */
export const EXAMPLE = {
  deposit: 50_000_000n,
  sbtcMaxPerTrade: 10_000_000n,
  sbtcMaxPerDay: 30_000_000n,
  usdMaxPerTrade: 10_000_000_000n,
  usdMaxPerDay: 30_000_000_000n,
  cooldownBlocks: 0n,
  policyBlocks: 1000n,
  maxSlippageBps: 100n,
  maxPriceAgeMs: 3_600_000n,
  /** Not part of the example setup: the threshold form's starting value. */
  approvalThreshold: 5_000_000n,
} as const;

const POST_CONDITION_FAILURE = "Post-condition check failure";

/**
 * Starts the session from the files in the virtual store and sets up the
 * mocks: 1 mock sBTC for the owner, USD reserves and a rate for mock-dex, and
 * an oracle price. The vault itself is left untouched: the owner opens it
 * from the dashboard. Throws if a mock call is not `ok`.
 */
export async function startSimnetChain(
  simnet: DashboardSimnet,
): Promise<SimulationSession> {
  await simnet.initSession(PROJECT_DIR, "Clarinet.toml", null);

  const accounts = simnet.getAccounts();
  const account = (name: string): string => {
    const address = accounts.get(name);
    if (address === undefined) throw new Error(`no simnet account ${name}`);
    return address;
  };
  const deployer = account("deployer");
  const owner = account("wallet_1");
  const agent = account("wallet_2");
  const sbtc = `${deployer}.mock-sbtc`;
  const usd = `${deployer}.mock-usd`;
  const dex = `${deployer}.mock-dex`;
  const vault = `${deployer}.keelio-vault`;

  const tx: TxConfig = {
    vault,
    assetNames: { [sbtc]: "mock-sbtc", [usd]: "mock-usd" },
    adapters: { [dex]: { pool: null } },
  };
  const readConfig: VaultConfig = {
    vault,
    tokens: [sbtc, usd],
    adapters: [dex],
    oracle: `${deployer}.mock-oracle`,
    sbtcToken: sbtc,
    priceScale: PRICE_SCALE,
  };
  const config: ChainConfig = {
    tx,
    read: readConfig,
    tokens: [
      {
        id: sbtc,
        name: "mock sBTC",
        symbol: "sBTC",
        decimals: 8,
        unit: "sats",
      },
      {
        id: usd,
        name: "mock USD",
        symbol: "USD",
        decimals: 6,
        unit: "base units",
      },
    ],
    adapters: [{ id: dex, name: "mock-dex" }],
    labels: {
      [owner]: "the owner",
      [agent]: "the agent",
      [vault]: "the vault",
      [dex]: "mock-dex",
      [sbtc]: "mock sBTC",
      [usd]: "mock USD",
    },
  };
  const client = simnetClient(simnet, deployer);
  // The simnet keeps no event history, so the journal is recorded here.
  const journal: JournalRecord[] = [];

  const attempt = (
    call: VaultCall,
    sender: string,
    postConditions: VaultCall["postConditions"],
  ): ReturnType<DashboardSimnet["callPublicFn"]> | { aborted: string } => {
    try {
      return simnet.callPublicFn(
        `${call.contractAddress}.${call.contractName}`,
        call.functionName,
        call.functionArgs,
        sender,
        { postConditions, postConditionMode: call.postConditionMode },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const at = message.indexOf(POST_CONDITION_FAILURE);
      if (at === -1) throw error;
      return { aborted: message.slice(at) };
    }
  };

  /**
   * Sends a built call with its post-conditions and journals its events.
   *
   * When the contract returns `(err …)` nothing moves, so a condition such as
   * "sends exactly N" fails and the simnet reports only that. To still show
   * the contract's code, the call is then run once more with no conditions in
   * Deny mode: an `(err …)` comes back as it is, and a call that would move
   * any token is aborted again, so this second run can never change state.
   */
  const send = (call: VaultCall, sender: string): Receipt => {
    const burnHeight = BigInt(simnet.burnBlockHeight);
    const response = attempt(call, sender, call.postConditions);
    if ("aborted" in response) {
      const bare = attempt(call, sender, []);
      if (!("aborted" in bare) && bare.result.type === "err") {
        return {
          status: "refused",
          result: bare.result,
          postCondition: response.aborted,
        };
      }
      return { status: "aborted", reason: response.aborted };
    }
    if (response.result.type !== "ok") {
      return { status: "refused", result: response.result };
    }
    for (const e of response.events) {
      if (
        e.event === "print_event" &&
        e.data.contract_identifier === vault &&
        e.data.value !== undefined
      ) {
        journal.push({ burnHeight, value: e.data.value });
      }
    }
    return { status: "ok", result: response.result };
  };

  const mock = (
    contract: string,
    fn: string,
    args: ClarityValue[],
  ): Receipt => {
    const result = simnet.callPublicFn(contract, fn, args, deployer).result;
    return result.type === "ok"
      ? { status: "ok", result }
      : { status: "refused", result };
  };
  const mustMock = (contract: string, fn: string, args: ClarityValue[]) => {
    const receipt = mock(contract, fn, args);
    if (receipt.status !== "ok") {
      throw new Error(`mock setup ${contract}.${fn} failed`);
    }
  };
  const setOracle = (price: bigint): Receipt =>
    mock("mock-oracle", "set-value-aged", [
      Cl.stringAscii("BTC/USD"),
      Cl.uint(price),
      Cl.uint(0),
    ]);

  mustMock("mock-sbtc", "mint", [Cl.uint(SBTC_MINTED), Cl.principal(owner)]);
  mustMock("mock-usd", "mint", [Cl.uint(USD_RESERVES), Cl.principal(dex)]);
  mustMock("mock-dex", "set-rate", [Cl.uint(RATE), Cl.uint(1)]);
  if (setOracle(ORACLE_PRICE).status !== "ok") {
    throw new Error("mock setup mock-oracle.set-value-aged failed");
  }

  const walletBalance = (token: string): bigint => {
    const answer = simnet.callReadOnlyFn(
      token,
      "get-balance",
      [Cl.principal(owner)],
      deployer,
    ).result;
    if (answer.type !== "ok" || answer.value.type !== "uint") {
      throw new Error(`${token} get-balance did not return (ok uint)`);
    }
    return BigInt(answer.value.value);
  };

  const read = async (): Promise<ChainRead> => {
    const wallet: Record<string, bigint> = {};
    for (const token of config.tokens) {
      wallet[token.id] = walletBalance(token.id);
    }
    return {
      vault: await readVault(client, readConfig, owner),
      burnHeight: BigInt(simnet.burnBlockHeight),
      nowMs: BigInt(simnet.getBlockTime()) * 1000n,
      wallet,
    };
  };

  const agentSwap = async (input: SwapInput): Promise<SwapOutcome> => {
    const state = await read();
    const intent = { caller: agent, adapter: dex, ...input };
    const check = checkIntent(
      { ...state.vault, burnHeight: state.burnHeight, nowMs: state.nowMs },
      intent,
    );
    let call: VaultCall;
    try {
      call = buildExecuteSwap(tx, { owner, adapter: dex, ...input });
    } catch (error) {
      if (error instanceof TxBuildError) {
        return { check, buildError: error.message };
      }
      throw error;
    }
    // mock-dex holds one rate, so point it the way this trade goes.
    if (input.tokenIn === sbtc) {
      mustMock("mock-dex", "set-rate", [Cl.uint(RATE), Cl.uint(1)]);
    } else {
      mustMock("mock-dex", "set-rate", [Cl.uint(1), Cl.uint(RATE)]);
    }
    return { check, call, receipt: send(call, agent) };
  };

  const agentRequest = async (input: SwapInput): Promise<RequestOutcome> => {
    const state = await read();
    const check = checkRequest(
      { ...state.vault, burnHeight: state.burnHeight, nowMs: state.nowMs },
      { caller: agent, adapter: dex, ...input },
    );
    try {
      const call = buildRequestSwap(tx, { owner, adapter: dex, ...input });
      return { check, call, receipt: send(call, agent) };
    } catch (error) {
      if (error instanceof TxBuildError) {
        return { check, buildError: error.message };
      }
      throw error;
    }
  };

  const agentCancelRequest = async (): Promise<CancelOutcome> => {
    const state = await read();
    const check = checkCancelRequest(state.vault, agent);
    const call = buildCancelSwapRequest(tx, { owner });
    return { check, call, receipt: send(call, agent) };
  };

  /**
   * mock-dex holds one rate. An approved request trades at approval, so the
   * rate is pointed the way the trade goes before the owner's `approve-swap`
   * runs, as `agentSwap` does for the agent's own trade. The direction is
   * read from the call itself (its `token-in` argument), not from the stored
   * request: the call names the request the owner approved, and the vault
   * refuses it (u131) if another one is stored.
   */
  const pointDexForApproval = (call: VaultCall): void => {
    if (call.functionName !== "approve-swap") return;
    const tokenIn = call.functionArgs[1];
    if (tokenIn === undefined) return;
    if (Cl.prettyPrint(tokenIn) === `'${sbtc}`) {
      mustMock("mock-dex", "set-rate", [Cl.uint(RATE), Cl.uint(1)]);
    } else {
      mustMock("mock-dex", "set-rate", [Cl.uint(1), Cl.uint(RATE)]);
    }
  };

  const runExampleSetup = async (): Promise<SetupStep[]> => {
    const expiresAt = BigInt(simnet.burnBlockHeight) + EXAMPLE.policyBlocks;
    const calls = [
      buildDeposit(tx, { owner, token: sbtc, amount: EXAMPLE.deposit }),
      buildSetAgent(tx, { agent }),
      buildSetTokenCaps(tx, {
        token: sbtc,
        maxPerTrade: EXAMPLE.sbtcMaxPerTrade,
        maxPerDay: EXAMPLE.sbtcMaxPerDay,
      }),
      buildSetTokenCaps(tx, {
        token: usd,
        maxPerTrade: EXAMPLE.usdMaxPerTrade,
        maxPerDay: EXAMPLE.usdMaxPerDay,
      }),
      buildSetPolicy(tx, {
        cooldownBlocks: EXAMPLE.cooldownBlocks,
        expiresAt,
      }),
      buildAllowToken(tx, { token: sbtc, allowed: true }),
      buildAllowToken(tx, { token: usd, allowed: true }),
      buildAllowAdapter(tx, { adapter: dex, allowed: true }),
      buildSetPriceBounds(tx, {
        maxSlippageBps: EXAMPLE.maxSlippageBps,
        maxPriceAge: EXAMPLE.maxPriceAgeMs,
      }),
    ];
    const steps: SetupStep[] = [];
    for (const call of calls) {
      const receipt = send(call, owner);
      steps.push({ call, receipt });
      if (receipt.status !== "ok") break;
    }
    return steps;
  };

  return {
    kind: "simulation",
    owner,
    agent,
    config,
    read,
    submit: async (call) => {
      pointDexForApproval(call);
      return send(call, owner);
    },
    // Every print of the vault contract, whoever sent the call.
    journal: async () => [...journal],
    journalScope: "contract",
    agentSwap,
    agentRequest,
    agentCancelRequest,
    advanceBurnBlocks: async (count) => {
      if (!Number.isSafeInteger(count) || count < 1) {
        throw new RangeError("count must be a whole number, 1 or more");
      }
      simnet.mineEmptyBurnBlocks(count);
      return BigInt(simnet.burnBlockHeight);
    },
    setOraclePrice: async (price) => setOracle(price),
    runExampleSetup,
  };
}
