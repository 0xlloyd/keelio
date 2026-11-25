// The demo page's simnet session, with no DOM, so tests can drive it in Node.
// It imports the SDK by file, not through its index, so the Stacks API client
// never reaches the page bundle. Nothing here signs or broadcasts.
import { Cl, type ClarityValue } from "@stacks/transactions";
import {
  buildAllowAdapter,
  buildAllowToken,
  buildDeposit,
  buildExecuteSwap,
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
  type VaultRead,
} from "../../../packages/sdk/src/read-vault.js";
import {
  checkIntent,
  type IntentCheck,
} from "../../../packages/sdk/src/vault.js";
import { formatBtc, formatUnits } from "../../../scripts/format-amount.js";

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

/** The part of the browser SDK's simnet the demo uses. */
export interface DemoSimnet {
  /** The third argument is the remote-data API URL; the demo passes `null`. */
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
  ): { result: ClarityValue };
  callReadOnlyFn(
    contract: string,
    method: string,
    args: ClarityValue[],
    sender: string,
  ): { result: ClarityValue };
  readonly burnBlockHeight: number;
  /** The latest block's `stacks-block-time`, in seconds. */
  getBlockTime(): bigint | number;
}

export type SwapOutcome = { check: IntentCheck } & (
  { result: ClarityValue } | { buildError: string }
);

export interface DemoSession {
  owner: string;
  agent: string;
  ids: { sbtc: string; usd: string; dex: string; vault: string };
  /** The four mock calls, then the eight owner calls, as `runDemo` collects them. */
  setup: ClarityValue[];
  read(): Promise<{ vault: VaultRead; burnHeight: bigint }>;
  swap(input: { amountIn: bigint; minOut: bigint }): Promise<SwapOutcome>;
}

/** Every keelio-vault error code, copied from docs/errors.md. */
export const ERROR_NAMES: Readonly<Record<string, string>> = {
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

// The setup constants of `runDemo` in scripts/demo.ts. Keep them in step.
const SBTC_SUPPLY = 100_000_000n;
const USD_RESERVES = 1_000_000_000_000n;
const RATE = 900n;
const DEPOSIT = 100_000_000n;
const MAX_PER_TRADE = 10_000_000n;
const MAX_PER_DAY = 30_000_000n;
const USD_MAX_PER_TRADE = 10_000_000_000n;
const USD_MAX_PER_DAY = 30_000_000_000n;
const POLICY_BLOCKS = 1000n;
const ORACLE_PRICE = 9_000_000_000_000n;
const MAX_SLIPPAGE_BPS = 100n;
const MAX_PRICE_AGE_MS = 3_600_000n;
// The vault's PRICE-SCALE: 10^(8 + 8 - 6) for the oracle's 8 decimals,
// sBTC's 8 and mock-usd's 6.
const PRICE_SCALE = 10_000_000_000n;

const MAX_UINT = 2n ** 128n - 1n;

/** `checkIntent`'s answer in the words `renderDemo` uses. */
export function describeCheck(check: IntentCheck): string {
  return check.ok
    ? "ok, no policy rule refuses"
    : `${check.rule} (u${check.errorCode}): ${check.message}`;
}

/**
 * `execute-swap`'s result: an error with its keelio-vault constant name, or
 * the USD an sBTC sale received.
 */
export function describeResult(result: ClarityValue): string {
  const shown = Cl.prettyPrint(result);
  if (result.type === "err" && result.value.type === "uint") {
    const name = ERROR_NAMES[result.value.value.toString()];
    return name === undefined ? shown : `${shown} ${name}`;
  }
  if (result.type === "ok" && result.value.type === "uint") {
    const received = BigInt(result.value.value);
    return `${shown}, ${formatUnits(received, 6)} USD received`;
  }
  return shown;
}

/**
 * A whole number of base units in `[min, 2^128 - 1]`, or `null`. Digits only
 * after trimming, parsed with `BigInt`, so no amount passes through a float.
 */
export function parseBaseUnits(text: string, min: bigint): bigint | null {
  const trimmed = text.trim();
  if (!/^[0-9]+$/.test(trimmed)) return null;
  const value = BigInt(trimmed);
  return value < min || value > MAX_UINT ? null : value;
}

function ok(value: ClarityValue, what: string): ClarityValue {
  if (value.type !== "ok") {
    throw new Error(`${what} failed: ${Cl.prettyPrint(value)}`);
  }
  return value;
}

/**
 * Starts the session from the files in the virtual store and runs the setup
 * of `runDemo` (scripts/demo.ts): the mocks, then the owner opens the vault.
 * Throws if any setup call is not `ok`.
 */
export async function startDemo(simnet: DemoSimnet): Promise<DemoSession> {
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
    vault: "keelio-vault",
    tokens: [sbtc, usd],
    adapters: [dex],
    oracle: "mock-oracle",
    sbtcToken: sbtc,
    priceScale: PRICE_SCALE,
  };
  const client = simnetClient(simnet, deployer);

  const send = (call: VaultCall, sender: string): ClarityValue =>
    simnet.callPublicFn(
      `${call.contractAddress}.${call.contractName}`,
      call.functionName,
      call.functionArgs,
      sender,
    ).result;
  const mock = (contract: string, fn: string, args: ClarityValue[]) =>
    simnet.callPublicFn(contract, fn, args, deployer).result;

  const setup = [
    mock("mock-sbtc", "mint", [Cl.uint(SBTC_SUPPLY), Cl.principal(owner)]),
    mock("mock-usd", "mint", [Cl.uint(USD_RESERVES), Cl.principal(dex)]),
    mock("mock-dex", "set-rate", [Cl.uint(RATE), Cl.uint(1)]),
    mock("mock-oracle", "set-value-aged", [
      Cl.stringAscii("BTC/USD"),
      Cl.uint(ORACLE_PRICE),
      Cl.uint(0),
    ]),
  ];
  setup.push(
    send(buildDeposit(tx, { owner, token: sbtc, amount: DEPOSIT }), owner),
  );
  const policyHeight = BigInt(simnet.burnBlockHeight);
  setup.push(
    send(buildSetAgent(tx, { agent }), owner),
    send(
      buildSetTokenCaps(tx, {
        token: sbtc,
        maxPerTrade: MAX_PER_TRADE,
        maxPerDay: MAX_PER_DAY,
      }),
      owner,
    ),
    send(
      buildSetTokenCaps(tx, {
        token: usd,
        maxPerTrade: USD_MAX_PER_TRADE,
        maxPerDay: USD_MAX_PER_DAY,
      }),
      owner,
    ),
    send(
      buildSetPolicy(tx, {
        cooldownBlocks: 0n,
        expiresAt: policyHeight + POLICY_BLOCKS,
      }),
      owner,
    ),
    send(buildAllowToken(tx, { token: sbtc, allowed: true }), owner),
    send(buildAllowToken(tx, { token: usd, allowed: true }), owner),
    send(buildAllowAdapter(tx, { adapter: dex, allowed: true }), owner),
    send(
      buildSetPriceBounds(tx, {
        maxSlippageBps: MAX_SLIPPAGE_BPS,
        maxPriceAge: MAX_PRICE_AGE_MS,
      }),
      owner,
    ),
  );
  setup.forEach((value, i) => ok(value, `setup call ${i + 1}`));

  const read = async () => ({
    vault: await readVault(client, readConfig, owner),
    burnHeight: BigInt(simnet.burnBlockHeight),
  });

  const swap = async ({
    amountIn,
    minOut,
  }: {
    amountIn: bigint;
    minOut: bigint;
  }): Promise<SwapOutcome> => {
    const { vault: state, burnHeight } = await read();
    const check = checkIntent(
      { ...state, burnHeight, nowMs: BigInt(simnet.getBlockTime()) * 1000n },
      {
        caller: agent,
        adapter: dex,
        tokenIn: sbtc,
        tokenOut: usd,
        amountIn,
        minOut,
      },
    );
    let call: VaultCall;
    try {
      call = buildExecuteSwap(tx, {
        owner,
        adapter: dex,
        tokenIn: sbtc,
        tokenOut: usd,
        amountIn,
        minOut,
      });
    } catch (error) {
      if (error instanceof TxBuildError) {
        return { check, buildError: error.message };
      }
      throw error;
    }
    // Sent even when checkIntent refuses: the page shows the contract
    // refusing for the same rule.
    return { check, result: send(call, agent) };
  };

  return {
    owner,
    agent,
    ids: { sbtc, usd, dex, vault },
    setup,
    read,
    swap,
  };
}

/** Amounts in each token's units, for the page. */
export const formatSbtc = (amount: bigint): string =>
  `${formatBtc(amount)} sBTC`;
export const formatUsd = (amount: bigint): string =>
  `${formatUnits(amount, 6)} USD`;
