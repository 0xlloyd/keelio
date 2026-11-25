// The dashboard's testnet session (apps/dashboard/src/wallet-chain.ts),
// proven with fakes only: no wallet, no deployed vault and no network.
//
// The stand-in node answers read-only calls from the Clarinet simnet and
// every other request in the shapes recorded from the public API
// (tests/fixtures/stacks-api/extended.json). The stand-in wallet "signs" by
// running the call on the simnet. The simnet does not enforce
// post-conditions, so the aborted receipts come from the recorded shapes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { initSimnet } from "@stacks/clarinet-sdk";
import {
  Cl,
  deserializePostConditionWire,
  wireToPostCondition,
  type ClarityValue,
} from "@stacks/transactions";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  ChainSession,
  SubmitProgress,
} from "../apps/dashboard/src/chain.js";
import {
  ChainApiError,
  type ApiFetch,
} from "../apps/dashboard/src/chain-api.js";
import {
  APPROVED_PROVIDER_IDS,
  connectWallet,
} from "../apps/dashboard/src/connect-wallet.js";
import {
  FLOWS,
  prepareCall,
  type FlowEnv,
  type FlowId,
  type FormValues,
} from "../apps/dashboard/src/flows.js";
import {
  describeReceipt,
  parseErrorTable,
  progressWords,
} from "../apps/dashboard/src/format.js";
import { journalEntries } from "../apps/dashboard/src/journal.js";
import { modeFromSearch } from "../apps/dashboard/src/mode.js";
import { vaultPanel } from "../apps/dashboard/src/panel.js";
import { reviewCall } from "../apps/dashboard/src/review.js";
import { connect, request } from "../apps/dashboard/src/stacks-connect.js";
import {
  assertTestnet,
  chainConfigOf,
  MAINNET_REFUSAL,
  MainnetRefusedError,
  parseTestnetConfig,
  type TestnetConfig,
} from "../apps/dashboard/src/testnet-config.js";
import {
  callDifference,
  startWalletChain,
  WalletChainError,
  type Wallet,
  type WalletChainOptions,
} from "../apps/dashboard/src/wallet-chain.js";
import type { VaultCall } from "../packages/sdk/src/build-tx.js";
import { readVault, simnetClient } from "../packages/sdk/src/read-vault.js";

const root = join(import.meta.dirname, "..");
const errors = parseErrorTable(
  readFileSync(join(root, "docs", "errors.md"), "utf8"),
);

type Json = Record<string, unknown>;
const recorded = JSON.parse(
  readFileSync(join(root, "tests/fixtures/stacks-api/extended.json"), "utf8"),
) as {
  info: Json;
  blockLatest: Json;
  balances: Json;
  contractEvents: { limit: number; offset: number; results: Json[] };
  eventTxs: Json[];
  txAbortByResponse: Json;
  txAbortByPostConditionErr: Json;
  txAbortByPostConditionOk: Json;
  txPending: Json;
  txNotFound: Json;
};
/** A recorded successful contract call that returned `(ok true)`. */
const recordedSuccess = recorded.eventTxs[1]!;

const simnet = await initSimnet();
const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const owner = accounts.get("wallet_1")!;
const agent = accounts.get("wallet_2")!;
const stranger = accounts.get("wallet_3")!;

const vault = `${deployer}.keelio-vault`;
const sbtc = `${deployer}.mock-sbtc`;
const usd = `${deployer}.mock-usd`;
const dex = `${deployer}.mock-dex`;
const oracle = `${deployer}.mock-oracle`;
const API = "https://api.testnet.example";
/** Testnet's `network_id`; mainnet's, in the recorded `/v2/info`, is 1. */
const TESTNET_NETWORK_ID = 2147483648;
// Valid mainnet principals, taken from the recorded responses.
const MAINNET_ADDRESS = "SP1MZ5N6YCQ5BFHK4N9NFGXG2K4N53BQ0MFXAKAC1";
const MAINNET_CONTRACT = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";

const config: TestnetConfig = {
  network: "testnet",
  apiUrl: API,
  vault,
  tokens: [
    {
      id: sbtc,
      assetName: "mock-sbtc",
      name: "test sBTC",
      symbol: "sBTC",
      decimals: 8,
      unit: "sats",
    },
    {
      id: usd,
      assetName: "mock-usd",
      name: "test USD",
      symbol: "USD",
      decimals: 6,
      unit: "base units",
    },
  ],
  sbtcToken: sbtc,
  adapters: [{ id: dex, name: "mock-dex", pool: null }],
  oracle,
  priceScale: 10_000_000_000n,
};

/** The config as the owner would write it in testnet.config.json. */
const configJson = {
  ...config,
  priceScale: config.priceScale.toString(),
};

// No test may reach the network: any use of the global fetch throws.
const globalFetch = vi.fn(() => {
  throw new Error("network disabled in tests");
});
beforeAll(() => {
  vi.stubGlobal("fetch", globalFetch);
});
afterAll(() => {
  vi.unstubAllGlobals();
  expect(globalFetch).not.toHaveBeenCalled();
});

// ---- the stand-in node ------------------------------------------------------

const CONDITION_CODES = {
  eq: "sent_equal_to",
  gte: "sent_greater_than_or_equal_to",
  lte: "sent_less_than_or_equal_to",
} as const;

/** The SDK's post-conditions in the API's recorded JSON form. */
function apiPostConditions(call: VaultCall): Json[] {
  return call.postConditions.map((pc) => {
    if (pc.type !== "ft-postcondition") throw new Error("not fungible");
    const [contract, assetName] = pc.asset.split("::");
    const [contractAddress, contractName] = contract!.split(".");
    const [address, name] = pc.address.split(".");
    return {
      principal:
        name === undefined
          ? { type_id: "principal_standard", address }
          : { type_id: "principal_contract", address, contract_name: name },
      condition_code:
        CONDITION_CODES[pc.condition as keyof typeof CONDITION_CODES],
      amount: pc.amount.toString(),
      type: "fungible",
      asset: {
        asset_name: assetName,
        contract_address: contractAddress,
        contract_name: contractName,
      },
    };
  });
}

/**
 * A recorded transaction response with its identity replaced by `call`'s:
 * who sent it, what it calls and the post-conditions it carries. The status,
 * result, block and error fields stay as recorded.
 */
function shaped(base: Json, txId: string, call: VaultCall, sender: string) {
  return {
    ...base,
    tx_id: txId,
    sender_address: sender,
    post_condition_mode: call.postConditionMode,
    post_conditions: apiPostConditions(call),
    tx_type: "contract_call",
    contract_call: {
      contract_id: `${call.contractAddress}.${call.contractName}`,
      function_name: call.functionName,
      function_args: call.functionArgs.map((arg) => ({
        hex: "0x" + Cl.serialize(arg),
        repr: Cl.prettyPrint(arg),
      })),
    },
  };
}

const clarityJson = (value: ClarityValue) => ({
  hex: "0x" + Cl.serialize(value),
  repr: Cl.prettyPrint(value),
});

class FakeNode {
  /** Every request made, as `METHOD path`. */
  readonly requests: string[] = [];
  networkId = TESTNET_NETWORK_ID;
  /** The API's own cap on an events page. */
  pageCap = 50;
  /** Serve each events page oldest first, to show the session sorts. */
  reversePages = false;
  private nextId = 1;
  private blockHeight = 1000;
  private readonly txs = new Map<string, Json>();
  /** Answers to serve for a tx id before its settled one. */
  private readonly queued = new Map<string, (Json | null)[]>();
  /** Oldest first. */
  private readonly events: Json[] = [];

  newTxId(): string {
    return "0x" + (this.nextId++).toString(16).padStart(64, "0");
  }

  /** Stores a transaction response as the API would serve it. */
  put(txId: string, tx: Json | null, before: (Json | null)[] = []): void {
    if (tx !== null) this.txs.set(txId, tx);
    this.queued.set(txId, [...before]);
  }

  /**
   * Runs the call on the simnet as `sender` and stores its transaction and
   * the vault's print events, as a node would after mining it.
   */
  mine(call: VaultCall, sender: string, change: Json = {}): string {
    const txId = this.newTxId();
    const { result, events } = simnet.callPublicFn(
      `${call.contractAddress}.${call.contractName}`,
      call.functionName,
      call.functionArgs,
      sender,
    );
    const ok = result.type === "ok";
    this.blockHeight += 1;
    this.txs.set(txId, {
      ...shaped(
        ok ? recordedSuccess : recorded.txAbortByResponse,
        txId,
        call,
        sender,
      ),
      tx_result: clarityJson(result),
      block_height: this.blockHeight,
      burn_block_height: simnet.burnBlockHeight,
      tx_index: 0,
      ...change,
    });
    if (ok) {
      events.forEach((event, index) => {
        if (event.event !== "print_event") return;
        const data = event.data as {
          contract_identifier: string;
          value: ClarityValue;
        };
        this.events.push({
          event_index: index,
          event_type: "smart_contract_log",
          tx_id: txId,
          contract_log: {
            contract_id: data.contract_identifier,
            topic: "print",
            value: clarityJson(data.value),
          },
        });
      });
    }
    return txId;
  }

  readonly fetch: ApiFetch = async (url, init) => {
    const { pathname, searchParams, origin } = new URL(url);
    this.requests.push(`${init.method} ${pathname}`);
    if (origin !== API) throw new Error(`unexpected origin ${origin}`);
    const reply = (body: unknown, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    });

    const callRead =
      /^\/v2\/contracts\/call-read\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(pathname);
    if (callRead !== null && init.method === "POST") {
      const [address, name, fn] = callRead.slice(1).map(decodeURIComponent);
      const body = JSON.parse(init.body!) as {
        sender: string;
        arguments: string[];
      };
      const { result } = simnet.callReadOnlyFn(
        `${address}.${name}`,
        fn!,
        body.arguments.map((hex) => Cl.deserialize(hex)),
        body.sender,
      );
      return reply({ okay: true, result: "0x" + Cl.serialize(result) });
    }
    if (init.method !== "GET") throw new Error(`unexpected ${init.method}`);

    if (pathname === "/v2/info") {
      return reply({ ...recorded.info, network_id: this.networkId });
    }
    if (pathname === "/extended/v2/blocks/latest") {
      return reply({
        ...recorded.blockLatest,
        burn_block_height: simnet.burnBlockHeight,
        block_time: Number(simnet.getBlockTime()),
      });
    }
    const balances = /^\/extended\/v1\/address\/([^/]+)\/balances$/.exec(
      pathname,
    );
    if (balances !== null) {
      const who = decodeURIComponent(balances[1]!);
      const fungible: Json = {};
      for (const token of config.tokens) {
        const answer = simnet.callReadOnlyFn(
          token.id,
          "get-balance",
          [Cl.principal(who)],
          who,
        ).result;
        if (answer.type !== "ok" || answer.value.type !== "uint") {
          throw new Error("get-balance did not return (ok uint)");
        }
        // As recorded: an asset the address never held has no entry.
        if (BigInt(answer.value.value) > 0n) {
          fungible[`${token.id}::${token.assetName}`] = {
            balance: answer.value.value.toString(),
            total_sent: "0",
            total_received: answer.value.value.toString(),
          };
        }
      }
      return reply({ ...recorded.balances, fungible_tokens: fungible });
    }
    const tx = /^\/extended\/v1\/tx\/(0x[0-9a-f]{64})$/.exec(pathname);
    if (tx !== null) {
      const txId = tx[1]!;
      const queue = this.queued.get(txId);
      const next =
        queue !== undefined && queue.length > 0 ? queue.shift() : undefined;
      const body = next !== undefined ? next : (this.txs.get(txId) ?? null);
      return body === null ? reply(recorded.txNotFound, 404) : reply(body);
    }
    const events = /^\/extended\/v1\/contract\/([^/]+)\/events$/.exec(pathname);
    if (events !== null) {
      const contract = decodeURIComponent(events[1]!);
      const limit = Math.min(Number(searchParams.get("limit")), this.pageCap);
      const offset = Number(searchParams.get("offset"));
      this.requests[this.requests.length - 1] += `?offset=${offset}`;
      const newestFirst = this.events
        .filter((e) => (e.contract_log as Json).contract_id === contract)
        .reverse();
      const page = newestFirst.slice(offset, offset + limit);
      return reply({
        limit,
        offset,
        results: this.reversePages ? page.reverse() : page,
      });
    }
    throw new Error(`unexpected request ${init.method} ${url}`);
  };
}

interface Harness {
  node: FakeNode;
  session: ChainSession;
  /** Every call handed to the wallet, with its context. */
  handed: { call: VaultCall; network: string; owner: string }[];
  /** What the wallet answers next, instead of mining the call. */
  answer: { next: ((call: VaultCall) => Promise<string>) | null };
  slept: number[];
}

async function harness(
  options: Partial<WalletChainOptions> = {},
  node = new FakeNode(),
): Promise<Harness> {
  const handed: Harness["handed"] = [];
  const answer: Harness["answer"] = { next: null };
  const slept: number[] = [];
  const wallet: Wallet = {
    connect: async () => owner,
    requestContractCall: async (call, context) => {
      handed.push({ call, ...context });
      if (answer.next !== null) {
        const next = answer.next;
        answer.next = null;
        return next(call);
      }
      return node.mine(call, context.owner);
    },
  };
  const session = await startWalletChain({
    config,
    wallet,
    fetch: node.fetch,
    sleep: async (ms) => {
      slept.push(ms);
    },
    pollMs: 1000,
    timeoutMs: 3000,
    ...options,
  });
  return { node, session, handed, answer, slept };
}

function build(session: FlowEnv, id: FlowId, values: FormValues) {
  const prepared = prepareCall(session, id, values);
  if (!prepared.ok) {
    throw new Error(`form ${id} did not build: ${JSON.stringify(prepared)}`);
  }
  return prepared.call;
}

/** Every owner flow, in an order the contract accepts, with its form values. */
const FLOW_RUNS: [FlowId, FormValues][] = [
  ["deposit", { token: sbtc, amount: "50000000" }],
  ["set-agent", { agent }],
  [
    "set-token-caps",
    { token: sbtc, maxPerTrade: "10000000", maxPerDay: "30000000" },
  ],
  ["set-policy", { cooldownBlocks: "0", expiresAt: "100000" }],
  ["allow-token", { token: sbtc, allowed: "allow" }],
  ["allow-adapter", { adapter: dex, allowed: "allow" }],
  ["set-price-bounds", { maxSlippageBps: "100", maxPriceAge: "3600000" }],
  ["set-approval-threshold", { token: sbtc, threshold: "5000000" }],
  ["pause", {}],
  ["unpause", {}],
  ["withdraw", { token: sbtc, amount: "20000000" }],
  ["remove-agent", {}],
];

const mock = (contract: string, fn: string, args: ClarityValue[]) => {
  const { result } = simnet.callPublicFn(contract, fn, args, deployer);
  if (result.type !== "ok") throw new Error(`mock setup ${contract}.${fn}`);
};

beforeAll(() => {
  mock("mock-sbtc", "mint", [Cl.uint(100_000_000n), Cl.principal(owner)]);
  mock("mock-sbtc", "mint", [Cl.uint(100_000_000n), Cl.principal(stranger)]);
  mock("mock-oracle", "set-value-aged", [
    Cl.stringAscii("BTC/USD"),
    Cl.uint(9_000_000_000_000n),
    Cl.uint(0),
  ]);
});

// ---- tests ------------------------------------------------------------------

describe("the mode switch", () => {
  it("is the simulation unless the address asks for testnet", () => {
    expect(modeFromSearch("")).toBe("simulation");
    expect(modeFromSearch("?mode=simulation")).toBe("simulation");
    expect(modeFromSearch("?mode=mainnet")).toBe("simulation");
    expect(modeFromSearch("?mode=TESTNET")).toBe("simulation");
    expect(modeFromSearch("?other=1&mode=testnet")).toBe("testnet");
  });
});

describe("the testnet config", () => {
  it("accepts a filled-in config and keeps the price scale a bigint", () => {
    const parsed = parseTestnetConfig(JSON.parse(JSON.stringify(configJson)));
    expect(parsed).toStrictEqual({ ok: true, config });
  });

  it("says what is missing when there is no config at all", () => {
    const parsed = parseTestnetConfig({});
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.mainnet).toBe(false);
    expect(parsed.problems).toStrictEqual([
      'network must be "testnet".',
      "apiUrl is missing: give the testnet Stacks API root.",
      "vault is missing: give a contract id, ADDRESS.name.",
      "oracle is missing: give a contract id, ADDRESS.name.",
      "tokens is missing: list the vault's tokens.",
      "sbtcToken is missing: give a contract id, ADDRESS.name.",
      "adapters is missing: list the vault's swap adapter.",
      'priceScale is missing: give the vault\'s PRICE-SCALE as a string of digits, for example "10000000000".',
    ]);
    expect(parseTestnetConfig(null)).toMatchObject({ ok: false });
    expect(parseTestnetConfig([])).toMatchObject({ ok: false });
  });

  it("refuses the committed example: every id is still a placeholder", () => {
    const text = readFileSync(
      join(root, "apps/dashboard/testnet.config.example.json"),
      "utf8",
    );
    // No real id: no Stacks address anywhere in the example.
    expect(text).not.toMatch(/\bS[PMTN][0-9A-Z]{20,}/);
    const parsed = parseTestnetConfig(JSON.parse(text));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.mainnet).toBe(false);
    const named = (field: string) =>
      parsed.problems.some((p) => p.startsWith(`${field} `));
    for (const field of [
      "vault",
      "oracle",
      "tokens[0].id",
      "tokens[1].id",
      "tokens[0].assetName",
      "sbtcToken",
      "adapters[0].id",
      "adapters[0].name",
      "priceScale",
    ]) {
      expect(named(field), field).toBe(true);
    }
  });

  it("refuses a price scale given as a JSON number, and a bad token", () => {
    const parsed = parseTestnetConfig({
      ...configJson,
      priceScale: 10000000000,
      tokens: [{ ...config.tokens[0], decimals: 8.5 }, config.tokens[1]],
      adapters: [{ id: dex, name: "mock-dex" }],
    });
    expect(parsed).toMatchObject({
      ok: false,
      problems: [
        "tokens[0].decimals must be a whole number from 0 to 38.",
        "sbtcToken must be the id of one of tokens.",
        "adapters[0].pool is missing: give the pool's contract id, or null if the adapter pays out itself.",
        expect.stringMatching(/^priceScale is missing/),
      ],
    });
  });
});

describe("the mainnet guard", () => {
  it.each([
    ["network", { network: "mainnet" }],
    ["apiUrl", { apiUrl: "https://api.hiro.so" }],
    ["apiUrl", { apiUrl: "https://api.mainnet.hiro.so" }],
    ["vault", { vault: `${MAINNET_ADDRESS}.keelio-vault` }],
    ["oracle", { oracle: MAINNET_CONTRACT }],
    ["sbtcToken", { sbtcToken: MAINNET_CONTRACT }],
    [
      "tokens[0].id",
      {
        tokens: [
          { ...config.tokens[0], id: MAINNET_CONTRACT },
          config.tokens[1],
        ],
      },
    ],
    [
      "adapters[0].pool",
      { adapters: [{ id: dex, name: "dex", pool: MAINNET_CONTRACT }] },
    ],
  ])("refuses a config whose %s names mainnet", (field, change) => {
    const parsed = parseTestnetConfig({ ...configJson, ...change });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.mainnet).toBe(true);
    const problem = parsed.problems.find((p) => p.startsWith(MAINNET_REFUSAL));
    expect(problem).toContain(field);
    expect(MAINNET_REFUSAL).toBe(
      "Mainnet is outside this version of the Keelio dashboard. It runs on testnet only.",
    );
  });

  it.each<[string, Partial<TestnetConfig>]>([
    ["network", { network: "mainnet" as "testnet" }],
    ["api.hiro.so", { apiUrl: "https://api.hiro.so" }],
    ["api.mainnet.hiro.so", { apiUrl: "https://api.mainnet.hiro.so/" }],
    ["vault", { vault: `${MAINNET_ADDRESS}.keelio-vault` }],
    ["oracle", { oracle: MAINNET_CONTRACT }],
    ["token", { tokens: [{ ...config.tokens[0]!, id: MAINNET_CONTRACT }] }],
    [
      "adapter",
      { adapters: [{ id: MAINNET_CONTRACT, name: "x", pool: null }] },
    ],
  ])(
    "the session refuses to start on a mainnet %s, before any request",
    async (_name, change) => {
      const node = new FakeNode();
      const connectSpy = vi.fn(async () => owner);
      const start = startWalletChain({
        config: { ...config, ...change },
        wallet: { connect: connectSpy, requestContractCall: vi.fn() },
        fetch: node.fetch,
      });
      await expect(start).rejects.toBeInstanceOf(MainnetRefusedError);
      await expect(start).rejects.toThrow(MAINNET_REFUSAL);
      expect(node.requests).toStrictEqual([]);
      expect(connectSpy).not.toHaveBeenCalled();
      expect(() => assertTestnet({ ...config, ...change })).toThrow(
        MainnetRefusedError,
      );
    },
  );

  it("refuses a node that reports mainnet's network id, before the wallet", async () => {
    // The recorded /v2/info is mainnet's own answer.
    expect(recorded.info.network_id).toBe(1);
    const node = new FakeNode();
    node.networkId = recorded.info.network_id as number;
    const connectSpy = vi.fn(async () => owner);
    const start = startWalletChain({
      config,
      wallet: { connect: connectSpy, requestContractCall: vi.fn() },
      fetch: node.fetch,
    });
    await expect(start).rejects.toThrow(MainnetRefusedError);
    await expect(start).rejects.toThrow(/reports mainnet's network id/);
    expect(connectSpy).not.toHaveBeenCalled();
    expect(node.requests).toStrictEqual(["GET /v2/info"]);
  });

  it("refuses a wallet that answers with a mainnet address", async () => {
    const node = new FakeNode();
    const start = startWalletChain({
      config,
      wallet: {
        connect: async () => MAINNET_ADDRESS,
        requestContractCall: vi.fn(),
      },
      fetch: node.fetch,
    });
    await expect(start).rejects.toThrow(MainnetRefusedError);
    await expect(start).rejects.toThrow(/switch the wallet to testnet/);
  });

  it("refuses an answer that is not a Stacks address, and a declined connection", async () => {
    const node = new FakeNode();
    const withWallet = (connectFn: Wallet["connect"]) =>
      startWalletChain({
        config,
        wallet: { connect: connectFn, requestContractCall: vi.fn() },
        fetch: node.fetch,
      });
    await expect(
      withWallet(async () => "bc1qtmqe7hg4etkq4t384nzg0mrmwf2sam9fjsz0mr"),
    ).rejects.toMatchObject({ code: "BAD_ADDRESS" });
    await expect(
      withWallet(async () => {
        throw new Error("User rejected the request");
      }),
    ).rejects.toMatchObject({
      code: "WALLET_REJECTED",
      message: "The wallet did not connect: User rejected the request",
    });
  });
});

describe("the testnet session", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });

  it("is the owner's session on the configured vault, with no simulation parts", () => {
    const { session } = h;
    expect(session.kind).toBe("testnet");
    expect(session.owner).toBe(owner);
    expect(session.config.tx).toStrictEqual({
      vault,
      assetNames: { [sbtc]: "mock-sbtc", [usd]: "mock-usd" },
      adapters: { [dex]: { pool: null } },
    });
    expect(session.config.read).toStrictEqual({
      vault,
      tokens: [sbtc, usd],
      adapters: [dex],
      oracle,
      sbtcToken: sbtc,
      priceScale: 10_000_000_000n,
    });
    expect(session.config.labels[owner]).toBe("the owner");
    expect(session.config.labels[vault]).toBe("the vault");
    expect(Object.keys(session).sort()).toStrictEqual([
      "config",
      "journal",
      "journalScope",
      "kind",
      "owner",
      "read",
      "submit",
    ]);
    for (const simulationOnly of [
      "agent",
      "agentSwap",
      "advanceBurnBlocks",
      "setOraclePrice",
      "runExampleSetup",
    ]) {
      expect(simulationOnly in session, simulationOnly).toBe(false);
    }
  });

  it("covers every owner flow the dashboard has", () => {
    expect(FLOW_RUNS.map(([id]) => id).sort()).toStrictEqual(
      FLOWS.map((flow) => flow.id).sort(),
    );
  });

  it.each(FLOW_RUNS)(
    "%s: the wallet gets the SDK's call, post-conditions and Deny mode unchanged",
    async (id, values) => {
      const call = build(h.session, id, values);
      const before = structuredClone(call);
      const progress: SubmitProgress[] = [];
      const receipt = await h.session.submit(call, (p) => progress.push(p));

      const handed = h.handed.at(-1)!;
      // The same object, not a copy, and nothing in it was touched.
      expect(handed.call).toBe(call);
      expect(handed.call.postConditions).toBe(call.postConditions);
      expect(call).toStrictEqual(before);
      expect(handed.call.postConditionMode).toBe("deny");
      expect(handed.network).toBe("testnet");
      expect(handed.owner).toBe(owner);
      // What the review step showed is what was handed over.
      const shown = reviewCall(call, h.session.config, 0n);
      expect(
        shown.postConditions.map((pc) => JSON.parse(pc.raw)),
      ).toStrictEqual(handed.call.postConditions);
      if (id === "deposit") {
        expect(call.postConditions).toStrictEqual([
          {
            type: "ft-postcondition",
            address: owner,
            condition: "eq",
            amount: "50000000",
            asset: `${sbtc}::mock-sbtc`,
          },
        ]);
      } else if (id === "withdraw") {
        expect(call.postConditions).toStrictEqual([
          {
            type: "ft-postcondition",
            address: vault,
            condition: "eq",
            amount: "20000000",
            asset: `${sbtc}::mock-sbtc`,
          },
        ]);
      } else {
        expect(call.postConditions).toStrictEqual([]);
      }

      expect(receipt.status).toBe("ok");
      expect(progress[0]).toStrictEqual({ stage: "wallet" });
    },
  );

  it("reads the vault, the tip and the wallet balances from the API", async () => {
    const read = await h.session.read();
    expect(read.vault).toStrictEqual(
      await readVault(
        simnetClient(simnet, owner),
        h.session.config.read,
        owner,
      ),
    );
    expect(read.vault.balances).toStrictEqual({
      [sbtc]: 30_000_000n,
      [usd]: 0n,
    });
    expect(read.vault.vault).toStrictEqual({ agent: null, paused: false });
    expect(read.vault.policy.caps[sbtc]).toStrictEqual({
      maxPerTrade: 10_000_000n,
      maxPerDay: 30_000_000n,
    });
    expect(read.vault.priceBounds).toStrictEqual({
      maxSlippageBps: 100n,
      maxPriceAge: 3_600_000n,
    });
    expect(read.vault.oracle.price?.value).toBe(9_000_000_000_000n);
    expect(read.burnHeight).toBe(BigInt(simnet.burnBlockHeight));
    expect(read.nowMs).toBe(BigInt(simnet.getBlockTime()) * 1000n);
    // 1 sBTC minted, 0.5 deposited, 0.2 withdrawn. USD was never held, so the
    // API has no entry for it and the session reads that as 0.
    expect(read.wallet).toStrictEqual({ [sbtc]: 70_000_000n, [usd]: 0n });
    // The panel the page draws takes this read as it is.
    const cards = vaultPanel(read, h.session.config, owner);
    expect(cards.map((card) => card.title).length).toBe(3);
  });

  it("journals the owner's events oldest first, across pages, and no one else's", async () => {
    // Another owner uses the same vault contract.
    const theirs = build(
      { owner: stranger, config: h.session.config },
      "deposit",
      { token: sbtc, amount: "1000" },
    );
    h.node.mine(theirs, stranger);
    // A transaction that is no longer on the chain keeps no place.
    const orphan = build(h.session, "pause", {});
    h.node.mine(orphan, owner, { canonical: false });
    simnet.callPublicFn(vault, "unpause", [], owner);

    h.node.pageCap = 4;
    const names = async (session: ChainSession) =>
      (await session.journal()).map((record) => {
        const value = record.value;
        if (value.type !== "tuple") throw new Error("not a tuple");
        expect(Cl.prettyPrint(value.value.owner!)).toBe(`'${owner}`);
        return Cl.prettyPrint(value.value.event!).replaceAll('"', "");
      });
    const expected = FLOW_RUNS.map(([id]) => id);
    const fresh = await harness({}, h.node);
    const start = h.node.requests.length;
    expect(await names(fresh.session)).toStrictEqual(expected);
    // 13 events at 4 a page: four pages, the last one short.
    expect(
      h.node.requests.slice(start).filter((r) => r.includes("/events")),
    ).toStrictEqual([
      `GET /extended/v1/contract/${vault}/events?offset=0`,
      `GET /extended/v1/contract/${vault}/events?offset=4`,
      `GET /extended/v1/contract/${vault}/events?offset=8`,
      `GET /extended/v1/contract/${vault}/events?offset=12`,
    ]);
    const records = await fresh.session.journal();
    expect(records[0]!.burnHeight).toBe(BigInt(simnet.burnBlockHeight));

    // The order comes from block, transaction and event index, not from the
    // order the API lists a page in.
    h.node.reversePages = true;
    const shuffled = await harness({}, h.node);
    expect(await names(shuffled.session)).toStrictEqual(expected);
    h.node.reversePages = false;

    // A second read stops at the first page that holds a known event.
    const again = h.node.requests.length;
    expect(await names(fresh.session)).toStrictEqual(expected);
    expect(
      h.node.requests.slice(again).filter((r) => r.includes("/events")),
    ).toStrictEqual([`GET /extended/v1/contract/${vault}/events?offset=0`]);

    // The page's own journal code prints it, newest first.
    const entries = journalEntries(records, h.session.config, owner);
    expect(entries.map((e) => e.event)).toStrictEqual([...expected].reverse());
    expect(entries.at(-1)!.text).toBe(
      "The owner deposited 50000000 sats of test sBTC (0.50000000 sBTC). Vault balance after: 50000000 sats of test sBTC (0.50000000 sBTC).",
    );
    h.node.pageCap = 50;
  });

  it("reads the whole journal again after a read that failed part-way", async () => {
    h.node.pageCap = 4;
    const whole = await (await harness({}, h.node)).session.journal();
    expect(whole.length).toBeGreaterThan(4);
    let fail = true;
    const flaky = await harness(
      {
        fetch: async (url, init) => {
          if (fail && url.includes("/events") && url.includes("offset=4")) {
            fail = false;
            throw new Error("connection reset");
          }
          return h.node.fetch(url, init);
        },
      },
      h.node,
    );
    await expect(flaky.session.journal()).rejects.toMatchObject({
      code: "HTTP_ERROR",
    });
    // The first page's events are known now, but the older pages were never
    // read: the next read must not stop at the first page.
    expect(await flaky.session.journal()).toStrictEqual(whole);
    h.node.pageCap = 50;
  });

  it("adds a new event to the journal after the next call", async () => {
    const before = (await h.session.journal()).length;
    await h.session.submit(build(h.session, "pause", {}));
    await h.session.submit(build(h.session, "unpause", {}));
    expect((await h.session.journal()).length).toBe(before + 2);
  });

  it("reports a refusal with the contract's own error code", async () => {
    // Withdrawing more than the ledger holds: the simnet runs the real
    // contract, which answers ERR-INSUFFICIENT-BALANCE.
    const call = build(h.session, "withdraw", {
      token: sbtc,
      amount: "999999999",
    });
    const receipt = await h.session.submit(call);
    expect(receipt).toStrictEqual({
      status: "refused",
      result: Cl.error(Cl.uint(101)),
    });
    expect(describeReceipt(receipt, errors, "testnet").headline).toBe(
      "Refused: more than the vault holds",
    );
  });
});

describe("receipts, from the recorded transaction shapes", () => {
  let h: Harness;
  let call: VaultCall;
  beforeAll(async () => {
    h = await harness();
    call = build(h.session, "deposit", { token: sbtc, amount: "1000" });
  });

  /** The wallet answers with a tx id the node serves `tx` for. */
  const broadcastAs = (base: Json, before: (Json | null)[] = []) => {
    const txId = h.node.newTxId();
    h.answer.next = async (c) => {
      h.node.put(
        txId,
        shaped(base, txId, c, owner),
        before.map((b) => (b === null ? null : shaped(b, txId, c, owner))),
      );
      return txId;
    };
    return txId;
  };

  it("ok: a recorded success", async () => {
    expect(recordedSuccess.tx_status).toBe("success");
    broadcastAs(recordedSuccess);
    expect(await h.session.submit(call)).toStrictEqual({
      status: "ok",
      result: Cl.ok(Cl.bool(true)),
    });
  });

  it("refused: a recorded abort_by_response carries the contract's error", async () => {
    expect(recorded.txAbortByResponse.tx_status).toBe("abort_by_response");
    broadcastAs(recorded.txAbortByResponse);
    const receipt = await h.session.submit(call);
    expect(receipt).toStrictEqual({
      status: "refused",
      result: Cl.error(Cl.uint(5001)),
    });
    expect(describeReceipt(receipt, errors, "testnet")).toStrictEqual({
      kind: "refused",
      headline: "Refused by the contract",
      returned: "(err u5001)",
      details: [
        "Nothing changed.",
        "u5001 is not a keelio-vault code. It came from a contract the vault called.",
      ],
    });
  });

  it("refused: a recorded post-condition abort whose result is an error", async () => {
    const base = recorded.txAbortByPostConditionErr;
    expect(base.tx_status).toBe("abort_by_post_condition");
    broadcastAs(base);
    const receipt = await h.session.submit(call);
    expect(receipt).toStrictEqual({
      status: "refused",
      result: Cl.error(Cl.uint(4003)),
      postCondition: base.vm_error,
    });
    expect(base.vm_error).toMatch(/^Post-condition check failure/);
    const text = describeReceipt(receipt, errors, "testnet");
    expect(text.details.at(-1)).toBe(
      `Because nothing moved, the call's post-condition also failed. The chain reported: ${String(base.vm_error)}`,
    );
    // The simulation's wording says how the simnet found the code instead.
    expect(describeReceipt(receipt, errors).details.at(-1)).toMatch(
      /The simulation ran the call again/,
    );
  });

  it("aborted: a recorded post-condition abort whose result was ok", async () => {
    const base = recorded.txAbortByPostConditionOk;
    expect(base.tx_status).toBe("abort_by_post_condition");
    broadcastAs(base);
    const receipt = await h.session.submit(call);
    expect(receipt).toStrictEqual({ status: "aborted", reason: base.vm_error });
    expect(describeReceipt(receipt, errors, "testnet")).toStrictEqual({
      kind: "aborted",
      headline: "Rolled back by a post-condition",
      details: [
        "The transaction was rolled back and nothing changed.",
        base.vm_error,
      ],
    });
  });

  it("pending: unknown, then in the mempool, then mined", async () => {
    expect(recorded.txPending.tx_status).toBe("pending");
    expect(recorded.txNotFound).toMatchObject({ statusCode: 404 });
    const txId = broadcastAs(recordedSuccess, [null, recorded.txPending]);
    const progress: SubmitProgress[] = [];
    h.slept.length = 0;
    const receipt = await h.session.submit(call, (p) => progress.push(p));
    expect(receipt.status).toBe("ok");
    expect(progress).toStrictEqual([
      { stage: "wallet" },
      { stage: "pending", txId, waitedMs: 0 },
      { stage: "pending", txId, waitedMs: 1000 },
    ]);
    expect(h.slept).toStrictEqual([1000, 1000]);
    expect(progressWords(progress[0]!)).toMatch(/^Waiting for your wallet/);
    expect(progressWords(progress[2]!)).toBe(
      `Broadcast by your wallet as ${txId}. Pending: not in a block yet (1 seconds).`,
    );
  });

  it("timeout: stops after the limit and leaves the transaction id", async () => {
    const txId = h.node.newTxId();
    h.answer.next = async (c) => {
      h.node.put(txId, shaped(recorded.txPending, txId, c, owner));
      return txId;
    };
    const progress: SubmitProgress[] = [];
    h.slept.length = 0;
    const submit = h.session.submit(call, (p) => progress.push(p));
    await expect(submit).rejects.toBeInstanceOf(WalletChainError);
    await expect(submit).rejects.toMatchObject({ code: "TX_TIMEOUT", txId });
    await expect(submit).rejects.toThrow(
      `Transaction ${txId} was broadcast but is not in a block after 3 seconds. It may still be mined`,
    );
    // Three waits of one second, and the id was shown from the first.
    expect(h.slept).toStrictEqual([1000, 1000, 1000]);
    expect(progress[1]).toStrictEqual({ stage: "pending", txId, waitedMs: 0 });
  });

  it("accepts a transaction id without 0x, and refuses anything else", async () => {
    const txId = h.node.newTxId();
    h.answer.next = async (c) => {
      h.node.put(txId, shaped(recordedSuccess, txId, c, owner));
      return txId.slice(2).toUpperCase();
    };
    expect((await h.session.submit(call)).status).toBe("ok");

    h.answer.next = async () => "not-a-tx-id";
    await expect(h.session.submit(call)).rejects.toMatchObject({
      code: "BAD_TX_ID",
    });
  });

  it("says so when the owner declines in the wallet", async () => {
    h.answer.next = async () => {
      throw new Error("User rejected the request");
    };
    const before = h.node.requests.length;
    await expect(h.session.submit(call)).rejects.toMatchObject({
      code: "WALLET_REJECTED",
      message:
        "Not sent. The wallet did not sign the call: User rejected the request",
    });
    expect(h.node.requests.length).toBe(before);
  });

  it("refuses a status it does not know, with the transaction id", async () => {
    const txId = broadcastAs({
      ...recordedSuccess,
      tx_status: "something_new",
    });
    await expect(h.session.submit(call)).rejects.toMatchObject({
      code: "TX_FAILED",
      txId,
    });
  });

  it("refuses a malformed transaction response", async () => {
    broadcastAs({ ...recordedSuccess, tx_result: { hex: "0xzz" } });
    await expect(h.session.submit(call)).rejects.toBeInstanceOf(ChainApiError);
  });

  describe("a wallet that changes the call", () => {
    it.each<[string, (c: VaultCall) => Json, RegExp]>([
      [
        "drops the post-conditions",
        () => ({ post_conditions: [] }),
        /carries 0 post-condition\(s\) that are not the 1 reviewed/,
      ],
      [
        "switches to Allow mode",
        () => ({ post_condition_mode: "allow" }),
        /post-condition mode is allow, not deny/,
      ],
      [
        "changes an amount",
        (c) => ({
          post_conditions: apiPostConditions({
            ...c,
            postConditions: c.postConditions.map((pc) => ({
              ...pc,
              amount: "999",
            })),
          }),
        }),
        /carries 1 post-condition\(s\) that are not the 1 reviewed/,
      ],
    ])("is reported when it %s", async (_name, change, why) => {
      const txId = h.node.newTxId();
      h.answer.next = async (c) => {
        h.node.put(txId, {
          ...shaped(recordedSuccess, txId, c, owner),
          ...change(c),
        });
        return txId;
      };
      const submit = h.session.submit(call);
      await expect(submit).rejects.toMatchObject({
        code: "CALL_CHANGED",
        txId,
      });
      await expect(submit).rejects.toThrow(why);
      await expect(submit).rejects.toThrow(/not the call you reviewed/);
    });

    it("is reported while the transaction is still pending", async () => {
      const txId = h.node.newTxId();
      h.answer.next = async (c) => {
        h.node.put(txId, {
          ...shaped(recorded.txPending, txId, c, owner),
          post_condition_mode: "allow",
        });
        return txId;
      };
      h.slept.length = 0;
      await expect(h.session.submit(call)).rejects.toMatchObject({
        code: "CALL_CHANGED",
      });
      expect(h.slept).toStrictEqual([]);
    });

    it("is reported for another contract, function or argument", async () => {
      const other = build(h.session, "deposit", {
        token: sbtc,
        amount: "1001",
      });
      const txId = h.node.newTxId();
      const tx = (c: VaultCall) =>
        callDifference(call, {
          txId,
          status: "pending",
          canonical: true,
          postConditionMode: "deny",
          postConditions: [],
          call: {
            contractId: `${c.contractAddress}.${c.contractName}`,
            functionName: c.functionName,
            argsHex: c.functionArgs.map((a) => "0x" + Cl.serialize(a)),
          },
          mined: null,
        });
      expect(tx(other)).toBe("its arguments are not the reviewed ones");
      expect(tx({ ...call, functionName: "withdraw" })).toBe(
        "it calls withdraw, not deposit",
      );
      expect(tx({ ...call, contractName: "other-vault" })).toBe(
        `it calls ${deployer}.other-vault, not ${vault}`,
      );
      // The recorded mainnet call, untouched, is no Keelio call at all.
      h.answer.next = async () => {
        const id = h.node.newTxId();
        h.node.put(id, { ...recordedSuccess, tx_id: id });
        return id;
      };
      await expect(h.session.submit(call)).rejects.toThrow(
        `it calls ${MAINNET_CONTRACT}, not ${vault}`,
      );
    });
  });
});

describe("the wallet adapter on the installed @stacks/connect", () => {
  // A stand-in for a wallet's injected provider: it records the JSON-RPC
  // request the real library sends and answers like a wallet.
  const sent: { method: string; params: Json }[] = [];
  let answer: unknown;
  const provider = {
    request: async (method: string, params: Json) => {
      sent.push({ method, params });
      return { jsonrpc: "2.0", id: 1, result: answer };
    },
  };
  // The library's `connect` always opens its wallet picker, which needs a
  // browser, so it is replaced here. `request` is the real one.
  let addresses: { address: string; publicKey: string }[] = [];
  const fakeConnect = vi.fn(async () => ({ addresses }));
  const wallet = connectWallet(
    {
      connect: fakeConnect as unknown as typeof connect,
      request,
      // A pinned provider never reads the stored choice.
      getSelectedProviderId: () => null,
    },
    { provider: provider as never, enableLocalStorage: false },
  );
  const env = { owner, config: chainConfigOf(config, owner) };

  it("offers only the wallet the library documents as taking post-conditions", () => {
    expect(APPROVED_PROVIDER_IDS).toStrictEqual(["LeatherProvider"]);
  });

  it("asks for the testnet address and picks the Stacks one", async () => {
    const bitcoin = {
      address: "bc1qtmqe7hg4etkq4t384nzg0mrmwf2sam9fjsz0mr",
      publicKey: "",
    };
    addresses = [bitcoin, { address: owner, publicKey: "" }];
    expect(await wallet.connect("testnet")).toBe(owner);
    expect(fakeConnect).toHaveBeenCalledWith({
      provider,
      enableLocalStorage: false,
      network: "testnet",
    });

    addresses = [bitcoin];
    await expect(wallet.connect("testnet")).rejects.toThrow(
      "the wallet returned no Stacks address",
    );
  });

  it.each(FLOW_RUNS)(
    "%s: the provider receives the SDK's post-conditions, Deny mode and arguments",
    async (id, values) => {
      const call = build(env, id, values);
      const before = structuredClone(call);
      answer = { txid: "ab".repeat(32) };
      sent.length = 0;
      const txId = await wallet.requestContractCall(call, {
        network: "testnet",
        owner,
      });
      expect(txId).toBe("ab".repeat(32));
      expect(call).toStrictEqual(before);

      expect(sent).toHaveLength(1);
      const { method, params } = sent[0]!;
      expect(method).toBe("stx_callContract");
      expect(params.contract).toBe(vault);
      expect(params.functionName).toBe(call.functionName);
      expect(params.postConditionMode).toBe("deny");
      expect(params.network).toBe("testnet");
      expect(params.address).toBe(owner);
      // The library hex-encodes for the wallet. Decoded, each post-condition
      // and argument is the SDK's own.
      const conditions = (params.postConditions as string[]).map((hex) =>
        wireToPostCondition(deserializePostConditionWire(hex)),
      );
      expect(conditions).toStrictEqual(call.postConditions);
      expect(
        (params.functionArgs as string[]).map((hex) =>
          Cl.serialize(Cl.deserialize(hex)),
        ),
      ).toStrictEqual(call.functionArgs.map((arg) => Cl.serialize(arg)));
      if (id === "deposit" || id === "withdraw") {
        expect(conditions).toHaveLength(1);
      }
    },
  );

  it("fails when the wallet returns no transaction id", async () => {
    answer = { transaction: "00" };
    await expect(
      wallet.requestContractCall(build(env, "pause", {}), {
        network: "testnet",
        owner,
      }),
    ).rejects.toThrow("the wallet returned no transaction id");
  });
});

describe("the wallet adapter signs only with the wallet picked at connect", () => {
  // Without a pinned provider the library signs with whatever wallet id is
  // stored at that moment. Another page on the same origin could change it
  // to a wallet that drops post-conditions between connect and signing.
  let selected: string | null = null;
  // The provider Leather injects; the library would look it up by id.
  const leather = { request: vi.fn() };
  beforeAll(() => {
    Object.assign(globalThis, { LeatherProvider: leather });
  });
  afterAll(() => {
    delete (globalThis as Record<string, unknown>).LeatherProvider;
  });
  const fakeConnect = vi.fn(async () => ({
    addresses: [{ address: owner, publicKey: "" }],
  }));
  const fakeRequest = vi.fn(async () => ({ txid: "cd".repeat(32) }));
  const wallet = connectWallet({
    connect: fakeConnect as unknown as typeof connect,
    request: fakeRequest as unknown as typeof request,
    getSelectedProviderId: () => selected,
  });
  const env = { owner, config: chainConfigOf(config, owner) };
  const sign = () =>
    wallet.requestContractCall(build(env, "pause", {}), {
      network: "testnet",
      owner,
    });

  it("refuses to sign before a wallet is connected", async () => {
    selected = "LeatherProvider";
    await expect(sign()).rejects.toThrow("connect a wallet first");
    expect(fakeRequest).not.toHaveBeenCalled();
  });

  it("refuses a connect to an offered wallet that is not installed", async () => {
    delete (globalThis as Record<string, unknown>).LeatherProvider;
    selected = "LeatherProvider";
    await expect(wallet.connect("testnet")).rejects.toThrow(
      "the wallet picked is not installed in this browser",
    );
    Object.assign(globalThis, { LeatherProvider: leather });
  });

  it.each([
    ["no stored choice", null],
    ["a wallet that is not offered", "XverseProviders.StacksProvider"],
  ])("refuses a connect that leaves %s", async (_, id) => {
    selected = id;
    await expect(wallet.connect("testnet")).rejects.toThrow(
      "the wallet picked is not one this dashboard offers",
    );
  });

  it("signs with the connected wallet, and refuses once the stored choice changes", async () => {
    selected = "LeatherProvider";
    expect(await wallet.connect("testnet")).toBe(owner);
    expect(await sign()).toBe("cd".repeat(32));
    expect(fakeRequest).toHaveBeenCalledTimes(1);
    // The provider goes to the library itself, so it never reads the
    // stored id, which could change while the request is under way.
    expect(fakeRequest).toHaveBeenCalledWith(
      {
        approvedProviderIds: [...APPROVED_PROVIDER_IDS],
        provider: leather,
      },
      "stx_callContract",
      expect.anything(),
    );

    selected = "XverseProviders.StacksProvider";
    await expect(sign()).rejects.toThrow(
      "the selected wallet changed since you connected",
    );
    selected = null;
    await expect(sign()).rejects.toThrow(
      "the selected wallet changed since you connected",
    );
    expect(fakeRequest).toHaveBeenCalledTimes(1);
  });
});
