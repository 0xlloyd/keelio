import { readFileSync } from "node:fs";
import { join } from "node:path";
import { initSimnet } from "@stacks/clarinet-sdk";
import {
  Cl,
  type ClarityValue,
  type ContractCallOptions,
} from "@stacks/transactions";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  buildAllowAdapter,
  buildAllowToken,
  buildDeposit,
  buildExecuteSwap,
  buildPause,
  buildRemoveAgent,
  buildSetAgent,
  buildSetPolicy,
  buildSetPriceBounds,
  buildSetTokenCaps,
  buildUnpause,
  buildWithdraw,
  readVault,
  simnetClient,
  TxBuildError,
  type AdapterRoute,
  type ExecuteSwapInput,
  type TxBuildErrorCode,
  type TxConfig,
  type VaultCall,
  type VaultConfig,
} from "../packages/sdk/src/index.js";
import { PRICE_90K, PRICE_SCALE, armOracle } from "./oracle-fixture.js";

const simnet = await initSimnet();
const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const alice = accounts.get("wallet_1")!;
const bob = accounts.get("wallet_2")!;
const mallory = accounts.get("wallet_3")!;

const vaultId = `${deployer}.keelio-vault`;
const sbtc = `${deployer}.mock-sbtc`;
const usd = `${deployer}.mock-usd`;
const dex = `${deployer}.mock-dex`;

// Written from the contracts, not from the builder: each token's
// `define-fungible-token` name is the same as its contract name.
const SBTC_ASSET = `${deployer}.mock-sbtc::mock-sbtc`;
const USD_ASSET = `${deployer}.mock-usd::mock-usd`;

const RATE = 900n;
const DEPOSIT = 1_000_000n;
const AMOUNT_IN = 10_000n;
const MAX_PER_TRADE = 100_000n;
const MAX_PER_DAY = 1_000_000_000n;
const EXPIRES_AT = 1_000_000n;
const MAX_UINT = 2n ** 128n - 1n;

const config: TxConfig = {
  vault: vaultId,
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

type CallResult = ReturnType<typeof simnet.callPublicFn>;

interface FtTransfer {
  asset_identifier: string;
  sender: string;
  recipient: string;
  amount: string;
}

/** Runs a built call on the simnet, passing its fields straight through. */
function run(call: VaultCall, sender: string): CallResult {
  return simnet.callPublicFn(
    `${call.contractAddress}.${call.contractName}`,
    call.functionName,
    call.functionArgs,
    sender,
  );
}

function ftTransfers(events: CallResult["events"]): FtTransfer[] {
  return events
    .filter((e) => e.event === "ft_transfer_event")
    .map((e) => e.data as FtTransfer);
}

type PcCheck = { ok: true } | { ok: false; reason: string };

/**
 * Test-only stand-in for the chain: the simnet does not enforce
 * post-conditions. Sums the FT amounts each principal sent per asset, checks
 * each post-condition against its sum (no transfer counts as 0), and in Deny
 * mode fails any (sender, asset) that moved without a post-condition.
 */
function checkPostConditions(
  call: VaultCall,
  events: CallResult["events"],
): PcCheck {
  const sent = new Map<string, bigint>();
  for (const t of ftTransfers(events)) {
    const key = `${t.sender}|${t.asset_identifier}`;
    sent.set(key, (sent.get(key) ?? 0n) + BigInt(t.amount));
  }
  const covered = new Set<string>();
  for (const pc of call.postConditions) {
    if (pc.type !== "ft-postcondition") {
      return { ok: false, reason: `unsupported ${pc.type}` };
    }
    const key = `${pc.address}|${pc.asset}`;
    covered.add(key);
    const actual = sent.get(key) ?? 0n;
    const want = BigInt(pc.amount);
    const holds = {
      eq: actual === want,
      gt: actual > want,
      gte: actual >= want,
      lt: actual < want,
      lte: actual <= want,
    }[pc.condition];
    if (!holds) {
      return {
        ok: false,
        reason: `${key} sent ${actual}, needs ${pc.condition} ${want}`,
      };
    }
  }
  if (call.postConditionMode === "deny") {
    for (const key of sent.keys()) {
      if (!covered.has(key)) {
        return { ok: false, reason: `${key} not covered in deny mode` };
      }
    }
  }
  return { ok: true };
}

/**
 * Compares arguments by their consensus bytes: a built `uint` holds its value
 * as a decimal string, so it is not `toStrictEqual` to `Cl.uint(bigint)`.
 */
function expectArgs(call: VaultCall, expected: ClarityValue[]) {
  expect(call.functionArgs.map((a) => Cl.serialize(a))).toStrictEqual(
    expected.map((a) => Cl.serialize(a)),
  );
}

function ok(call: { result: ClarityValue }) {
  expect(call.result).toStrictEqual(Cl.ok(Cl.bool(true)));
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

function readOnly(contract: string, fn: string, args: ClarityValue[]) {
  return simnet.callReadOnlyFn(contract, fn, args, deployer).result;
}

/** The owner's ledger entry in the vault. */
function ledger(owner: string, token: string): bigint {
  const v = readOnly("keelio-vault", "get-balance", [
    Cl.principal(owner),
    Cl.principal(token),
  ]);
  if (v.type !== "uint") throw new Error(`expected uint, got ${v.type}`);
  return BigInt(v.value);
}

/** The vault contract's own balance of a token. */
function vaultHolds(token: string): bigint {
  const name = token.split(".")[1]!;
  const v = readOnly(name, "get-balance", [Cl.principal(vaultId)]);
  if (v.type !== "ok" || v.value.type !== "uint") {
    throw new Error(`unexpected get-balance result ${v.type}`);
  }
  return BigInt(v.value.value);
}

function isAllowed(fn: string, owner: string, id: string): ClarityValue {
  return readOnly("keelio-vault", fn, [Cl.principal(owner), Cl.principal(id)]);
}

function swapInput(over: Partial<ExecuteSwapInput> = {}): ExecuteSwapInput {
  return {
    owner: alice,
    adapter: dex,
    tokenIn: sbtc,
    tokenOut: usd,
    amountIn: AMOUNT_IN,
    minOut: AMOUNT_IN * RATE,
    ...over,
  };
}

function expectBuildError(code: TxBuildErrorCode, build: () => VaultCall) {
  let returned: VaultCall | undefined;
  try {
    returned = build();
  } catch (e) {
    expect(e).toBeInstanceOf(TxBuildError);
    expect((e as TxBuildError).code).toBe(code);
    return;
  }
  expect.fail(`expected ${code}, got ${JSON.stringify(returned)}`);
}

beforeAll(() => {
  // Reserves for both swap directions.
  mint("mock-usd", 10n ** 18n, dex);
  mint("mock-sbtc", 10n ** 18n, dex);
});

beforeEach(() => {
  simnet.mineEmptyBurnBlocks(144);
  setRate(RATE, 1n);
  mint("mock-sbtc", DEPOSIT, alice);
  // Fixture set-up uses raw calls, so a broken builder fails only its own test.
  expect(
    simnet.callPublicFn(
      "keelio-vault",
      "deposit",
      [Cl.principal(sbtc), Cl.uint(DEPOSIT)],
      alice,
    ).result.type,
  ).toBe("ok");
  const owner = (fn: string, args: ClarityValue[] = []) =>
    ok(simnet.callPublicFn("keelio-vault", fn, args, alice));
  owner("set-agent", [Cl.principal(bob)]);
  owner("unpause");
  owner("allow-token", [Cl.principal(sbtc), Cl.bool(true)]);
  owner("allow-token", [Cl.principal(usd), Cl.bool(true)]);
  owner("allow-adapter", [Cl.principal(dex), Cl.bool(true)]);
  owner("set-token-caps", [
    Cl.principal(sbtc),
    Cl.uint(MAX_PER_TRADE),
    Cl.uint(MAX_PER_DAY),
  ]);
  // The same caps for USD, so the USD-in swaps here pass the vault.
  owner("set-token-caps", [
    Cl.principal(usd),
    Cl.uint(MAX_PER_TRADE),
    Cl.uint(MAX_PER_DAY),
  ]);
  owner("set-policy", [Cl.uint(0n), Cl.uint(EXPIRES_AT)]);
  // The oracle at the dex rate, so a swap at minOut of the exact output
  // clears the vault's floor.
  armOracle(simnet, alice, {
    price: PRICE_90K,
    slippageBps: 100n,
    maxAgeMs: 10n ** 15n,
  });
});

describe("buildDeposit", () => {
  const amount = 5_000n;

  it("builds the call the contract expects", () => {
    const call = buildDeposit(config, { owner: alice, token: sbtc, amount });
    expect(call.contractAddress).toBe(deployer);
    expect(call.contractName).toBe("keelio-vault");
    expect(call.functionName).toBe("deposit");
    expectArgs(call, [
      Cl.contractPrincipal(deployer, "mock-sbtc"),
      Cl.uint(amount),
    ]);
  });

  it("the owner sends exactly amount of the token", () => {
    const call = buildDeposit(config, { owner: alice, token: sbtc, amount });
    expect(call.postConditionMode).toBe("deny");
    expect(call.postConditions).toStrictEqual([
      {
        type: "ft-postcondition",
        address: alice,
        condition: "eq",
        amount: "5000",
        asset: SBTC_ASSET,
      },
    ]);
  });

  it("runs on the simnet: ledger and vault balance rise by amount", () => {
    mint("mock-sbtc", amount, alice);
    const ledgerBefore = ledger(alice, sbtc);
    const heldBefore = vaultHolds(sbtc);
    const call = buildDeposit(config, { owner: alice, token: sbtc, amount });

    const res = run(call, alice);

    expect(res.result).toStrictEqual(Cl.ok(Cl.uint(ledgerBefore + amount)));
    expect(ledger(alice, sbtc)).toBe(ledgerBefore + amount);
    expect(vaultHolds(sbtc)).toBe(heldBefore + amount);
    expect(ftTransfers(res.events)).toStrictEqual([
      {
        asset_identifier: SBTC_ASSET,
        sender: alice,
        recipient: vaultId,
        amount: "5000",
      },
    ]);
    expect(checkPostConditions(call, res.events)).toStrictEqual({ ok: true });
  });

  it("deposits the quote token with its own asset name", () => {
    mint("mock-usd", amount, alice);
    const call = buildDeposit(config, { owner: alice, token: usd, amount });
    expect(call.postConditions).toStrictEqual([
      {
        type: "ft-postcondition",
        address: alice,
        condition: "eq",
        amount: "5000",
        asset: USD_ASSET,
      },
    ]);
    const before = ledger(alice, usd);
    const res = run(call, alice);
    expect(res.result.type).toBe("ok");
    expect(ledger(alice, usd)).toBe(before + amount);
    expect(checkPostConditions(call, res.events)).toStrictEqual({ ok: true });
  });
});

describe("buildWithdraw", () => {
  const amount = 4_000n;

  it("the vault sends exactly amount of the token", () => {
    const call = buildWithdraw(config, { token: sbtc, amount });
    expect(call.functionName).toBe("withdraw");
    expectArgs(call, [
      Cl.contractPrincipal(deployer, "mock-sbtc"),
      Cl.uint(amount),
    ]);
    expect(call.postConditionMode).toBe("deny");
    expect(call.postConditions).toStrictEqual([
      {
        type: "ft-postcondition",
        address: vaultId,
        condition: "eq",
        amount: "4000",
        asset: SBTC_ASSET,
      },
    ]);
  });

  it("runs on the simnet: ledger and vault balance fall by amount", () => {
    const ledgerBefore = ledger(alice, sbtc);
    const heldBefore = vaultHolds(sbtc);
    const call = buildWithdraw(config, { token: sbtc, amount });

    const res = run(call, alice);

    expect(res.result).toStrictEqual(Cl.ok(Cl.uint(ledgerBefore - amount)));
    expect(ledger(alice, sbtc)).toBe(ledgerBefore - amount);
    expect(vaultHolds(sbtc)).toBe(heldBefore - amount);
    expect(checkPostConditions(call, res.events)).toStrictEqual({ ok: true });
  });

  it("the post-condition check fails when the amount is off by one", () => {
    const res = run(buildWithdraw(config, { token: sbtc, amount }), alice);
    expect(res.result.type).toBe("ok");
    const short = buildWithdraw(config, { token: sbtc, amount: amount - 1n });
    expect(checkPostConditions(short, res.events)).toMatchObject({
      ok: false,
    });
  });
});

describe("buildExecuteSwap", () => {
  it("the vault sends at most amountIn; the adapter at least minOut", () => {
    const call = buildExecuteSwap(config, swapInput());
    expect(call.functionName).toBe("execute-swap");
    expectArgs(call, [
      Cl.standardPrincipal(alice),
      Cl.contractPrincipal(deployer, "mock-dex"),
      Cl.contractPrincipal(deployer, "mock-sbtc"),
      Cl.contractPrincipal(deployer, "mock-usd"),
      Cl.uint(10_000n),
      Cl.uint(9_000_000n),
    ]);
    expect(call.postConditionMode).toBe("deny");
    expect(call.postConditions).toStrictEqual([
      {
        type: "ft-postcondition",
        address: vaultId,
        condition: "lte",
        amount: "10000",
        asset: SBTC_ASSET,
      },
      {
        type: "ft-postcondition",
        address: dex,
        condition: "gte",
        amount: "9000000",
        asset: USD_ASSET,
      },
    ]);
    // Nothing may leave the agent: no entry names it, so Deny mode aborts
    // any transfer from it.
    for (const pc of call.postConditions) {
      expect("address" in pc && pc.address).not.toBe(bob);
    }
  });

  it("sBTC to USD with minOut at the exact output", async () => {
    const before = (await readVault(client, readConfig, alice)).balances;
    const call = buildExecuteSwap(config, swapInput());

    const res = run(call, bob);

    expect(res.result.type).toBe("ok");
    const after = (await readVault(client, readConfig, alice)).balances;
    expect(after[sbtc]).toBe(before[sbtc]! - AMOUNT_IN);
    expect(after[usd]).toBe(before[usd]! + AMOUNT_IN * RATE);
    expect(ftTransfers(res.events)).toStrictEqual([
      {
        asset_identifier: SBTC_ASSET,
        sender: vaultId,
        recipient: dex,
        amount: "10000",
      },
      {
        asset_identifier: USD_ASSET,
        sender: dex,
        recipient: vaultId,
        amount: "9000000",
      },
    ]);
    expect(checkPostConditions(call, res.events)).toStrictEqual({ ok: true });
  });

  it("USD to sBTC with minOut at the exact output", async () => {
    // Give alice a USD ledger, then swap 90 000 USD units for 100 sats.
    mint("mock-usd", 90_000n, alice);
    expect(
      run(
        buildDeposit(config, { owner: alice, token: usd, amount: 90_000n }),
        alice,
      ).result.type,
    ).toBe("ok");
    setRate(1n, RATE);
    const before = (await readVault(client, readConfig, alice)).balances;
    const call = buildExecuteSwap(
      config,
      swapInput({
        tokenIn: usd,
        tokenOut: sbtc,
        amountIn: 90_000n,
        minOut: 100n,
      }),
    );
    expect(call.postConditions).toStrictEqual([
      {
        type: "ft-postcondition",
        address: vaultId,
        condition: "lte",
        amount: "90000",
        asset: USD_ASSET,
      },
      {
        type: "ft-postcondition",
        address: dex,
        condition: "gte",
        amount: "100",
        asset: SBTC_ASSET,
      },
    ]);
    for (const pc of call.postConditions) {
      expect("address" in pc && pc.address).not.toBe(bob);
    }

    const res = run(call, bob);

    expect(res.result.type).toBe("ok");
    const after = (await readVault(client, readConfig, alice)).balances;
    expect(after[usd]).toBe(before[usd]! - 90_000n);
    expect(after[sbtc]).toBe(before[sbtc]! + 100n);
    expect(checkPostConditions(call, res.events)).toStrictEqual({ ok: true });
  });

  it("passes the post-condition check with minOut of zero", () => {
    const call = buildExecuteSwap(config, swapInput({ minOut: 0n }));
    const res = run(call, bob);
    // The vault refuses min-out 0 below its oracle floor (u125) before any
    // transfer, and the post-conditions hold for a swap that moves nothing.
    expect(res.result).toStrictEqual(Cl.error(Cl.uint(125)));
    expect(ftTransfers(res.events)).toStrictEqual([]);
    expect(checkPostConditions(call, res.events)).toStrictEqual({ ok: true });
  });

  it("fails the check in Deny mode when the adapter's transfer is uncovered", () => {
    const call = buildExecuteSwap(config, swapInput());
    const res = run(call, bob);
    expect(res.result.type).toBe("ok");
    const withoutAdapter: VaultCall = {
      ...call,
      postConditions: [call.postConditions[0]!],
    };
    expect(checkPostConditions(withoutAdapter, res.events)).toStrictEqual({
      ok: false,
      reason: `${dex}|${USD_ASSET} not covered in deny mode`,
    });
  });
});

describe("the no-asset builders", () => {
  function expectNoAssets(call: VaultCall, sender: string) {
    expect(call.postConditions).toStrictEqual([]);
    expect(call.postConditionMode).toBe("deny");
    const res = run(call, sender);
    ok(res);
    expect(ftTransfers(res.events)).toStrictEqual([]);
  }
  const vaultOf = async (owner: string) =>
    (await readVault(client, readConfig, owner)).vault;

  it("buildSetAgent replaces the agent", async () => {
    const call = buildSetAgent(config, { agent: mallory });
    expect(call.functionName).toBe("set-agent");
    expectArgs(call, [Cl.standardPrincipal(mallory)]);
    expectNoAssets(call, alice);
    expect(await vaultOf(alice)).toStrictEqual({
      agent: mallory,
      paused: false,
    });
  });

  it("buildRemoveAgent clears the agent", async () => {
    const call = buildRemoveAgent(config);
    expect(call.functionName).toBe("remove-agent");
    expectArgs(call, []);
    expectNoAssets(call, alice);
    expect(await vaultOf(alice)).toStrictEqual({ agent: null, paused: false });
  });

  it("buildPause and buildUnpause flip paused", async () => {
    const pause = buildPause(config);
    expect(pause.functionName).toBe("pause");
    expectArgs(pause, []);
    expectNoAssets(pause, alice);
    expect(await vaultOf(alice)).toStrictEqual({ agent: bob, paused: true });

    const unpause = buildUnpause(config);
    expect(unpause.functionName).toBe("unpause");
    expectArgs(unpause, []);
    expectNoAssets(unpause, alice);
    expect(await vaultOf(alice)).toStrictEqual({ agent: bob, paused: false });
  });

  it("buildSetPolicy sets the owner-wide fields and no token's caps", () => {
    const read = (token: string) =>
      readOnly("keelio-vault", "get-policy", [
        Cl.principal(alice),
        Cl.principal(token),
      ]);
    const sbtcBefore = read(sbtc);
    const usdBefore = read(usd);
    if (sbtcBefore.type !== "tuple" || usdBefore.type !== "tuple")
      throw new Error("expected tuple");
    const call = buildSetPolicy(config, {
      cooldownBlocks: 2n,
      expiresAt: 999n,
    });
    expect(call.functionName).toBe("set-policy");
    expectArgs(call, [Cl.uint(2n), Cl.uint(999n)]);
    expectNoAssets(call, alice);
    // Both tokens keep their caps; only the cooldown and expiry change.
    for (const [token, before] of [
      [sbtc, sbtcBefore],
      [usd, usdBefore],
    ] as const) {
      expect(read(token)).toStrictEqual(
        Cl.tuple({
          "max-per-trade": before.value["max-per-trade"]!,
          "max-per-day": before.value["max-per-day"]!,
          "cooldown-blocks": Cl.uint(2n),
          "expires-at": Cl.uint(999n),
        }),
      );
    }
  });

  it("buildSetTokenCaps sets one token's caps and nothing else", () => {
    const read = (token: string) =>
      readOnly("keelio-vault", "get-policy", [
        Cl.principal(alice),
        Cl.principal(token),
      ]);
    const sbtcBefore = read(sbtc);
    const usdBefore = read(usd);
    if (sbtcBefore.type !== "tuple") throw new Error("expected tuple");
    const call = buildSetTokenCaps(config, {
      token: sbtc,
      maxPerTrade: 5n,
      maxPerDay: 50n,
    });
    expect(call.functionName).toBe("set-token-caps");
    expectArgs(call, [
      Cl.contractPrincipal(deployer, "mock-sbtc"),
      Cl.uint(5n),
      Cl.uint(50n),
    ]);
    expectNoAssets(call, alice);
    // The cooldown and expiry keep their values; USD keeps everything.
    expect(read(sbtc)).toStrictEqual(
      Cl.tuple({
        "max-per-trade": Cl.uint(5n),
        "max-per-day": Cl.uint(50n),
        "cooldown-blocks": sbtcBefore.value["cooldown-blocks"]!,
        "expires-at": sbtcBefore.value["expires-at"]!,
      }),
    );
    expect(read(usd)).toStrictEqual(usdBefore);
  });

  it("buildSetPriceBounds sets the owner's bounds", async () => {
    const call = buildSetPriceBounds(config, {
      maxSlippageBps: 100n,
      maxPriceAge: 60_000n,
    });
    expect(call.contractAddress).toBe(deployer);
    expect(call.contractName).toBe("keelio-vault");
    expect(call.functionName).toBe("set-price-bounds");
    expectArgs(call, [Cl.uint(100n), Cl.uint(60_000n)]);
    expectNoAssets(call, alice);
    expect(
      readOnly("keelio-vault", "get-price-bounds", [Cl.principal(alice)]),
    ).toStrictEqual(
      Cl.tuple({
        "max-slippage-bps": Cl.uint(100n),
        "max-price-age": Cl.uint(60_000n),
      }),
    );
    expect(
      (await readVault(client, readConfig, alice)).priceBounds,
    ).toStrictEqual({
      maxSlippageBps: 100n,
      maxPriceAge: 60_000n,
    });
  });

  it("buildAllowToken sets false then true", () => {
    const off = buildAllowToken(config, { token: usd, allowed: false });
    expect(off.functionName).toBe("allow-token");
    expectArgs(off, [
      Cl.contractPrincipal(deployer, "mock-usd"),
      Cl.bool(false),
    ]);
    expectNoAssets(off, alice);
    expect(isAllowed("is-token-allowed", alice, usd)).toStrictEqual(
      Cl.bool(false),
    );

    expectNoAssets(
      buildAllowToken(config, { token: usd, allowed: true }),
      alice,
    );
    expect(isAllowed("is-token-allowed", alice, usd)).toStrictEqual(
      Cl.bool(true),
    );
  });

  it("buildAllowAdapter sets false then true", () => {
    const off = buildAllowAdapter(config, { adapter: dex, allowed: false });
    expect(off.functionName).toBe("allow-adapter");
    expectArgs(off, [
      Cl.contractPrincipal(deployer, "mock-dex"),
      Cl.bool(false),
    ]);
    expectNoAssets(off, alice);
    expect(isAllowed("is-adapter-allowed", alice, dex)).toStrictEqual(
      Cl.bool(false),
    );

    expectNoAssets(
      buildAllowAdapter(config, { adapter: dex, allowed: true }),
      alice,
    );
    expect(isAllowed("is-adapter-allowed", alice, dex)).toStrictEqual(
      Cl.bool(true),
    );
  });
});

describe("input validation", () => {
  const amounts = { cooldownBlocks: 1n, expiresAt: 1n };
  const policy = { ...amounts };
  const capAmounts = { maxPerTrade: 1n, maxPerDay: 1n };
  const caps = { token: sbtc, ...capAmounts };

  describe("INVALID_AMOUNT", () => {
    for (const amount of [0n, -1n, 2n ** 64n, 2n ** 128n]) {
      it(`refuses amount ${amount}`, () => {
        expectBuildError("INVALID_AMOUNT", () =>
          buildDeposit(config, { owner: alice, token: sbtc, amount }),
        );
        expectBuildError("INVALID_AMOUNT", () =>
          buildWithdraw(config, { token: sbtc, amount }),
        );
        expectBuildError("INVALID_AMOUNT", () =>
          buildExecuteSwap(config, swapInput({ amountIn: amount })),
        );
      });
    }

    it("refuses minOut below zero, above u64 or above uint128", () => {
      expectBuildError("INVALID_AMOUNT", () =>
        buildExecuteSwap(config, swapInput({ minOut: -1n })),
      );
      expectBuildError("INVALID_AMOUNT", () =>
        buildExecuteSwap(config, swapInput({ minOut: 2n ** 64n })),
      );
      expectBuildError("INVALID_AMOUNT", () =>
        buildExecuteSwap(config, swapInput({ minOut: 2n ** 128n })),
      );
    });

    for (const field of Object.keys(amounts) as (keyof typeof amounts)[]) {
      it(`refuses ${field} of 2^128 or -1`, () => {
        expectBuildError("INVALID_AMOUNT", () =>
          buildSetPolicy(config, { ...policy, [field]: 2n ** 128n }),
        );
        expectBuildError("INVALID_AMOUNT", () =>
          buildSetPolicy(config, { ...policy, [field]: -1n }),
        );
      });
    }

    for (const field of Object.keys(
      capAmounts,
    ) as (keyof typeof capAmounts)[]) {
      it(`refuses set-token-caps ${field} of 2^128 or -1`, () => {
        expectBuildError("INVALID_AMOUNT", () =>
          buildSetTokenCaps(config, { ...caps, [field]: 2n ** 128n }),
        );
        expectBuildError("INVALID_AMOUNT", () =>
          buildSetTokenCaps(config, { ...caps, [field]: -1n }),
        );
      });
    }

    it("refuses amounts that are not bigint", () => {
      for (const bad of [1000, "1000", 1e3, undefined, null]) {
        const amount = bad as unknown as bigint;
        expectBuildError("INVALID_AMOUNT", () =>
          buildDeposit(config, { owner: alice, token: sbtc, amount }),
        );
        expectBuildError("INVALID_AMOUNT", () =>
          buildWithdraw(config, { token: sbtc, amount }),
        );
        expectBuildError("INVALID_AMOUNT", () =>
          buildExecuteSwap(config, swapInput({ minOut: amount })),
        );
        expectBuildError("INVALID_AMOUNT", () =>
          buildSetPolicy(config, { ...policy, cooldownBlocks: amount }),
        );
        expectBuildError("INVALID_AMOUNT", () =>
          buildSetPolicy(config, { ...policy, expiresAt: amount }),
        );
        expectBuildError("INVALID_AMOUNT", () =>
          buildSetTokenCaps(config, { ...caps, maxPerTrade: amount }),
        );
        expectBuildError("INVALID_AMOUNT", () =>
          buildSetTokenCaps(config, { ...caps, maxPerDay: amount }),
        );
      }
    });

    it("builds minOut 0, policy fields of 0 and 2^128 - 1, and a 2^64 - 1 withdraw", () => {
      const swapArgs = buildExecuteSwap(
        config,
        swapInput({ minOut: 0n }),
      ).functionArgs;
      expect(Cl.serialize(swapArgs[5]!)).toBe(Cl.serialize(Cl.uint(0n)));
      expectArgs(
        buildSetPolicy(config, { cooldownBlocks: 0n, expiresAt: 0n }),
        [Cl.uint(0n), Cl.uint(0n)],
      );
      expectArgs(
        buildSetPolicy(config, {
          cooldownBlocks: MAX_UINT,
          expiresAt: MAX_UINT,
        }),
        [Cl.uint(MAX_UINT), Cl.uint(MAX_UINT)],
      );
      expectArgs(
        buildSetTokenCaps(config, {
          token: usd,
          maxPerTrade: 0n,
          maxPerDay: 0n,
        }),
        [Cl.contractPrincipal(deployer, "mock-usd"), Cl.uint(0n), Cl.uint(0n)],
      );
      expectArgs(
        buildSetTokenCaps(config, {
          token: sbtc,
          maxPerTrade: MAX_UINT,
          maxPerDay: MAX_UINT,
        }),
        [
          Cl.contractPrincipal(deployer, "mock-sbtc"),
          Cl.uint(MAX_UINT),
          Cl.uint(MAX_UINT),
        ],
      );
      expect(
        buildWithdraw(config, { token: sbtc, amount: 2n ** 64n - 1n })
          .postConditions,
      ).toStrictEqual([
        {
          type: "ft-postcondition",
          address: vaultId,
          condition: "eq",
          amount: "18446744073709551615",
          asset: SBTC_ASSET,
        },
      ]);
    });
  });

  describe("buildSetPriceBounds", () => {
    const bounds = { maxSlippageBps: 100n, maxPriceAge: 60_000n };

    it("builds 0, 9999 bps and an age of 2^128 - 1", () => {
      for (const over of [
        { maxSlippageBps: 0n },
        { maxPriceAge: 0n },
        { maxSlippageBps: 9_999n },
        { maxPriceAge: MAX_UINT },
      ]) {
        const call = buildSetPriceBounds(config, { ...bounds, ...over });
        const want = { ...bounds, ...over };
        expectArgs(call, [
          Cl.uint(want.maxSlippageBps),
          Cl.uint(want.maxPriceAge),
        ]);
      }
    });

    it("refuses 10000 bps or more with INVALID_PRICE_BOUNDS", () => {
      for (const maxSlippageBps of [10_000n, 10_001n, MAX_UINT]) {
        expectBuildError("INVALID_PRICE_BOUNDS", () =>
          buildSetPriceBounds(config, { ...bounds, maxSlippageBps }),
        );
      }
    });

    it("refuses either field below zero or above uint128", () => {
      for (const bad of [-1n, 2n ** 128n]) {
        expectBuildError("INVALID_AMOUNT", () =>
          buildSetPriceBounds(config, { ...bounds, maxSlippageBps: bad }),
        );
        expectBuildError("INVALID_AMOUNT", () =>
          buildSetPriceBounds(config, { ...bounds, maxPriceAge: bad }),
        );
      }
    });

    it("refuses a malformed vault id", () => {
      expectBuildError("INVALID_PRINCIPAL", () =>
        buildSetPriceBounds({ ...config, vault: "keelio-vault" }, bounds),
      );
    });

    it("the contract refuses what the builder refuses with u120", () => {
      expect(
        simnet.callPublicFn(
          "keelio-vault",
          "set-price-bounds",
          [Cl.uint(10_000n), Cl.uint(60_000n)],
          alice,
        ).result,
      ).toStrictEqual(Cl.error(Cl.uint(120)));
    });
  });

  describe("INVALID_PRINCIPAL", () => {
    const malformed = [
      "not-an-address",
      `${deployer}.`,
      `.keelio-vault`,
      "",
      `${deployer}.${"a".repeat(41)}`,
      `${deployer}.1starts-with-digit`,
      `${deployer}.mock-sbtc.extra`,
      `${deployer.slice(0, -1)}X.mock-sbtc`,
      42 as unknown as string,
    ];

    it("refuses a malformed owner or agent", () => {
      for (const bad of ["not-an-address", `${deployer}.`, "", `${alice}X`]) {
        expectBuildError("INVALID_PRINCIPAL", () =>
          buildDeposit(config, { owner: bad, token: sbtc, amount: 1n }),
        );
        expectBuildError("INVALID_PRINCIPAL", () =>
          buildExecuteSwap(config, swapInput({ owner: bad })),
        );
        expectBuildError("INVALID_PRINCIPAL", () =>
          buildSetAgent(config, { agent: bad }),
        );
      }
    });

    it("accepts a contract principal as owner or agent", () => {
      expectArgs(buildSetAgent(config, { agent: dex }), [
        Cl.contractPrincipal(deployer, "mock-dex"),
      ]);
      expect(
        buildDeposit(config, { owner: dex, token: sbtc, amount: 1n })
          .postConditions,
      ).toStrictEqual([
        {
          type: "ft-postcondition",
          address: dex,
          condition: "eq",
          amount: "1",
          asset: SBTC_ASSET,
        },
      ]);
    });

    it("refuses a malformed token, adapter, tokenIn or tokenOut", () => {
      for (const bad of [...malformed, alice]) {
        expectBuildError("INVALID_PRINCIPAL", () =>
          buildDeposit(config, { owner: alice, token: bad, amount: 1n }),
        );
        expectBuildError("INVALID_PRINCIPAL", () =>
          buildWithdraw(config, { token: bad, amount: 1n }),
        );
        expectBuildError("INVALID_PRINCIPAL", () =>
          buildAllowToken(config, { token: bad, allowed: true }),
        );
        expectBuildError("INVALID_PRINCIPAL", () =>
          buildSetTokenCaps(config, { ...caps, token: bad }),
        );
        expectBuildError("INVALID_PRINCIPAL", () =>
          buildAllowAdapter(config, { adapter: bad, allowed: true }),
        );
        expectBuildError("INVALID_PRINCIPAL", () =>
          buildExecuteSwap(config, swapInput({ adapter: bad })),
        );
        expectBuildError("INVALID_PRINCIPAL", () =>
          buildExecuteSwap(config, swapInput({ tokenIn: bad })),
        );
        expectBuildError("INVALID_PRINCIPAL", () =>
          buildExecuteSwap(config, swapInput({ tokenOut: bad })),
        );
      }
    });

    it("refuses a malformed vault id in every builder", () => {
      for (const vault of [...malformed, "keelio-vault", deployer]) {
        const bad: TxConfig = { ...config, vault };
        const builds: (() => VaultCall)[] = [
          () => buildDeposit(bad, { owner: alice, token: sbtc, amount: 1n }),
          () => buildWithdraw(bad, { token: sbtc, amount: 1n }),
          () => buildSetAgent(bad, { agent: bob }),
          () => buildRemoveAgent(bad),
          () => buildPause(bad),
          () => buildUnpause(bad),
          () => buildSetPolicy(bad, policy),
          () => buildSetTokenCaps(bad, caps),
          () => buildAllowToken(bad, { token: sbtc, allowed: true }),
          () => buildAllowAdapter(bad, { adapter: dex, allowed: true }),
          () => buildExecuteSwap(bad, swapInput()),
        ];
        for (const build of builds)
          expectBuildError("INVALID_PRINCIPAL", build);
      }
    });
  });

  describe("UNKNOWN_ASSET", () => {
    const sbtcOnly: TxConfig = {
      vault: vaultId,
      assetNames: { [sbtc]: "mock-sbtc" },
    };

    it("refuses a token with no asset name", () => {
      expectBuildError("UNKNOWN_ASSET", () =>
        buildDeposit(sbtcOnly, { owner: alice, token: usd, amount: 1n }),
      );
      expectBuildError("UNKNOWN_ASSET", () =>
        buildWithdraw(sbtcOnly, { token: usd, amount: 1n }),
      );
      expectBuildError("UNKNOWN_ASSET", () =>
        buildExecuteSwap(sbtcOnly, swapInput({ tokenOut: usd })),
      );
      expectBuildError("UNKNOWN_ASSET", () =>
        buildExecuteSwap(sbtcOnly, swapInput({ tokenIn: usd, tokenOut: sbtc })),
      );
    });

    it("refuses an asset name that is not a Clarity name", () => {
      for (const name of ["", "mock sbtc", "1abc", "a::b"]) {
        const bad: TxConfig = { vault: vaultId, assetNames: { [sbtc]: name } };
        expectBuildError("UNKNOWN_ASSET", () =>
          buildWithdraw(bad, { token: sbtc, amount: 1n }),
        );
      }
    });

    it("does not read inherited keys as asset names", () => {
      const inherited: TxConfig = {
        vault: vaultId,
        assetNames: Object.create({ [sbtc]: "mock-sbtc" }) as Record<
          string,
          string
        >,
      };
      expectBuildError("UNKNOWN_ASSET", () =>
        buildWithdraw(inherited, { token: sbtc, amount: 1n }),
      );
    });

    it("allowToken needs no asset name", () => {
      const none: TxConfig = { vault: vaultId, assetNames: {} };
      expectArgs(buildAllowToken(none, { token: usd, allowed: true }), [
        Cl.contractPrincipal(deployer, "mock-usd"),
        Cl.bool(true),
      ]);
    });
  });
});

describe("compatibility", () => {
  it("a built call fits ContractCallOptions", () => {
    type CallFields = Pick<
      ContractCallOptions,
      | "contractAddress"
      | "contractName"
      | "functionName"
      | "functionArgs"
      | "postConditions"
      | "postConditionMode"
    >;
    const fields: CallFields = buildExecuteSwap(config, swapInput());
    expect(fields.postConditionMode).toBe("deny");
  });

  it("does not change its inputs", () => {
    const input = swapInput();
    const copy = structuredClone({ config, input });
    buildExecuteSwap(config, input);
    expect({ config, input }).toStrictEqual(copy);
  });
});

interface RecordedSwap {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut: string;
  transfers: FtTransfer[];
}

/**
 * The `ft_transfer_event` data of two `execute-swap`s through bitflow-adapter
 * (sBTC to USDCx and back), copied from a `pnpm run test:online` run of
 * tests/bitflow-adapter.test.ts. Principals and amounts only.
 */
const recorded = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "fixtures/bitflow/execute-swap-transfers.json"),
    "utf8",
  ),
) as {
  vault: string;
  adapter: string;
  pool: string;
  sbtc: string;
  usdcx: string;
  swaps: RecordedSwap[];
};

describe("buildExecuteSwap through bitflow-adapter (recorded events)", () => {
  const { vault, adapter, pool, sbtc: rSbtc, usdcx } = recorded;
  // Written from the recorded events, not from the builder.
  const assetOf: Record<string, string> = {
    [rSbtc]: `${rSbtc}::sbtc-token`,
    [usdcx]: `${usdcx}::usdcx-token`,
  };
  const assetNames = { [rSbtc]: "sbtc-token", [usdcx]: "usdcx-token" };
  const bitflow: TxConfig = {
    vault,
    assetNames,
    adapters: { [adapter]: { pool } },
  };

  const events = (swap: RecordedSwap) =>
    swap.transfers.map((data) => ({
      event: "ft_transfer_event",
      data,
    })) as unknown as CallResult["events"];

  const build = (cfg: TxConfig, swap: RecordedSwap, minOut: bigint) =>
    buildExecuteSwap(cfg, {
      owner: alice,
      adapter,
      tokenIn: swap.tokenIn,
      tokenOut: swap.tokenOut,
      amountIn: BigInt(swap.amountIn),
      minOut,
    });

  it("the fixture holds both directions", () => {
    expect(recorded.swaps.map((s) => [s.tokenIn, s.tokenOut])).toStrictEqual([
      [rSbtc, usdcx],
      [usdcx, rSbtc],
    ]);
  });

  for (const swap of recorded.swaps) {
    const dir = `${swap.tokenIn.split(".")[1]} to ${swap.tokenOut.split(".")[1]}`;
    const amountIn = BigInt(swap.amountIn);
    const amountOut = BigInt(swap.amountOut);
    const assetIn = assetOf[swap.tokenIn]!;
    const assetOut = assetOf[swap.tokenOut]!;

    describe(dir, () => {
      for (const minOut of [amountOut, 1n]) {
        it(`builds the four post-conditions in order and passes with minOut ${minOut}`, () => {
          const call = build(bitflow, swap, minOut);
          expect(call.postConditionMode).toBe("deny");
          expect(call.postConditions).toStrictEqual([
            {
              type: "ft-postcondition",
              address: vault,
              condition: "lte",
              amount: amountIn.toString(),
              asset: assetIn,
            },
            {
              type: "ft-postcondition",
              address: adapter,
              condition: "lte",
              amount: amountIn.toString(),
              asset: assetIn,
            },
            {
              type: "ft-postcondition",
              address: pool,
              condition: "gte",
              amount: minOut.toString(),
              asset: assetOut,
            },
            {
              type: "ft-postcondition",
              address: adapter,
              condition: "gte",
              amount: minOut.toString(),
              asset: assetOut,
            },
          ]);
          for (const pc of call.postConditions) {
            expect("address" in pc && pc.address).not.toBe(bob);
          }
          expect(checkPostConditions(call, events(swap))).toStrictEqual({
            ok: true,
          });
        });
      }

      it("fails on the pool's output when minOut is one above it", () => {
        const call = build(bitflow, swap, amountOut + 1n);
        expect(checkPostConditions(call, events(swap))).toStrictEqual({
          ok: false,
          reason: `${pool}|${assetOut} sent ${amountOut}, needs gte ${amountOut + 1n}`,
        });
      });

      it("fails in Deny mode without the pool route", () => {
        const noPool: TxConfig = {
          vault,
          assetNames,
          adapters: { [adapter]: { pool: null } },
        };
        const call = build(noPool, swap, 1n);
        expect(call.postConditions).toHaveLength(2);
        expect(checkPostConditions(call, events(swap))).toStrictEqual({
          ok: false,
          reason: `${adapter}|${assetIn} not covered in deny mode`,
        });
      });
    });
  }
});

describe("buildExecuteSwap adapter routes", () => {
  const pool = `${deployer}.mock-usd-pool`;
  const withRoute = (route: unknown): TxConfig => ({
    ...config,
    adapters: { [dex]: route as AdapterRoute },
  });

  describe("UNKNOWN_ADAPTER", () => {
    it("refuses a config with no adapters when both asset names are present", () => {
      const none: TxConfig = { vault: vaultId, assetNames: config.assetNames };
      expectBuildError("UNKNOWN_ADAPTER", () =>
        buildExecuteSwap(none, swapInput()),
      );
    });

    it("refuses an adapter missing from config.adapters", () => {
      expectBuildError("UNKNOWN_ADAPTER", () =>
        buildExecuteSwap({ ...config, adapters: {} }, swapInput()),
      );
      expectBuildError("UNKNOWN_ADAPTER", () =>
        buildExecuteSwap(
          { ...config, adapters: { [pool]: { pool: null } } },
          swapInput(),
        ),
      );
    });

    it("does not read inherited keys as routes", () => {
      const inherited: TxConfig = {
        ...config,
        adapters: Object.create({ [dex]: { pool: null } }) as Record<
          string,
          AdapterRoute
        >,
      };
      expectBuildError("UNKNOWN_ADAPTER", () =>
        buildExecuteSwap(inherited, swapInput()),
      );
    });

    it("refuses an entry that is not an object or whose pool is not a string or null", () => {
      for (const route of [
        { pool: 42 },
        { pool: undefined },
        {},
        null,
        "pool",
        42,
      ]) {
        expectBuildError("UNKNOWN_ADAPTER", () =>
          buildExecuteSwap(withRoute(route), swapInput()),
        );
      }
    });

    it("names config.adapters and the adapter in the message", () => {
      expect(() =>
        buildExecuteSwap({ ...config, adapters: {} }, swapInput()),
      ).toThrow(`config.adapters has no route for ${dex}`);
    });

    it("reports UNKNOWN_ASSET before UNKNOWN_ADAPTER", () => {
      const sbtcOnly: TxConfig = {
        vault: vaultId,
        assetNames: { [sbtc]: "mock-sbtc" },
      };
      expectBuildError("UNKNOWN_ASSET", () =>
        buildExecuteSwap(sbtcOnly, swapInput()),
      );
    });
  });

  describe("pool check", () => {
    it("refuses a malformed pool, a standard address, the vault or the adapter", () => {
      for (const bad of [
        "not-an-address",
        `${deployer}.`,
        "",
        `${deployer}.1starts-with-digit`,
        alice,
        vaultId,
        dex,
      ]) {
        expectBuildError("INVALID_PRINCIPAL", () =>
          buildExecuteSwap(withRoute({ pool: bad }), swapInput()),
        );
      }
    });

    it("names config.adapters[<adapter>].pool in the message", () => {
      expect(() =>
        buildExecuteSwap(withRoute({ pool: vaultId }), swapInput()),
      ).toThrow(`config.adapters[${dex}].pool`);
      expect(() =>
        buildExecuteSwap(withRoute({ pool: alice }), swapInput()),
      ).toThrow(`config.adapters[${dex}].pool`);
    });

    it("builds the four entries for a valid pool", () => {
      const call = buildExecuteSwap(withRoute({ pool }), swapInput());
      expect(call.postConditions).toStrictEqual([
        {
          type: "ft-postcondition",
          address: vaultId,
          condition: "lte",
          amount: "10000",
          asset: SBTC_ASSET,
        },
        {
          type: "ft-postcondition",
          address: dex,
          condition: "lte",
          amount: "10000",
          asset: SBTC_ASSET,
        },
        {
          type: "ft-postcondition",
          address: pool,
          condition: "gte",
          amount: "9000000",
          asset: USD_ASSET,
        },
        {
          type: "ft-postcondition",
          address: dex,
          condition: "gte",
          amount: "9000000",
          asset: USD_ASSET,
        },
      ]);
    });
  });
});
