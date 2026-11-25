import { initSimnet, tx, type Tx } from "@stacks/clarinet-sdk";
import { Cl, type ClarityValue } from "@stacks/transactions";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  checkIntent,
  minOutFloor,
  readVault,
  RULES,
  simnetClient,
  suggestSize,
  type Intent,
  type IntentRefusal,
  type VaultConfig,
  type VaultState,
} from "../packages/sdk/src/index.js";
import {
  ORACLE_KEY,
  PRICE_90K,
  PRICE_SCALE,
  armOracle,
  floorOf,
} from "./oracle-fixture.js";

const simnet = await initSimnet();
const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const alice = accounts.get("wallet_1")!;
const bob = accounts.get("wallet_2")!;
const mallory = accounts.get("wallet_3")!;
const dave = accounts.get("wallet_4")!;

const sbtc = `${deployer}.mock-sbtc`;
const usd = `${deployer}.mock-usd`;
const dex = `${deployer}.mock-dex`;
const evil = `${deployer}.evil-token`;

const RATE = 900n;
const DEPOSIT = 1_000_000n;
const AMOUNT_IN = 10_000n;
const MAX_PER_TRADE = 100_000n;
const MAX_PER_DAY = 1_000_000_000n;
const USD_MAX_PER_TRADE = MAX_PER_TRADE * RATE;
const USD_MAX_PER_DAY = MAX_PER_DAY * RATE;
const EXPIRES_AT = 1_000_000n;
// The oracle fixture: $90,000, the dex rate 900, and an age limit no test
// here reaches. Every trade sends min-out at the oracle floor unless it names
// its own.
const SLIPPAGE_BPS = 100n;

const config: VaultConfig = {
  vault: "keelio-vault",
  tokens: [sbtc, usd],
  adapters: [dex],
  oracle: "mock-oracle",
  sbtcToken: sbtc,
  priceScale: PRICE_SCALE,
};
const client = simnetClient(simnet, deployer);

function ok(call: { result: ClarityValue }) {
  expect(call.result).toStrictEqual(Cl.ok(Cl.bool(true)));
}

function vaultCall(sender: string, fn: string, args: ClarityValue[] = []) {
  return simnet.callPublicFn("keelio-vault", fn, args, sender);
}

function setPolicy(
  maxPerTrade: bigint,
  maxPerDay: bigint,
  cooldownBlocks: bigint,
  expiresAt: bigint,
  token = sbtc,
) {
  ok(
    vaultCall(alice, "set-token-caps", [
      Cl.principal(token),
      Cl.uint(maxPerTrade),
      Cl.uint(maxPerDay),
    ]),
  );
  ok(
    vaultCall(alice, "set-policy", [
      Cl.uint(cooldownBlocks),
      Cl.uint(expiresAt),
    ]),
  );
}

// An oracle timestamp in ms, a literal so the expected reads do not come from
// the oracle itself.
const PRICE_AT = 1_700_000_000_000n;

function setPrice(price: bigint, timestamp: bigint) {
  ok(
    simnet.callPublicFn(
      "mock-oracle",
      "set-value",
      [Cl.stringAscii(ORACLE_KEY), Cl.uint(price), Cl.uint(timestamp)],
      deployer,
    ),
  );
}

// Any test that sets it resets it in a `finally`.
function setFailing(on: boolean) {
  ok(
    simnet.callPublicFn("mock-oracle", "set-failing", [Cl.bool(on)], deployer),
  );
}

function allowToken(token: string, allowed: boolean) {
  ok(vaultCall(alice, "allow-token", [Cl.principal(token), Cl.bool(allowed)]));
}

function mint(contract: string, amount: bigint, recipient: string) {
  ok(
    simnet.callPublicFn(
      contract,
      "mint",
      [Cl.uint(amount), Cl.principal(recipient)],
      deployer,
    ),
  );
}

type Trade = Partial<Intent> & { owner?: string };

// min-out defaults to the oracle floor at the fixture's price and slippage.
function intentOf(t: Trade): Intent {
  const tokenIn = t.tokenIn ?? sbtc;
  const amountIn = t.amountIn ?? AMOUNT_IN;
  return {
    caller: t.caller ?? bob,
    adapter: t.adapter ?? dex,
    tokenIn,
    tokenOut: t.tokenOut ?? usd,
    amountIn,
    minOut:
      t.minOut ?? floorOf(amountIn, PRICE_90K, SLIPPAGE_BPS, tokenIn === sbtc),
  };
}

function swapTx(t: Trade): Tx {
  const i = intentOf(t);
  return tx.callPublicFn(
    "keelio-vault",
    "execute-swap",
    [
      Cl.principal(t.owner ?? alice),
      Cl.principal(i.adapter),
      Cl.principal(i.tokenIn),
      Cl.principal(i.tokenOut),
      Cl.uint(i.amountIn),
      Cl.uint(i.minOut),
    ],
    i.caller,
  );
}

// Runs the trade through the contract, with the intent's caller as sender.
function contractResult(t: Trade): ClarityValue {
  const i = intentOf(t);
  return simnet.callPublicFn(
    "keelio-vault",
    "execute-swap",
    [
      Cl.principal(t.owner ?? alice),
      Cl.principal(i.adapter),
      Cl.principal(i.tokenIn),
      Cl.principal(i.tokenOut),
      Cl.uint(i.amountIn),
      Cl.uint(i.minOut),
    ],
    i.caller,
  ).result;
}

/** The time `execute-swap` saw: read after the block the swap ran in. */
function blockTimeMs(): bigint {
  return BigInt(simnet.getBlockTime()) * 1000n;
}

async function checkAgainstContract(t: Trade) {
  const read = await readVault(client, config, t.owner ?? alice);
  const burnHeight = BigInt(simnet.burnBlockHeight);
  const result = contractResult(t);
  const check = checkIntent(
    { ...read, burnHeight, nowMs: blockTimeMs() },
    intentOf(t),
  );
  return { check, result };
}

async function expectRefusal(code: number, t: Trade = {}) {
  const { check, result } = await checkAgainstContract(t);
  expect(result).toStrictEqual(Cl.error(Cl.uint(code)));
  expect(check).toMatchObject({ ok: false, errorCode: code });
}

async function expectAllowed(t: Trade = {}) {
  const { check, result } = await checkAgainstContract(t);
  expect(check).toStrictEqual({ ok: true });
  expect(result.type).toBe("ok");
}

beforeAll(() => {
  mint("mock-usd", 10n ** 18n, dex);
});

beforeEach(() => {
  simnet.mineEmptyBurnBlocks(144);
  ok(
    simnet.callPublicFn(
      "mock-dex",
      "set-rate",
      [Cl.uint(RATE), Cl.uint(1)],
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
  allowToken(sbtc, true);
  allowToken(usd, true);
  ok(vaultCall(alice, "allow-adapter", [Cl.principal(dex), Cl.bool(true)]));
  setPolicy(USD_MAX_PER_TRADE, USD_MAX_PER_DAY, 0n, EXPIRES_AT, usd);
  setPolicy(MAX_PER_TRADE, MAX_PER_DAY, 0n, EXPIRES_AT);
  armOracle(simnet, alice, {
    price: PRICE_90K,
    slippageBps: SLIPPAGE_BPS,
    maxAgeMs: 10n ** 15n,
  });
});

describe("readVault", () => {
  it("returns the contract's own values, with no trade yet", async () => {
    // Dave has never traded, so there is no last trade.
    mint("mock-sbtc", 500n, dave);
    expect(
      vaultCall(dave, "deposit", [Cl.principal(sbtc), Cl.uint(500n)]).result
        .type,
    ).toBe("ok");
    ok(vaultCall(dave, "set-agent", [Cl.principal(bob)]));
    ok(vaultCall(dave, "allow-token", [Cl.principal(sbtc), Cl.bool(true)]));
    ok(vaultCall(dave, "allow-adapter", [Cl.principal(dex), Cl.bool(true)]));
    ok(
      vaultCall(dave, "set-token-caps", [
        Cl.principal(sbtc),
        Cl.uint(7n),
        Cl.uint(70n),
      ]),
    );
    ok(vaultCall(dave, "set-policy", [Cl.uint(3n), Cl.uint(EXPIRES_AT)]));
    ok(vaultCall(dave, "set-price-bounds", [Cl.uint(33n), Cl.uint(5_000n)]));
    setPrice(PRICE_90K, PRICE_AT);

    expect(await readVault(client, config, dave)).toStrictEqual({
      vault: { agent: bob, paused: false },
      policy: {
        cooldownBlocks: 3n,
        expiresAt: EXPIRES_AT,
        // USD was never set, so its caps read 0n.
        caps: {
          [sbtc]: { maxPerTrade: 7n, maxPerDay: 70n },
          [usd]: { maxPerTrade: 0n, maxPerDay: 0n },
        },
        allowedTokens: [sbtc],
        allowedAdapters: [dex],
      },
      usage: { dayTotals: { [sbtc]: 0n, [usd]: 0n }, lastTradeHeight: null },
      balances: { [sbtc]: 500n, [usd]: 0n },
      priceBounds: { maxSlippageBps: 33n, maxPriceAge: 5_000n },
      oracle: {
        sbtcToken: sbtc,
        priceScale: PRICE_SCALE,
        price: { value: PRICE_90K, timestamp: PRICE_AT },
      },
      // No threshold set and no request made: no approval band.
      approvalThresholds: { [sbtc]: null, [usd]: null },
      pendingSwap: null,
    });
  });

  it("reads the usage and balances after a trade", async () => {
    const before = (await readVault(client, config, alice)).balances;
    const h = BigInt(simnet.burnBlockHeight);
    expect(contractResult({}).type).toBe("ok");
    const read = await readVault(client, config, alice);
    expect(read.usage).toStrictEqual({
      dayTotals: { [sbtc]: AMOUNT_IN, [usd]: 0n },
      lastTradeHeight: h,
    });
    expect(read.policy.caps).toStrictEqual({
      [sbtc]: { maxPerTrade: MAX_PER_TRADE, maxPerDay: MAX_PER_DAY },
      [usd]: { maxPerTrade: USD_MAX_PER_TRADE, maxPerDay: USD_MAX_PER_DAY },
    });
    expect(read.balances).toStrictEqual({
      [sbtc]: before[sbtc]! - AMOUNT_IN,
      [usd]: before[usd]! + AMOUNT_IN * RATE,
    });
    expect(read.policy.allowedTokens).toStrictEqual([sbtc, usd]);
    expect(read.vault).toStrictEqual({ agent: bob, paused: false });
  });

  it("reads an owner with nothing set", async () => {
    setPrice(PRICE_90K, PRICE_AT);
    expect(await readVault(client, config, mallory)).toStrictEqual({
      vault: { agent: null, paused: false },
      policy: {
        cooldownBlocks: 0n,
        expiresAt: 0n,
        caps: {
          [sbtc]: { maxPerTrade: 0n, maxPerDay: 0n },
          [usd]: { maxPerTrade: 0n, maxPerDay: 0n },
        },
        allowedTokens: [],
        allowedAdapters: [],
      },
      usage: { dayTotals: { [sbtc]: 0n, [usd]: 0n }, lastTradeHeight: null },
      balances: { [sbtc]: 0n, [usd]: 0n },
      // Never set: the agent may not trade, but the oracle is still read.
      priceBounds: { maxSlippageBps: 0n, maxPriceAge: 0n },
      oracle: {
        sbtcToken: sbtc,
        priceScale: PRICE_SCALE,
        price: { value: PRICE_90K, timestamp: PRICE_AT },
      },
      // No threshold set and no request made: no approval band.
      approvalThresholds: { [sbtc]: null, [usd]: null },
      pendingSwap: null,
    });
  });

  it("reads a failing oracle as price null", async () => {
    setFailing(true);
    try {
      const read = await readVault(client, config, mallory);
      expect(read.oracle).toStrictEqual({
        sbtcToken: sbtc,
        priceScale: PRICE_SCALE,
        price: null,
      });
    } finally {
      setFailing(false);
    }
  });

  it("throws on an oracle answer that is not a response", async () => {
    const odd = {
      callReadOnly: (contract: string, fn: string, args: ClarityValue[]) =>
        fn === "get-value"
          ? Cl.uint(1)
          : client.callReadOnly(contract, fn, args),
    };
    await expect(readVault(odd, config, alice)).rejects.toThrow(
      "expected response, got uint",
    );
  });

  it("propagates any other oracle throw", async () => {
    const down = {
      callReadOnly: (contract: string, fn: string, args: ClarityValue[]) => {
        if (fn === "get-value") throw new Error("node down");
        return client.callReadOnly(contract, fn, args);
      },
    };
    await expect(readVault(down, config, alice)).rejects.toThrow("node down");
  });

  it("refuses an empty token list", async () => {
    await expect(
      readVault(client, { ...config, tokens: [] }, alice),
    ).rejects.toThrow("config.tokens is empty");
  });
});

describe("checkIntent agrees with execute-swap", () => {
  it("108: a stranger", () => expectRefusal(108, { caller: mallory }));
  it("108: the owner as caller", () => expectRefusal(108, { caller: alice }));
  it("108: a removed agent", async () => {
    ok(vaultCall(alice, "remove-agent"));
    await expectRefusal(108);
  });
  it("108: a replaced agent", async () => {
    ok(vaultCall(alice, "set-agent", [Cl.principal(mallory)]));
    await expectRefusal(108);
  });
  it("108: an owner with no agent", () =>
    expectRefusal(108, { owner: mallory }));

  it("109: paused", async () => {
    ok(vaultCall(alice, "pause"));
    await expectRefusal(109);
  });
  it("110: expired", async () => {
    setPolicy(
      MAX_PER_TRADE,
      MAX_PER_DAY,
      0n,
      BigInt(simnet.burnBlockHeight) - 1n,
    );
    await expectRefusal(110);
  });
  it("111: token in not allowed", async () => {
    allowToken(sbtc, false);
    await expectRefusal(111);
  });
  it("111: token out not allowed", async () => {
    allowToken(usd, false);
    await expectRefusal(111);
  });
  it("111: a token outside the fixed set", async () => {
    await expectRefusal(111, { tokenIn: evil });
    await expectRefusal(111, { tokenOut: evil });
  });
  it("112: same token", () => expectRefusal(112, { tokenOut: sbtc }));
  it("113: adapter not allowed", async () => {
    ok(vaultCall(alice, "allow-adapter", [Cl.principal(dex), Cl.bool(false)]));
    await expectRefusal(113);
  });
  it("100: zero amount", () => expectRefusal(100, { amountIn: 0n }));
  it("114: over maxPerTrade", () =>
    expectRefusal(114, { amountIn: MAX_PER_TRADE + 1n }));
  it("115: over maxPerDay", async () => {
    setPolicy(AMOUNT_IN, AMOUNT_IN + 1n, 0n, EXPIRES_AT);
    await expectAllowed();
    await expectRefusal(115, { amountIn: 2n });
  });
  it("116: cooldown", async () => {
    setPolicy(MAX_PER_TRADE, MAX_PER_DAY, 1n, EXPIRES_AT);
    await expectAllowed();
    await expectRefusal(116);
  });
  it("101: amount over the ledger, both directions", async () => {
    const huge = 2n ** 100n;
    setPolicy(huge, huge, 0n, EXPIRES_AT, usd);
    setPolicy(huge, huge, 0n, EXPIRES_AT);
    const { balances } = await readVault(client, config, alice);
    await expectRefusal(101, { amountIn: balances[sbtc]! + 1n });
    await expectRefusal(101, {
      tokenIn: usd,
      tokenOut: sbtc,
      amountIn: balances[usd]! + 1n,
    });
  });

  describe("accepted trades", () => {
    it("the success case", () => expectAllowed());
    it("burnHeight equals expiresAt", async () => {
      setPolicy(MAX_PER_TRADE, MAX_PER_DAY, 0n, BigInt(simnet.burnBlockHeight));
      await expectAllowed();
    });
    it("amountIn equals maxPerTrade", () =>
      expectAllowed({ amountIn: MAX_PER_TRADE }));
    it("the whole ledger", async () => {
      const { balances } = await readVault(client, config, alice);
      const all = balances[sbtc]!;
      setPolicy(all, all, 0n, EXPIRES_AT);
      await expectAllowed({ amountIn: all });
    });
    it("cooldown met exactly", async () => {
      setPolicy(MAX_PER_TRADE, MAX_PER_DAY, 3n, EXPIRES_AT);
      await expectAllowed();
      simnet.mineEmptyBurnBlocks(2);
      await expectRefusal(116);
      simnet.mineEmptyBurnBlocks(1);
      await expectAllowed();
    });
    it("the day window exactly full", async () => {
      setPolicy(AMOUNT_IN, 2n * AMOUNT_IN, 0n, EXPIRES_AT);
      await expectAllowed();
      await expectAllowed();
      await expectRefusal(115, { amountIn: 1n });
    });
  });

  describe("when two rules fail, the contract's first one wins", () => {
    it("paused with a zero amount gives 109", async () => {
      ok(vaultCall(alice, "pause"));
      await expectRefusal(109, { amountIn: 0n });
    });
    it("a stranger with an expired policy gives 108", async () => {
      setPolicy(MAX_PER_TRADE, MAX_PER_DAY, 0n, 0n);
      await expectRefusal(108, { caller: mallory });
    });
    it("over the trade cap and the ledger gives 114", () =>
      expectRefusal(114, { amountIn: MAX_PER_TRADE + 2n ** 64n }));
    it("same token that is also not allowed gives 111", async () => {
      await expectRefusal(111, { tokenIn: evil, tokenOut: evil });
    });
  });
});

// Job 015: each refusal in criteria 2-5, against the contract.
describe("checkIntent agrees with execute-swap on caps per token", () => {
  const setRate = (num: bigint, den: bigint) =>
    ok(
      simnet.callPublicFn(
        "mock-dex",
        "set-rate",
        [Cl.uint(num), Cl.uint(den)],
        deployer,
      ),
    );
  const sellUsd = { tokenIn: usd, tokenOut: sbtc };

  beforeAll(() => {
    mint("mock-sbtc", 10n ** 15n, dex);
  });
  beforeEach(() => {
    mint("mock-usd", 10n ** 12n, alice);
    expect(
      vaultCall(alice, "deposit", [Cl.principal(usd), Cl.uint(10n ** 12n)])
        .result.type,
    ).toBe("ok");
    setPolicy(10_000n, 30_000n, 0n, EXPIRES_AT, sbtc);
    setPolicy(9_000_000n, 27_000_000n, 0n, EXPIRES_AT, usd);
  });

  it("isolation: sBTC at its day cap, USD still trades", async () => {
    for (let i = 0; i < 3; i++) await expectAllowed({ amountIn: 10_000n });
    await expectRefusal(115, { amountIn: 1n });
    setRate(1n, RATE);
    await expectAllowed({ ...sellUsd, amountIn: 9_000_000n });
  });

  it("isolation: USD at its day cap, sBTC still trades", async () => {
    setRate(1n, RATE);
    for (let i = 0; i < 3; i++)
      await expectAllowed({ ...sellUsd, amountIn: 9_000_000n });
    await expectRefusal(115, { ...sellUsd, amountIn: 900n });
    setRate(RATE, 1n);
    await expectAllowed({ amountIn: 10_000n });
  });

  it("114 per token: the other token's larger cap does not count", async () => {
    // USD's cap is larger than sBTC's.
    await expectRefusal(114, { amountIn: 10_001n });
    await expectAllowed({ amountIn: 10_000n });
    setRate(1n, RATE);
    await expectRefusal(114, { ...sellUsd, amountIn: 9_000_001n });
    // Now sBTC's cap is larger than USD's.
    setPolicy(5_000n, 5_000n, 0n, EXPIRES_AT, usd);
    await expectRefusal(114, { ...sellUsd, amountIn: 5_001n * RATE });
    await expectRefusal(114, { ...sellUsd, amountIn: 9_000n });
  });

  it("115 per token: reaching a cap exactly passes, one more refuses", async () => {
    setPolicy(9_000_000n, 18_000_000n, 0n, EXPIRES_AT, usd);
    setRate(1n, RATE);
    await expectAllowed({ ...sellUsd, amountIn: 9_000_000n });
    await expectAllowed({ ...sellUsd, amountIn: 9_000_000n });
    await expectRefusal(115, { ...sellUsd, amountIn: 900n });
    // sBTC's window is still empty: three full trades reach its cap.
    setRate(RATE, 1n);
    for (let i = 0; i < 3; i++) await expectAllowed({ amountIn: 10_000n });
    await expectRefusal(115, { amountIn: 1n });
  });

  it("a token whose caps were never set refuses with 114", async () => {
    // Dave set caps for sBTC only (readVault test above).
    mint("mock-usd", 1_000n, dave);
    expect(
      vaultCall(dave, "deposit", [Cl.principal(usd), Cl.uint(1_000n)]).result
        .type,
    ).toBe("ok");
    ok(vaultCall(dave, "allow-token", [Cl.principal(usd), Cl.bool(true)]));
    ok(
      vaultCall(dave, "set-token-caps", [
        Cl.principal(sbtc),
        Cl.uint(7n),
        Cl.uint(70n),
      ]),
    );
    ok(vaultCall(dave, "set-policy", [Cl.uint(0n), Cl.uint(EXPIRES_AT)]));
    const read = await readVault(client, config, dave);
    expect(read.policy.caps[usd]).toStrictEqual({
      maxPerTrade: 0n,
      maxPerDay: 0n,
    });
    const { check, result } = await checkAgainstContract({
      owner: dave,
      ...sellUsd,
      amountIn: 1n,
    });
    expect(result).toStrictEqual(Cl.error(Cl.uint(114)));
    // A size refusal also carries a suggestion (R5): with no caps, nothing.
    expect(check).toStrictEqual({
      ok: false,
      rule: "TRADE_CAP_EXCEEDED",
      errorCode: 114,
      message: "the amount is above the per-trade cap for token in",
      suggestion: {
        maxAmountIn: 0n,
        limitedBy: "TRADE_CAP_EXCEEDED",
        limits: { perTrade: 0n, dayRoom: 0n, balance: read.balances[usd] },
        cooldownEndsAt: null,
        dayWindowClearBy: null,
        approvalThreshold: null,
        maxDirectAmountIn: 0n,
        directLimitedBy: "TRADE_CAP_EXCEEDED",
      },
    });
  });

  it("a state with no caps or total entry for token in reads 0n", async () => {
    const read = await readVault(client, config, alice);
    const state = {
      ...read,
      policy: { ...read.policy, caps: {} },
      usage: { ...read.usage, dayTotals: {} },
      burnHeight: BigInt(simnet.burnBlockHeight),
      nowMs: blockTimeMs(),
    };
    expect(checkIntent(state, intentOf({ amountIn: 1n }))).toMatchObject({
      ok: false,
      rule: "TRADE_CAP_EXCEEDED",
      errorCode: 114,
    });
    // A caps entry but no total: the total reads 0n, so the trade passes.
    const capsOnly = {
      ...state,
      policy: { ...state.policy, caps: read.policy.caps },
    };
    expect(checkIntent(capsOnly, intentOf({ amountIn: 1n }))).toStrictEqual({
      ok: true,
    });
  });
});

describe("checkIntent", () => {
  it("does not change its inputs", async () => {
    const read = await readVault(client, config, alice);
    const state = {
      ...read,
      burnHeight: BigInt(simnet.burnBlockHeight),
      nowMs: blockTimeMs(),
    };
    const intent = intentOf({ amountIn: 0n });
    const copy = structuredClone({ state, intent });
    checkIntent(state, intent);
    expect({ state, intent }).toStrictEqual(copy);
  });
});

describe("RULES", () => {
  it("lists the 18 rules in execute-swap's order, with its codes", () => {
    expect(RULES.map((r) => [r.rule, r.errorCode])).toStrictEqual([
      ["NOT_AGENT", 108],
      ["VAULT_PAUSED", 109],
      ["POLICY_EXPIRED", 110],
      ["TOKEN_NOT_ALLOWED", 111],
      ["SAME_TOKEN", 112],
      ["ADAPTER_NOT_ALLOWED", 113],
      ["ZERO_AMOUNT", 100],
      ["TRADE_CAP_EXCEEDED", 114],
      ["APPROVAL_REQUIRED", 126],
      ["DAY_CAP_EXCEEDED", 115],
      ["COOLDOWN_ACTIVE", 116],
      ["INSUFFICIENT_BALANCE", 101],
      ["PRICE_BOUNDS_UNSET", 119],
      ["ORACLE_FAILED", 121],
      ["PRICE_ZERO", 122],
      ["PRICE_STALE", 123],
      ["PRICE_OVERFLOW", 124],
      ["BELOW_ORACLE_FLOOR", 125],
    ]);
  });
});

const MAX_UINT = 2n ** 128n - 1n;

// Job 028: the oracle floor, checked by checkIntent and by execute-swap on the
// same trade. Every row sets the price inside the swap's own block, so its age
// is exact, and reads the time after that block.
describe("checkIntent agrees with execute-swap on the oracle floor", () => {
  const MAX_AGE = 60_000n;
  // The deployer never calls set-price-bounds in this file.
  const unset = deployer;

  type Price = {
    value?: bigint;
    age?: bigint;
    ahead?: bigint;
  };
  type Row = {
    name: string;
    setUp?: () => void;
    owner?: string;
    price?: Price;
    trade: { tokenIn: string; amountIn: bigint; minOut: bigint };
    expect: number | "ok";
    /** The floor this row's trade must have, from the spec's worked example. */
    floor?: bigint;
  };

  function setBounds(slippageBps: bigint, maxAge = MAX_AGE, owner = alice) {
    ok(
      vaultCall(owner, "set-price-bounds", [
        Cl.uint(slippageBps),
        Cl.uint(maxAge),
      ]),
    );
  }

  function setRate(num: bigint, den: bigint) {
    ok(
      simnet.callPublicFn(
        "mock-dex",
        "set-rate",
        [Cl.uint(num), Cl.uint(den)],
        deployer,
      ),
    );
  }

  function priceTx({ value = PRICE_90K, age = 0n, ahead }: Price): Tx {
    return ahead === undefined
      ? tx.callPublicFn(
          "mock-oracle",
          "set-value-aged",
          [Cl.stringAscii(ORACLE_KEY), Cl.uint(value), Cl.uint(age)],
          deployer,
        )
      : tx.callPublicFn(
          "mock-oracle",
          "set-value-ahead",
          [Cl.stringAscii(ORACLE_KEY), Cl.uint(value), Cl.uint(ahead)],
          deployer,
        );
  }

  async function run(row: Row) {
    row.setUp?.();
    const owner = row.owner ?? alice;
    const { tokenIn, amountIn, minOut } = row.trade;
    const selling = tokenIn === sbtc;
    const trade: Trade = {
      owner,
      tokenIn,
      tokenOut: selling ? usd : sbtc,
      amountIn,
      minOut,
    };
    if (selling) setRate(RATE, 1n);
    else setRate(1n, RATE);

    const pre = await readVault(client, config, owner);
    const burnHeight = BigInt(simnet.burnBlockHeight);
    const [priced, swapped] = simnet.mineBlock([
      priceTx(row.price ?? {}),
      swapTx(trade),
    ]);
    if (priced!.status === "rejected") throw new Error(priced!.error);
    expect(priced!.execution.result).toStrictEqual(Cl.ok(Cl.bool(true)));
    if (swapped!.status === "rejected") throw new Error(swapped!.error);
    const result = swapped!.execution.result;
    const post = await readVault(client, config, owner);
    const state: VaultState = {
      ...pre,
      oracle: post.oracle,
      burnHeight,
      nowMs: blockTimeMs(),
    };
    const check = checkIntent(state, intentOf(trade));

    if (row.expect === "ok") {
      expect(result.type).toBe("ok");
      expect(check).toStrictEqual({ ok: true });
    } else {
      expect(result).toStrictEqual(Cl.error(Cl.uint(row.expect)));
      expect(check).toMatchObject({ ok: false, errorCode: row.expect });
    }
    if (row.floor !== undefined) {
      const slippage = pre.priceBounds.maxSlippageBps;
      const independent = floorOf(amountIn, PRICE_90K, slippage, selling);
      expect(independent).toBe(row.floor);
      expect(minOutFloor(state, tokenIn, amountIn)).toStrictEqual({
        ok: true,
        floor: independent,
      });
    }
  }

  function setFailing(on: boolean) {
    ok(
      simnet.callPublicFn(
        "mock-oracle",
        "set-failing",
        [Cl.bool(on)],
        deployer,
      ),
    );
  }

  beforeAll(() => {
    mint("mock-sbtc", 10n ** 15n, dex);
    // The deployer as a second owner: everything set up but the price bounds.
    mint("mock-sbtc", DEPOSIT, unset);
    expect(
      vaultCall(unset, "deposit", [Cl.principal(sbtc), Cl.uint(DEPOSIT)]).result
        .type,
    ).toBe("ok");
    ok(vaultCall(unset, "set-agent", [Cl.principal(bob)]));
    ok(vaultCall(unset, "allow-token", [Cl.principal(sbtc), Cl.bool(true)]));
    ok(vaultCall(unset, "allow-token", [Cl.principal(usd), Cl.bool(true)]));
    ok(vaultCall(unset, "allow-adapter", [Cl.principal(dex), Cl.bool(true)]));
    ok(
      vaultCall(unset, "set-token-caps", [
        Cl.principal(sbtc),
        Cl.uint(MAX_PER_TRADE),
        Cl.uint(MAX_PER_DAY),
      ]),
    );
    ok(vaultCall(unset, "set-policy", [Cl.uint(0n), Cl.uint(EXPIRES_AT)]));
  });

  beforeEach(() => {
    mint("mock-usd", 10n ** 12n, alice);
    expect(
      vaultCall(alice, "deposit", [Cl.principal(usd), Cl.uint(10n ** 12n)])
        .result.type,
    ).toBe("ok");
    setBounds(SLIPPAGE_BPS);
  });

  const sell = (amountIn: bigint, minOut: bigint) => ({
    tokenIn: sbtc,
    amountIn,
    minOut,
  });
  const buy = (amountIn: bigint, minOut: bigint) => ({
    tokenIn: usd,
    amountIn,
    minOut,
  });
  const floor90k = (amountIn: bigint, selling = true) =>
    floorOf(amountIn, PRICE_90K, SLIPPAGE_BPS, selling);
  const slippage33 = () => setBounds(33n);

  const rows: Row[] = [
    // 2.1: 1 sat at $90,000 less 33 bps is 897.03 USD base units: floor 898.
    {
      name: "sell sBTC, remainder > 0, minOut = floor",
      setUp: slippage33,
      trade: sell(1n, 898n),
      expect: "ok",
      floor: 898n,
    },
    {
      name: "sell sBTC, remainder > 0, minOut = floor - 1",
      setUp: slippage33,
      trade: sell(1n, 897n),
      expect: 125,
      floor: 898n,
    },
    // 2.2: 10,000 sats less 100 bps is exactly 8,910,000.
    {
      name: "sell sBTC, remainder 0, minOut = floor",
      trade: sell(10_000n, 8_910_000n),
      expect: "ok",
      floor: 8_910_000n,
    },
    {
      name: "sell sBTC, remainder 0, minOut = floor - 1",
      trade: sell(10_000n, 8_909_999n),
      expect: 125,
      floor: 8_910_000n,
    },
    // 2.3: 9,000,001 USD base units less 33 bps is 9967.0011 sats: floor 9968.
    {
      name: "buy sBTC, remainder > 0, minOut = floor",
      setUp: slippage33,
      trade: buy(9_000_001n, 9_968n),
      expect: "ok",
      floor: 9_968n,
    },
    {
      name: "buy sBTC, remainder > 0, minOut = floor - 1",
      setUp: slippage33,
      trade: buy(9_000_001n, 9_967n),
      expect: 125,
      floor: 9_968n,
    },
    // 9,000,000 less 33 bps is exactly 9967 sats.
    {
      name: "buy sBTC, remainder 0, minOut = floor",
      setUp: slippage33,
      trade: buy(9_000_000n, 9_967n),
      expect: "ok",
      floor: 9_967n,
    },
    {
      name: "buy sBTC, remainder 0, minOut = floor - 1",
      setUp: slippage33,
      trade: buy(9_000_000n, 9_966n),
      expect: 125,
      floor: 9_967n,
    },
    // 2.4 and 2.5: the age limit is inclusive, before and after now.
    {
      name: "a price exactly maxPriceAge old",
      price: { age: MAX_AGE },
      trade: sell(AMOUNT_IN, floor90k(AMOUNT_IN)),
      expect: "ok",
    },
    {
      name: "a price maxPriceAge + 1 old",
      price: { age: MAX_AGE + 1n },
      trade: sell(AMOUNT_IN, floor90k(AMOUNT_IN)),
      expect: 123,
    },
    {
      name: "a timestamp exactly maxPriceAge ahead",
      price: { ahead: MAX_AGE },
      trade: sell(AMOUNT_IN, floor90k(AMOUNT_IN)),
      expect: "ok",
    },
    {
      name: "a timestamp maxPriceAge + 1 ahead",
      price: { ahead: MAX_AGE + 1n },
      trade: sell(AMOUNT_IN, floor90k(AMOUNT_IN)),
      expect: 123,
    },
    // 2.6
    {
      name: "a zero price",
      price: { value: 0n },
      trade: sell(AMOUNT_IN, floor90k(AMOUNT_IN)),
      expect: 122,
    },
    // 2.8
    {
      name: "bounds never set",
      owner: unset,
      trade: sell(AMOUNT_IN, floor90k(AMOUNT_IN)),
      expect: 119,
    },
    // 2.9
    {
      name: "overflow selling: a * P passes 2^128 - 1",
      price: { value: MAX_UINT },
      trade: sell(AMOUNT_IN, MAX_UINT),
      expect: 124,
    },
    {
      name: "overflow buying in d: P * 10000 passes 2^128 - 1",
      price: { value: MAX_UINT / 10_000n + 1n },
      trade: buy(9_000_000n, 0n),
      expect: 124,
    },
    // 2.10: when two rules fail, the contract's first one wins.
    {
      name: "over the trade cap with a stale price gives 114",
      price: { age: MAX_AGE + 1n },
      trade: sell(MAX_PER_TRADE + 1n, floor90k(MAX_PER_TRADE + 1n)),
      expect: 114,
    },
    {
      name: "unset bounds with a zero price gives 119",
      owner: unset,
      price: { value: 0n },
      trade: sell(AMOUNT_IN, floor90k(AMOUNT_IN)),
      expect: 119,
    },
    {
      name: "a zero price that is also stale gives 122",
      price: { value: 0n, age: MAX_AGE + 1n },
      trade: sell(AMOUNT_IN, floor90k(AMOUNT_IN)),
      expect: 122,
    },
    {
      name: "a stale price with min-out below the floor gives 123",
      price: { age: MAX_AGE + 1n },
      trade: sell(AMOUNT_IN, 0n),
      expect: 123,
    },
  ];

  for (const row of rows) {
    it(`${row.name}: ${row.expect}`, () => run(row));
  }

  // 2.7 and 2.8: the oracle fails. Reset in the same test.
  it("a failing oracle: 121", async () => {
    setFailing(true);
    try {
      await run({ name: "failing", trade: sell(AMOUNT_IN, 1n), expect: 121 });
    } finally {
      setFailing(false);
    }
  });

  it("bounds never set with a failing oracle: 119, before the oracle", async () => {
    setFailing(true);
    try {
      await run({
        name: "unset and failing",
        owner: unset,
        trade: sell(AMOUNT_IN, 1n),
        expect: 119,
      });
    } finally {
      setFailing(false);
    }
  });
});

describe("minOutFloor", () => {
  const SBTC = "SP000000000000000000002Q6VF78.sbtc";
  const USD = "SP000000000000000000002Q6VF78.usd";
  const NOW = 1_700_000_000_000n;

  function stateOf(
    price: { value: bigint; timestamp?: bigint } | null,
    maxSlippageBps = 100n,
    maxPriceAge = 60_000n,
  ): VaultState {
    return {
      vault: { agent: bob, paused: false },
      policy: {
        cooldownBlocks: 0n,
        expiresAt: 1_000n,
        caps: { [SBTC]: { maxPerTrade: MAX_UINT, maxPerDay: MAX_UINT } },
        allowedTokens: [SBTC, USD],
        allowedAdapters: [dex],
      },
      usage: { dayTotals: {}, lastTradeHeight: null },
      balances: { [SBTC]: MAX_UINT },
      burnHeight: 1n,
      priceBounds: { maxSlippageBps, maxPriceAge },
      oracle: {
        sbtcToken: SBTC,
        priceScale: 10_000_000_000n,
        price:
          price === null
            ? null
            : { value: price.value, timestamp: price.timestamp ?? NOW },
      },
      nowMs: NOW,
    };
  }

  const ceil = (n: bigint, d: bigint) => n / d + (n % d === 0n ? 0n : 1n);

  it("keep 15, a 17, P = MAX_UINT / 255: a * P * keep is exactly MAX_UINT", () => {
    const p = MAX_UINT / 255n;
    // MAX_UINT = 255 * p, since 2^8 - 1 divides 2^128 - 1.
    expect(p * 255n).toBe(MAX_UINT);
    expect(minOutFloor(stateOf({ value: p }, 9_985n), SBTC, 17n)).toStrictEqual(
      { ok: true, floor: ceil(MAX_UINT, 10n ** 14n) },
    );
    expect(
      minOutFloor(stateOf({ value: p + 1n }, 9_985n), SBTC, 17n),
    ).toMatchObject({ ok: false, rule: "PRICE_OVERFLOW", errorCode: 124 });
  });

  it("buying: overflow in n, or in d alone, is PRICE_OVERFLOW", () => {
    // n = a * PRICE-SCALE * keep passes MAX_UINT; P is ordinary.
    expect(
      minOutFloor(
        stateOf({ value: PRICE_90K }),
        USD,
        MAX_UINT / 10n ** 10n + 1n,
      ),
    ).toMatchObject({ rule: "PRICE_OVERFLOW" });
    // d = P * 10000 passes MAX_UINT at the least such P.
    expect(
      minOutFloor(stateOf({ value: MAX_UINT / 10_000n + 1n }), USD, 1n),
    ).toMatchObject({ rule: "PRICE_OVERFLOW" });
    // One below it, d fits and the floor is computed.
    expect(
      minOutFloor(stateOf({ value: MAX_UINT / 10_000n }), USD, 1n),
    ).toMatchObject({ ok: true });
  });

  it("refuses when either bound is 0", () => {
    for (const [slip, age] of [
      [0n, 60_000n],
      [100n, 0n],
      [0n, 0n],
    ] as const) {
      expect(
        minOutFloor(stateOf({ value: PRICE_90K }, slip, age), SBTC, 1n),
      ).toStrictEqual({
        ok: false,
        rule: "PRICE_BOUNDS_UNSET",
        errorCode: 119,
        message: "the owner has not set price bounds",
      });
    }
  });

  it("names each oracle refusal with its stable message", () => {
    expect(minOutFloor(stateOf(null), SBTC, 1n)).toStrictEqual({
      ok: false,
      rule: "ORACLE_FAILED",
      errorCode: 121,
      message: "the oracle did not return a price",
    });
    expect(minOutFloor(stateOf({ value: 0n }), SBTC, 1n)).toStrictEqual({
      ok: false,
      rule: "PRICE_ZERO",
      errorCode: 122,
      message: "the oracle's price is zero",
    });
    expect(
      minOutFloor(
        stateOf({ value: PRICE_90K, timestamp: NOW - 60_001n }),
        SBTC,
        1n,
      ),
    ).toStrictEqual({
      ok: false,
      rule: "PRICE_STALE",
      errorCode: 123,
      message:
        "the oracle's price is further from now than the owner's max price age",
    });
    expect(minOutFloor(stateOf({ value: MAX_UINT }), SBTC, 2n)).toStrictEqual({
      ok: false,
      rule: "PRICE_OVERFLOW",
      errorCode: 124,
      message: "the oracle floor for this amount is too large to compute",
    });
  });

  it("accepts an age of exactly maxPriceAge either side of now", () => {
    for (const timestamp of [NOW - 60_000n, NOW + 60_000n]) {
      expect(
        minOutFloor(stateOf({ value: PRICE_90K, timestamp }), SBTC, 1n),
      ).toMatchObject({ ok: true });
    }
    expect(
      minOutFloor(
        stateOf({ value: PRICE_90K, timestamp: NOW + 60_001n }),
        SBTC,
        1n,
      ),
    ).toMatchObject({ rule: "PRICE_STALE" });
  });

  it("throws a RangeError for maxSlippageBps of 10000 or more", () => {
    for (const slip of [10_000n, 10_001n]) {
      expect(() =>
        minOutFloor(stateOf({ value: PRICE_90K }, slip), SBTC, 1n),
      ).toThrow(RangeError);
    }
  });

  it("checkIntent refuses below the floor and accepts it exactly", () => {
    const state = stateOf({ value: PRICE_90K }, 33n);
    const intent = {
      caller: bob,
      adapter: dex,
      tokenIn: SBTC,
      tokenOut: USD,
      amountIn: 1n,
    };
    expect(checkIntent(state, { ...intent, minOut: 898n })).toStrictEqual({
      ok: true,
    });
    expect(checkIntent(state, { ...intent, minOut: 897n })).toStrictEqual({
      ok: false,
      rule: "BELOW_ORACLE_FLOOR",
      errorCode: 125,
      message: "min-out is below the oracle floor",
    });
  });
});

// R5: a size or cooldown refusal says what would pass. Each suggestion is
// checked against the contract: the suggested amount is accepted and one more
// is refused, at the heights the suggestion names.
describe("checkIntent suggests a size that would pass", () => {
  /** The prediction for `t` now. Sends nothing. */
  async function predict(t: Trade) {
    const read = await readVault(client, config, t.owner ?? alice);
    return checkIntent(
      {
        ...read,
        burnHeight: BigInt(simnet.burnBlockHeight),
        nowMs: blockTimeMs(),
      },
      intentOf(t),
    );
  }

  async function refusal(code: number, t: Trade): Promise<IntentRefusal> {
    const check = await predict(t);
    if (check.ok) throw new Error("expected a refusal");
    expect(check.errorCode).toBe(code);
    return check;
  }

  function mineTo(height: bigint) {
    simnet.mineEmptyBurnBlocks(Number(height) - simnet.burnBlockHeight);
    expect(BigInt(simnet.burnBlockHeight)).toBe(height);
  }

  it("114: the per-trade cap is the largest amount, in both directions", async () => {
    const sell = await refusal(114, { amountIn: MAX_PER_TRADE + 1n });
    expect(sell.suggestion).toStrictEqual({
      maxAmountIn: MAX_PER_TRADE,
      limitedBy: "TRADE_CAP_EXCEEDED",
      limits: {
        perTrade: MAX_PER_TRADE,
        dayRoom: MAX_PER_DAY,
        balance: (await readVault(client, config, alice)).balances[sbtc],
      },
      cooldownEndsAt: null,
      dayWindowClearBy: null,
      approvalThreshold: null,
      maxDirectAmountIn: MAX_PER_TRADE,
      directLimitedBy: "TRADE_CAP_EXCEEDED",
    });
    const max = sell.suggestion!.maxAmountIn;
    await expectRefusal(114, { amountIn: max + 1n });
    await expectAllowed({ amountIn: max });

    // Buying: the USD the sale above brought in, against USD's own cap.
    const usdCap = 1_000n;
    setPolicy(usdCap, usdCap * 10n, 0n, EXPIRES_AT, usd);
    const buy = { tokenIn: usd, tokenOut: sbtc };
    const refused = await refusal(114, { ...buy, amountIn: usdCap * 5n });
    expect(refused.suggestion).toMatchObject({
      maxAmountIn: usdCap,
      limitedBy: "TRADE_CAP_EXCEEDED",
    });
    await expectRefusal(114, { ...buy, amountIn: usdCap + 1n });
    await expectAllowed({ ...buy, amountIn: usdCap });
  });

  it("115: the room left in the day window is the largest amount", async () => {
    setPolicy(AMOUNT_IN, AMOUNT_IN + 7n, 0n, EXPIRES_AT);
    const h = BigInt(simnet.burnBlockHeight);
    await expectAllowed();
    const check = await refusal(115, {});
    expect(check.suggestion).toMatchObject({
      maxAmountIn: 7n,
      limitedBy: "DAY_CAP_EXCEEDED",
      limits: { perTrade: AMOUNT_IN, dayRoom: 7n },
      cooldownEndsAt: null,
      dayWindowClearBy: h + 144n,
    });
    await expectRefusal(115, { amountIn: 8n });
    await expectAllowed({ amountIn: 7n });
  });

  it("115: a full window suggests 0n, and the height it is clear by", async () => {
    setPolicy(AMOUNT_IN, AMOUNT_IN, 0n, EXPIRES_AT);
    const h = BigInt(simnet.burnBlockHeight);
    await expectAllowed();
    const check = await refusal(115, { amountIn: 1n });
    expect(check.suggestion).toMatchObject({
      maxAmountIn: 0n,
      limitedBy: "DAY_CAP_EXCEEDED",
      dayWindowClearBy: h + 144n,
    });
    // Nothing passes now: 0 is refused as zero, 1 by the day cap.
    await expectRefusal(100, { amountIn: 0n });
    await expectRefusal(115, { amountIn: 1n });
    // One block before the height named the window is still full; at it the
    // whole cap is free again.
    const clearBy = check.suggestion!.dayWindowClearBy!;
    mineTo(clearBy - 1n);
    await expectRefusal(115, { amountIn: 1n });
    mineTo(clearBy);
    await expectAllowed({ amountIn: AMOUNT_IN });
  });

  it("101: the ledger balance is the largest amount", async () => {
    const huge = 2n ** 100n;
    setPolicy(huge, huge, 0n, EXPIRES_AT);
    const balance = (await readVault(client, config, alice)).balances[sbtc]!;
    const check = await refusal(101, { amountIn: balance + 1n });
    expect(check.suggestion).toStrictEqual({
      maxAmountIn: balance,
      limitedBy: "INSUFFICIENT_BALANCE",
      limits: { perTrade: huge, dayRoom: huge, balance },
      cooldownEndsAt: null,
      dayWindowClearBy: null,
      approvalThreshold: null,
      maxDirectAmountIn: balance,
      directLimitedBy: "INSUFFICIENT_BALANCE",
    });
    await expectRefusal(101, { amountIn: balance + 1n });
    await expectAllowed({ amountIn: balance });
  });

  it("101: an empty ledger suggests 0n", async () => {
    // Earlier tests left USD in Alice's ledger: take it out first.
    const held = (await readVault(client, config, alice)).balances[usd]!;
    if (held > 0n) {
      expect(
        vaultCall(alice, "withdraw", [Cl.principal(usd), Cl.uint(held)]).result
          .type,
      ).toBe("ok");
    }
    const check = await refusal(101, { tokenIn: usd, tokenOut: sbtc });
    expect(check.suggestion).toMatchObject({
      maxAmountIn: 0n,
      limitedBy: "INSUFFICIENT_BALANCE",
    });
    await expectRefusal(101, { tokenIn: usd, tokenOut: sbtc, amountIn: 1n });
  });

  it("116: the height the cooldown ends at", async () => {
    setPolicy(MAX_PER_TRADE, MAX_PER_DAY, 3n, EXPIRES_AT);
    const h = BigInt(simnet.burnBlockHeight);
    await expectAllowed();
    const check = await refusal(116, {});
    expect(check.suggestion).toMatchObject({
      maxAmountIn: MAX_PER_TRADE,
      cooldownEndsAt: h + 3n,
      dayWindowClearBy: h + 144n,
    });
    mineTo(h + 2n);
    await expectRefusal(116);
    mineTo(h + 3n);
    expect(
      (await refusal(114, { amountIn: MAX_PER_TRADE + 1n })).suggestion,
    ).toMatchObject({ maxAmountIn: MAX_PER_TRADE, cooldownEndsAt: null });
    await expectRefusal(114, { amountIn: MAX_PER_TRADE + 1n });
    await expectAllowed({ amountIn: MAX_PER_TRADE });
  });

  it("a size refusal during the cooldown names both", async () => {
    setPolicy(MAX_PER_TRADE, MAX_PER_DAY, 5n, EXPIRES_AT);
    const h = BigInt(simnet.burnBlockHeight);
    await expectAllowed();
    const check = await refusal(114, { amountIn: MAX_PER_TRADE + 1n });
    expect(check.suggestion).toMatchObject({
      maxAmountIn: MAX_PER_TRADE,
      cooldownEndsAt: h + 5n,
    });
    // The suggested amount passes the size rules now and meets the cooldown.
    await expectRefusal(116, { amountIn: MAX_PER_TRADE });
    mineTo(h + 5n);
    await expectAllowed({ amountIn: MAX_PER_TRADE });
  });

  it("carries no suggestion on any other refusal, or on ok", async () => {
    expect(await predict({})).toStrictEqual({ ok: true });
    const low = await refusal(125, { minOut: 1n });
    expect("suggestion" in low).toBe(false);
    ok(vaultCall(alice, "pause"));
    const paused = await refusal(109, { amountIn: MAX_PER_TRADE + 1n });
    expect("suggestion" in paused).toBe(false);
    expect(Object.keys(paused)).toStrictEqual([
      "ok",
      "rule",
      "errorCode",
      "message",
    ]);
  });

  it("keeps the refusal's existing fields as they were", async () => {
    const check = await refusal(114, { amountIn: MAX_PER_TRADE + 1n });
    expect(check).toMatchObject({
      ok: false,
      rule: "TRADE_CAP_EXCEEDED",
      errorCode: 114,
      message: "the amount is above the per-trade cap for token in",
    });
  });
});

describe("suggestSize", () => {
  const T = "SP000000000000000000002Q6VF78.sbtc";

  function stateOf(over: {
    caps?: { maxPerTrade: bigint; maxPerDay: bigint };
    dayTotal?: bigint;
    balance?: bigint;
    last?: bigint | null;
    cooldown?: bigint;
    burnHeight?: bigint;
  }): VaultState {
    return {
      vault: { agent: bob, paused: false },
      policy: {
        cooldownBlocks: over.cooldown ?? 0n,
        expiresAt: 10_000n,
        caps: over.caps === undefined ? {} : { [T]: over.caps },
        allowedTokens: [T],
        allowedAdapters: [dex],
      },
      usage: {
        dayTotals: over.dayTotal === undefined ? {} : { [T]: over.dayTotal },
        lastTradeHeight: over.last ?? null,
      },
      balances: over.balance === undefined ? {} : { [T]: over.balance },
      burnHeight: over.burnHeight ?? 500n,
      priceBounds: { maxSlippageBps: 100n, maxPriceAge: 60_000n },
      oracle: { sbtcToken: T, priceScale: 10_000_000_000n, price: null },
      nowMs: 0n,
    };
  }

  it("reads a token with no caps, total or balance entry as 0n", () => {
    expect(suggestSize(stateOf({}), T)).toStrictEqual({
      maxAmountIn: 0n,
      limitedBy: "TRADE_CAP_EXCEEDED",
      limits: { perTrade: 0n, dayRoom: 0n, balance: 0n },
      cooldownEndsAt: null,
      dayWindowClearBy: null,
      approvalThreshold: null,
      maxDirectAmountIn: 0n,
      directLimitedBy: "TRADE_CAP_EXCEEDED",
    });
  });

  it("takes the smallest limit and names the contract's first rule on a tie", () => {
    const caps = { maxPerTrade: 50n, maxPerDay: 80n };
    const of = (dayTotal: bigint, balance: bigint) => {
      const s = suggestSize(stateOf({ caps, dayTotal, balance }), T);
      return [s.maxAmountIn, s.limitedBy];
    };
    expect(of(0n, 100n)).toStrictEqual([50n, "TRADE_CAP_EXCEEDED"]);
    expect(of(30n, 50n)).toStrictEqual([50n, "TRADE_CAP_EXCEEDED"]);
    expect(of(31n, 100n)).toStrictEqual([49n, "DAY_CAP_EXCEEDED"]);
    expect(of(31n, 49n)).toStrictEqual([49n, "DAY_CAP_EXCEEDED"]);
    expect(of(31n, 48n)).toStrictEqual([48n, "INSUFFICIENT_BALANCE"]);
  });

  it("gives no day room when the total is above a lowered cap", () => {
    const s = suggestSize(
      stateOf({
        caps: { maxPerTrade: 5n, maxPerDay: 5n },
        dayTotal: 9n,
        balance: 100n,
        last: 490n,
      }),
      T,
    );
    expect(s).toMatchObject({
      maxAmountIn: 0n,
      limitedBy: "DAY_CAP_EXCEEDED",
      limits: { dayRoom: 0n },
      dayWindowClearBy: 634n,
    });
  });

  it("names the cooldown's end only while it refuses", () => {
    const at = (burnHeight: bigint) =>
      suggestSize(stateOf({ last: 490n, cooldown: 10n, burnHeight }), T)
        .cooldownEndsAt;
    expect(at(499n)).toBe(500n);
    expect(at(500n)).toBeNull();
    // Before any trade there is no cooldown and no window to clear.
    const fresh = suggestSize(stateOf({ cooldown: 10n, dayTotal: 0n }), T);
    expect(fresh.cooldownEndsAt).toBeNull();
    expect(fresh.dayWindowClearBy).toBeNull();
  });

  it("does not change its input", () => {
    const state = stateOf({
      caps: { maxPerTrade: 5n, maxPerDay: 9n },
      dayTotal: 1n,
      balance: 3n,
      last: 499n,
      cooldown: 4n,
    });
    const before = structuredClone(state);
    suggestSize(state, T);
    expect(state).toStrictEqual(before);
  });
});
