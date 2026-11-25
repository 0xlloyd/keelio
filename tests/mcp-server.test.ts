import { initSimnet } from "@stacks/clarinet-sdk";
import {
  Cl,
  type ClarityValue,
  type PostCondition,
} from "@stacks/transactions";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildExecuteSwap,
  sizePosition,
  type ExecuteSwapInput,
  type TxConfig,
  type VaultConfig,
} from "../packages/sdk/src/index.js";
import {
  createServer,
  runStdio,
  simnetChain,
  type KeelioMcpDeps,
  type SimnetChain,
} from "../packages/mcp/src/index.js";
import {
  Client,
  InMemoryTransport,
  type CallToolResult,
} from "../packages/mcp/testing.js";
import {
  ORACLE_KEY,
  PRICE_90K,
  PRICE_SCALE,
  floorOf,
  oracleTimestamp,
} from "./oracle-fixture.js";

// initSimnet starts a new session, so each test gets a fresh chain.
let simnet = await initSimnet();
const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const alice = accounts.get("wallet_1")!;
const bob = accounts.get("wallet_2")!;
const mallory = accounts.get("wallet_3")!;
const dave = accounts.get("wallet_4")!;

const vaultId = `${deployer}.keelio-vault`;
const sbtc = `${deployer}.mock-sbtc`;
const usd = `${deployer}.mock-usd`;
const dex = `${deployer}.mock-dex`;

const RATE = 900n;
const DEPOSIT = 1_000_000n;
const AMOUNT_IN = 10_000n;
const MAX_PER_TRADE = 100_000n;
const MAX_PER_DAY = 1_000_000_000n;
const EXPIRES_AT = 1_000_000n;
// The oracle fixture: $90,000, the dex rate 900, and an age limit no test
// here reaches.
const SLIPPAGE_BPS = 100n;

const read: VaultConfig = {
  vault: "keelio-vault",
  tokens: [sbtc, usd],
  adapters: [dex],
  oracle: "mock-oracle",
  sbtcToken: sbtc,
  priceScale: PRICE_SCALE,
};
const tx: TxConfig = {
  vault: vaultId,
  assetNames: { [sbtc]: "mock-sbtc", [usd]: "mock-usd" },
  adapters: { [dex]: { pool: null } },
};

let chain: SimnetChain;
let client: Client;

function ok(call: { result: ClarityValue }) {
  expect(call.result).toStrictEqual(Cl.ok(Cl.bool(true)));
}

function vaultCall(sender: string, fn: string, args: ClarityValue[] = []) {
  return chain.callPublicFn("keelio-vault", fn, args, sender);
}

function mint(contract: string, amount: bigint, recipient: string) {
  ok(
    chain.callPublicFn(
      contract,
      "mint",
      [Cl.uint(amount), Cl.principal(recipient)],
      deployer,
    ),
  );
}

/** A swap through the contract with bob as the agent, at the oracle floor. */
function swap(amountIn: bigint, owner = alice) {
  return vaultCall(bob, "execute-swap", [
    Cl.principal(owner),
    Cl.principal(dex),
    Cl.principal(sbtc),
    Cl.principal(usd),
    Cl.uint(amountIn),
    Cl.uint(floorOf(amountIn, PRICE_90K, SLIPPAGE_BPS, true)),
  ]);
}

async function connect(deps: KeelioMcpDeps): Promise<Client> {
  const server = createServer(deps);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "keelio-test", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), c.connect(clientSide)]);
  return c;
}

type Json = Record<string, unknown>;

async function call(
  name: string,
  args: Json,
): Promise<{ res: CallToolResult; body: Json }> {
  const res = (await client.callTool({
    name,
    arguments: args,
  })) as CallToolResult;
  return { res, body: res.structuredContent as Json };
}

/** Calls a tool that must succeed and returns its structured result. */
async function result(name: string, args: Json): Promise<Json> {
  const { res, body } = await call(name, args);
  expect(res.isError ?? false).toBe(false);
  expect(res.content).toHaveLength(1);
  expect(JSON.parse((res.content[0] as { text: string }).text)).toStrictEqual(
    body,
  );
  return body;
}

async function expectInputError(
  name: string,
  args: Json,
  code: string,
  field: string,
) {
  const { res, body } = await call(name, args);
  expect(res.isError).toBe(true);
  expect(res.content).toHaveLength(1);
  expect(body).toMatchObject({ error: { code, field } });
  expect(JSON.parse((res.content[0] as { text: string }).text)).toStrictEqual(
    body,
  );
}

const trade = (over: Json = {}): Json => ({
  owner: alice,
  agent: bob,
  adapter: dex,
  tokenIn: sbtc,
  tokenOut: usd,
  amountIn: AMOUNT_IN.toString(),
  // The exact output at the dex rate: above the oracle floor.
  minOut: (AMOUNT_IN * RATE).toString(),
  ...over,
});

// The check and the build take the same input.
const swapArgs = trade;

beforeEach(async () => {
  simnet = await initSimnet();
  chain = simnetChain(simnet, deployer);
  simnet.mineEmptyBurnBlocks(144);
  mint("mock-usd", 10n ** 18n, dex);
  ok(
    chain.callPublicFn(
      "mock-dex",
      "set-rate",
      [Cl.uint(RATE), Cl.uint(1n)],
      deployer,
    ),
  );
  mint("mock-sbtc", DEPOSIT, alice);
  expect(
    vaultCall(alice, "deposit", [Cl.principal(sbtc), Cl.uint(DEPOSIT)]).result
      .type,
  ).toBe("ok");
  ok(vaultCall(alice, "set-agent", [Cl.principal(bob)]));
  ok(vaultCall(alice, "unpause"));
  // Through `chain`, so the journal records the set-price-bounds event.
  ok(
    chain.callPublicFn(
      "mock-oracle",
      "set-value-aged",
      [Cl.stringAscii(ORACLE_KEY), Cl.uint(PRICE_90K), Cl.uint(0n)],
      deployer,
    ),
  );
  ok(
    vaultCall(alice, "set-price-bounds", [
      Cl.uint(SLIPPAGE_BPS),
      Cl.uint(10n ** 15n),
    ]),
  );
  ok(vaultCall(alice, "allow-token", [Cl.principal(sbtc), Cl.bool(true)]));
  ok(vaultCall(alice, "allow-token", [Cl.principal(usd), Cl.bool(true)]));
  ok(vaultCall(alice, "allow-adapter", [Cl.principal(dex), Cl.bool(true)]));
  ok(
    vaultCall(alice, "set-token-caps", [
      Cl.principal(sbtc),
      Cl.uint(MAX_PER_TRADE),
      Cl.uint(MAX_PER_DAY),
    ]),
  );
  ok(vaultCall(alice, "set-policy", [Cl.uint(0n), Cl.uint(EXPIRES_AT)]));
  client = await connect({ chain, read, tx });
});

describe("listTools", () => {
  it("lists exactly the nine tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toStrictEqual(
      [
        "keelio_accountability",
        "keelio_agent_history",
        "keelio_build_cancel_request",
        "keelio_build_swap",
        "keelio_build_swap_request",
        "keelio_check_trade",
        "keelio_get_vault",
        "keelio_journal",
        "keelio_size_position",
      ].sort(),
    );
  });

  it("builds no call that only the owner can send", async () => {
    const { tools } = await client.listTools();
    for (const t of tools) {
      expect(t.name).not.toMatch(/approve|reject|threshold/);
    }
  });

  it("no input can carry a key, fee, nonce, network or skip the check", async () => {
    const { tools } = await client.listTools();
    const banned =
      /key|secret|mnemonic|seed|fee|nonce|network|sign|broadcast|^ok$|check|force|skip/i;
    for (const t of tools) {
      const props = Object.keys(t.inputSchema.properties ?? {});
      expect(props.length).toBeGreaterThan(0);
      for (const p of props) expect(p, `${t.name}.${p}`).not.toMatch(banned);
    }
  });

  it("check and build descriptions name u117, u118 and the agent rule", async () => {
    const { tools } = await client.listTools();
    for (const name of ["keelio_check_trade", "keelio_build_swap"]) {
      const d = tools.find((t) => t.name === name)!.description!;
      expect(d).toContain("u117");
      expect(d).toContain("u118");
      expect(d).toContain("must be the vault's agent");
      expect(d).toContain("u119 and u121 to u125");
      expect(d).toContain("u104");
      expect(d).toContain("latest block's time");
    }
    const build = tools.find((t) => t.name === "keelio_build_swap")!;
    expect(build.description).toContain("unsigned");
    expect(build.description).toContain("agent principal must sign and send");
    expect(build.description).toContain(
      "never signs a transaction and never submits one to the network",
    );
  });
});

describe("keelio_get_vault", () => {
  it("returns the vault with amounts as strings", async () => {
    const body = await result("keelio_get_vault", { owner: alice });
    expect(body).toStrictEqual({
      owner: alice,
      burnHeight: String(simnet.burnBlockHeight),
      agent: bob,
      paused: false,
      policy: {
        cooldownBlocks: "0",
        expiresAt: EXPIRES_AT.toString(),
        // USD caps were never set, so USD may not be sold.
        caps: {
          [sbtc]: {
            maxPerTrade: MAX_PER_TRADE.toString(),
            maxPerDay: MAX_PER_DAY.toString(),
          },
          [usd]: { maxPerTrade: "0", maxPerDay: "0" },
        },
        allowedTokens: [sbtc, usd],
        allowedAdapters: [dex],
      },
      usage: { dayTotals: { [sbtc]: "0", [usd]: "0" }, lastTradeHeight: null },
      balances: { [sbtc]: "1000000", [usd]: "0" },
      dayRemaining: { [sbtc]: MAX_PER_DAY.toString(), [usd]: "0" },
      // No approval threshold and no request: tests/mcp-approval.test.ts
      // covers a vault that has them.
      approvalThresholds: { [sbtc]: null, [usd]: null },
      pendingSwap: null,
    });
  });

  it("shows the usage after a swap", async () => {
    const h = String(simnet.burnBlockHeight);
    expect(swap(AMOUNT_IN).result.type).toBe("ok");
    const body = await result("keelio_get_vault", { owner: alice });
    expect(body.usage).toStrictEqual({
      dayTotals: { [sbtc]: "10000", [usd]: "0" },
      lastTradeHeight: h,
    });
    expect(body.dayRemaining).toStrictEqual({
      [sbtc]: (MAX_PER_DAY - AMOUNT_IN).toString(),
      [usd]: "0",
    });
    expect(body.balances).toStrictEqual({
      [sbtc]: (DEPOSIT - AMOUNT_IN).toString(),
      [usd]: (AMOUNT_IN * RATE).toString(),
    });
  });

  it("gives dayRemaining 0 once the day cap is used", async () => {
    ok(
      vaultCall(alice, "set-token-caps", [
        Cl.principal(sbtc),
        Cl.uint(AMOUNT_IN),
        Cl.uint(AMOUNT_IN),
      ]),
    );
    ok(vaultCall(alice, "set-policy", [Cl.uint(0n), Cl.uint(EXPIRES_AT)]));
    expect(swap(AMOUNT_IN).result.type).toBe("ok");
    const body = await result("keelio_get_vault", { owner: alice });
    expect(body.dayRemaining).toStrictEqual({ [sbtc]: "0", [usd]: "0" });
    // A lowered cap below what was already traded still gives 0.
    ok(
      vaultCall(alice, "set-token-caps", [
        Cl.principal(sbtc),
        Cl.uint(1n),
        Cl.uint(1n),
      ]),
    );
    expect(
      (await result("keelio_get_vault", { owner: alice })).dayRemaining,
    ).toStrictEqual({ [sbtc]: "0", [usd]: "0" });
  });

  it("an owner with no vault is well-formed, not an error", async () => {
    const body = await result("keelio_get_vault", { owner: mallory });
    expect(body).toMatchObject({
      owner: mallory,
      agent: null,
      paused: false,
      balances: { [sbtc]: "0", [usd]: "0" },
      usage: { dayTotals: { [sbtc]: "0", [usd]: "0" }, lastTradeHeight: null },
      dayRemaining: { [sbtc]: "0", [usd]: "0" },
    });
  });
});

// Job 015: caps and day totals per input token.
describe("caps per token", () => {
  const USD_TRADE = 9_000_000n;
  const USD_DAY = 18_000_000n;
  const sellUsd = { tokenIn: usd, tokenOut: sbtc };

  beforeEach(() => {
    ok(
      vaultCall(alice, "set-token-caps", [
        Cl.principal(sbtc),
        Cl.uint(AMOUNT_IN),
        Cl.uint(AMOUNT_IN),
      ]),
    );
    ok(vaultCall(alice, "set-policy", [Cl.uint(0n), Cl.uint(EXPIRES_AT)]));
    ok(
      vaultCall(alice, "set-token-caps", [
        Cl.principal(usd),
        Cl.uint(USD_TRADE),
        Cl.uint(USD_DAY),
      ]),
    );
    // sBTC sold to its day cap; the USD proceeds fund the USD trades.
    expect(swap(AMOUNT_IN).result).toStrictEqual(
      Cl.ok(Cl.uint(AMOUNT_IN * RATE)),
    );
  });

  it("keelio_get_vault returns caps, day totals and dayRemaining per token", async () => {
    const body = await result("keelio_get_vault", { owner: alice });
    expect(body.policy).toMatchObject({
      caps: {
        [sbtc]: {
          maxPerTrade: AMOUNT_IN.toString(),
          maxPerDay: AMOUNT_IN.toString(),
        },
        [usd]: {
          maxPerTrade: USD_TRADE.toString(),
          maxPerDay: USD_DAY.toString(),
        },
      },
    });
    expect(body.usage).toStrictEqual({
      dayTotals: { [sbtc]: AMOUNT_IN.toString(), [usd]: "0" },
      lastTradeHeight: String(simnet.burnBlockHeight),
    });
    expect(body.dayRemaining).toStrictEqual({
      [sbtc]: "0",
      [usd]: USD_DAY.toString(),
    });
  });

  it("keelio_check_trade refuses USD over the USD cap with 114", async () => {
    expect(
      await result(
        "keelio_check_trade",
        trade({ ...sellUsd, amountIn: (USD_TRADE + 1n).toString() }),
      ),
    ).toStrictEqual({
      ok: false,
      rule: "TRADE_CAP_EXCEEDED",
      errorCode: 114,
      message: "the amount is above the per-trade cap for token in",
      burnHeight: String(simnet.burnBlockHeight),
      // The size that would pass (R5), and the advisory warnings.
      suggestion: expect.objectContaining({
        maxAmountIn: USD_TRADE.toString(),
        limitedBy: "TRADE_CAP_EXCEEDED",
      }),
      warnings: expect.any(Array),
    });
  });

  it("keelio_check_trade passes USD under its cap while sBTC is at its cap", async () => {
    expect(await result("keelio_check_trade", trade())).toMatchObject({
      ok: false,
      rule: "DAY_CAP_EXCEEDED",
      errorCode: 115,
      message:
        "the amount would take the day total above the daily cap for token in",
    });
    expect(
      await result(
        "keelio_check_trade",
        trade({ ...sellUsd, amountIn: USD_TRADE.toString() }),
      ),
    ).toStrictEqual({
      ok: true,
      burnHeight: String(simnet.burnBlockHeight),
      warnings: expect.any(Array),
    });
  });

  it("keelio_journal decodes set-token-caps's token", async () => {
    const events = (await result("keelio_journal", { owner: alice }))
      .events as Json[];
    expect(events[1]).toStrictEqual({
      burnHeight: String(simnet.burnBlockHeight),
      event: "set-token-caps",
      owner: alice,
      token: usd,
      "max-per-trade": USD_TRADE.toString(),
      "max-per-day": USD_DAY.toString(),
    });
    expect(events[2]).toStrictEqual({
      burnHeight: String(simnet.burnBlockHeight),
      event: "set-policy",
      owner: alice,
      "cooldown-blocks": "0",
      "expires-at": EXPIRES_AT.toString(),
    });
  });
});

describe("keelio_check_trade", () => {
  it("passes a valid trade", async () => {
    expect(await result("keelio_check_trade", trade())).toStrictEqual({
      ok: true,
      burnHeight: String(simnet.burnBlockHeight),
      // Advisory, and beside the verdict: the vault has not traded yet.
      warnings: [
        {
          kind: "FIRST_TRADE_IN_DIRECTION",
          message: "this vault has never sold this token for that one before",
          tokenIn: sbtc,
          tokenOut: usd,
        },
      ],
    });
  });

  it("refuses above the per-trade cap with the contract code", async () => {
    expect(
      await result(
        "keelio_check_trade",
        trade({ amountIn: (MAX_PER_TRADE + 1n).toString() }),
      ),
    ).toStrictEqual({
      ok: false,
      rule: "TRADE_CAP_EXCEEDED",
      errorCode: 114,
      message: "the amount is above the per-trade cap for token in",
      burnHeight: String(simnet.burnBlockHeight),
      suggestion: {
        maxAmountIn: MAX_PER_TRADE.toString(),
        limitedBy: "TRADE_CAP_EXCEEDED",
        limits: {
          perTrade: MAX_PER_TRADE.toString(),
          dayRoom: MAX_PER_DAY.toString(),
          balance: DEPOSIT.toString(),
        },
        cooldownEndsAt: null,
        dayWindowClearBy: null,
        approvalThreshold: null,
        maxDirectAmountIn: MAX_PER_TRADE.toString(),
        directLimitedBy: "TRADE_CAP_EXCEEDED",
      },
      warnings: expect.any(Array),
    });
  });

  it("refuses an agent that is not the vault's agent", async () => {
    expect(
      await result("keelio_check_trade", trade({ agent: mallory })),
    ).toMatchObject({ ok: false, rule: "NOT_AGENT", errorCode: 108 });
    // The owner is not the caller either.
    expect(
      await result("keelio_check_trade", trade({ agent: alice })),
    ).toMatchObject({ ok: false, rule: "NOT_AGENT", errorCode: 108 });
  });

  it("refuses when paused", async () => {
    ok(vaultCall(alice, "pause"));
    expect(await result("keelio_check_trade", trade())).toMatchObject({
      ok: false,
      rule: "VAULT_PAUSED",
      errorCode: 109,
    });
  });

  it("refuses a zero amount with ZERO_AMOUNT", async () => {
    expect(
      await result("keelio_check_trade", trade({ amountIn: "0" })),
    ).toMatchObject({ ok: false, rule: "ZERO_AMOUNT", errorCode: 100 });
  });

  it("agrees with the contract on the cooldown", async () => {
    ok(
      vaultCall(alice, "set-token-caps", [
        Cl.principal(sbtc),
        Cl.uint(MAX_PER_TRADE),
        Cl.uint(MAX_PER_DAY),
      ]),
    );
    ok(vaultCall(alice, "set-policy", [Cl.uint(1n), Cl.uint(EXPIRES_AT)]));
    expect(swap(AMOUNT_IN).result.type).toBe("ok");
    expect(await result("keelio_check_trade", trade())).toMatchObject({
      ok: false,
      rule: "COOLDOWN_ACTIVE",
    });
    expect(swap(AMOUNT_IN).result).toStrictEqual(Cl.error(Cl.uint(116)));
  });

  it("refuses minOut one below the oracle floor with 125, as the contract does", async () => {
    const floor = floorOf(AMOUNT_IN, PRICE_90K, SLIPPAGE_BPS, true);
    // 10,000 sats at $90,000 less 1%: 8,910,000 USD base units.
    expect(floor).toBe(8_910_000n);
    expect(
      await result(
        "keelio_check_trade",
        trade({ minOut: (floor - 1n).toString() }),
      ),
    ).toStrictEqual({
      ok: false,
      rule: "BELOW_ORACLE_FLOOR",
      errorCode: 125,
      message: "min-out is below the oracle floor",
      burnHeight: String(simnet.burnBlockHeight),
      // Not a size refusal: no suggestion.
      warnings: expect.any(Array),
    });
    expect(
      await result("keelio_check_trade", trade({ minOut: floor.toString() })),
    ).toMatchObject({ ok: true });
    const atFloor = vaultCall(bob, "execute-swap", [
      Cl.principal(alice),
      Cl.principal(dex),
      Cl.principal(sbtc),
      Cl.principal(usd),
      Cl.uint(AMOUNT_IN),
      Cl.uint(floor - 1n),
    ]);
    expect(atFloor.result).toStrictEqual(Cl.error(Cl.uint(125)));
  });

  it("refuses an owner who never set price bounds with 119", async () => {
    // Dave is set up like alice, except for the price bounds.
    mint("mock-sbtc", DEPOSIT, dave);
    const daveCall = (fn: string, args: ClarityValue[]) =>
      ok(vaultCall(dave, fn, args));
    expect(
      vaultCall(dave, "deposit", [Cl.principal(sbtc), Cl.uint(DEPOSIT)]).result
        .type,
    ).toBe("ok");
    daveCall("set-agent", [Cl.principal(bob)]);
    daveCall("allow-token", [Cl.principal(sbtc), Cl.bool(true)]);
    daveCall("allow-token", [Cl.principal(usd), Cl.bool(true)]);
    daveCall("allow-adapter", [Cl.principal(dex), Cl.bool(true)]);
    daveCall("set-token-caps", [
      Cl.principal(sbtc),
      Cl.uint(MAX_PER_TRADE),
      Cl.uint(MAX_PER_DAY),
    ]);
    daveCall("set-policy", [Cl.uint(0n), Cl.uint(EXPIRES_AT)]);
    expect(
      await result("keelio_check_trade", trade({ owner: dave })),
    ).toMatchObject({
      ok: false,
      rule: "PRICE_BOUNDS_UNSET",
      errorCode: 119,
      message: "the owner has not set price bounds",
    });
    expect(swap(AMOUNT_IN, dave).result).toStrictEqual(Cl.error(Cl.uint(119)));
  });
});

/** Runs a serialised call on the simnet with its post-conditions enforced. */
function runJson(c: Json, sender: string) {
  const functionArgs = (c.functionArgs as string[]).map((h) =>
    Cl.deserialize(h),
  );
  const postConditions = (c.postConditions as Json[]).map(
    (pc) => ({ ...pc, amount: BigInt(pc.amount as string) }) as PostCondition,
  );
  return simnet.callPublicFn(
    `${c.contractAddress as string}.${c.contractName as string}`,
    c.functionName as string,
    functionArgs,
    sender,
    { postConditions, postConditionMode: c.postConditionMode as "deny" },
  );
}

describe("keelio_build_swap", () => {
  it("refuses minOut below the oracle floor and builds no call", async () => {
    const floor = floorOf(AMOUNT_IN, PRICE_90K, SLIPPAGE_BPS, true);
    const body = await result(
      "keelio_build_swap",
      swapArgs({ minOut: (floor - 1n).toString() }),
    );
    expect(body).toStrictEqual({
      ok: false,
      rule: "BELOW_ORACLE_FLOOR",
      errorCode: 125,
      message: "min-out is below the oracle floor",
      burnHeight: String(simnet.burnBlockHeight),
    });
    expect(body).not.toHaveProperty("call");
  });

  it("refuses above the cap and builds no call", async () => {
    const { res, body } = await call(
      "keelio_build_swap",
      swapArgs({ amountIn: (MAX_PER_TRADE + 1n).toString() }),
    );
    expect(res.isError ?? false).toBe(false);
    expect(body).toStrictEqual({
      ok: false,
      rule: "TRADE_CAP_EXCEEDED",
      errorCode: 114,
      message: "the amount is above the per-trade cap for token in",
      burnHeight: String(simnet.burnBlockHeight),
      // The check's refusal with its suggestion, and no warnings: the build
      // does not read the journal.
      suggestion: expect.objectContaining({
        maxAmountIn: MAX_PER_TRADE.toString(),
      }),
    });
    expect("call" in body).toBe(false);
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect("call" in parsed).toBe(false);
    expect(parsed).toStrictEqual(body);
  });

  it("refuses a stranger agent and builds no call", async () => {
    const body = await result(
      "keelio_build_swap",
      swapArgs({ agent: mallory }),
    );
    expect(body).toMatchObject({ ok: false, rule: "NOT_AGENT" });
    expect("call" in body).toBe(false);
  });

  it("re-checks on every call: a pause after a pass refuses", async () => {
    expect(await result("keelio_build_swap", swapArgs())).toMatchObject({
      ok: true,
    });
    ok(vaultCall(alice, "pause"));
    const body = await result("keelio_build_swap", swapArgs());
    expect(body).toMatchObject({ ok: false, rule: "VAULT_PAUSED" });
    expect("call" in body).toBe(false);
  });

  it("builds the unsigned execute-swap call for a passing trade", async () => {
    const body = await result("keelio_build_swap", swapArgs());
    expect(Object.keys(body).sort()).toStrictEqual(
      ["burnHeight", "call", "ok"].sort(),
    );
    expect(body.ok).toBe(true);
    expect(body.burnHeight).toBe(String(simnet.burnBlockHeight));
    const c = body.call as Json;
    const input: ExecuteSwapInput = {
      owner: alice,
      adapter: dex,
      tokenIn: sbtc,
      tokenOut: usd,
      amountIn: AMOUNT_IN,
      minOut: AMOUNT_IN * RATE,
    };
    const built = buildExecuteSwap(tx, input);
    expect(c.contractAddress).toBe(deployer);
    expect(c.contractName).toBe("keelio-vault");
    expect(c.functionName).toBe("execute-swap");
    // The built call holds uint values as decimal strings; the hex decodes to
    // the bigint values written here from the contract's signature.
    expect(
      (c.functionArgs as string[]).map((h) => Cl.deserialize(h)),
    ).toStrictEqual([
      Cl.standardPrincipal(alice),
      Cl.contractPrincipal(deployer, "mock-dex"),
      Cl.contractPrincipal(deployer, "mock-sbtc"),
      Cl.contractPrincipal(deployer, "mock-usd"),
      Cl.uint(AMOUNT_IN),
      Cl.uint(AMOUNT_IN * RATE),
    ]);
    expect(c.functionArgs).toStrictEqual(
      built.functionArgs.map((a) => Cl.serialize(a)),
    );
    expect(c.functionArgsRepr).toStrictEqual(
      built.functionArgs.map((a) => Cl.prettyPrint(a)),
    );
    expect(c.postConditionMode).toBe("deny");
    expect(c.postConditions).toStrictEqual([
      {
        type: "ft-postcondition",
        address: vaultId,
        condition: "lte",
        amount: "10000",
        asset: `${sbtc}::mock-sbtc`,
      },
      {
        type: "ft-postcondition",
        address: dex,
        condition: "gte",
        amount: "9000000",
        asset: `${usd}::mock-usd`,
      },
    ]);
  });

  it("the built call runs on the simnet when bob sends it", async () => {
    const body = await result("keelio_build_swap", swapArgs());
    const res = runJson(body.call as Json, bob);
    expect(res.result.type).toBe("ok");
    const after = await result("keelio_get_vault", { owner: alice });
    expect(after.balances).toStrictEqual({
      [sbtc]: (DEPOSIT - AMOUNT_IN).toString(),
      [usd]: (AMOUNT_IN * RATE).toString(),
    });
  });

  it("returns UNKNOWN_ASSET when the config has no asset name", async () => {
    const c = await connect({
      chain,
      read,
      tx: { ...tx, assetNames: { [sbtc]: "mock-sbtc" } },
    });
    const res = (await c.callTool({
      name: "keelio_build_swap",
      arguments: swapArgs(),
    })) as CallToolResult;
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({
      error: { code: "UNKNOWN_ASSET", field: "tokenOut" },
    });
  });

  it("returns UNKNOWN_ADAPTER when the config has no route for an allowed adapter", async () => {
    const c = await connect({ chain, read, tx: { ...tx, adapters: {} } });
    const res = (await c.callTool({
      name: "keelio_build_swap",
      arguments: swapArgs(),
    })) as CallToolResult;
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({
      error: { code: "UNKNOWN_ADAPTER", field: "adapter" },
    });
  });

  it("still returns the trade check's refusal before UNKNOWN_ADAPTER", async () => {
    const c = await connect({ chain, read, tx: { ...tx, adapters: {} } });
    const res = (await c.callTool({
      name: "keelio_build_swap",
      arguments: swapArgs({ amountIn: (MAX_PER_TRADE + 1n).toString() }),
    })) as CallToolResult;
    expect(res.isError ?? false).toBe(false);
    expect(res.structuredContent).toMatchObject({
      ok: false,
      rule: "TRADE_CAP_EXCEEDED",
    });
    expect("call" in (res.structuredContent ?? {})).toBe(false);
  });
});

describe("bad input", () => {
  const PRINCIPAL_TOOLS: [string, (o: Json) => Json][] = [
    ["keelio_get_vault", (o) => ({ owner: alice, ...o })],
    ["keelio_check_trade", trade],
    ["keelio_build_swap", swapArgs],
    ["keelio_journal", (o) => ({ owner: alice, ...o })],
  ];

  it("INVALID_PRINCIPAL for a bad owner, in every tool", async () => {
    for (const [name, args] of PRINCIPAL_TOOLS) {
      await expectInputError(
        name,
        args({ owner: "not-a-principal" }),
        "INVALID_PRINCIPAL",
        "owner",
      );
    }
  });

  it("INVALID_PRINCIPAL for a bad agent", async () => {
    for (const name of ["keelio_check_trade", "keelio_build_swap"]) {
      const args = name === "keelio_check_trade" ? trade : swapArgs;
      for (const bad of ["not-a-principal", `${bob}X`, `${deployer}.`]) {
        await expectInputError(
          name,
          args({ agent: bad }),
          "INVALID_PRINCIPAL",
          "agent",
        );
      }
    }
  });

  it("INVALID_PRINCIPAL for a standard address as adapter or token", async () => {
    for (const name of ["keelio_check_trade", "keelio_build_swap"]) {
      const args = name === "keelio_check_trade" ? trade : swapArgs;
      for (const field of ["adapter", "tokenIn", "tokenOut"]) {
        await expectInputError(
          name,
          args({ [field]: alice }),
          "INVALID_PRINCIPAL",
          field,
        );
        await expectInputError(
          name,
          args({ [field]: `${deployer}.${"a".repeat(41)}` }),
          "INVALID_PRINCIPAL",
          field,
        );
      }
    }
  });

  it("INVALID_AMOUNT for amountIn that is not a uint decimal string", async () => {
    const bad = [
      "-1",
      "1.5",
      "1e3",
      " 10",
      "",
      "0x10",
      (2n ** 128n).toString(),
    ];
    for (const name of ["keelio_check_trade", "keelio_build_swap"]) {
      const args = name === "keelio_check_trade" ? trade : swapArgs;
      for (const amountIn of bad) {
        await expectInputError(
          name,
          args({ amountIn }),
          "INVALID_AMOUNT",
          "amountIn",
        );
      }
    }
  });

  it("accepts amountIn of 2^128 - 1 as input; the policy refuses it", async () => {
    expect(
      await result(
        "keelio_check_trade",
        trade({ amountIn: (2n ** 128n - 1n).toString() }),
      ),
    ).toMatchObject({ ok: false, rule: "TRADE_CAP_EXCEEDED" });
  });

  it("INVALID_AMOUNT for a bad minOut", async () => {
    for (const name of ["keelio_check_trade", "keelio_build_swap"]) {
      for (const minOut of ["abc", "-1", (2n ** 128n).toString()]) {
        await expectInputError(
          name,
          trade({ minOut }),
          "INVALID_AMOUNT",
          "minOut",
        );
      }
    }
  });

  it("a missing minOut is an input error, never a check without it", async () => {
    // minOut is required in the schema, so the MCP SDK's own input check
    // refuses the call (-32602) before the handler runs.
    const { tools } = await client.listTools();
    for (const name of ["keelio_check_trade", "keelio_build_swap"]) {
      const schema = tools.find((t) => t.name === name)!.inputSchema;
      expect(schema.required).toContain("minOut");
      const { res, body } = await call(name, trade({ minOut: undefined }));
      expect(res.isError).toBe(true);
      expect(body).toBeUndefined();
      const text = (res.content[0] as { text: string }).text;
      expect(text).toContain("Input validation error");
      expect(text).toContain("minOut");
    }
  });

  it("INVALID_AMOUNT for a minOut above 2^64 - 1 on a passing trade", async () => {
    // A post-condition amount must fit u64; the policy check passes first.
    await expectInputError(
      "keelio_build_swap",
      swapArgs({ minOut: (2n ** 64n).toString() }),
      "INVALID_AMOUNT",
      "minOut",
    );
    expect(
      await result(
        "keelio_build_swap",
        swapArgs({ minOut: (2n ** 64n - 1n).toString() }),
      ),
    ).toMatchObject({ ok: true });
  });

  it("INVALID_INPUT for a limit out of range", async () => {
    for (const limit of [0, 501, -1]) {
      await expectInputError(
        "keelio_journal",
        { owner: alice, limit },
        "INVALID_INPUT",
        "limit",
      );
    }
  });

  it("a number for amountIn is refused, never treated as an amount", async () => {
    // The SDK's own schema check may answer first, as a tool error or a
    // rejected call; both are refusals.
    let res: CallToolResult | undefined;
    try {
      res = (await client.callTool({
        name: "keelio_check_trade",
        arguments: trade({ amountIn: 10000 }),
      })) as CallToolResult;
    } catch {
      return;
    }
    expect(res.isError).toBe(true);
  });

  it("a chain failure is CHAIN_ERROR and the server keeps serving", async () => {
    let fail = true;
    const flaky = {
      ...chain,
      callReadOnly: (contract: string, fn: string, args: ClarityValue[]) => {
        if (fail) throw new Error("node unreachable");
        return chain.callReadOnly(contract, fn, args);
      },
    };
    const c = await connect({ chain: flaky, read, tx });
    const res = (await c.callTool({
      name: "keelio_get_vault",
      arguments: { owner: alice },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toStrictEqual({
      error: { code: "CHAIN_ERROR", field: null, message: "node unreachable" },
    });
    fail = false;
    const again = (await c.callTool({
      name: "keelio_get_vault",
      arguments: { owner: alice },
    })) as CallToolResult;
    expect(again.isError ?? false).toBe(false);
  });
});

/**
 * Another spelling of the same principal: c32 reads O as 0 and I as 1, so the
 * contract sees these as one principal.
 */
function alias(principal: string): string {
  const [address, name] = principal.split(".") as [string, string?];
  const spelled =
    address.slice(0, 2) +
    address.slice(2).replace(/0/g, "O").replace(/1/g, "I");
  expect(spelled).not.toBe(address);
  const out = name === undefined ? spelled : `${spelled}.${name}`;
  expect(Cl.serialize(Cl.principal(out))).toBe(
    Cl.serialize(Cl.principal(principal)),
  );
  return out;
}

describe("principals spelled another way", () => {
  // Every simnet account here has a 0 or 1 to respell.
  const aliased = (): Json =>
    trade({
      owner: alias(alice),
      agent: alias(bob),
      adapter: alias(dex),
      tokenIn: alias(sbtc),
      tokenOut: alias(usd),
    });

  it("keelio_check_trade agrees with the contract, which accepts the swap", async () => {
    expect(await result("keelio_check_trade", aliased())).toStrictEqual({
      ok: true,
      burnHeight: String(simnet.burnBlockHeight),
      warnings: expect.any(Array),
    });
    const t = aliased();
    const res = vaultCall(alias(bob), "execute-swap", [
      Cl.principal(t.owner as string),
      Cl.principal(t.adapter as string),
      Cl.principal(t.tokenIn as string),
      Cl.principal(t.tokenOut as string),
      Cl.uint(BigInt(t.amountIn as string)),
      Cl.uint(BigInt(t.minOut as string)),
    ]);
    expect(res.result.type).toBe("ok");
  });

  it("keelio_build_swap builds the same call as for the usual spelling", async () => {
    const plain = await result("keelio_build_swap", swapArgs());
    expect(await result("keelio_build_swap", aliased())).toStrictEqual(plain);
  });

  it("keelio_get_vault and keelio_journal read the owner's vault and echo the usual spelling", async () => {
    expect(
      await result("keelio_get_vault", { owner: alias(alice) }),
    ).toStrictEqual(await result("keelio_get_vault", { owner: alice }));
    const events = (await result("keelio_journal", { owner: alias(alice) }))
      .events as Json[];
    expect(events).toHaveLength(9);
  });
});

describe("keelio_journal", () => {
  it("lists the owner's events newest first", async () => {
    expect(swap(AMOUNT_IN).result.type).toBe("ok");
    ok(vaultCall(alice, "pause"));
    const body = await result("keelio_journal", { owner: alice });
    expect(body.owner).toBe(alice);
    const events = body.events as Json[];
    expect(events.map((e) => e.event)).toStrictEqual([
      "pause",
      "execute-swap",
      "set-policy",
      "set-token-caps",
      "allow-adapter",
      "allow-token",
      "allow-token",
      "set-price-bounds",
      "unpause",
      "set-agent",
      "deposit",
    ]);
    for (const e of events) {
      expect(Object.keys(e).slice(0, 2)).toStrictEqual(["burnHeight", "event"]);
    }
    expect(events[0]).toStrictEqual({
      burnHeight: String(simnet.burnBlockHeight),
      event: "pause",
      owner: alice,
      agent: bob,
      paused: true,
    });
    expect(events[1]).toStrictEqual({
      burnHeight: String(simnet.burnBlockHeight),
      event: "execute-swap",
      owner: alice,
      agent: bob,
      adapter: dex,
      "token-in": sbtc,
      "token-out": usd,
      "amount-in": "10000",
      "min-out": "8910000",
      "amount-out": "9000000",
      "balance-in": (DEPOSIT - AMOUNT_IN).toString(),
      "balance-out": "9000000",
      "day-total": "10000",
      "oracle-price": PRICE_90K.toString(),
      "oracle-timestamp": oracleTimestamp(simnet).toString(),
      "min-out-floor": "8910000",
    });
    expect(events.at(-1)).toStrictEqual({
      burnHeight: String(simnet.burnBlockHeight),
      event: "deposit",
      owner: alice,
      token: sbtc,
      amount: DEPOSIT.toString(),
      balance: DEPOSIT.toString(),
    });
  });

  it("decodes remove-agent's none as null", async () => {
    ok(vaultCall(alice, "remove-agent"));
    const [first] = (await result("keelio_journal", { owner: alice, limit: 1 }))
      .events as Json[];
    expect(first).toStrictEqual({
      burnHeight: String(simnet.burnBlockHeight),
      event: "remove-agent",
      owner: alice,
      agent: null,
      paused: false,
    });
  });

  it("limit caps the count", async () => {
    const body = await result("keelio_journal", { owner: alice, limit: 2 });
    expect((body.events as Json[]).map((e) => e.event)).toStrictEqual([
      "set-policy",
      "set-token-caps",
    ]);
  });

  it("leaves out another owner's events", async () => {
    mint("mock-sbtc", 500n, dave);
    expect(
      vaultCall(dave, "deposit", [Cl.principal(sbtc), Cl.uint(500n)]).result
        .type,
    ).toBe("ok");
    ok(vaultCall(dave, "pause"));
    const alices = (await result("keelio_journal", { owner: alice }))
      .events as Json[];
    // The nine setup calls: deposit, set-agent, unpause, set-price-bounds,
    // two allow-token, allow-adapter, set-token-caps and set-policy.
    expect(alices).toHaveLength(9);
    expect(alices.every((e) => e.owner === alice)).toBe(true);
    const daves = (await result("keelio_journal", { owner: dave }))
      .events as Json[];
    expect(daves.map((e) => e.event)).toStrictEqual(["pause", "deposit"]);
  });

  it("a refused call adds no event", async () => {
    const before = (await result("keelio_journal", { owner: alice }))
      .events as Json[];
    expect(swap(MAX_PER_TRADE + 1n).result).toStrictEqual(
      Cl.error(Cl.uint(114)),
    );
    expect(
      (await result("keelio_journal", { owner: alice })).events,
    ).toStrictEqual(before);
  });

  it("records only the vault's prints, at the call's burn height", async () => {
    const h = BigInt(simnet.burnBlockHeight);
    const records = await chain.vaultEvents();
    expect(records).toHaveLength(9);
    expect(records.every((r) => r.burnHeight === h)).toBe(true);
  });

  it("an owner with no events gets an empty list", async () => {
    expect(await result("keelio_journal", { owner: mallory })).toStrictEqual({
      owner: mallory,
      events: [],
    });
  });
});

describe("runStdio", () => {
  it("refuses to start without an injected chain client", async () => {
    await expect(runStdio({} as KeelioMcpDeps)).rejects.toThrow(
      "chain client must be injected",
    );
    await expect(
      runStdio({
        chain: { callReadOnly: () => Cl.uint(0n) },
        read,
        tx,
      } as unknown as KeelioMcpDeps),
    ).rejects.toThrow("chain client must be injected");
    // Every method but blockTimeMs.
    const { blockTimeMs: _, ...noClock } = chain;
    void _;
    await expect(
      runStdio({ chain: noClock, read, tx } as unknown as KeelioMcpDeps),
    ).rejects.toThrow("chain client must be injected");
  });
});

describe("keelio_size_position", () => {
  const good = {
    capital: "1000000",
    riskBps: "100",
    entry: "50000",
    stop: "49000",
    lotSize: "1",
  };

  it("describes itself as size-only", async () => {
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === "keelio_size_position");
    expect(t?.description).toContain("does not read the vault");
    expect(t?.description).toContain("policy");
  });

  it("returns the SDK's size as decimal strings", async () => {
    const body = await result("keelio_size_position", good);
    const want = sizePosition({
      capital: 1000000n,
      riskBps: 100n,
      entry: 50000n,
      stop: 49000n,
      lotSize: 1n,
    });
    expect(body).toStrictEqual({
      ok: true,
      quantity: want.quantity.toString(),
      riskAmount: want.riskAmount.toString(),
    });
  });

  it("returns ok with zero when the quantity rounds to zero lots", async () => {
    const body = await result("keelio_size_position", {
      ...good,
      lotSize: "1000000000000",
    });
    expect(body).toStrictEqual({ ok: true, quantity: "0", riskAmount: "0" });
  });

  it.each([
    ["NON_POSITIVE_INPUT", { capital: "0" }],
    ["RISK_ABOVE_CEILING", { riskBps: "201" }],
    ["ENTRY_EQUALS_STOP", { stop: "50000" }],
  ])("returns %s as a normal refusal", async (code, patch) => {
    const body = await result("keelio_size_position", { ...good, ...patch });
    expect(body).toMatchObject({ ok: false, code });
    expect(String(body.message).length).toBeGreaterThan(0);
  });

  it.each(["-1", "1.5"])("refuses capital %s as INVALID_AMOUNT", async (v) => {
    await expectInputError(
      "keelio_size_position",
      { ...good, capital: v },
      "INVALID_AMOUNT",
      "capital",
    );
  });
});
