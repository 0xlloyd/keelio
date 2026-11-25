import { initSimnet } from "@stacks/clarinet-sdk";
import { Cl, type ClarityValue } from "@stacks/transactions";
import { beforeEach, describe, expect, it } from "vitest";
import {
  accountabilityRecords,
  agentHistory,
  APPROVAL_RULES,
  APPROVAL_WINDOW_BLOCKS,
  buildApproveSwap,
  buildCancelSwapRequest,
  buildExecuteSwap,
  buildRejectSwap,
  buildRequestSwap,
  buildSetApprovalThreshold,
  CANCEL_RULES,
  checkApproval,
  checkCancelRequest,
  checkIntent,
  checkRequest,
  parseJournal,
  pendingSwapExpired,
  readVault,
  renderAccountabilityReport,
  REQUEST_RULES,
  RULE_CODES,
  RULES,
  simnetClient,
  suggestSize,
  swapEvent,
  swapRequestEvent,
  tradeWarnings,
  TxBuildError,
  type ApprovalTerms,
  type Intent,
  type SwapTerms,
  type TxConfig,
  type VaultCall,
  type VaultConfig,
  type VaultState,
} from "../packages/sdk/src/index.js";
import { PRICE_90K, PRICE_SCALE, floorOf } from "./oracle-fixture.js";
import { EXPIRES_AT, SLIPPAGE_BPS, vaultHarness } from "./sdk-fixture.js";

// R1, the owner-approval band, through the SDK: the reads, the three checks
// that predict `execute-swap`, `request-swap` and `approve-swap`, the size
// suggestion, the builders and the journal helpers. Every prediction is
// compared with the real contract's answer to the same call on the simnet.
//
// Each test starts from a fresh simnet: Alice's vault with Bob as agent, an
// sBTC threshold of 20,000 sats under a per-trade cap of 100,000.

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
const evil = `${deployer}.evil-token`;
const otherDex = `${deployer}.other-dex`;

const DEPOSIT = 1_000_000n;
const MAX_PER_TRADE = 100_000n;
const MAX_PER_DAY = 250_000n;
const THRESHOLD = 20_000n;
/** Inside the agent's own authority. */
const SMALL = 10_000n;
/** In the band: above the threshold, inside the per-trade cap. */
const BIG = 50_000n;

const config: VaultConfig = {
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

let h: ReturnType<typeof vaultHarness>;

const floor = (amountIn: bigint) =>
  floorOf(amountIn, PRICE_90K, SLIPPAGE_BPS, true);
const height = () => BigInt(simnet.burnBlockHeight);
const err = (code: number) => Cl.error(Cl.uint(code));

function setThreshold(threshold: bigint | null, token = sbtc, owner = alice) {
  h.ok(owner, "set-approval-threshold", [
    Cl.principal(token),
    threshold === null ? Cl.none() : Cl.some(Cl.uint(threshold)),
  ]);
}

function setCaps(perTrade: bigint, perDay: bigint, token = sbtc) {
  h.ok(alice, "set-token-caps", [
    Cl.principal(token),
    Cl.uint(perTrade),
    Cl.uint(perDay),
  ]);
}

/** The trade of most tests: selling `amountIn` sBTC at the oracle floor. */
function terms(amountIn: bigint, over: Partial<SwapTerms> = {}): SwapTerms {
  return {
    adapter: dex,
    tokenIn: sbtc,
    tokenOut: usd,
    amountIn,
    minOut: floor(amountIn),
    ...over,
  };
}

function swapArgs(t: SwapTerms): ClarityValue[] {
  return [
    Cl.principal(t.adapter),
    Cl.principal(t.tokenIn),
    Cl.principal(t.tokenOut),
    Cl.uint(t.amountIn),
    Cl.uint(t.minOut),
  ];
}

// The three contract calls. Each goes through the harness, so a successful
// one joins the journal.
const execute = (t: SwapTerms, sender = bob, owner = alice) =>
  h.call(sender, "execute-swap", [Cl.principal(owner), ...swapArgs(t)]);
const request = (t: SwapTerms, sender = bob, owner = alice) =>
  h.call(sender, "request-swap", [Cl.principal(owner), ...swapArgs(t)]);
const approve = (t: ApprovalTerms, owner = alice) =>
  h.call(owner, "approve-swap", [...swapArgs(t), Cl.uint(t.requestedAt)]);

/** The vault as the SDK reads it now, ready for a check. */
async function state(owner = alice): Promise<VaultState> {
  const burnHeight = height();
  const read = await readVault(simnetClient(simnet, deployer), config, owner, {
    burnHeight,
  });
  return {
    ...read,
    burnHeight,
    nowMs: BigInt(simnet.getBlockTime()) * 1000n,
  };
}

const intent = (t: SwapTerms, caller = bob): Intent => ({ caller, ...t });

/** `checkIntent`'s answer, then `execute-swap`'s, for the same trade. */
async function executeBoth(t: SwapTerms, caller = bob) {
  const check = checkIntent(await state(), intent(t, caller));
  return { check, result: execute(t, caller).result };
}

/** `checkRequest`'s answer, then `request-swap`'s. */
async function requestBoth(t: SwapTerms, caller = bob) {
  const check = checkRequest(await state(), intent(t, caller));
  return { check, result: request(t, caller).result };
}

/**
 * The approval of trade `t` for the request made at `requestedAt`. Left out,
 * it is the stored request's height, as an owner who has just read it would
 * sign (0 with nothing pending): the tests of the other rules use that.
 */
async function approval(
  t: SwapTerms,
  requestedAt?: bigint,
): Promise<ApprovalTerms> {
  return {
    ...t,
    requestedAt: requestedAt ?? (await state()).pendingSwap?.requestedAt ?? 0n,
  };
}

/** `checkApproval`'s answer, then `approve-swap`'s. */
async function approveBoth(t: SwapTerms, requestedAt?: bigint) {
  const signed = await approval(t, requestedAt);
  const check = checkApproval(await state(), signed);
  return { check, result: approve(signed).result };
}

type Both = Promise<{
  check: { ok: boolean; errorCode?: number };
  result: ClarityValue;
}>;

async function expectCode(code: number, both: Both) {
  const { check, result } = await both;
  expect(result).toStrictEqual(err(code));
  expect(check).toMatchObject({ ok: false, errorCode: code });
}

async function expectOk(both: Both) {
  const { check, result } = await both;
  expect(check).toStrictEqual({ ok: true });
  expect(result.type).toBe("ok");
}

function run(call: VaultCall, sender: string) {
  return h.call(sender, call.functionName, call.functionArgs);
}

beforeEach(async () => {
  simnet = await initSimnet();
  h = vaultHarness(simnet);
  // A second contract with the adapter trait, outside the vault's fixed set.
  simnet.deployContract(
    "other-dex",
    `(impl-trait .swap-adapter-trait.swap-adapter-trait)
(use-trait sip-010 .sip-010-trait.sip-010-trait)
(define-public (swap (token-in <sip-010>) (token-out <sip-010>) (amount-in uint) (min-out uint) (recipient principal))
  (ok u0))`,
    { clarityVersion: 3 },
    deployer,
  );
  h.fundDex();
  // The dex pays the oracle price for sBTC: 900 USD base units a sat.
  expect(
    simnet.callPublicFn(
      "mock-dex",
      "set-rate",
      [Cl.uint(900n), Cl.uint(1n)],
      deployer,
    ).result.type,
  ).toBe("ok");
  h.setUpOwner({
    owner: alice,
    agent: bob,
    deposit: DEPOSIT,
    maxPerTrade: MAX_PER_TRADE,
    maxPerDay: MAX_PER_DAY,
  });
  setThreshold(THRESHOLD);
});

describe("readVault reads the approval band", () => {
  it("reads each token's threshold: set, zero, cleared and never set", async () => {
    const read = async () =>
      (await readVault(simnetClient(simnet, deployer), config, alice))
        .approvalThresholds;
    // USD's was never set: none, which is no band.
    expect(await read()).toStrictEqual({ [sbtc]: THRESHOLD, [usd]: null });
    setThreshold(0n);
    expect(await read()).toStrictEqual({ [sbtc]: 0n, [usd]: null });
    setThreshold(null);
    setThreshold(7n, usd);
    expect(await read()).toStrictEqual({ [sbtc]: null, [usd]: 7n });
  });

  it("reads no pending request as null", async () => {
    expect((await state()).pendingSwap).toBeNull();
    // An owner with nothing set reads the same.
    const empty = await state(mallory);
    expect(empty.pendingSwap).toBeNull();
    expect(empty.approvalThresholds).toStrictEqual({
      [sbtc]: null,
      [usd]: null,
    });
  });

  it("reads the stored request, expired from H + 7 on", async () => {
    const at = height();
    expect(request(terms(BIG)).result).toStrictEqual(
      Cl.ok(Cl.uint(at + APPROVAL_WINDOW_BLOCKS)),
    );
    const stored = {
      agent: bob,
      adapter: dex,
      tokenIn: sbtc,
      tokenOut: usd,
      amountIn: BIG,
      minOut: floor(BIG),
      requestedAt: at,
      expiresAt: at + 6n,
    };
    expect((await state()).pendingSwap).toStrictEqual({
      ...stored,
      expired: false,
    });
    simnet.mineEmptyBurnBlocks(6);
    expect(height()).toBe(at + 6n);
    expect((await state()).pendingSwap).toStrictEqual({
      ...stored,
      expired: false,
    });
    simnet.mineEmptyBurnBlocks(1);
    // The contract keeps an expired request; the flag says it is one.
    expect((await state()).pendingSwap).toStrictEqual({
      ...stored,
      expired: true,
    });
    // Without a burn height the SDK cannot say.
    const bare = await readVault(simnetClient(simnet, deployer), config, alice);
    expect(bare.pendingSwap).toStrictEqual({ ...stored, expired: null });
  });

  it("pendingSwapExpired is true only above expiresAt", () => {
    expect(pendingSwapExpired({ expiresAt: 10n }, 10n)).toBe(false);
    expect(pendingSwapExpired({ expiresAt: 10n }, 11n)).toBe(true);
  });
});

describe("the rule tables", () => {
  it("list each function's checks in the contract's order", () => {
    const codes = (rules: readonly { errorCode: number }[]) =>
      rules.map((r) => r.errorCode);
    expect(codes(RULES)).toStrictEqual([
      108, 109, 110, 111, 112, 113, 100, 114, 126, 115, 116, 101, 119, 121, 122,
      123, 124, 125,
    ]);
    expect(codes(REQUEST_RULES)).toStrictEqual([
      108, 109, 110, 111, 112, 113, 100, 114, 127, 101, 128,
    ]);
    expect(codes(APPROVAL_RULES)).toStrictEqual([129, 130, 131, 132]);
    expect(codes(CANCEL_RULES)).toStrictEqual([129, 133]);
  });

  it("give one code per rule name, the same in every table", () => {
    for (const table of [RULES, REQUEST_RULES, APPROVAL_RULES, CANCEL_RULES]) {
      for (const { rule, errorCode } of table) {
        expect(RULE_CODES[rule], rule).toBe(errorCode);
      }
    }
    const all = Object.values(RULE_CODES);
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort((a, b) => a - b)).toStrictEqual([
      100, 101, 108, 109, 110, 111, 112, 113, 114, 115, 116, 119, 121, 122, 123,
      124, 125, 126, 127, 128, 129, 130, 131, 132, 133,
    ]);
  });
});

describe("checkIntent agrees with execute-swap on the approval threshold", () => {
  it("126 one above the threshold, and says to request the swap", async () => {
    const { check, result } = await executeBoth(terms(THRESHOLD + 1n));
    expect(result).toStrictEqual(err(126));
    expect(check).toMatchObject({
      ok: false,
      rule: "APPROVAL_REQUIRED",
      errorCode: 126,
    });
    if (check.ok) throw new Error("expected a refusal");
    expect(check.message).toMatch(/request-swap/);
    // A size refusal: it carries what the agent can send alone.
    expect(check.suggestion).toMatchObject({
      approvalThreshold: THRESHOLD,
      maxDirectAmountIn: THRESHOLD,
      maxAmountIn: MAX_PER_TRADE,
    });
  });

  it("passes at the threshold exactly", async () => {
    await expectOk(executeBoth(terms(THRESHOLD)));
  });

  it("a threshold of 0 refuses every amount, and none refuses nothing", async () => {
    setThreshold(0n);
    await expectCode(126, executeBoth(terms(1n)));
    // Zero is still the amount's own refusal, checked before the threshold.
    await expectCode(100, executeBoth(terms(0n)));
    setThreshold(null);
    await expectOk(executeBoth(terms(MAX_PER_TRADE)));
  });

  it("counts only the input token's threshold", async () => {
    // Selling USD has no threshold, whatever sBTC's is.
    setThreshold(0n);
    h.mint("mock-usd", 10_000_000n, alice);
    h.ok(alice, "deposit", [Cl.principal(usd), Cl.uint(10_000_000n)]);
    setCaps(10n ** 9n, 10n ** 10n, usd);
    expect(
      simnet.callPublicFn(
        "mock-dex",
        "set-rate",
        [Cl.uint(1n), Cl.uint(900n)],
        deployer,
      ).result.type,
    ).toBe("ok");
    const buy = terms(9_000_000n, {
      tokenIn: usd,
      tokenOut: sbtc,
      minOut: floorOf(9_000_000n, PRICE_90K, SLIPPAGE_BPS, false),
    });
    await expectOk(executeBoth(buy));
  });

  describe("in the contract's order: after u114, before u115", () => {
    it("over the per-trade cap gives 114, not 126", async () => {
      await expectCode(114, executeBoth(terms(MAX_PER_TRADE + 1n)));
    });

    it("over the threshold and the day cap gives 126", async () => {
      setCaps(MAX_PER_TRADE, MAX_PER_TRADE);
      await expectOk(executeBoth(terms(THRESHOLD)));
      // 20,000 used of 100,000: 90,000 is over both.
      const over = terms(90_000n);
      await expectCode(126, executeBoth(over));
      setThreshold(null);
      await expectCode(115, executeBoth(over));
    });

    it("over the threshold during the cooldown gives 126", async () => {
      h.ok(alice, "set-policy", [Cl.uint(5n), Cl.uint(EXPIRES_AT)]);
      await expectOk(executeBoth(terms(SMALL)));
      await expectCode(126, executeBoth(terms(BIG)));
      await expectCode(116, executeBoth(terms(SMALL)));
    });

    it("a paused vault gives 109 first", async () => {
      h.ok(alice, "pause");
      await expectCode(109, executeBoth(terms(BIG)));
    });
  });
});

describe("suggestSize tells the direct limit from the approved one", () => {
  it("the contract accepts each amount it names and refuses one more", async () => {
    const s = suggestSize(await state(), sbtc);
    expect(s).toStrictEqual({
      maxAmountIn: MAX_PER_TRADE,
      limitedBy: "TRADE_CAP_EXCEEDED",
      limits: {
        perTrade: MAX_PER_TRADE,
        dayRoom: MAX_PER_DAY,
        balance: DEPOSIT,
      },
      cooldownEndsAt: null,
      dayWindowClearBy: null,
      approvalThreshold: THRESHOLD,
      maxDirectAmountIn: THRESHOLD,
      directLimitedBy: "APPROVAL_REQUIRED",
    });
    // execute-swap: one above the direct limit is refused by that rule.
    await expectCode(126, executeBoth(terms(s.maxDirectAmountIn + 1n)));
    // With approval: one above the larger limit cannot even be requested.
    await expectCode(114, requestBoth(terms(s.maxAmountIn + 1n)));
    await expectOk(requestBoth(terms(s.maxAmountIn)));
    await expectOk(approveBoth(terms(s.maxAmountIn)));
    // And the direct limit itself goes straight through.
    await expectOk(executeBoth(terms(s.maxDirectAmountIn)));
  });

  it("a threshold at or above the size limits changes nothing", async () => {
    setThreshold(MAX_PER_TRADE);
    const at = suggestSize(await state(), sbtc);
    // A tie names the contract's first rule: u114 is checked before u126.
    expect(at).toMatchObject({
      maxAmountIn: MAX_PER_TRADE,
      maxDirectAmountIn: MAX_PER_TRADE,
      directLimitedBy: "TRADE_CAP_EXCEEDED",
    });
    await expectCode(114, executeBoth(terms(MAX_PER_TRADE + 1n)));
    // Nothing can be requested: the largest amount needs no approval.
    await expectCode(127, requestBoth(terms(MAX_PER_TRADE)));
    await expectOk(executeBoth(terms(MAX_PER_TRADE)));
  });

  it("the day room and the ledger still limit a direct trade below the threshold", async () => {
    setThreshold(90_000n);
    setCaps(MAX_PER_TRADE, MAX_PER_TRADE);
    await expectOk(executeBoth(terms(60_000n)));
    // 40,000 of the day cap is left, under the threshold.
    const s = suggestSize(await state(), sbtc);
    expect(s).toMatchObject({
      maxAmountIn: 40_000n,
      limitedBy: "DAY_CAP_EXCEEDED",
      approvalThreshold: 90_000n,
      maxDirectAmountIn: 40_000n,
      directLimitedBy: "DAY_CAP_EXCEEDED",
    });
    await expectCode(115, executeBoth(terms(40_001n)));
    await expectOk(executeBoth(terms(40_000n)));
  });

  it("a threshold of 0 leaves no direct amount", async () => {
    setThreshold(0n);
    expect(suggestSize(await state(), sbtc)).toMatchObject({
      maxAmountIn: MAX_PER_TRADE,
      approvalThreshold: 0n,
      maxDirectAmountIn: 0n,
      directLimitedBy: "APPROVAL_REQUIRED",
    });
    await expectCode(126, executeBoth(terms(1n)));
  });

  it("names u126 when the threshold ties with the day room", async () => {
    const { approvalThresholds, ...rest } = await state();
    expect(approvalThresholds).toStrictEqual({
      [sbtc]: THRESHOLD,
      [usd]: null,
    });
    const base: VaultState = rest;
    const tied: VaultState = {
      ...base,
      policy: {
        ...base.policy,
        caps: { [sbtc]: { maxPerTrade: 500n, maxPerDay: 300n } },
      },
      approvalThresholds: { [sbtc]: 300n },
    };
    expect(suggestSize(tied, sbtc)).toMatchObject({
      maxAmountIn: 300n,
      limitedBy: "DAY_CAP_EXCEEDED",
      maxDirectAmountIn: 300n,
      directLimitedBy: "APPROVAL_REQUIRED",
    });
    // A state with no thresholds at all reads as no band.
    const without: VaultState = { ...base, policy: tied.policy };
    expect(suggestSize(without, sbtc)).toMatchObject({
      approvalThreshold: null,
      maxDirectAmountIn: 300n,
      directLimitedBy: "DAY_CAP_EXCEEDED",
    });
  });
});

describe("checkRequest agrees with request-swap", () => {
  it("passes one above the threshold, and the contract stores it", async () => {
    const at = height();
    const { check, result } = await requestBoth(terms(THRESHOLD + 1n));
    expect(check).toStrictEqual({ ok: true });
    expect(result).toStrictEqual(Cl.ok(Cl.uint(at + 6n)));
  });

  it("127 at the threshold: the agent sends execute-swap instead", async () => {
    const { check, result } = await requestBoth(terms(THRESHOLD));
    expect(result).toStrictEqual(err(127));
    expect(check).toMatchObject({
      ok: false,
      rule: "APPROVAL_NOT_NEEDED",
      errorCode: 127,
    });
    if (check.ok) throw new Error("expected a refusal");
    expect(check.message).toMatch(/execute-swap/);
  });

  it("127 for a token with no threshold, at any amount", async () => {
    setThreshold(null);
    await expectCode(127, requestBoth(terms(BIG)));
  });

  it("108: a stranger, and the owner", async () => {
    await expectCode(108, requestBoth(terms(BIG), mallory));
    await expectCode(108, requestBoth(terms(BIG), alice));
  });

  it("109: paused", async () => {
    h.ok(alice, "pause");
    await expectCode(109, requestBoth(terms(BIG)));
  });

  it("110: expired", async () => {
    h.ok(alice, "set-policy", [Cl.uint(0n), Cl.uint(height() - 1n)]);
    await expectCode(110, requestBoth(terms(BIG)));
  });

  it("111: a token off the list, and one outside the fixed set", async () => {
    await expectCode(111, requestBoth(terms(BIG, { tokenOut: evil })));
    h.ok(alice, "allow-token", [Cl.principal(usd), Cl.bool(false)]);
    await expectCode(111, requestBoth(terms(BIG)));
  });

  it("112: same token", async () => {
    await expectCode(112, requestBoth(terms(BIG, { tokenOut: sbtc })));
  });

  it("113: an adapter outside the fixed set, and one the owner revoked", async () => {
    await expectCode(113, requestBoth(terms(BIG, { adapter: otherDex })));
    h.ok(alice, "allow-adapter", [Cl.principal(dex), Cl.bool(false)]);
    await expectCode(113, requestBoth(terms(BIG)));
  });

  it("100: a zero amount, before the threshold is looked at", async () => {
    await expectCode(100, requestBoth(terms(0n)));
  });

  it("114: over the per-trade cap, with the size that would pass", async () => {
    const { check, result } = await requestBoth(terms(MAX_PER_TRADE + 1n));
    expect(result).toStrictEqual(err(114));
    expect(check).toMatchObject({
      errorCode: 114,
      suggestion: { maxAmountIn: MAX_PER_TRADE, maxDirectAmountIn: THRESHOLD },
    });
  });

  it("101: over the ledger, checked after 127 and before 128", async () => {
    const huge = DEPOSIT * 10n;
    setCaps(huge, huge);
    await expectCode(101, requestBoth(terms(DEPOSIT + 1n)));
    // The whole ledger can be requested.
    await expectOk(requestBoth(terms(DEPOSIT)));
    // Now a request is pending: over the ledger is still 101, not 128.
    await expectCode(101, requestBoth(terms(DEPOSIT + 1n)));
    // And an amount that needs no approval is 127 before either.
    setThreshold(huge);
    await expectCode(127, requestBoth(terms(DEPOSIT + 1n)));
  });

  it("128 while a request is pending, through H + 6; H + 7 overwrites it", async () => {
    const at = height();
    await expectOk(requestBoth(terms(BIG)));
    const other = terms(BIG + 1n);
    await expectCode(128, requestBoth(other));
    simnet.mineEmptyBurnBlocks(6);
    expect(height()).toBe(at + 6n);
    await expectCode(128, requestBoth(other));
    simnet.mineEmptyBurnBlocks(1);
    const { check, result } = await requestBoth(other);
    expect(check).toStrictEqual({ ok: true });
    expect(result).toStrictEqual(Cl.ok(Cl.uint(at + 7n + 6n)));
    expect((await state()).pendingSwap).toMatchObject({
      amountIn: BIG + 1n,
      requestedAt: at + 7n,
      expired: false,
    });
  });

  it("leaves the day cap, the cooldown and the price to the approval", async () => {
    // A cooldown is running, the day cap has no room for BIG and min-out is
    // far below the oracle floor: the request is still stored.
    h.ok(alice, "set-policy", [Cl.uint(50n), Cl.uint(EXPIRES_AT)]);
    setCaps(MAX_PER_TRADE, MAX_PER_TRADE);
    await expectOk(executeBoth(terms(THRESHOLD)));
    setCaps(BIG, BIG);
    const cheap = terms(BIG, { minOut: 0n });
    await expectOk(requestBoth(cheap));
    // The owner's approval is refused by the first of them: the day cap.
    await expectCode(115, approveBoth(cheap));
  });

  it("does not change its inputs", async () => {
    const s = await state();
    const i = intent(terms(BIG));
    const copy = structuredClone({ s, i });
    checkRequest(s, i);
    checkApproval(s, { ...terms(BIG), requestedAt: s.burnHeight });
    checkCancelRequest(s, bob);
    expect({ s, i }).toStrictEqual(copy);
  });
});

describe("checkApproval agrees with approve-swap", () => {
  it("129: no request", async () => {
    const { check, result } = await approveBoth(terms(BIG));
    expect(result).toStrictEqual(err(129));
    expect(check).toMatchObject({
      ok: false,
      rule: "NO_PENDING_SWAP",
      errorCode: 129,
    });
  });

  it("approves the stored request in the block it was made in", async () => {
    await expectOk(requestBoth(terms(BIG)));
    const { check, result } = await approveBoth(terms(BIG));
    expect(check).toStrictEqual({ ok: true });
    // The mock dex pays 900 USD base units a sat.
    expect(result).toStrictEqual(Cl.ok(Cl.uint(BIG * 900n)));
    // The request is used up.
    expect((await state()).pendingSwap).toBeNull();
    await expectCode(129, approveBoth(terms(BIG)));
  });

  it("approves at H + 6", async () => {
    const at = height();
    await expectOk(requestBoth(terms(BIG)));
    simnet.mineEmptyBurnBlocks(6);
    expect(height()).toBe(at + 6n);
    await expectOk(approveBoth(terms(BIG)));
  });

  it("130 at H + 7", async () => {
    const at = height();
    await expectOk(requestBoth(terms(BIG)));
    simnet.mineEmptyBurnBlocks(7);
    expect(height()).toBe(at + 7n);
    const { check, result } = await approveBoth(terms(BIG));
    expect(result).toStrictEqual(err(130));
    expect(check).toMatchObject({ rule: "REQUEST_EXPIRED", errorCode: 130 });
  });

  it("131: any field that is not the stored request's", async () => {
    await expectOk(requestBoth(terms(BIG)));
    await expectCode(131, approveBoth(terms(BIG + 1n, { minOut: floor(BIG) })));
    await expectCode(131, approveBoth(terms(BIG, { minOut: floor(BIG) + 1n })));
    await expectCode(131, approveBoth(terms(BIG, { adapter: otherDex })));
    await expectCode(131, approveBoth(terms(BIG, { tokenOut: sbtc })));
    await expectCode(131, approveBoth(terms(BIG, { tokenIn: usd })));
    // The request itself still approves.
    await expectOk(approveBoth(terms(BIG)));
  });

  it("131: the stored request was not made at requestedAt, the trade being equal", async () => {
    const at = height();
    await expectOk(requestBoth(terms(BIG)));
    simnet.mineEmptyBurnBlocks(2);
    for (const wrong of [0n, at - 1n, at + 1n, at + 2n, at + 6n]) {
      const { check, result } = await approveBoth(terms(BIG), wrong);
      expect(result).toStrictEqual(err(131));
      expect(check).toMatchObject({
        ok: false,
        rule: "REQUEST_MISMATCH",
        errorCode: 131,
      });
    }
    expect((await state()).pendingSwap).toMatchObject({ requestedAt: at });
    await expectOk(approveBoth(terms(BIG), at));
  });

  it("131: an approval for the request of H does not fit the same trade requested again", async () => {
    const at = height();
    await expectOk(requestBoth(terms(BIG)));
    // The owner reads the request and builds the approval for it.
    const seen = (await state()).pendingSwap!;
    expect(seen.requestedAt).toBe(at);
    const signed: ApprovalTerms = { ...terms(BIG), requestedAt: at };
    simnet.mineEmptyBurnBlocks(5);
    // The agent withdraws it and asks again for the same trade.
    h.ok(bob, "cancel-swap-request", [Cl.principal(alice)]);
    await expectOk(requestBoth(terms(BIG)));
    simnet.mineEmptyBurnBlocks(5);
    // H + 10: past the window of the request the owner saw.
    const now = await state();
    expect(now.pendingSwap).toMatchObject({
      requestedAt: at + 5n,
      expired: false,
    });
    expect(checkApproval(now, signed)).toMatchObject({
      ok: false,
      rule: "REQUEST_MISMATCH",
      errorCode: 131,
    });
    expect(approve(signed).result).toStrictEqual(err(131));
    expect(run(buildApproveSwap(tx, signed), alice).result).toStrictEqual(
      err(131),
    );
    // Approving the request that is stored now is a new decision.
    await expectOk(approveBoth(terms(BIG), at + 5n));
  });

  it("132: the agent that asked was replaced, or removed", async () => {
    await expectOk(requestBoth(terms(BIG)));
    h.ok(alice, "set-agent", [Cl.principal(dave)]);
    const { check, result } = await approveBoth(terms(BIG));
    expect(result).toStrictEqual(err(132));
    expect(check).toMatchObject({
      rule: "REQUEST_AGENT_CHANGED",
      errorCode: 132,
    });
    h.ok(alice, "remove-agent");
    await expectCode(132, approveBoth(terms(BIG)));
    // Naming the requester again makes the request approvable again.
    h.ok(alice, "set-agent", [Cl.principal(bob)]);
    await expectOk(approveBoth(terms(BIG)));
  });

  it("checks in order: 130 before 131 before 132", async () => {
    await expectOk(requestBoth(terms(BIG)));
    h.ok(alice, "set-agent", [Cl.principal(dave)]);
    const at = height();
    const wrong = terms(BIG + 1n);
    await expectCode(131, approveBoth(wrong));
    // The height alone, with the agent replaced: 131 before 132.
    await expectCode(131, approveBoth(terms(BIG), at + 1n));
    await expectCode(132, approveBoth(terms(BIG), at));
    simnet.mineEmptyBurnBlocks(7);
    await expectCode(130, approveBoth(wrong));
    await expectCode(130, approveBoth(terms(BIG), at + 1n));
  });

  describe("then every execute-swap check, as of the approval", () => {
    beforeEach(async () => {
      await expectOk(requestBoth(terms(BIG)));
    });

    it("109: the owner paused after the request", async () => {
      h.ok(alice, "pause");
      await expectCode(109, approveBoth(terms(BIG)));
    });

    it("110: the policy expired", async () => {
      h.ok(alice, "set-policy", [Cl.uint(0n), Cl.uint(height() - 1n)]);
      await expectCode(110, approveBoth(terms(BIG)));
    });

    it("111 and 113: a token or the adapter was revoked", async () => {
      h.ok(alice, "allow-adapter", [Cl.principal(dex), Cl.bool(false)]);
      await expectCode(113, approveBoth(terms(BIG)));
      h.ok(alice, "allow-token", [Cl.principal(usd), Cl.bool(false)]);
      await expectCode(111, approveBoth(terms(BIG)));
    });

    it("114: the per-trade cap was lowered", async () => {
      setCaps(BIG - 1n, MAX_PER_DAY);
      await expectCode(114, approveBoth(terms(BIG)));
    });

    it("115: the day cap has no room left", async () => {
      setCaps(BIG, BIG);
      await expectOk(executeBoth(terms(SMALL)));
      const { check, result } = await approveBoth(terms(BIG));
      expect(result).toStrictEqual(err(115));
      expect(check).toMatchObject({
        errorCode: 115,
        suggestion: { maxAmountIn: BIG - SMALL },
      });
    });

    it("116: a trade since the request started the cooldown", async () => {
      h.ok(alice, "set-policy", [Cl.uint(3n), Cl.uint(EXPIRES_AT)]);
      await expectOk(executeBoth(terms(SMALL)));
      await expectCode(116, approveBoth(terms(BIG)));
      simnet.mineEmptyBurnBlocks(3);
      await expectOk(approveBoth(terms(BIG)));
    });

    it("101: the owner withdrew below the amount", async () => {
      h.ok(alice, "withdraw", [
        Cl.principal(sbtc),
        Cl.uint(DEPOSIT - BIG + 1n),
      ]);
      await expectCode(101, approveBoth(terms(BIG)));
    });

    it("119: the price bounds were unset", async () => {
      h.ok(alice, "set-price-bounds", [Cl.uint(0n), Cl.uint(0n)]);
      await expectCode(119, approveBoth(terms(BIG)));
    });

    it("never 126: the threshold is the one check an approval skips", async () => {
      setThreshold(0n);
      await expectOk(approveBoth(terms(BIG)));
    });
  });

  it("125: the stored min-out is below the oracle floor at approval", async () => {
    const low = terms(BIG, { minOut: floor(BIG) - 1n });
    await expectOk(requestBoth(low));
    const { check, result } = await approveBoth(low);
    expect(result).toStrictEqual(err(125));
    expect(check).toMatchObject({
      rule: "BELOW_ORACLE_FLOOR",
      errorCode: 125,
    });
  });
});

describe("checkCancelRequest agrees with cancel-swap-request", () => {
  async function cancelBoth(caller: string) {
    const check = checkCancelRequest(await state(), caller);
    const result = h.call(caller, "cancel-swap-request", [
      Cl.principal(alice),
    ]).result;
    return { check, result };
  }

  it("129: nothing to withdraw", async () => {
    const { check, result } = await cancelBoth(bob);
    expect(result).toStrictEqual(err(129));
    expect(check).toMatchObject({ rule: "NO_PENDING_SWAP", errorCode: 129 });
    // A state that never read the request reads as none.
    expect(checkCancelRequest({}, bob)).toMatchObject({ errorCode: 129 });
  });

  it("133: a stranger, and the owner", async () => {
    await expectOk(requestBoth(terms(BIG)));
    const { check, result } = await cancelBoth(mallory);
    expect(result).toStrictEqual(err(133));
    expect(check).toMatchObject({ rule: "NOT_REQUESTER", errorCode: 133 });
    await expectCode(133, cancelBoth(alice));
  });

  it("the requester withdraws it, and it is gone", async () => {
    await expectOk(requestBoth(terms(BIG)));
    const { check, result } = await cancelBoth(bob);
    expect(check).toStrictEqual({ ok: true });
    expect(result).toStrictEqual(Cl.ok(Cl.bool(true)));
    expect((await state()).pendingSwap).toBeNull();
    await expectCode(129, cancelBoth(bob));
  });

  it("a replaced agent can still withdraw an expired request", async () => {
    await expectOk(requestBoth(terms(BIG)));
    h.ok(alice, "set-agent", [Cl.principal(dave)]);
    simnet.mineEmptyBurnBlocks(7);
    // The new agent did not make it.
    await expectCode(133, cancelBoth(dave));
    await expectOk(cancelBoth(bob));
  });
});

describe("the approval builders", () => {
  it("buildSetApprovalThreshold sets and clears, moving nothing", async () => {
    const set = buildSetApprovalThreshold(tx, { token: sbtc, threshold: 5n });
    expect(set).toMatchObject({
      contractAddress: deployer,
      contractName: "keelio-vault",
      functionName: "set-approval-threshold",
      postConditions: [],
      postConditionMode: "deny",
    });
    expect(run(set, alice).result).toStrictEqual(Cl.ok(Cl.bool(true)));
    expect((await state()).approvalThresholds?.[sbtc]).toBe(5n);
    const clear = buildSetApprovalThreshold(tx, {
      token: sbtc,
      threshold: null,
    });
    expect(clear.functionArgs[1]).toStrictEqual(Cl.none());
    expect(run(clear, alice).result).toStrictEqual(Cl.ok(Cl.bool(true)));
    expect((await state()).approvalThresholds?.[sbtc]).toBeNull();
    // 0 is a threshold, not a clear.
    const zero = buildSetApprovalThreshold(tx, { token: sbtc, threshold: 0n });
    expect(run(zero, alice).result.type).toBe("ok");
    expect((await state()).approvalThresholds?.[sbtc]).toBe(0n);
  });

  it("buildSetApprovalThreshold refuses a bad token or threshold", () => {
    const code = (build: () => VaultCall) => {
      try {
        build();
      } catch (e) {
        expect(e).toBeInstanceOf(TxBuildError);
        return (e as TxBuildError).code;
      }
      return "built";
    };
    expect(
      code(() =>
        buildSetApprovalThreshold(tx, { token: alice, threshold: 1n }),
      ),
    ).toBe("INVALID_PRINCIPAL");
    expect(
      code(() =>
        buildSetApprovalThreshold(tx, { token: sbtc, threshold: -1n }),
      ),
    ).toBe("INVALID_AMOUNT");
    expect(
      code(() =>
        buildSetApprovalThreshold(tx, { token: sbtc, threshold: 2n ** 128n }),
      ),
    ).toBe("INVALID_AMOUNT");
    // The contract refuses a token outside the fixed set with u106.
    const outside = buildSetApprovalThreshold(tx, {
      token: evil,
      threshold: 1n,
    });
    expect(run(outside, alice).result).toStrictEqual(err(106));
  });

  it("buildRequestSwap says nothing moves, and the contract stores the request", () => {
    const call = buildRequestSwap(tx, { owner: alice, ...terms(BIG) });
    expect(call).toMatchObject({
      functionName: "request-swap",
      postConditions: [],
      postConditionMode: "deny",
    });
    const at = height();
    const sent = run(call, bob);
    expect(sent.result).toStrictEqual(Cl.ok(Cl.uint(at + 6n)));
    // One print and no transfer.
    expect(sent.events.map((e) => e.event)).toStrictEqual(["print_event"]);
    // The same call from anyone else is refused.
    expect(run(call, mallory).result).toStrictEqual(err(108));
  });

  it("buildRequestSwap needs no asset name or adapter route", () => {
    const bare: TxConfig = { vault: vaultId, assetNames: {} };
    expect(
      buildRequestSwap(bare, { owner: alice, ...terms(BIG) }).functionArgs,
    ).toHaveLength(6);
    expect(() =>
      buildRequestSwap(tx, { owner: "nobody", ...terms(BIG) }),
    ).toThrow(TxBuildError);
    expect(() => buildRequestSwap(tx, { owner: alice, ...terms(0n) })).toThrow(
      /amountIn/,
    );
  });

  it("buildApproveSwap carries execute-swap's post-conditions and runs the request", async () => {
    const at = height();
    run(buildRequestSwap(tx, { owner: alice, ...terms(BIG) }), bob);
    const call = buildApproveSwap(tx, { ...terms(BIG), requestedAt: at });
    expect(call.functionName).toBe("approve-swap");
    // The five trade fields, then the request's height.
    expect(call.functionArgs).toHaveLength(6);
    expect(call.functionArgs[5]).toStrictEqual({
      type: "uint",
      value: at.toString(),
    });
    // Built for another height, the same trade is refused.
    expect(
      run(buildApproveSwap(tx, { ...terms(BIG), requestedAt: at + 1n }), alice)
        .result,
    ).toStrictEqual(err(131));
    expect(call.postConditionMode).toBe("deny");
    expect(call.postConditions).toStrictEqual(
      buildExecuteSwap(tx, { owner: alice, ...terms(BIG) }).postConditions,
    );
    expect(call.postConditions).toStrictEqual([
      {
        type: "ft-postcondition",
        address: vaultId,
        condition: "lte",
        amount: BIG.toString(),
        asset: `${sbtc}::mock-sbtc`,
      },
      {
        type: "ft-postcondition",
        address: dex,
        condition: "gte",
        amount: floor(BIG).toString(),
        asset: `${usd}::mock-usd`,
      },
    ]);
    // Anyone but the owner has no request of their own to approve.
    expect(run(call, bob).result).toStrictEqual(err(129));
    const sent = run(call, alice);
    expect(sent.result).toStrictEqual(Cl.ok(Cl.uint(BIG * 900n)));
    // The transfers are the ones the post-conditions name: the vault sends
    // the input and the adapter sends the output.
    const transfers = sent.events
      .filter((e) => e.event === "ft_transfer_event")
      .map((e) => e.data as { sender: string; amount: string });
    expect(transfers).toMatchObject([
      { sender: vaultId, amount: BIG.toString() },
      { sender: dex, amount: (BIG * 900n).toString() },
    ]);
  });

  it("buildApproveSwap refuses an adapter with no route or a token with no name", () => {
    const code = (config: TxConfig) => {
      try {
        buildApproveSwap(config, { ...terms(BIG), requestedAt: 1n });
      } catch (e) {
        return (e as TxBuildError).code;
      }
      return "built";
    };
    expect(code({ vault: vaultId, assetNames: tx.assetNames })).toBe(
      "UNKNOWN_ADAPTER",
    );
    expect(code({ ...tx, assetNames: { [sbtc]: "mock-sbtc" } })).toBe(
      "UNKNOWN_ASSET",
    );
    // A pool route adds the pool leg, as for execute-swap.
    const pool = `${deployer}.mock-usd-pool`;
    const routed = { ...tx, adapters: { [dex]: { pool } } };
    expect(
      buildApproveSwap(routed, { ...terms(BIG), requestedAt: 1n })
        .postConditions,
    ).toHaveLength(4);
  });

  it("buildApproveSwap refuses a requestedAt that is not a uint", () => {
    const build = (requestedAt: unknown) => () =>
      buildApproveSwap(tx, {
        ...terms(BIG),
        requestedAt: requestedAt as bigint,
      });
    for (const bad of [-1n, 2n ** 128n, 7, "7", undefined]) {
      expect(build(bad), String(bad)).toThrow(TxBuildError);
      expect(build(bad), String(bad)).toThrow(/requestedAt/);
    }
    expect(build(0n)).not.toThrow();
    expect(build(2n ** 128n - 1n)).not.toThrow();
  });

  it("buildRejectSwap removes the owner's request, and is refused without one", async () => {
    const call = buildRejectSwap(tx);
    expect(call).toMatchObject({
      functionName: "reject-swap",
      functionArgs: [],
      postConditions: [],
      postConditionMode: "deny",
    });
    expect(run(call, alice).result).toStrictEqual(err(129));
    run(buildRequestSwap(tx, { owner: alice, ...terms(BIG) }), bob);
    // Bob has no request of his own: reject-swap is the owner's call.
    expect(run(call, bob).result).toStrictEqual(err(129));
    expect(run(call, alice).result).toStrictEqual(Cl.ok(Cl.bool(true)));
    expect((await state()).pendingSwap).toBeNull();
  });

  it("buildCancelSwapRequest withdraws the agent's request, and only the agent's", async () => {
    const call = buildCancelSwapRequest(tx, { owner: alice });
    expect(call).toMatchObject({
      functionName: "cancel-swap-request",
      functionArgs: [Cl.principal(alice)],
      postConditions: [],
      postConditionMode: "deny",
    });
    expect(run(call, bob).result).toStrictEqual(err(129));
    run(buildRequestSwap(tx, { owner: alice, ...terms(BIG) }), bob);
    expect(run(call, mallory).result).toStrictEqual(err(133));
    expect(run(call, bob).result).toStrictEqual(Cl.ok(Cl.bool(true)));
    expect((await state()).pendingSwap).toBeNull();
    expect(() => buildCancelSwapRequest(tx, { owner: "nobody" })).toThrow(
      TxBuildError,
    );
  });
});

// One story on the real contract for the journal helpers: Bob trades inside
// his authority, asks for three larger trades, and the owner approves one
// and rejects one while Bob withdraws the third.
describe("the journal helpers count approved trades", () => {
  let events: ReturnType<typeof parseJournal>;
  let requestedAt: bigint;
  let approvedAt: bigint;
  /** Indexes of the story's events in the journal. */
  const at = {
    threshold: 8,
    direct: 9,
    request: 10,
    approve: 11,
    rejected: 13,
    cancelled: 15,
  };

  beforeEach(() => {
    // 0 to 7 are the set-up, 8 the threshold.
    expect(execute(terms(SMALL)).result.type).toBe("ok"); // 9
    requestedAt = height();
    expect(request(terms(BIG)).result.type).toBe("ok"); // 10
    simnet.mineEmptyBurnBlocks(2);
    approvedAt = height();
    expect(approve({ ...terms(BIG), requestedAt }).result.type).toBe("ok"); // 11
    expect(request(terms(BIG + 1n)).result.type).toBe("ok"); // 12
    h.ok(alice, "reject-swap"); // 13
    expect(request(terms(BIG + 2n)).result.type).toBe("ok"); // 14
    h.ok(bob, "cancel-swap-request", [Cl.principal(alice)]); // 15
    events = parseJournal(h.records);
    expect(events.map((e) => e.event).slice(8)).toStrictEqual([
      "set-approval-threshold",
      "execute-swap",
      "request-swap",
      "approve-swap",
      "request-swap",
      "reject-swap",
      "request-swap",
      "cancel-swap-request",
    ]);
  });

  const ref = (index: number) => ({
    index,
    burnHeight: h.records[index]!.burnHeight,
    txId: null,
  });

  it("swapEvent reads an approve-swap as a trade the owner approved", () => {
    expect(swapEvent(events[at.approve]!)).toStrictEqual({
      ref: { index: at.approve, burnHeight: approvedAt, txId: null },
      owner: alice,
      agent: bob,
      adapter: dex,
      tokenIn: sbtc,
      tokenOut: usd,
      amountIn: BIG,
      minOut: floor(BIG),
      amountOut: BIG * 900n,
      balanceIn: DEPOSIT - SMALL - BIG,
      balanceOut: (SMALL + BIG) * 900n,
      dayTotal: SMALL + BIG,
      oraclePrice: PRICE_90K,
      oracleTimestamp: events[at.approve]!.fields["oracle-timestamp"],
      minOutFloor: floor(BIG),
      approved: true,
      requestedAt,
    });
    expect(swapEvent(events[at.direct]!)).toMatchObject({
      approved: false,
      requestedAt: null,
    });
    // A request is not a trade, and an approval without its height is not
    // read as one.
    expect(swapEvent(events[at.request]!)).toBeNull();
    const rest = Object.fromEntries(
      Object.entries(events[at.approve]!.fields).filter(
        ([name]) => name !== "requested-at",
      ),
    );
    expect(swapEvent({ ...events[at.approve]!, fields: rest })).toBeNull();
  });

  it("swapRequestEvent reads a request, a rejection and a withdrawal", () => {
    expect(swapRequestEvent(events[at.request]!)).toStrictEqual({
      ref: ref(at.request),
      kind: "requested",
      owner: alice,
      agent: bob,
      adapter: dex,
      tokenIn: sbtc,
      tokenOut: usd,
      amountIn: BIG,
      minOut: floor(BIG),
      requestedAt,
      expiresAt: requestedAt + 6n,
    });
    expect(swapRequestEvent(events[at.rejected]!)).toMatchObject({
      kind: "rejected",
      amountIn: BIG + 1n,
    });
    expect(swapRequestEvent(events[at.cancelled]!)).toMatchObject({
      kind: "cancelled",
      amountIn: BIG + 2n,
    });
    expect(swapRequestEvent(events[at.approve]!)).toBeNull();
    expect(swapRequestEvent(events[at.direct]!)).toBeNull();
    const damaged = { ...events[at.request]!, fields: { owner: alice } };
    expect(swapRequestEvent(damaged)).toBeNull();
  });

  it("accountabilityRecords gives both trades, with the threshold in force", () => {
    const records = accountabilityRecords(events);
    expect(records.map((r) => r.swap.ref.index)).toStrictEqual([
      at.direct,
      at.approve,
    ]);
    const [direct, approved] = records;
    const threshold = {
      token: sbtc,
      threshold: THRESHOLD,
      setBy: ref(at.threshold),
    };
    expect(direct!.swap.approved).toBe(false);
    expect(direct!.request).toBeNull();
    expect(direct!.policy.approvalThreshold).toStrictEqual(threshold);
    expect(direct!.issues).toStrictEqual([]);
    // The approved trade is above the threshold, and that is no issue.
    expect(approved!.swap).toMatchObject({
      approved: true,
      requestedAt,
      amountIn: BIG,
    });
    expect(approved!.request).toStrictEqual(ref(at.request));
    expect(approved!.policy.approvalThreshold).toStrictEqual(threshold);
    expect(approved!.issues).toStrictEqual([]);
  });

  it("accountabilityRecords follows a threshold that is changed or cleared", () => {
    setThreshold(null); // 16
    expect(execute(terms(BIG)).result.type).toBe("ok"); // 17
    setThreshold(BIG, usd); // 18: another token's threshold
    const last = accountabilityRecords(parseJournal(h.records)).at(-1)!;
    expect(last.swap.ref.index).toBe(17);
    expect(last.policy.approvalThreshold).toStrictEqual({
      token: sbtc,
      threshold: null,
      setBy: ref(16),
    });
    expect(last.issues).toStrictEqual([]);
  });

  it("flags an execute-swap above the threshold in force", () => {
    // The contract cannot print this. Replay the story with the approval
    // rewritten as the agent's own call.
    const forged = events.map((e) =>
      e.index === at.approve ? { ...e, event: "execute-swap" } : e,
    );
    const record = accountabilityRecords(forged)[1]!;
    expect(record.swap).toMatchObject({ approved: false, amountIn: BIG });
    expect(record.issues).toStrictEqual([
      {
        code: "OVER_APPROVAL_THRESHOLD",
        message:
          "the agent sent this trade alone, and the amount sold is above the approval threshold replayed",
      },
    ]);
    // At the threshold exactly there is nothing to flag.
    const atThreshold = forged.map((e) =>
      e.index === at.approve
        ? { ...e, fields: { ...e.fields, "amount-in": THRESHOLD } }
        : e,
    );
    expect(accountabilityRecords(atThreshold)[1]!.issues).toStrictEqual([]);
  });

  it("flags an approval whose request the journal does not hold", () => {
    const without = events.filter((e) => e.index !== at.request);
    const record = accountabilityRecords(without)[1]!;
    expect(record.request).toBeNull();
    expect(record.issues.map((i) => i.code)).toStrictEqual([
      "NO_REQUEST_EVENT",
    ]);
    // A request of another height is not this approval's.
    const moved = events.map((e) =>
      e.index === at.request
        ? { ...e, fields: { ...e.fields, "requested-at": requestedAt + 1n } }
        : e,
    );
    expect(accountabilityRecords(moved)[1]!.request).toBeNull();
  });

  it("the report says who had the authority, and names the threshold", () => {
    const report = renderAccountabilityReport(accountabilityRecords(events));
    expect(report).toContain("2 trades, oldest first.");
    expect(report).toContain(
      "- Authority: sent by the agent alone (`execute-swap`)",
    );
    expect(report).toContain(
      `- Authority: approved by the owner (\`approve-swap\`). The agent requested it at burn height ${requestedAt}, journal event ${at.request} at burn height ${requestedAt}`,
    );
    expect(report).toContain(`- Agent that requested the trade: \`${bob}\``);
    expect(report).toContain(
      `- Approval threshold for the token sold: a trade selling more than ${THRESHOLD} needs the owner's approval. Set by journal event ${at.threshold} at burn height ${h.records[at.threshold]!.burnHeight}`,
    );
    // Without the threshold event, the report says none was found.
    const bare = renderAccountabilityReport(
      accountabilityRecords(events.filter((e) => e.index !== at.threshold)),
    );
    expect(bare).toContain(
      "- Approval threshold for the token sold: none set in the journal",
    );
    const missing = renderAccountabilityReport(
      accountabilityRecords(events.filter((e) => e.index !== at.request)),
    );
    expect(missing).toContain(
      "its request-swap event was not found in the journal",
    );
    expect(missing).toContain("- NO_REQUEST_EVENT:");
  });

  it("agentHistory counts the approved trade, and what became of each request", () => {
    const history = agentHistory(events, bob);
    expect(history).toMatchObject({
      known: true,
      swaps: 2n,
      volume: [{ tokenIn: sbtc, swaps: 2n, amountIn: SMALL + BIG }],
      lastTrade: ref(at.approve),
      approvedSwaps: 1n,
      requests: { made: 3n, approved: 1n, rejected: 1n, cancelled: 1n },
    });
    // The owner approved and rejected, but is not an agent.
    expect(agentHistory(events, alice)).toStrictEqual({
      known: false,
      agent: alice,
    });
    // An agent first seen in a request is known.
    const onlyRequest = agentHistory([events[at.request]!], bob);
    expect(onlyRequest).toMatchObject({
      known: true,
      firstSeen: ref(at.request),
      swaps: 0n,
      requests: { made: 1n, approved: 0n, rejected: 0n, cancelled: 0n },
    });
  });

  it("tradeWarnings counts the approved trade as a past trade", () => {
    const trade = {
      owner: alice,
      tokenIn: sbtc,
      tokenOut: usd,
      amountIn: BIG,
      burnHeight: approvedAt,
    };
    // With only the approval in the journal this is not a first trade.
    const approvalOnly = [events[at.approve]!];
    expect(tradeWarnings(approvalOnly, trade)).toStrictEqual([]);
    expect(tradeWarnings([], trade).map((w) => w.kind)).toStrictEqual([
      "FIRST_TRADE_IN_DIRECTION",
    ]);
    // Both trades count towards a burst and the size baseline; the
    // requests, the rejection and the withdrawal do not.
    const warnings = tradeWarnings(
      events,
      { ...trade, amountIn: BIG * 10n },
      { burstTrades: 3n, sizeBaseline: "largest" },
    );
    expect(warnings).toMatchObject([
      { kind: "LARGE_TRADE", baseline: BIG, pastTrades: 2n },
      { kind: "BURST", trades: 3n },
    ]);
  });
});
