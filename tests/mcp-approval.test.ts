import { initSimnet } from "@stacks/clarinet-sdk";
import { Cl, type ClarityValue } from "@stacks/transactions";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildCancelSwapRequest,
  buildRequestSwap,
  type TxConfig,
  type VaultConfig,
} from "../packages/sdk/src/index.js";
import {
  createServer,
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
} from "./oracle-fixture.js";

// The owner-approval band (R1) and the journal tools (R3, R5, R7, R8)
// through the MCP server. Each test starts from a fresh simnet: Alice's vault
// with Bob as agent and an sBTC approval threshold of 20,000 sats under a
// per-trade cap of 100,000. Every refusal the tools predict is compared with
// the contract's answer to the same call.

let simnet = await initSimnet();
const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const alice = accounts.get("wallet_1")!;
const bob = accounts.get("wallet_2")!;
const mallory = accounts.get("wallet_3")!;
const carol = accounts.get("wallet_4")!;

const vaultId = `${deployer}.keelio-vault`;
const sbtc = `${deployer}.mock-sbtc`;
const usd = `${deployer}.mock-usd`;
const dex = `${deployer}.mock-dex`;

const RATE = 900n;
const DEPOSIT = 1_000_000n;
const MAX_PER_TRADE = 100_000n;
const MAX_PER_DAY = 250_000n;
const THRESHOLD = 20_000n;
const SMALL = 10_000n;
const BIG = 50_000n;
const EXPIRES_AT = 1_000_000n;
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

type Json = Record<string, unknown>;

const floor = (amountIn: bigint) =>
  floorOf(amountIn, PRICE_90K, SLIPPAGE_BPS, true);
const height = () => BigInt(simnet.burnBlockHeight);
const err = (code: number) => Cl.error(Cl.uint(code));

function vaultCall(sender: string, fn: string, args: ClarityValue[] = []) {
  return chain.callPublicFn("keelio-vault", fn, args, sender);
}

function ok(call: { result: ClarityValue }) {
  expect(call.result).toStrictEqual(Cl.ok(Cl.bool(true)));
}

function swapArgs(amountIn: bigint, minOut = floor(amountIn)) {
  return [
    Cl.principal(dex),
    Cl.principal(sbtc),
    Cl.principal(usd),
    Cl.uint(amountIn),
    Cl.uint(minOut),
  ];
}

// The contract's own calls, through `chain` so the journal records them.
const execute = (amountIn: bigint, sender = bob) =>
  vaultCall(sender, "execute-swap", [
    Cl.principal(alice),
    ...swapArgs(amountIn),
  ]);
const request = (amountIn: bigint, sender = bob) =>
  vaultCall(sender, "request-swap", [
    Cl.principal(alice),
    ...swapArgs(amountIn),
  ]);
/** Alice approves the request stored now, as an owner who has just read it. */
const approve = (amountIn: bigint) => {
  const stored = simnet.callReadOnlyFn(
    "keelio-vault",
    "get-pending-swap",
    [Cl.principal(alice)],
    deployer,
  ).result;
  const at =
    stored.type === "some" && stored.value.type === "tuple"
      ? stored.value.value["requested-at"]
      : undefined;
  return vaultCall(alice, "approve-swap", [
    ...swapArgs(amountIn),
    at?.type === "uint" ? at : Cl.uint(0),
  ]);
};

function setThreshold(threshold: bigint | null, token = sbtc) {
  ok(
    vaultCall(alice, "set-approval-threshold", [
      Cl.principal(token),
      threshold === null ? Cl.none() : Cl.some(Cl.uint(threshold)),
    ]),
  );
}

async function connect(deps: KeelioMcpDeps): Promise<Client> {
  const server = createServer(deps);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "keelio-test", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), c.connect(clientSide)]);
  return c;
}

/** Calls a tool that must succeed and returns its structured result. */
async function result(name: string, args: Json, on = client): Promise<Json> {
  const res = (await on.callTool({ name, arguments: args })) as CallToolResult;
  expect(res.isError ?? false, JSON.stringify(res.structuredContent)).toBe(
    false,
  );
  const body = res.structuredContent as Json;
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
  const res = (await client.callTool({
    name,
    arguments: args,
  })) as CallToolResult;
  expect(res.isError).toBe(true);
  expect(res.structuredContent).toMatchObject({ error: { code, field } });
}

/** The tools' trade input: selling `amountIn` sBTC at the oracle floor. */
const trade = (amountIn: bigint, over: Json = {}): Json => ({
  owner: alice,
  agent: bob,
  adapter: dex,
  tokenIn: sbtc,
  tokenOut: usd,
  amountIn: amountIn.toString(),
  minOut: floor(amountIn).toString(),
  ...over,
});

/** Sends a call a tool built, as a wallet would after decoding it. */
function send(call: unknown, sender: string) {
  const c = call as { functionName: string; functionArgs: string[] };
  return vaultCall(
    sender,
    c.functionName,
    c.functionArgs.map((hex) => Cl.deserialize(hex)),
  );
}

/** Paths in a tool result holding a number: only these may. */
function numbers(value: unknown, path = ""): string[] {
  if (typeof value === "number") return [path];
  if (typeof value === "bigint") return [`${path} (bigint)`];
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => numbers(v, `${path}[${i}]`));
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([k, v]) =>
      numbers(v, path === "" ? k : `${path}.${k}`),
    );
  }
  return [];
}

beforeEach(async () => {
  simnet = await initSimnet();
  chain = simnetChain(simnet, deployer);
  const mint = (token: string, amount: bigint, to: string) =>
    ok(
      chain.callPublicFn(
        token,
        "mint",
        [Cl.uint(amount), Cl.principal(to)],
        deployer,
      ),
    );
  mint("mock-usd", 10n ** 18n, dex);
  ok(
    chain.callPublicFn(
      "mock-dex",
      "set-rate",
      [Cl.uint(RATE), Cl.uint(1n)],
      deployer,
    ),
  );
  ok(
    chain.callPublicFn(
      "mock-oracle",
      "set-value-aged",
      [Cl.stringAscii(ORACLE_KEY), Cl.uint(PRICE_90K), Cl.uint(0n)],
      deployer,
    ),
  );
  mint("mock-sbtc", DEPOSIT, alice);
  // Alice's journal, in order: events 0 to 8.
  expect(
    vaultCall(alice, "deposit", [Cl.principal(sbtc), Cl.uint(DEPOSIT)]).result
      .type,
  ).toBe("ok"); // 0
  ok(vaultCall(alice, "set-agent", [Cl.principal(bob)])); // 1
  ok(vaultCall(alice, "allow-token", [Cl.principal(sbtc), Cl.bool(true)])); // 2
  ok(vaultCall(alice, "allow-token", [Cl.principal(usd), Cl.bool(true)])); // 3
  ok(vaultCall(alice, "allow-adapter", [Cl.principal(dex), Cl.bool(true)])); // 4
  ok(
    vaultCall(alice, "set-token-caps", [
      Cl.principal(sbtc),
      Cl.uint(MAX_PER_TRADE),
      Cl.uint(MAX_PER_DAY),
    ]),
  ); // 5
  ok(vaultCall(alice, "set-policy", [Cl.uint(0n), Cl.uint(EXPIRES_AT)])); // 6
  ok(
    vaultCall(alice, "set-price-bounds", [
      Cl.uint(SLIPPAGE_BPS),
      Cl.uint(10n ** 15n),
    ]),
  ); // 7
  setThreshold(THRESHOLD); // 8
  client = await connect({ chain, read, tx });
});

describe("keelio_get_vault with an approval band", () => {
  it("returns each token's threshold and no request", async () => {
    const body = await result("keelio_get_vault", { owner: alice });
    expect(body.approvalThresholds).toStrictEqual({
      [sbtc]: THRESHOLD.toString(),
      [usd]: null,
    });
    expect(body.pendingSwap).toBeNull();
    // A threshold of 0 is a threshold: every trade needs approval.
    setThreshold(0n);
    const zero = await result("keelio_get_vault", { owner: alice });
    expect(zero.approvalThresholds).toStrictEqual({ [sbtc]: "0", [usd]: null });
  });

  it("returns the stored request, and says when it has expired", async () => {
    const at = height();
    expect(request(BIG).result.type).toBe("ok");
    const stored = {
      agent: bob,
      adapter: dex,
      tokenIn: sbtc,
      tokenOut: usd,
      amountIn: BIG.toString(),
      minOut: floor(BIG).toString(),
      requestedAt: at.toString(),
      expiresAt: (at + 6n).toString(),
    };
    const pending = async () =>
      (await result("keelio_get_vault", { owner: alice })).pendingSwap;
    expect(await pending()).toStrictEqual({ ...stored, expired: false });
    simnet.mineEmptyBurnBlocks(6);
    expect(await pending()).toStrictEqual({ ...stored, expired: false });
    simnet.mineEmptyBurnBlocks(1);
    const body = await result("keelio_get_vault", { owner: alice });
    expect(body.burnHeight).toBe((at + 7n).toString());
    expect(body.pendingSwap).toStrictEqual({ ...stored, expired: true });
    expect(numbers(body)).toStrictEqual([]);
  });
});

describe("keelio_check_trade with an approval band", () => {
  it("passes at the threshold, as the contract does", async () => {
    const body = await result("keelio_check_trade", trade(THRESHOLD));
    expect(body).toMatchObject({ ok: true });
    expect(execute(THRESHOLD).result.type).toBe("ok");
  });

  it("one above the threshold is u126, and says a request is needed", async () => {
    const body = await result("keelio_check_trade", trade(THRESHOLD + 1n));
    expect(body).toStrictEqual({
      ok: false,
      rule: "APPROVAL_REQUIRED",
      errorCode: 126,
      message:
        "the amount is above the owner's approval threshold for token in: " +
        "send it with request-swap instead, and it runs when the owner approves",
      burnHeight: height().toString(),
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
        approvalThreshold: THRESHOLD.toString(),
        maxDirectAmountIn: THRESHOLD.toString(),
        directLimitedBy: "APPROVAL_REQUIRED",
      },
      requestNeeded: true,
      warnings: [
        {
          kind: "FIRST_TRADE_IN_DIRECTION",
          message: "this vault has never sold this token for that one before",
          tokenIn: sbtc,
          tokenOut: usd,
        },
      ],
    });
    expect(numbers(body)).toStrictEqual(["errorCode"]);
    expect(execute(THRESHOLD + 1n).result).toStrictEqual(err(126));
  });

  it("a size refusal carries the suggestion, and only u126 asks for a request", async () => {
    const over = await result("keelio_check_trade", trade(MAX_PER_TRADE + 1n));
    expect(over).toMatchObject({
      ok: false,
      rule: "TRADE_CAP_EXCEEDED",
      errorCode: 114,
      suggestion: {
        maxAmountIn: MAX_PER_TRADE.toString(),
        maxDirectAmountIn: THRESHOLD.toString(),
      },
    });
    expect(over).not.toHaveProperty("requestNeeded");
    expect(execute(MAX_PER_TRADE + 1n).result).toStrictEqual(err(114));
    // The suggested amounts hold on the contract.
    const direct = BigInt(
      (over.suggestion as { maxDirectAmountIn: string }).maxDirectAmountIn,
    );
    expect(execute(direct + 1n).result).toStrictEqual(err(126));
    expect(execute(direct).result.type).toBe("ok");
    // Any other refusal has neither field.
    ok(vaultCall(alice, "pause"));
    const paused = await result("keelio_check_trade", trade(SMALL));
    expect(paused).toMatchObject({ ok: false, rule: "VAULT_PAUSED" });
    expect(paused).not.toHaveProperty("suggestion");
    expect(paused).not.toHaveProperty("requestNeeded");
  });

  it("warnings sit beside a passing verdict and never change it", async () => {
    expect(execute(1_000n).result.type).toBe("ok");
    expect(execute(1_000n).result.type).toBe("ok");
    // The third trade in one burn block, and 20 times the median.
    const body = await result("keelio_check_trade", trade(THRESHOLD));
    expect(body).toStrictEqual({
      ok: true,
      burnHeight: height().toString(),
      warnings: [
        {
          kind: "LARGE_TRADE",
          message:
            "the amount is more than 3 times the median of this vault's past trades in this direction",
          amountIn: THRESHOLD.toString(),
          baseline: "1000",
          basis: "median",
          sizeMultiple: "3",
          pastTrades: "2",
        },
        {
          kind: "BURST",
          message: "this would be trade 3 of this vault within 6 burn blocks",
          trades: "3",
          burstBlocks: "6",
        },
      ],
    });
    expect(numbers(body)).toStrictEqual([]);
    // Advisory: the build passes the same trade and the contract runs it.
    const built = await result("keelio_build_swap", trade(THRESHOLD));
    expect(built).toMatchObject({ ok: true });
    expect(built).not.toHaveProperty("warnings");
    expect(send(built.call, bob).result.type).toBe("ok");
  });

  it("counts a trade the owner approved as a past trade", async () => {
    expect(request(BIG).result.type).toBe("ok");
    expect(approve(BIG).result.type).toBe("ok");
    simnet.mineEmptyBurnBlocks(10);
    const body = await result("keelio_check_trade", trade(SMALL));
    // Not a first trade in this direction: the approve-swap was one.
    expect(body).toStrictEqual({
      ok: true,
      burnHeight: height().toString(),
      warnings: [],
    });
  });

  it("a journal that cannot be read leaves the verdict standing", async () => {
    const broken = await connect({
      chain: {
        ...chain,
        vaultEvents: () => {
          throw new Error("event index down");
        },
      },
      read,
      tx,
    });
    expect(
      await result("keelio_check_trade", trade(SMALL), broken),
    ).toStrictEqual({
      ok: true,
      burnHeight: height().toString(),
      warnings: null,
      warningsError: "event index down",
    });
    expect(
      await result("keelio_check_trade", trade(BIG), broken),
    ).toMatchObject({
      ok: false,
      errorCode: 126,
      requestNeeded: true,
      warnings: null,
    });
  });
});

describe("keelio_build_swap with an approval band", () => {
  it("refuses a trade above the threshold and builds no call", async () => {
    const body = await result("keelio_build_swap", trade(BIG));
    expect(body).toMatchObject({
      ok: false,
      rule: "APPROVAL_REQUIRED",
      errorCode: 126,
      requestNeeded: true,
      suggestion: { maxDirectAmountIn: THRESHOLD.toString() },
    });
    expect(body).not.toHaveProperty("call");
    expect(body).not.toHaveProperty("warnings");
  });

  it("builds a direct trade exactly as before", async () => {
    const body = await result("keelio_build_swap", trade(THRESHOLD));
    expect(Object.keys(body).sort()).toStrictEqual([
      "burnHeight",
      "call",
      "ok",
    ]);
    expect(body.call).toMatchObject({ functionName: "execute-swap" });
    expect(send(body.call, bob).result.type).toBe("ok");
  });
});

describe("keelio_build_swap_request", () => {
  it("builds the unsigned request-swap call, which moves nothing", async () => {
    const body = await result("keelio_build_swap_request", trade(BIG));
    const want = buildRequestSwap(tx, {
      owner: alice,
      adapter: dex,
      tokenIn: sbtc,
      tokenOut: usd,
      amountIn: BIG,
      minOut: floor(BIG),
    });
    expect(body).toStrictEqual({
      ok: true,
      burnHeight: height().toString(),
      call: {
        contractAddress: deployer,
        contractName: "keelio-vault",
        functionName: "request-swap",
        functionArgs: want.functionArgs.map((a) => Cl.serialize(a)),
        functionArgsRepr: [
          `'${alice}`,
          `'${dex}`,
          `'${sbtc}`,
          `'${usd}`,
          `u${BIG}`,
          `u${floor(BIG)}`,
        ],
        postConditions: [],
        postConditionMode: "deny",
      },
    });
    // The server has sent nothing: there is no request until the agent does.
    expect(
      (await result("keelio_get_vault", { owner: alice })).pendingSwap,
    ).toBeNull();
    const at = height();
    expect(send(body.call, bob).result).toStrictEqual(Cl.ok(Cl.uint(at + 6n)));
    expect(
      (await result("keelio_get_vault", { owner: alice })).pendingSwap,
    ).toMatchObject({ amountIn: BIG.toString(), expired: false });
  });

  /** The tool's refusal, then the contract's answer to the same request. */
  async function refusedBoth(
    code: number,
    rule: string,
    amountIn: bigint,
    sender = bob,
  ) {
    const body = await result(
      "keelio_build_swap_request",
      trade(amountIn, { agent: sender }),
    );
    expect(body).toMatchObject({
      ok: false,
      rule,
      errorCode: code,
      burnHeight: height().toString(),
    });
    expect(body).not.toHaveProperty("call");
    expect(request(amountIn, sender).result).toStrictEqual(err(code));
    return body;
  }

  it("u127 at the threshold: no request is needed", async () => {
    const body = await refusedBoth(127, "APPROVAL_NOT_NEEDED", THRESHOLD);
    expect(body.message).toMatch(/execute-swap/);
    expect(numbers(body)).toStrictEqual(["errorCode"]);
    // One more is a request.
    expect(
      await result("keelio_build_swap_request", trade(THRESHOLD + 1n)),
    ).toMatchObject({ ok: true });
  });

  it("u127 for a token with no threshold", async () => {
    setThreshold(null);
    await refusedBoth(127, "APPROVAL_NOT_NEEDED", BIG);
  });

  it("u108 for a principal that is not the vault's agent", async () => {
    await refusedBoth(108, "NOT_AGENT", BIG, mallory);
    await refusedBoth(108, "NOT_AGENT", BIG, alice);
  });

  it("u109 when paused, and u114 over the cap with the size that would pass", async () => {
    const over = await refusedBoth(
      114,
      "TRADE_CAP_EXCEEDED",
      MAX_PER_TRADE + 1n,
    );
    expect(over.suggestion).toMatchObject({
      maxAmountIn: MAX_PER_TRADE.toString(),
    });
    ok(vaultCall(alice, "pause"));
    await refusedBoth(109, "VAULT_PAUSED", BIG);
  });

  it("u128 while a request is pending through H + 6, and builds again at H + 7", async () => {
    expect(request(BIG).result.type).toBe("ok");
    await refusedBoth(128, "REQUEST_PENDING", BIG + 1n);
    simnet.mineEmptyBurnBlocks(6);
    await refusedBoth(128, "REQUEST_PENDING", BIG + 1n);
    simnet.mineEmptyBurnBlocks(1);
    const body = await result("keelio_build_swap_request", trade(BIG + 1n));
    expect(body).toMatchObject({ ok: true });
    expect(send(body.call, bob).result.type).toBe("ok");
  });

  it("re-checks on every call: a pause after a pass refuses", async () => {
    expect(await result("keelio_build_swap_request", trade(BIG))).toMatchObject(
      {
        ok: true,
      },
    );
    ok(vaultCall(alice, "pause"));
    const body = await result("keelio_build_swap_request", trade(BIG));
    expect(body).toMatchObject({ ok: false, rule: "VAULT_PAUSED" });
    expect(body).not.toHaveProperty("call");
  });

  it("returns input errors in the tools' format", async () => {
    await expectInputError(
      "keelio_build_swap_request",
      trade(BIG, { owner: "nobody" }),
      "INVALID_PRINCIPAL",
      "owner",
    );
    await expectInputError(
      "keelio_build_swap_request",
      trade(BIG, { adapter: alice }),
      "INVALID_PRINCIPAL",
      "adapter",
    );
    await expectInputError(
      "keelio_build_swap_request",
      trade(BIG, { amountIn: "1.5" }),
      "INVALID_AMOUNT",
      "amountIn",
    );
    // The owner's approval carries min-out in a post-condition, so a
    // request above u64 is refused here, after the check passes.
    await expectInputError(
      "keelio_build_swap_request",
      trade(BIG, { minOut: (2n ** 64n).toString() }),
      "INVALID_AMOUNT",
      "minOut",
    );
  });
});

describe("keelio_build_cancel_request", () => {
  const args = (agent = bob): Json => ({ owner: alice, agent });
  const cancel = (sender: string) =>
    vaultCall(sender, "cancel-swap-request", [Cl.principal(alice)]);

  it("u129 when the owner has no request", async () => {
    const body = await result("keelio_build_cancel_request", args());
    expect(body).toStrictEqual({
      ok: false,
      rule: "NO_PENDING_SWAP",
      errorCode: 129,
      message: "the owner has no pending request",
      burnHeight: height().toString(),
    });
    expect(cancel(bob).result).toStrictEqual(err(129));
  });

  it("u133 for a principal that did not make the request", async () => {
    expect(request(BIG).result.type).toBe("ok");
    for (const other of [mallory, alice]) {
      const body = await result("keelio_build_cancel_request", args(other));
      expect(body).toMatchObject({
        ok: false,
        rule: "NOT_REQUESTER",
        errorCode: 133,
      });
      expect(body).not.toHaveProperty("call");
      expect(cancel(other).result).toStrictEqual(err(133));
    }
  });

  it("builds the unsigned call, and the requester's send removes the request", async () => {
    expect(request(BIG).result.type).toBe("ok");
    // Expired or not: an expired request can still be withdrawn.
    simnet.mineEmptyBurnBlocks(7);
    const body = await result("keelio_build_cancel_request", args());
    const want = buildCancelSwapRequest(tx, { owner: alice });
    expect(body).toStrictEqual({
      ok: true,
      burnHeight: height().toString(),
      call: {
        contractAddress: deployer,
        contractName: "keelio-vault",
        functionName: "cancel-swap-request",
        functionArgs: want.functionArgs.map((a) => Cl.serialize(a)),
        functionArgsRepr: [`'${alice}`],
        postConditions: [],
        postConditionMode: "deny",
      },
    });
    expect(send(body.call, bob).result).toStrictEqual(Cl.ok(Cl.bool(true)));
    expect(
      (await result("keelio_get_vault", { owner: alice })).pendingSwap,
    ).toBeNull();
  });

  it("returns input errors in the tools' format", async () => {
    await expectInputError(
      "keelio_build_cancel_request",
      { owner: alice, agent: "nobody" },
      "INVALID_PRINCIPAL",
      "agent",
    );
    await expectInputError(
      "keelio_build_cancel_request",
      { owner: "nobody", agent: bob },
      "INVALID_PRINCIPAL",
      "owner",
    );
  });
});

describe("the approval flow, as an agent sees it", () => {
  it("u126, a request, the owner's approval, then approve-swap in the journal", async () => {
    // The agent's direct trade is refused in advance.
    const check = await result("keelio_check_trade", trade(BIG));
    expect(check).toMatchObject({ errorCode: 126, requestNeeded: true });
    // It builds the request and sends it itself.
    const built = await result("keelio_build_swap_request", trade(BIG));
    const requestedAt = height();
    expect(send(built.call, bob).result.type).toBe("ok");
    const newest = async () =>
      (
        (await result("keelio_journal", { owner: alice, limit: 1 }))
          .events as Json[]
      )[0]!;
    expect(await newest()).toMatchObject({
      event: "request-swap",
      "amount-in": BIG.toString(),
      "requested-at": requestedAt.toString(),
      "expires-at": (requestedAt + 6n).toString(),
    });
    // The owner approves in the dashboard: the owner's own call.
    simnet.mineEmptyBurnBlocks(2);
    expect(approve(BIG).result).toStrictEqual(Cl.ok(Cl.uint(BIG * RATE)));
    // The agent reads the outcome: an approve-swap and no execute-swap.
    expect(await newest()).toMatchObject({
      event: "approve-swap",
      agent: bob,
      "amount-in": BIG.toString(),
      "amount-out": (BIG * RATE).toString(),
      "requested-at": requestedAt.toString(),
    });
    const vault = await result("keelio_get_vault", { owner: alice });
    expect(vault.pendingSwap).toBeNull();
    expect(vault.balances).toStrictEqual({
      [sbtc]: (DEPOSIT - BIG).toString(),
      [usd]: (BIG * RATE).toString(),
    });
  });

  it("a request nobody approves expires, and the agent can ask again", async () => {
    const built = await result("keelio_build_swap_request", trade(BIG));
    expect(send(built.call, bob).result.type).toBe("ok");
    simnet.mineEmptyBurnBlocks(7);
    const vault = await result("keelio_get_vault", { owner: alice });
    expect(vault.pendingSwap).toMatchObject({ expired: true });
    // The owner is too late.
    expect(approve(BIG).result).toStrictEqual(err(130));
    const again = await result("keelio_build_swap_request", trade(BIG));
    expect(again).toMatchObject({ ok: true });
    expect(send(again.call, bob).result.type).toBe("ok");
    expect(approve(BIG).result.type).toBe("ok");
  });

  it("a rejected request shows as reject-swap in the journal", async () => {
    expect(request(BIG).result.type).toBe("ok");
    ok(vaultCall(alice, "reject-swap"));
    const { events } = await result("keelio_journal", {
      owner: alice,
      limit: 2,
    });
    expect((events as Json[]).map((e) => e.event)).toStrictEqual([
      "reject-swap",
      "request-swap",
    ]);
    expect(
      (await result("keelio_get_vault", { owner: alice })).pendingSwap,
    ).toBeNull();
  });
});

// Bob trades inside his authority (event 9), asks for a larger trade (10)
// which Alice approves (11), asks again and is rejected (12, 13), and asks
// once more and withdraws it (14, 15).
function story() {
  expect(execute(SMALL).result.type).toBe("ok");
  const requestedAt = height();
  expect(request(BIG).result.type).toBe("ok");
  simnet.mineEmptyBurnBlocks(1);
  const approvedAt = height();
  expect(approve(BIG).result.type).toBe("ok");
  expect(request(BIG + 1n).result.type).toBe("ok");
  ok(vaultCall(alice, "reject-swap"));
  expect(request(BIG + 2n).result.type).toBe("ok");
  ok(vaultCall(bob, "cancel-swap-request", [Cl.principal(alice)]));
  return { requestedAt, approvedAt };
}

describe("keelio_agent_history", () => {
  it("reports the agent's trades and requests from the journal", async () => {
    const { approvedAt } = story();
    const setUpAt = (
      (await result("keelio_journal", { owner: alice, limit: 500 }))
        .events as Json[]
    ).at(-2)!.burnHeight;
    const body = await result("keelio_agent_history", { agent: bob });
    expect(body).toStrictEqual({
      known: true,
      agent: bob,
      firstSeen: { index: 1, burnHeight: setUpAt, txId: null },
      owners: [
        {
          owner: alice,
          firstNamedAt: { index: 1, burnHeight: setUpAt, txId: null },
          current: true,
          endedAt: null,
        },
      ],
      swaps: "2",
      volume: [
        { tokenIn: sbtc, swaps: "2", amountIn: (SMALL + BIG).toString() },
      ],
      lastTrade: { index: 11, burnHeight: approvedAt.toString(), txId: null },
      approvedSwaps: "1",
      requests: { made: "3", approved: "1", rejected: "1", cancelled: "1" },
    });
    // The only numbers are positions in the journal.
    expect(numbers(body)).toStrictEqual([
      "firstSeen.index",
      "owners[0].firstNamedAt.index",
      "lastTrade.index",
    ]);
  });

  it("an owner replacing the agent ends its naming", async () => {
    ok(vaultCall(alice, "set-agent", [Cl.principal(carol)]));
    const body = await result("keelio_agent_history", { agent: bob });
    expect(body).toMatchObject({
      known: true,
      owners: [{ owner: alice, current: false, endedAt: { index: 9 } }],
      swaps: "0",
      lastTrade: null,
    });
  });

  it("a principal the journal never names is unknown, not an error", async () => {
    story();
    expect(
      await result("keelio_agent_history", { agent: mallory }),
    ).toStrictEqual({ known: false, agent: mallory });
    // An owner is not an agent.
    expect(
      await result("keelio_agent_history", { agent: alice }),
    ).toStrictEqual({
      known: false,
      agent: alice,
    });
  });

  it("refuses a malformed principal, and echoes the canonical spelling", async () => {
    await expectInputError(
      "keelio_agent_history",
      { agent: "not-a-principal" },
      "INVALID_PRINCIPAL",
      "agent",
    );
    // c32 reads O as 0 and I as 1: the same principal, spelled another way.
    const alias =
      bob.slice(0, 2) + bob.slice(2).replace(/0/g, "O").replace(/1/g, "I");
    expect(alias).not.toBe(bob);
    expect(
      await result("keelio_agent_history", { agent: alias }),
    ).toMatchObject({
      known: true,
      agent: bob,
    });
  });
});

describe("keelio_accountability", () => {
  it("returns each trade with its limits, as JSON and as a report", async () => {
    const { requestedAt, approvedAt } = story();
    const body = await result("keelio_accountability", { owner: alice });
    expect(body.owner).toBe(alice);
    expect(body.totalTrades).toBe("2");
    const records = body.records as Json[];
    expect(records).toHaveLength(2);
    const [direct, approved] = records as [Json, Json];
    expect(direct).toMatchObject({
      swap: {
        ref: { index: 9 },
        agent: bob,
        amountIn: SMALL.toString(),
        approved: false,
        requestedAt: null,
      },
      request: null,
      issues: [],
    });
    expect(approved).toMatchObject({
      swap: {
        ref: { index: 11, burnHeight: approvedAt.toString(), txId: null },
        owner: alice,
        agent: bob,
        adapter: dex,
        tokenIn: sbtc,
        tokenOut: usd,
        amountIn: BIG.toString(),
        minOut: floor(BIG).toString(),
        amountOut: (BIG * RATE).toString(),
        dayTotal: (SMALL + BIG).toString(),
        approved: true,
        requestedAt: requestedAt.toString(),
      },
      request: { index: 10, burnHeight: requestedAt.toString(), txId: null },
      policy: {
        agent: { agent: bob, setBy: { index: 1 } },
        terms: {
          cooldownBlocks: "0",
          expiresAt: EXPIRES_AT.toString(),
          setBy: { index: 6 },
        },
        caps: {
          token: sbtc,
          maxPerTrade: MAX_PER_TRADE.toString(),
          maxPerDay: MAX_PER_DAY.toString(),
          setBy: { index: 5 },
        },
        priceBounds: {
          maxSlippageBps: SLIPPAGE_BPS.toString(),
          setBy: { index: 7 },
        },
        approvalThreshold: {
          token: sbtc,
          threshold: THRESHOLD.toString(),
          setBy: { index: 8 },
        },
        tokens: [
          { id: sbtc, allowed: true, setBy: { index: 2 } },
          { id: usd, allowed: true, setBy: { index: 3 } },
        ],
        adapters: [{ id: dex, allowed: true, setBy: { index: 4 } }],
      },
      issues: [],
    });
    // Every amount and height is a string; the numbers are event positions.
    expect(numbers(body).every((path) => path.endsWith(".index"))).toBe(true);
    const report = body.report as string;
    expect(report).toMatch(
      new RegExp(`^# Keelio accountability record for ${alice}\n`),
    );
    expect(report).toContain("2 trades, oldest first.");
    expect(report).toContain("## Trade 2: journal event 11");
    expect(report).toContain("approved by the owner (`approve-swap`)");
    expect(report).toContain(
      `a trade selling more than ${THRESHOLD} needs the owner's approval`,
    );
  });

  it("limit keeps the most recent trades and still counts them all", async () => {
    story();
    const body = await result("keelio_accountability", {
      owner: alice,
      limit: 1,
    });
    expect(body.totalTrades).toBe("2");
    const records = body.records as { swap: { ref: { index: number } } }[];
    expect(records.map((r) => r.swap.ref.index)).toStrictEqual([11]);
    expect(body.report).toContain("1 trade, oldest first.");
    expect(body.report).not.toContain("journal event 9 ");
  });

  it("an owner with no trades gets an empty record, not an error", async () => {
    story();
    const body = await result("keelio_accountability", { owner: carol });
    expect(body).toStrictEqual({
      owner: carol,
      totalTrades: "0",
      records: [],
      report: expect.stringContaining("The journal given holds no trades."),
    });
  });

  it("leaves out another owner's trades", async () => {
    story();
    // Carol's own vault, with Bob as her agent too.
    ok(
      chain.callPublicFn(
        "mock-sbtc",
        "mint",
        [Cl.uint(5_000n), Cl.principal(carol)],
        deployer,
      ),
    );
    expect(
      vaultCall(carol, "deposit", [Cl.principal(sbtc), Cl.uint(5_000n)]).result
        .type,
    ).toBe("ok");
    ok(vaultCall(carol, "set-agent", [Cl.principal(bob)]));
    ok(vaultCall(carol, "allow-token", [Cl.principal(sbtc), Cl.bool(true)]));
    ok(vaultCall(carol, "allow-token", [Cl.principal(usd), Cl.bool(true)]));
    ok(vaultCall(carol, "allow-adapter", [Cl.principal(dex), Cl.bool(true)]));
    ok(
      vaultCall(carol, "set-token-caps", [
        Cl.principal(sbtc),
        Cl.uint(1_000n),
        Cl.uint(1_000n),
      ]),
    );
    ok(vaultCall(carol, "set-policy", [Cl.uint(0n), Cl.uint(EXPIRES_AT)]));
    ok(
      vaultCall(carol, "set-price-bounds", [
        Cl.uint(SLIPPAGE_BPS),
        Cl.uint(10n ** 15n),
      ]),
    );
    expect(
      vaultCall(bob, "execute-swap", [Cl.principal(carol), ...swapArgs(1_000n)])
        .result.type,
    ).toBe("ok");
    const carols = await result("keelio_accountability", { owner: carol });
    expect(carols.totalTrades).toBe("1");
    expect(carols.records).toMatchObject([
      {
        swap: { owner: carol, amountIn: "1000", approved: false },
        // Carol set no threshold: no band for her trade.
        policy: { approvalThreshold: null },
        issues: [],
      },
    ]);
    expect(
      (await result("keelio_accountability", { owner: alice })).totalTrades,
    ).toBe("2");
    // Bob's history spans both owners.
    expect(await result("keelio_agent_history", { agent: bob })).toMatchObject({
      swaps: "3",
      owners: [{ owner: alice }, { owner: carol }],
    });
  });

  it("refuses a bad owner or limit", async () => {
    await expectInputError(
      "keelio_accountability",
      { owner: "nobody" },
      "INVALID_PRINCIPAL",
      "owner",
    );
    for (const limit of [0, 501]) {
      await expectInputError(
        "keelio_accountability",
        { owner: alice, limit },
        "INVALID_INPUT",
        "limit",
      );
    }
  });
});
