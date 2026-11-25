// The simnet harness: everything in this example you would NOT keep on a real
// network. It stands in for the chain, the owner, the market and the agent's
// wallet, on Clarinet's in-process simnet with its throwaway accounts.
// Nothing is signed or broadcast.
import type { initSimnet } from "@stacks/clarinet-sdk";
import { Cl, type ClarityValue } from "@stacks/transactions";
import { vaultPrints } from "../../packages/mcp/src/chain.js";
import {
  buildAllowAdapter,
  buildAllowToken,
  buildDeposit,
  buildPause,
  buildSetAgent,
  buildSetPolicy,
  buildSetPriceBounds,
  buildSetTokenCaps,
  simnetClient,
  type TxConfig,
  type VaultCall,
  type VaultConfig,
} from "../../packages/sdk/src/index.js";
import type { AgentConfig, Chain, JournalRecord, Wallet } from "./agent.js";

export type Simnet = Awaited<ReturnType<typeof initSimnet>>;

/** The vault's PRICE-SCALE: 10^(8 + 8 - 6), for the oracle's 8 decimals, sBTC's 8 and mock-usd's 6. */
export const PRICE_SCALE = 10_000_000_000n;

/** What the owner deposits and allows. Base units: sats, and USD with 6 decimals. */
export const OWNER_SETUP = {
  sbtcDeposit: 50_000_000n,
  usdDeposit: 45_000_000_000n,
  sbtcMaxPerTrade: 5_000_000n,
  sbtcMaxPerDay: 15_000_000n,
  usdMaxPerTrade: 5_000_000_000n,
  usdMaxPerDay: 15_000_000_000n,
  cooldownBlocks: 3n,
  policyBlocks: 1000n,
  maxSlippageBps: 100n,
  maxPriceAgeMs: 3_600_000n,
} as const;

/** The mock DEX's reserves, so it can pay out either token. */
const DEX_SBTC = 1_000_000_000n;
const DEX_USD = 1_000_000_000_000n;

export interface Harness {
  owner: string;
  agent: string;
  ids: {
    vault: string;
    sbtc: string;
    usd: string;
    dex: string;
    oracle: string;
  };
  read: VaultConfig;
  tx: TxConfig;
  chain: Chain;
  wallet: Wallet;
  /** Sets the oracle's BTC/USD price (8 decimals), timestamped now. */
  setPrice(price: bigint): void;
  mineBurnBlocks(count: number): void;
  /** The owner pauses the vault. */
  pause(): ClarityValue;
  /** Runs `action` just before the agent's next transaction is mined. */
  beforeNextSubmit(action: () => void): void;
  /** A token balance outside the vault, to show the agent holds nothing. */
  walletBalance(token: string, who: string): bigint;
}

function expectOk(what: string, result: ClarityValue): void {
  if (result.type !== "ok") {
    throw new Error(`${what} failed: ${Cl.prettyPrint(result)}`);
  }
}

/**
 * Mints the mock tokens, has the owner open a vault and name the agent, and
 * returns the simnet-backed `Chain` and `Wallet` the agent runs against.
 */
export function openVault(simnet: Simnet): Harness {
  const accounts = simnet.getAccounts();
  const account = (name: string): string => {
    const address = accounts.get(name);
    if (address === undefined) throw new Error(`no simnet account ${name}`);
    return address;
  };
  const deployer = account("deployer");
  const owner = account("wallet_1");
  const agent = account("wallet_2");
  const ids = {
    vault: `${deployer}.keelio-vault`,
    sbtc: `${deployer}.mock-sbtc`,
    usd: `${deployer}.mock-usd`,
    dex: `${deployer}.mock-dex`,
    oracle: `${deployer}.mock-oracle`,
  };
  const read: VaultConfig = {
    vault: ids.vault,
    tokens: [ids.sbtc, ids.usd],
    adapters: [ids.dex],
    oracle: ids.oracle,
    sbtcToken: ids.sbtc,
    priceScale: PRICE_SCALE,
  };
  const tx: TxConfig = {
    vault: ids.vault,
    assetNames: { [ids.sbtc]: "mock-sbtc", [ids.usd]: "mock-usd" },
    adapters: { [ids.dex]: { pool: null } },
  };

  // The simnet keeps no event history, so the harness keeps the journal: the
  // vault's print events from every call made through `send`.
  const journal: JournalRecord[] = [];
  const send = (call: VaultCall, sender: string): ClarityValue => {
    const burnHeight = BigInt(simnet.burnBlockHeight);
    const response = simnet.callPublicFn(
      `${call.contractAddress}.${call.contractName}`,
      call.functionName,
      call.functionArgs,
      sender,
    );
    for (const value of vaultPrints(response.events, ids.vault)) {
      journal.push({ burnHeight, value });
    }
    return response.result;
  };
  const mock = (contract: string, fn: string, args: ClarityValue[]): void =>
    expectOk(
      `${contract} ${fn}`,
      simnet.callPublicFn(contract, fn, args, deployer).result,
    );

  let price = 0n;
  const setPrice = (next: bigint): void => {
    price = next;
    mock(ids.oracle, "set-value-aged", [
      Cl.stringAscii("BTC/USD"),
      Cl.uint(next),
      Cl.uint(0),
    ]);
  };

  // Simnet-only mocks: tokens for the owner and reserves for the DEX.
  const mint = (token: string, amount: bigint, to: string): void =>
    mock(token, "mint", [Cl.uint(amount), Cl.principal(to)]);
  mint(ids.sbtc, OWNER_SETUP.sbtcDeposit, owner);
  mint(ids.usd, OWNER_SETUP.usdDeposit, owner);
  mint(ids.sbtc, DEX_SBTC, ids.dex);
  mint(ids.usd, DEX_USD, ids.dex);

  // The owner opens the vault. Each call is built with the SDK, as the
  // owner's wallet would, and sent as the owner.
  const expiresAt = BigInt(simnet.burnBlockHeight) + OWNER_SETUP.policyBlocks;
  const ownerCalls: [string, VaultCall][] = [
    [
      "deposit sBTC",
      buildDeposit(tx, {
        owner,
        token: ids.sbtc,
        amount: OWNER_SETUP.sbtcDeposit,
      }),
    ],
    [
      "deposit USD",
      buildDeposit(tx, {
        owner,
        token: ids.usd,
        amount: OWNER_SETUP.usdDeposit,
      }),
    ],
    ["set-agent", buildSetAgent(tx, { agent })],
    [
      "set-token-caps sBTC",
      buildSetTokenCaps(tx, {
        token: ids.sbtc,
        maxPerTrade: OWNER_SETUP.sbtcMaxPerTrade,
        maxPerDay: OWNER_SETUP.sbtcMaxPerDay,
      }),
    ],
    [
      "set-token-caps USD",
      buildSetTokenCaps(tx, {
        token: ids.usd,
        maxPerTrade: OWNER_SETUP.usdMaxPerTrade,
        maxPerDay: OWNER_SETUP.usdMaxPerDay,
      }),
    ],
    [
      "set-policy",
      buildSetPolicy(tx, {
        cooldownBlocks: OWNER_SETUP.cooldownBlocks,
        expiresAt,
      }),
    ],
    [
      "allow-token sBTC",
      buildAllowToken(tx, { token: ids.sbtc, allowed: true }),
    ],
    ["allow-token USD", buildAllowToken(tx, { token: ids.usd, allowed: true })],
    [
      "allow-adapter",
      buildAllowAdapter(tx, { adapter: ids.dex, allowed: true }),
    ],
    [
      "set-price-bounds",
      buildSetPriceBounds(tx, {
        maxSlippageBps: OWNER_SETUP.maxSlippageBps,
        maxPriceAge: OWNER_SETUP.maxPriceAgeMs,
      }),
    ],
  ];
  for (const [what, call] of ownerCalls) expectOk(what, send(call, owner));

  const chain: Chain = {
    client: simnetClient(simnet, deployer),
    burnHeight: () => BigInt(simnet.burnBlockHeight),
    blockTimeMs: () => BigInt(simnet.getBlockTime()) * 1000n,
    journal: () => [...journal],
  };

  let pending: (() => void) | null = null;
  const wallet: Wallet = {
    // The simnet has no keys to sign with and no mempool: "submit" is a direct
    // call with the agent as sender. It does not check the post-conditions.
    async submit(call) {
      pending?.();
      pending = null;
      // mock-dex has one rate for both directions, so point it the way this
      // swap goes, at the oracle's price. A real DEX prices itself.
      const tokenIn = call.functionArgs[2];
      const selling =
        tokenIn !== undefined && Cl.prettyPrint(tokenIn) === `'${ids.sbtc}`;
      mock(
        ids.dex,
        "set-rate",
        selling
          ? [Cl.uint(price), Cl.uint(PRICE_SCALE)]
          : [Cl.uint(PRICE_SCALE), Cl.uint(price)],
      );
      return send(call, agent);
    },
  };

  return {
    owner,
    agent,
    ids,
    read,
    tx,
    chain,
    wallet,
    setPrice,
    mineBurnBlocks: (count) => {
      simnet.mineEmptyBurnBlocks(count);
    },
    pause: () => send(buildPause(tx), owner),
    beforeNextSubmit: (action) => {
      pending = action;
    },
    walletBalance: (token, who) => {
      const { result } = simnet.callReadOnlyFn(
        token,
        "get-balance",
        [Cl.principal(who)],
        deployer,
      );
      if (result.type !== "ok" || result.value.type !== "uint") {
        throw new Error(`get-balance: ${Cl.prettyPrint(result)}`);
      }
      return BigInt(result.value.value);
    },
  };
}

/** The agent's settings for this run. On a real network these are yours. */
export function agentConfig(harness: Harness): AgentConfig {
  return {
    owner: harness.owner,
    agent: harness.agent,
    sbtc: harness.ids.sbtc,
    quote: harness.ids.usd,
    adapter: harness.ids.dex,
    read: harness.read,
    tx: harness.tx,
    targetSbtcBps: 5_000n,
    bandBps: 200n,
    toleranceBps: 30n,
    riskBps: 50n,
    stopBps: 1_000n,
    lotSize: 1_000n,
  };
}
