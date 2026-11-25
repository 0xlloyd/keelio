import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSimnet } from "@stacks/clarinet-sdk";
import { Cl, type ClarityValue } from "@stacks/transactions";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ALERT_CODES,
  ConfigError,
  createMonitor,
  DEFAULT_THRESHOLDS,
  evaluate,
  fileStore,
  initialState,
  LEVEL_CODES,
  memoryStore,
  monitorSimnetChain,
  ownersWithBalance,
  parseConfig,
  parseState,
  VAULT_ERROR_NAMES,
  VAULT_ERROR_WORDS,
  type Alert,
  type AlertCode,
  type Monitor,
  type MonitorState,
  type RefusedCall,
  type SimnetMonitorChain,
  type StateStore,
  type Thresholds,
} from "../packages/monitor/src/index.js";
import type { VaultConfig } from "../packages/sdk/src/index.js";
import { parseArgs, runMonitorDemo } from "../scripts/monitor.js";
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
const carol = accounts.get("wallet_3")!;

const sbtc = `${deployer}.mock-sbtc`;
const usd = `${deployer}.mock-usd`;
const dex = `${deployer}.mock-dex`;

/** Raised with the `SWAP` of a vault's first trade in a direction. */
const FIRST = "TRADE_FIRST_IN_DIRECTION";

const DEPOSIT = 1_000_000n;
const SWAP = 100_000n;
const MAX_PER_DAY = 250_000n;
const SLIPPAGE_BPS = 100n;
const MAX_AGE_MS = 3_600_000n;
/** The floor for SWAP sats at $90,000 less 1%. */
const FLOOR = floorOf(SWAP, PRICE_90K, SLIPPAGE_BPS, true);

const read: VaultConfig = {
  vault: "keelio-vault",
  tokens: [sbtc, usd],
  adapters: [dex],
  oracle: "mock-oracle",
  sbtcToken: sbtc,
  priceScale: PRICE_SCALE,
};

let chain: SimnetMonitorChain;
let store: StateStore;
let monitor: Monitor;

function watch(thresholds: Partial<Thresholds> = {}): Monitor {
  return createMonitor({ chain, read, store, thresholds });
}

beforeEach(async () => {
  simnet = await initSimnet();
  chain = monitorSimnetChain(simnet, deployer);
  store = memoryStore();
  monitor = watch();
});

function call(
  contract: string,
  fn: string,
  args: ClarityValue[],
  sender: string,
): ClarityValue {
  return chain.callPublicFn(contract, fn, args, sender).result;
}

function ok(
  contract: string,
  fn: string,
  args: ClarityValue[],
  sender: string,
) {
  const result = call(contract, fn, args, sender);
  expect(result.type, Cl.prettyPrint(result)).toBe("ok");
}

function vault(sender: string, fn: string, args: ClarityValue[] = []) {
  ok("keelio-vault", fn, args, sender);
}

function setOracleAged(ageMs: bigint) {
  ok(
    "mock-oracle",
    "set-value-aged",
    [Cl.stringAscii(ORACLE_KEY), Cl.uint(PRICE_90K), Cl.uint(ageMs)],
    deployer,
  );
}

/** The age `evaluate` will measure: latest block time less the timestamp. */
function oracleAge(): bigint {
  return BigInt(simnet.getBlockTime()) * 1000n - oracleTimestamp(simnet);
}

function setRate(num: bigint, den = 1n) {
  ok("mock-dex", "set-rate", [Cl.uint(num), Cl.uint(den)], deployer);
}

/**
 * Opens `owner`'s vault with bob as agent: a deposit, caps, a policy, both
 * allow lists and price bounds. The dex trades at the oracle price.
 */
function open(owner = alice, expiresAt = 1_000_000n) {
  ok("mock-sbtc", "mint", [Cl.uint(DEPOSIT), Cl.principal(owner)], deployer);
  ok(
    "mock-usd",
    "mint",
    [Cl.uint(1_000_000_000_000n), Cl.principal(dex)],
    deployer,
  );
  setRate(900n);
  setOracleAged(0n);
  vault(owner, "deposit", [Cl.principal(sbtc), Cl.uint(DEPOSIT)]);
  vault(owner, "set-agent", [Cl.principal(bob)]);
  vault(owner, "set-token-caps", [
    Cl.principal(sbtc),
    Cl.uint(SWAP),
    Cl.uint(MAX_PER_DAY),
  ]);
  vault(owner, "set-policy", [Cl.uint(0), Cl.uint(expiresAt)]);
  vault(owner, "allow-token", [Cl.principal(sbtc), Cl.bool(true)]);
  vault(owner, "allow-token", [Cl.principal(usd), Cl.bool(true)]);
  vault(owner, "allow-adapter", [Cl.principal(dex), Cl.bool(true)]);
  vault(owner, "set-price-bounds", [
    Cl.uint(SLIPPAGE_BPS),
    Cl.uint(MAX_AGE_MS),
  ]);
}

/** Bob sells `amount` sats of `owner`'s for at least the oracle floor. */
function swap(amount = SWAP, owner = alice): ClarityValue {
  return call(
    "keelio-vault",
    "execute-swap",
    [
      Cl.principal(owner),
      Cl.principal(dex),
      Cl.principal(sbtc),
      Cl.principal(usd),
      Cl.uint(amount),
      Cl.uint(floorOf(amount, PRICE_90K, SLIPPAGE_BPS, true)),
    ],
    bob,
  );
}

function swapOk(amount = SWAP, owner = alice) {
  const result = swap(amount, owner);
  expect(result.type, Cl.prettyPrint(result)).toBe("ok");
}

function codes(alerts: readonly Alert[]): AlertCode[] {
  return alerts.map((a) => a.code);
}

function only(alerts: readonly Alert[], code: AlertCode): Alert {
  const found = alerts.filter((a) => a.code === code);
  expect(found, `${code} in ${codes(alerts).join(", ")}`).toHaveLength(1);
  return found[0]!;
}

/** Opens alice's vault and polls once, so later polls show only what is new. */
async function opened(expiresAt?: bigint) {
  open(alice, expiresAt);
  await monitor.poll();
}

describe("journal alerts", () => {
  it("raises one alert for each owner action, in journal order", async () => {
    open();
    const alerts = await monitor.poll();
    expect(codes(alerts)).toStrictEqual([
      "DEPOSIT",
      "AGENT_SET",
      "TOKEN_CAPS_SET",
      "POLICY_SET",
      "TOKEN_ALLOW_CHANGED",
      "TOKEN_ALLOW_CHANGED",
      "ADAPTER_ALLOW_CHANGED",
      "PRICE_BOUNDS_SET",
    ]);
    for (const alert of alerts) {
      expect(alert.owner).toBe(alice);
      expect(alert.severity).toBe(ALERT_CODES[alert.code]);
      expect(alert.message).not.toContain("\n");
    }
    expect(alerts[0]).toStrictEqual({
      id: "event:0:DEPOSIT",
      code: "DEPOSIT",
      severity: "info",
      owner: alice,
      burnHeight: simnet.burnBlockHeight.toString(),
      message: `deposited 1000000 of ${sbtc}; ledger balance 1000000`,
      details: { token: sbtc, amount: "1000000", balance: "1000000" },
    });
    expect(only(alerts, "TOKEN_CAPS_SET").details).toStrictEqual({
      token: sbtc,
      maxPerTrade: "100000",
      maxPerDay: "250000",
    });
    expect(only(alerts, "POLICY_SET").details).toStrictEqual({
      cooldownBlocks: "0",
      expiresAt: "1000000",
    });
    expect(only(alerts, "PRICE_BOUNDS_SET").details).toStrictEqual({
      maxSlippageBps: "100",
      maxPriceAge: "3600000",
    });
    expect(only(alerts, "AGENT_SET").details).toStrictEqual({
      agent: bob,
      paused: false,
    });
  });

  it("raises pause, unpause, remove-agent, revocations and a withdrawal", async () => {
    await opened();
    vault(alice, "pause");
    vault(alice, "unpause");
    vault(alice, "remove-agent");
    vault(alice, "allow-token", [Cl.principal(usd), Cl.bool(false)]);
    vault(alice, "allow-adapter", [Cl.principal(dex), Cl.bool(false)]);
    vault(alice, "withdraw", [Cl.principal(sbtc), Cl.uint(400_000)]);
    const alerts = await monitor.poll();
    expect(alerts.map((a) => [a.code, a.severity])).toStrictEqual([
      ["VAULT_PAUSED", "info"],
      ["VAULT_UNPAUSED", "warning"],
      ["AGENT_REMOVED", "info"],
      // Revoking narrows what the agent may do.
      ["TOKEN_ALLOW_CHANGED", "info"],
      ["ADAPTER_ALLOW_CHANGED", "info"],
      ["WITHDRAWAL", "info"],
    ]);
    expect(only(alerts, "WITHDRAWAL").details).toStrictEqual({
      token: sbtc,
      amount: "400000",
      balance: "600000",
    });
  });

  it("raises nothing for a call that changes nothing on the vault", async () => {
    await opened();
    setRate(901n);
    setOracleAged(0n);
    expect(await monitor.poll()).toStrictEqual([]);
  });

  it("SWAP: reports the amounts, the adapter and the margin over the floor", async () => {
    await opened();
    swapOk();
    const alerts = await monitor.poll();
    // The vault's first trade also raises the advisory first-direction alert
    // (tests/monitor-unusual.test.ts).
    expect(codes(alerts)).toStrictEqual(["SWAP", FIRST]);
    const alert = alerts[0]!;
    expect(alert.severity).toBe("info");
    expect(alert.owner).toBe(alice);
    expect(alert.details).toMatchObject({
      agent: bob,
      adapter: dex,
      tokenIn: sbtc,
      tokenOut: usd,
      amountIn: "100000",
      minOut: FLOOR.toString(),
      amountOut: "90000000",
      minOutFloor: "89100000",
      // (90000000 - 89100000) * 10000 / 89100000, rounded down.
      aboveFloorBps: "101",
      dayTotal: "100000",
      oraclePrice: PRICE_90K.toString(),
      approved: false,
      requestedAt: null,
    });
    expect(alert.message).toBe(
      `agent ${bob} sold 100000 of ${sbtc} for 90000000 of ${usd} on ${dex}; 101 bps above the floor 89100000`,
    );
  });

  it("SWAP_NEAR_FLOOR: raised at exactly the threshold above the floor", async () => {
    await opened();
    // 89_545_500 is the floor 89_100_000 plus exactly 50 bps of it.
    setRate(895_455n, 1000n);
    swapOk();
    const alerts = await monitor.poll();
    expect(codes(alerts)).toStrictEqual(["SWAP", "SWAP_NEAR_FLOOR", FIRST]);
    const near = only(alerts, "SWAP_NEAR_FLOOR");
    expect(near.severity).toBe("warning");
    expect(near.details).toMatchObject({
      amountOut: "89545500",
      minOutFloor: "89100000",
      aboveFloorBps: "50",
    });
  });

  it("SWAP_NEAR_FLOOR: not raised one hundred base units further from the floor", async () => {
    await opened();
    // The next rate the mock dex can express: 89_545_600 out.
    setRate(895_456n, 1000n);
    swapOk();
    const alerts = await monitor.poll();
    expect(codes(alerts)).toStrictEqual(["SWAP", FIRST]);
    expect(alerts[0]!.details.amountOut).toBe("89545600");
  });

  it("SWAP_NEAR_FLOOR: the threshold is configurable", async () => {
    await opened();
    setRate(892n);
    swapOk();
    // 89_200_000 is 11.2 bps above the floor.
    const strict = createMonitor({
      chain,
      read,
      store: memoryStore(await monitor.state()),
      thresholds: { nearFloorBps: 11n },
    });
    expect(codes(await strict.poll())).toStrictEqual(["SWAP", FIRST]);
    const loose = createMonitor({
      chain,
      read,
      store: memoryStore(await monitor.state()),
      thresholds: { nearFloorBps: 12n },
    });
    expect(codes(await loose.poll())).toStrictEqual([
      "SWAP",
      "SWAP_NEAR_FLOOR",
      FIRST,
    ]);
  });

  it("DAY_CAP_NEAR: not raised one sat below 80% of the cap, raised at it", async () => {
    await opened();
    swapOk(SWAP);
    swapOk(SWAP - 1n);
    // 199_999 of 250_000.
    expect(codes(await monitor.poll())).toStrictEqual(["SWAP", FIRST, "SWAP"]);
    swapOk(1n);
    const alerts = await monitor.poll();
    // The third trade at one burn height is also a burst.
    expect(codes(alerts)).toStrictEqual([
      "SWAP",
      "DAY_CAP_NEAR",
      "TRADE_BURST",
    ]);
    const near = only(alerts, "DAY_CAP_NEAR");
    expect(near.severity).toBe("warning");
    expect(near.details).toStrictEqual({
      token: sbtc,
      dayTotal: "200000",
      maxPerDay: "250000",
      usedBps: "8000",
    });
  });

  it("DAY_CAP_NEAR: measured against the cap the journal last showed", async () => {
    await opened();
    swapOk(SWAP);
    vault(alice, "set-token-caps", [
      Cl.principal(sbtc),
      Cl.uint(SWAP),
      Cl.uint(SWAP),
    ]);
    // Raised back before the poll: the swap was 40% of its cap when made.
    vault(alice, "set-token-caps", [
      Cl.principal(sbtc),
      Cl.uint(SWAP),
      Cl.uint(MAX_PER_DAY),
    ]);
    expect(codes(await monitor.poll())).toStrictEqual([
      "SWAP",
      FIRST,
      "TOKEN_CAPS_SET",
      "TOKEN_CAPS_SET",
    ]);
  });
});

describe("refused calls", () => {
  it("CALL_REFUSED: names the code, its constant and the owner", async () => {
    await opened();
    // Above max-per-trade.
    expect(swap(SWAP + 1n)).toStrictEqual(Cl.error(Cl.uint(114)));
    const alerts = await monitor.poll();
    expect(alerts).toStrictEqual([
      {
        id: "refusal:0",
        code: "CALL_REFUSED",
        severity: "warning",
        owner: alice,
        burnHeight: simnet.burnBlockHeight.toString(),
        message: `execute-swap by ${bob} was refused with (err u114) ERR-TRADE-CAP-EXCEEDED`,
        details: {
          function: "execute-swap",
          sender: bob,
          reason: "response",
          errorCode: "114",
          errorName: "ERR-TRADE-CAP-EXCEEDED",
          txId: null,
        },
      },
    ]);
  });

  it("CALL_REFUSED: not raised by a call that succeeds", async () => {
    await opened();
    swapOk();
    expect(codes(await monitor.poll())).toStrictEqual(["SWAP", FIRST]);
    expect(await chain.vaultRefusals()).toStrictEqual([]);
  });

  it("CALL_REFUSED: not raised by a failed call to another contract", async () => {
    await opened();
    expect(
      call("mock-dex", "set-rate", [Cl.uint(0), Cl.uint(1)], deployer).type,
    ).toBe("err");
    expect(await monitor.poll()).toStrictEqual([]);
  });

  it("CALL_REFUSED: a stranger's withdrawal is filed under the stranger", async () => {
    await opened();
    expect(
      call("keelio-vault", "withdraw", [Cl.principal(sbtc), Cl.uint(1)], carol),
    ).toStrictEqual(Cl.error(Cl.uint(101)));
    const alert = only(await monitor.poll(), "CALL_REFUSED");
    expect(alert.owner).toBe(carol);
    expect(alert.details.errorName).toBe("ERR-INSUFFICIENT-BALANCE");
  });

  it("CALL_REFUSED: critical when the adapter delivers less than it reports (u118)", async () => {
    await opened();
    ok("mock-dex", "set-skim", [Cl.uint(1)], deployer);
    const result = call(
      "keelio-vault",
      "execute-swap",
      [
        Cl.principal(alice),
        Cl.principal(dex),
        Cl.principal(sbtc),
        Cl.principal(usd),
        Cl.uint(SWAP),
        // Exactly what the dex computes; it then sends one unit less.
        Cl.uint(SWAP * 900n),
      ],
      bob,
    );
    expect(result).toStrictEqual(Cl.error(Cl.uint(118)));
    const alert = only(await monitor.poll(), "CALL_REFUSED");
    expect(alert.severity).toBe("critical");
    expect(alert.details.errorName).toBe("ERR-BELOW-MIN-OUT");
  });

  it("names every keelio-vault code as docs/errors.md does", () => {
    const doc = readFileSync(
      join(import.meta.dirname, "../docs/errors.md"),
      "utf8",
    );
    const listed: Record<string, string> = {};
    for (const row of doc.matchAll(
      /^\| `keelio-vault` +\| `u(\d+)` +\| `([A-Z-]+)`/gm,
    )) {
      listed[row[1]!] = row[2]!;
    }
    expect(Object.keys(listed).length).toBeGreaterThan(20);
    expect(VAULT_ERROR_NAMES).toStrictEqual(listed);
  });

  it("puts every keelio-vault code in plain words as docs/errors.md does", () => {
    const doc = readFileSync(
      join(import.meta.dirname, "../docs/errors.md"),
      "utf8",
    );
    const words: Record<string, string> = {};
    const table = doc.slice(
      doc.indexOf("## keelio-vault refusals in plain words"),
    );
    for (const row of table.matchAll(/^\| `u(\d+)` +\| (.+?) +\|$/gm)) {
      words[row[1]!] = row[2]!;
    }
    expect(Object.keys(words)).toStrictEqual(Object.keys(VAULT_ERROR_NAMES));
    expect(VAULT_ERROR_WORDS).toStrictEqual(words);
  });
});

describe("lasting conditions", () => {
  it("ORACLE_AGING: not raised 1 ms below 80% of max-price-age", async () => {
    await opened();
    setOracleAged((MAX_AGE_MS * 8n) / 10n - 1n);
    expect(oracleAge()).toBe(2_879_999n);
    expect(await monitor.poll()).toStrictEqual([]);
  });

  it("ORACLE_AGING: raised at 80% of max-price-age", async () => {
    await opened();
    setOracleAged((MAX_AGE_MS * 8n) / 10n);
    expect(oracleAge()).toBe(2_880_000n);
    const alerts = await monitor.poll();
    expect(codes(alerts)).toStrictEqual(["ORACLE_AGING"]);
    expect(alerts[0]).toMatchObject({
      id: `level:${alice}:ORACLE_AGING:${simnet.burnBlockHeight}`,
      severity: "warning",
      owner: alice,
      details: {
        ageMs: "2880000",
        maxPriceAge: "3600000",
        oraclePrice: PRICE_90K.toString(),
      },
    });
  });

  it("ORACLE_STALE: not raised at exactly max-price-age, where the vault still trades", async () => {
    await opened();
    setOracleAged(MAX_AGE_MS);
    expect(oracleAge()).toBe(MAX_AGE_MS);
    expect(codes(await monitor.poll())).toStrictEqual(["ORACLE_AGING"]);
  });

  it("ORACLE_STALE: raised 1 ms past max-price-age, when the vault refuses with u123", async () => {
    await opened();
    setOracleAged(MAX_AGE_MS + 1n);
    expect(oracleAge()).toBe(MAX_AGE_MS + 1n);
    const alerts = await monitor.poll();
    expect(codes(alerts)).toStrictEqual(["ORACLE_STALE"]);
    expect(alerts[0]!.severity).toBe("critical");
    expect(alerts[0]!.details.ageMs).toBe("3600001");
    // The contract agrees.
    expect(swap()).toStrictEqual(Cl.error(Cl.uint(123)));
    const refused = only(await monitor.poll(), "CALL_REFUSED");
    expect(refused.details.errorName).toBe("ERR-PRICE-STALE");
  });

  it("ORACLE_STALE: a price timestamped ahead of the block counts the same", async () => {
    await opened();
    ok(
      "mock-oracle",
      "set-value-ahead",
      [
        Cl.stringAscii(ORACLE_KEY),
        Cl.uint(PRICE_90K),
        Cl.uint(MAX_AGE_MS + 1n),
      ],
      deployer,
    );
    expect(codes(await monitor.poll())).toStrictEqual(["ORACLE_STALE"]);
  });

  it("ORACLE_UNAVAILABLE: raised when the oracle errors, not while it answers", async () => {
    await opened();
    expect(await monitor.poll()).toStrictEqual([]);
    ok("mock-oracle", "set-failing", [Cl.bool(true)], deployer);
    const alerts = await monitor.poll();
    expect(codes(alerts)).toStrictEqual(["ORACLE_UNAVAILABLE"]);
    expect(alerts[0]!.severity).toBe("critical");
    expect(alerts[0]!.details).toStrictEqual({ reason: "error" });
  });

  it("ORACLE_UNAVAILABLE: raised for a price of zero", async () => {
    await opened();
    ok(
      "mock-oracle",
      "set-value-aged",
      [Cl.stringAscii(ORACLE_KEY), Cl.uint(0), Cl.uint(0)],
      deployer,
    );
    const alerts = await monitor.poll();
    expect(codes(alerts)).toStrictEqual(["ORACLE_UNAVAILABLE"]);
    expect(alerts[0]!.details).toStrictEqual({ reason: "zero" });
  });

  it("POLICY_EXPIRING: not raised 145 burn blocks before expiry, raised at 144", async () => {
    const expiresAt = BigInt(simnet.burnBlockHeight) + 200n;
    await opened(expiresAt);
    // Mining moves block time; keep the oracle out of this test.
    vault(alice, "set-price-bounds", [Cl.uint(0), Cl.uint(0)]);
    simnet.mineEmptyBurnBlocks(
      Number(expiresAt) - 145 - simnet.burnBlockHeight,
    );
    expect(codes(await monitor.poll())).toStrictEqual(["PRICE_BOUNDS_SET"]);
    simnet.mineEmptyBurnBlocks(1);
    const alerts = await monitor.poll();
    expect(codes(alerts)).toStrictEqual(["POLICY_EXPIRING"]);
    expect(alerts[0]).toMatchObject({
      severity: "warning",
      owner: alice,
      burnHeight: (expiresAt - 144n).toString(),
      details: { expiresAt: expiresAt.toString(), blocksLeft: "144" },
    });
  });

  it("POLICY_EXPIRED: not raised at the expiry height, raised one block after", async () => {
    const expiresAt = BigInt(simnet.burnBlockHeight) + 200n;
    await opened(expiresAt);
    vault(alice, "set-price-bounds", [Cl.uint(0), Cl.uint(0)]);
    simnet.mineEmptyBurnBlocks(Number(expiresAt) - simnet.burnBlockHeight);
    expect(BigInt(simnet.burnBlockHeight)).toBe(expiresAt);
    expect(codes(await monitor.poll())).toStrictEqual([
      "PRICE_BOUNDS_SET",
      "POLICY_EXPIRING",
    ]);
    simnet.mineEmptyBurnBlocks(1);
    const alerts = await monitor.poll();
    expect(codes(alerts)).toStrictEqual(["POLICY_EXPIRED"]);
    expect(alerts[0]!.details).toStrictEqual({
      expiresAt: expiresAt.toString(),
      burnHeight: (expiresAt + 1n).toString(),
    });
  });

  it("raises a condition once, and again only after it has cleared", async () => {
    await opened();
    setOracleAged(MAX_AGE_MS + 1n);
    expect(codes(await monitor.poll())).toStrictEqual(["ORACLE_STALE"]);
    expect(await monitor.poll()).toStrictEqual([]);
    expect(await monitor.poll()).toStrictEqual([]);
    setOracleAged(0n);
    expect(await monitor.poll()).toStrictEqual([]);
    setOracleAged(MAX_AGE_MS + 1n);
    expect(codes(await monitor.poll())).toStrictEqual(["ORACLE_STALE"]);
  });

  it("raises none for a vault no agent can trade: paused, no agent or empty", async () => {
    await opened();
    setOracleAged(MAX_AGE_MS + 1n);
    vault(alice, "pause");
    expect(codes(await monitor.poll())).toStrictEqual(["VAULT_PAUSED"]);
    vault(alice, "unpause");
    vault(alice, "remove-agent");
    expect(codes(await monitor.poll())).toStrictEqual([
      "VAULT_UNPAUSED",
      "AGENT_REMOVED",
    ]);
    vault(alice, "set-agent", [Cl.principal(bob)]);
    vault(alice, "withdraw", [Cl.principal(sbtc), Cl.uint(DEPOSIT)]);
    expect(codes(await monitor.poll())).toStrictEqual([
      "AGENT_SET",
      "WITHDRAWAL",
    ]);
    // The same vault, funded again, is watched again.
    vault(alice, "deposit", [Cl.principal(sbtc), Cl.uint(1)]);
    expect(codes(await monitor.poll())).toStrictEqual([
      "DEPOSIT",
      "ORACLE_STALE",
    ]);
  });

  it("raises a condition for each owner it holds for", async () => {
    open(alice);
    open(carol);
    await monitor.poll();
    setOracleAged(MAX_AGE_MS + 1n);
    const alerts = await monitor.poll();
    expect(alerts.map((a) => [a.code, a.owner])).toStrictEqual(
      [alice, carol].sort().map((owner) => ["ORACLE_STALE", owner]),
    );
  });
});

describe("ledger solvency", () => {
  /**
   * The simnet chain, except that each token's `get-balance` of the vault
   * reads `lost` base units low: a vault that lost tokens no ledger shows,
   * which the contract never lets happen. Everything else is the real read.
   */
  function losing(lost: Record<string, bigint>) {
    const inner = chain;
    return {
      ...inner,
      callReadOnly: async (
        contract: string,
        fn: string,
        args: ClarityValue[],
      ) => {
        const result = await inner.callReadOnly(contract, fn, args);
        const gone = lost[contract] ?? 0n;
        if (fn !== "get-balance" || gone === 0n || result.type !== "ok") {
          return result;
        }
        const held = BigInt((result.value as { value: bigint }).value);
        return Cl.ok(Cl.uint(held - gone));
      },
    };
  }

  it("raises nothing while the vault holds what its ledgers owe, or more", async () => {
    await opened();
    swapOk();
    // Tokens sent straight to the vault make it hold more than it owes (T4).
    ok("mock-sbtc", "mint", [Cl.uint(5), Cl.principal(alice)], deployer);
    ok(
      "mock-sbtc",
      "transfer",
      [Cl.uint(5), Cl.principal(alice), Cl.principal(chain.vault), Cl.none()],
      alice,
    );
    expect(codes(await monitor.poll())).toStrictEqual(["SWAP", FIRST]);
    expect((await monitor.state()).shortTokens).toStrictEqual([]);
  });

  it("LEDGER_SHORTFALL: raised once when a token's vault balance falls below get-ledger-total, again after it clears", async () => {
    open(alice);
    open(carol);
    const lost: Record<string, bigint> = {};
    const short = createMonitor({ chain: losing(lost), read, store });
    await short.poll();
    lost[sbtc] = 1n;
    const alerts = await short.poll();
    expect(alerts).toStrictEqual([
      {
        id: `level:vault:LEDGER_SHORTFALL:${sbtc}:${simnet.burnBlockHeight}`,
        code: "LEDGER_SHORTFALL",
        severity: "critical",
        owner: null,
        burnHeight: simnet.burnBlockHeight.toString(),
        message: `the vault holds ${2n * DEPOSIT - 1n} of ${sbtc} but its ledgers owe ${2n * DEPOSIT}: 1 short, so not every owner can withdraw`,
        details: {
          token: sbtc,
          held: (2n * DEPOSIT - 1n).toString(),
          owed: (2n * DEPOSIT).toString(),
          shortBy: "1",
        },
      },
    ]);
    expect(await short.poll()).toStrictEqual([]);
    lost[sbtc] = 0n;
    expect(await short.poll()).toStrictEqual([]);
    expect((await short.state()).shortTokens).toStrictEqual([]);
    lost[sbtc] = 2n;
    expect(codes(await short.poll())).toStrictEqual(["LEDGER_SHORTFALL"]);
  });

  /**
   * The simnet chain, except that `act` runs once, as a block landing
   * between two reads would, straight after the poll's first read of `fn`
   * for sBTC. Every read is the real one.
   */
  function landingAfter(fn: string, act: () => void) {
    const inner = chain;
    let landed = false;
    return {
      ...inner,
      callReadOnly: async (
        contract: string,
        name: string,
        args: ClarityValue[],
      ) => {
        const result = await inner.callReadOnly(contract, name, args);
        const forSbtc =
          fn === "get-balance"
            ? contract === sbtc
            : args.length === 1 && Cl.prettyPrint(args[0]!) === `'${sbtc}`;
        if (!landed && name === fn && forSbtc) {
          landed = true;
          act();
        }
        return result;
      },
    };
  }

  it("LEDGER_SHORTFALL: not raised for a withdrawal that lands between the ledger read and the balance read", async () => {
    open(alice);
    const racing = createMonitor({
      chain: landingAfter("get-ledger-total", () =>
        vault(alice, "withdraw", [Cl.principal(sbtc), Cl.uint(SWAP)]),
      ),
      read,
      store,
    });
    expect(codes(await racing.poll())).not.toContain("LEDGER_SHORTFALL");
    expect((await racing.state()).shortTokens).toStrictEqual([]);
  });

  it("LEDGER_SHORTFALL: not raised for a deposit that lands between the balance read and the next ledger read", async () => {
    open(alice);
    ok("mock-sbtc", "mint", [Cl.uint(SWAP), Cl.principal(alice)], deployer);
    const racing = createMonitor({
      chain: landingAfter("get-balance", () =>
        vault(alice, "deposit", [Cl.principal(sbtc), Cl.uint(SWAP)]),
      ),
      read,
      store,
    });
    expect(codes(await racing.poll())).not.toContain("LEDGER_SHORTFALL");
  });

  it("LEDGER_SHORTFALL: checked even for a paused vault with no agent", async () => {
    open(alice);
    vault(alice, "pause");
    vault(alice, "remove-agent");
    const lost: Record<string, bigint> = { [sbtc]: 1n };
    const alerts = await createMonitor({
      chain: losing(lost),
      read,
      store,
    }).poll();
    expect(only(alerts, "LEDGER_SHORTFALL").details.token).toBe(sbtc);
  });

  it("evaluate: compares each token's reading, and keeps what it was not given", () => {
    const base = {
      thresholds: DEFAULT_THRESHOLDS,
      events: [],
      refusals: [],
      vaults: {},
      burnHeight: 10n,
      blockTimeMs: 0n,
    };
    const even = evaluate({
      ...base,
      state: initialState(),
      ledgers: {
        [sbtc]: { held: 5n, owed: 5n },
        [usd]: { held: 0n, owed: 0n },
      },
    });
    expect(even.alerts).toStrictEqual([]);
    const shortUsd = evaluate({
      ...base,
      state: even.state,
      ledgers: {
        [sbtc]: { held: 5n, owed: 5n },
        [usd]: { held: 2n, owed: 3n },
      },
    });
    expect(codes(shortUsd.alerts)).toStrictEqual(["LEDGER_SHORTFALL"]);
    expect(shortUsd.state.shortTokens).toStrictEqual([usd]);
    // Not read this poll: what was active stays active.
    const unread = evaluate({ ...base, state: shortUsd.state });
    expect(unread.alerts).toStrictEqual([]);
    expect(unread.state.shortTokens).toStrictEqual([usd]);
  });

  it("reads a state file written before shortTokens existed", () => {
    const old = { version: 1, cursor: { events: 2, refusals: 0 }, owners: {} };
    expect(parseState(old).shortTokens).toStrictEqual([]);
    expect(() => parseState({ ...old, shortTokens: [5] })).toThrow();
    expect(() => parseState({ ...old, shortTokens: "x" })).toThrow();
  });
});

describe("cursor and restarts", () => {
  it("raises nothing on a poll with nothing new", async () => {
    await opened();
    swapOk();
    expect(codes(await monitor.poll())).toStrictEqual(["SWAP", FIRST]);
    expect(await monitor.poll()).toStrictEqual([]);
    expect(await monitor.poll()).toStrictEqual([]);
  });

  it("gives every alert a different id across polls", async () => {
    const all: Alert[] = [];
    open();
    all.push(...(await monitor.poll()));
    swapOk();
    swap(SWAP + 1n);
    all.push(...(await monitor.poll()));
    setRate(892n);
    swapOk();
    setOracleAged(MAX_AGE_MS + 1n);
    swap(1n);
    all.push(...(await monitor.poll()));
    expect(all.length).toBeGreaterThan(12);
    expect(new Set(all.map((a) => a.id)).size).toBe(all.length);
  });

  it("a restart from the state file neither repeats nor skips an alert", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "keelio-monitor-")), "s.json");
    const start = () => createMonitor({ chain, read, store: fileStore(path) });

    open();
    swapOk();
    setOracleAged(MAX_AGE_MS + 1n);
    swap(1n);
    const first = await start().poll();
    expect(codes(first)).toContain("SWAP");
    expect(codes(first)).toContain("CALL_REFUSED");
    expect(codes(first)).toContain("ORACLE_STALE");

    // A new process: nothing happened, so nothing is raised, and the stale
    // oracle it already reported is not reported again.
    expect(await start().poll()).toStrictEqual([]);

    setOracleAged(0n);
    swapOk();
    swap(SWAP + 1n);
    vault(alice, "pause");
    const afterRestart = await start().poll();
    expect(afterRestart.map((a) => a.id)).toStrictEqual([
      "event:9:SWAP",
      // 200_000 of the 250_000 cap: the cap came from the saved state.
      "event:9:DAY_CAP_NEAR",
      "event:10:VAULT_PAUSED",
      "refusal:1",
    ]);

    // One monitor that never restarted sees exactly the same alerts.
    const whole = await createMonitor({
      chain,
      read,
      store: memoryStore(),
    }).poll();
    const journalIds = (alerts: Alert[]) =>
      alerts.filter((a) => !a.id.startsWith("level:")).map((a) => a.id);
    expect([...journalIds(first), ...journalIds(afterRestart)].sort()).toEqual(
      journalIds(whole).sort(),
    );

    const saved = JSON.parse(readFileSync(path, "utf8")) as MonitorState;
    expect(saved.cursor).toStrictEqual({ events: 11, refusals: 2 });
    expect(parseState(saved)).toStrictEqual(saved);
  });

  it("repeats the same alerts, with the same ids, when the save failed", async () => {
    open();
    const emitted: string[] = [];
    let fail = true;
    const inner = memoryStore();
    const flaky: StateStore = {
      load: inner.load,
      save(state) {
        if (fail) throw new Error("disk full");
        return inner.save(state);
      },
    };
    const start = () =>
      createMonitor({
        chain,
        read,
        store: flaky,
        emit: (alert) => {
          emitted.push(alert.id);
        },
      });
    await expect(start().poll()).rejects.toThrow("disk full");
    expect(emitted).toHaveLength(8);
    fail = false;
    const again = await start().poll();
    expect(emitted.slice(8)).toStrictEqual(emitted.slice(0, 8));
    expect(again.map((a) => a.id)).toStrictEqual(emitted.slice(0, 8));
    expect(await start().poll()).toStrictEqual([]);
  });

  it("refuses a cursor that is past the chain", async () => {
    await opened();
    const state = await monitor.state();
    const fresh = await initSimnet();
    const other = createMonitor({
      chain: monitorSimnetChain(fresh, deployer),
      read,
      store: memoryStore(state),
    });
    await expect(other.poll()).rejects.toThrow("is past the chain");
  });

  it("refuses a state file that is not a state", () => {
    const path = join(mkdtempSync(join(tmpdir(), "keelio-monitor-")), "s.json");
    expect(fileStore(path).load()).toBeNull();
    writeFileSync(path, JSON.stringify({ version: 2 }));
    expect(() => fileStore(path).load()).toThrow("version 1");
    const good = initialState();
    good.owners[alice] = {
      balances: { [sbtc]: "5" },
      dayCaps: {},
      active: [],
      approvalThresholds: { [sbtc]: "20000" },
      pending: {
        agent: bob,
        adapter: dex,
        tokenIn: sbtc,
        tokenOut: usd,
        amountIn: "50000",
        minOut: "1",
        requestedAt: "3",
        expiresAt: "9",
        expiryReported: false,
      },
    };
    expect(parseState(structuredClone(good))).toStrictEqual(good);
    // A state written before the approval band existed has neither field.
    expect(
      parseState({
        ...good,
        owners: { [alice]: { balances: {}, dayCaps: {}, active: [] } },
      }).owners[alice],
    ).toStrictEqual({
      balances: {},
      dayCaps: {},
      active: [],
      approvalThresholds: {},
      pending: null,
    });
    const owner = good.owners[alice];
    for (const bad of [
      { ...good, cursor: { events: -1, refusals: 0 } },
      { ...good, cursor: { events: 1.5, refusals: 0 } },
      { ...good, owners: { [alice]: { balances: { x: 5 } } } },
      {
        ...good,
        owners: { [alice]: { balances: {}, dayCaps: {}, active: ["SWAP"] } },
      },
      {
        ...good,
        owners: {
          [alice]: { balances: { x: "1.5" }, dayCaps: {}, active: [] },
        },
      },
      { ...good, owners: { [alice]: { ...owner, approvalThresholds: [5] } } },
      {
        ...good,
        owners: { [alice]: { ...owner, approvalThresholds: { [sbtc]: 5 } } },
      },
      { ...good, owners: { [alice]: { ...owner, pending: "x" } } },
      {
        ...good,
        owners: {
          [alice]: { ...owner, pending: { ...owner.pending, expiresAt: 9 } },
        },
      },
      {
        ...good,
        owners: {
          [alice]: { ...owner, pending: { ...owner.pending, agent: null } },
        },
      },
      {
        ...good,
        owners: {
          [alice]: {
            ...owner,
            pending: { ...owner.pending, expiryReported: "no" },
          },
        },
      },
    ]) {
      expect(() => parseState(bad)).toThrow();
    }
  });

  it("tracks who holds a balance, from the journal alone", async () => {
    open(alice);
    open(carol);
    swapOk(SWAP, carol);
    vault(alice, "withdraw", [Cl.principal(sbtc), Cl.uint(DEPOSIT)]);
    await monitor.poll();
    expect(ownersWithBalance(await monitor.state())).toStrictEqual([
      {
        owner: carol,
        balances: { [sbtc]: "900000", [usd]: "90000000" },
      },
    ]);
  });
});

describe("evaluate", () => {
  const base = {
    thresholds: DEFAULT_THRESHOLDS,
    events: [],
    refusals: [],
    vaults: {},
    burnHeight: 10n,
    blockTimeMs: 0n,
  };
  const swapRecord = (amountOut: bigint, floor: bigint, minOut = floor) => ({
    burnHeight: 7n,
    value: Cl.tuple({
      event: Cl.stringAscii("execute-swap"),
      owner: Cl.principal(alice),
      agent: Cl.principal(bob),
      adapter: Cl.principal(dex),
      "token-in": Cl.principal(sbtc),
      "token-out": Cl.principal(usd),
      "amount-in": Cl.uint(10),
      "min-out": Cl.uint(minOut),
      "amount-out": Cl.uint(amountOut),
      "balance-in": Cl.uint(0),
      "balance-out": Cl.uint(amountOut),
      "day-total": Cl.uint(10),
      "oracle-price": Cl.uint(PRICE_90K),
      "oracle-timestamp": Cl.uint(1),
      "min-out-floor": Cl.uint(floor),
    }),
  });

  it("does not change its inputs and returns JSON-safe output", async () => {
    await opened();
    const state = await monitor.state();
    const before = JSON.stringify(state);
    swapOk();
    const result = evaluate({
      ...base,
      state,
      events: (await chain.vaultEvents()).slice(state.cursor.events),
    });
    expect(JSON.stringify(state)).toBe(before);
    expect(result.state.cursor.events).toBe(state.cursor.events + 1);
    expect(JSON.parse(JSON.stringify(result))).toStrictEqual(result);
  });

  // The contract refuses such a swap (u118, u125), so the simnet cannot
  // journal one. The record is written by hand: this is the alert for a
  // broken contract, not for anything a working one does.
  it("SWAP_BELOW_FLOOR: raised for a journalled swap below its floor", () => {
    const { alerts } = evaluate({
      ...base,
      state: initialState(),
      events: [swapRecord(8909n, 8910n)],
    });
    expect(codes(alerts)).toStrictEqual(["SWAP", "SWAP_BELOW_FLOOR"]);
    expect(alerts[1]!.severity).toBe("critical");
    expect(alerts[1]!.details.aboveFloorBps).toBeNull();
  });

  it("SWAP_BELOW_FLOOR: raised for a swap below its own min-out", () => {
    const { alerts } = evaluate({
      ...base,
      state: initialState(),
      events: [swapRecord(8999n, 8910n, 9000n)],
    });
    expect(codes(alerts)).toStrictEqual(["SWAP", "SWAP_BELOW_FLOOR"]);
  });

  it("SWAP_BELOW_FLOOR: not raised at exactly the floor", () => {
    const { alerts } = evaluate({
      ...base,
      state: initialState(),
      events: [swapRecord(8910n, 8910n)],
    });
    expect(codes(alerts)).toStrictEqual(["SWAP", "SWAP_NEAR_FLOOR"]);
  });

  it("UNKNOWN_EVENT: raised for an event name or a shape it does not know", () => {
    const { alerts, state } = evaluate({
      ...base,
      state: initialState(),
      events: [
        {
          burnHeight: 1n,
          value: Cl.tuple({
            event: Cl.stringAscii("sweep"),
            owner: Cl.principal(alice),
          }),
        },
        { burnHeight: 2n, value: Cl.bufferFromHex("00") },
        {
          burnHeight: 3n,
          value: Cl.tuple({
            event: Cl.stringAscii("deposit"),
            owner: Cl.principal(carol),
          }),
        },
      ],
    });
    expect(alerts.map((a) => [a.code, a.owner, a.severity])).toStrictEqual([
      ["UNKNOWN_EVENT", alice, "warning"],
      ["UNKNOWN_EVENT", null, "warning"],
      ["UNKNOWN_EVENT", carol, "warning"],
    ]);
    expect(alerts[2]!.message).toContain("missing field token");
    // An unreadable record is still counted, so it is reported once.
    expect(state.cursor.events).toBe(3);
  });

  it("UNKNOWN_EVENT: not raised by any event the vault prints", async () => {
    open();
    swapOk();
    vault(alice, "pause");
    vault(alice, "unpause");
    vault(alice, "remove-agent");
    vault(alice, "withdraw", [Cl.principal(sbtc), Cl.uint(1)]);
    expect(codes(await monitor.poll())).not.toContain("UNKNOWN_EVENT");
  });

  it("CALL_REFUSED: reports a post-condition abort and an unknown code", () => {
    const refusal = (extra: Partial<RefusedCall>): RefusedCall => ({
      burnHeight: 5n,
      sender: bob,
      functionName: "execute-swap",
      args: [Cl.principal(alice)],
      reason: "response",
      result: Cl.error(Cl.uint(999)),
      txId: "0xab",
      ...extra,
    });
    const { alerts } = evaluate({
      ...base,
      state: initialState(),
      refusals: [
        refusal({}),
        refusal({ reason: "post-condition", result: Cl.ok(Cl.uint(1)) }),
        refusal({ result: Cl.error(Cl.uint(104)) }),
      ],
    });
    expect(
      alerts.map((a) => [a.id, a.severity, a.owner, a.message]),
    ).toStrictEqual([
      [
        "refusal:0",
        "warning",
        alice,
        `execute-swap by ${bob} was refused with (err u999) unknown code`,
      ],
      [
        "refusal:1",
        "warning",
        alice,
        `execute-swap by ${bob} was aborted by a post-condition`,
      ],
      [
        "refusal:2",
        "critical",
        alice,
        `execute-swap by ${bob} was refused with (err u104) ERR-ALLOWANCE-EXCEEDED`,
      ],
    ]);
    expect(alerts[1]!.details).toMatchObject({ errorCode: null, txId: "0xab" });
  });
});

describe("docs/monitoring.md", () => {
  const doc = readFileSync(
    join(import.meta.dirname, "../docs/monitoring.md"),
    "utf8",
  );

  it("lists every alert code with its default severity", () => {
    const listed: Record<string, string> = {};
    for (const row of doc.matchAll(
      /^\| `([A-Z_]+)` +\| (info|warning|critical)\b/gm,
    )) {
      listed[row[1]!] = row[2]!;
    }
    expect(listed).toStrictEqual(ALERT_CODES);
    for (const code of LEVEL_CODES) expect(ALERT_CODES[code]).toBeDefined();
  });

  it("states the default thresholds", () => {
    for (const [name, value] of Object.entries(DEFAULT_THRESHOLDS)) {
      expect(doc).toMatch(new RegExp(`\`${name}\` +\\| ${value}\\b`));
    }
  });

  it("marks the withdrawal plan as a draft with its channels unfilled", () => {
    const plan = doc.slice(
      doc.indexOf("## If a flaw is found: telling owners to withdraw"),
    );
    expect(plan).toContain("DRAFT");
    expect(plan).toContain("[TO FILL]");
  });
});

describe("the runner", () => {
  it("parses its arguments and refuses what it does not know", () => {
    const noDigest = {
      digest: false,
      from: null,
      to: null,
      out: null,
      json: false,
    };
    expect(parseArgs(["--", "--simnet-demo"])).toStrictEqual({
      simnetDemo: true,
      once: false,
      config: null,
      state: null,
      ...noDigest,
    });
    expect(
      parseArgs(["--config", "c.json", "--state", "s.json", "--once"]),
    ).toStrictEqual({
      simnetDemo: false,
      once: true,
      config: "c.json",
      state: "s.json",
      ...noDigest,
    });
    expect(parseArgs(["--simnet-demo", "--digest"])).toMatchObject({
      simnetDemo: true,
      digest: true,
      from: null,
      to: null,
    });
    expect(
      parseArgs([
        "--config",
        "c.json",
        "--digest",
        "--from",
        "100",
        "--to",
        "243",
        "--out",
        "d.txt",
        "--json",
      ]),
    ).toStrictEqual({
      simnetDemo: false,
      once: false,
      config: "c.json",
      state: null,
      digest: true,
      from: 100n,
      to: 243n,
      out: "d.txt",
      json: true,
    });
    for (const bad of [
      [],
      ["--config", "c.json"],
      ["--state"],
      ["--simnet-demo", "--once"],
      ["--testnet"],
      // The digest's options need --digest, and it keeps no state.
      ["--simnet-demo", "--from", "1"],
      ["--config", "c.json", "--state", "s.json", "--out", "d.txt"],
      ["--config", "c.json", "--state", "s.json", "--digest"],
      ["--config", "c.json", "--digest", "--once"],
      ["--digest"],
      ["--simnet-demo", "--digest", "--from", "1.5"],
      ["--simnet-demo", "--digest", "--to"],
      ["--simnet-demo", "--digest", "--from", "9", "--to", "8"],
    ]) {
      expect(() => parseArgs(bad)).toThrow(ConfigError);
    }
  });

  it("parses a config and names the first wrong field", () => {
    const config = {
      apiUrl: "https://api.example",
      sender: alice,
      vault: `${deployer}.keelio-vault`,
      tokens: [sbtc, usd],
      adapters: [dex],
      oracle: `${deployer}.mock-oracle`,
      sbtcToken: sbtc,
      priceScale: "10000000000",
    };
    expect(parseConfig(config)).toStrictEqual({
      apiUrl: "https://api.example",
      sender: alice,
      read: {
        vault: `${deployer}.keelio-vault`,
        tokens: [sbtc, usd],
        adapters: [dex],
        oracle: `${deployer}.mock-oracle`,
        sbtcToken: sbtc,
        priceScale: 10_000_000_000n,
      },
      thresholds: DEFAULT_THRESHOLDS,
      intervalMs: 30_000,
    });
    expect(
      parseConfig({
        ...config,
        intervalSeconds: 5,
        thresholds: { nearFloorBps: "25" },
      }),
    ).toMatchObject({
      intervalMs: 5000,
      thresholds: { ...DEFAULT_THRESHOLDS, nearFloorBps: 25n },
    });
    const bad: [Record<string, unknown>, string][] = [
      [{ apiUrl: "ftp://x" }, "apiUrl"],
      [{ sender: "bob" }, "sender"],
      [{ vault: "keelio-vault" }, "vault"],
      [{ tokens: [] }, "tokens"],
      [{ sbtcToken: dex }, "sbtcToken"],
      // A number could have passed through a float.
      [{ priceScale: 10_000_000_000 }, "priceScale"],
      [{ priceScale: "0" }, "priceScale"],
      [{ thresholds: { nearFloorBps: 25 } }, "thresholds.nearFloorBps"],
      [{ thresholds: { floor: "1" } }, "thresholds.floor"],
      [{ thresholds: { dayCapWarnBps: "10001" } }, "thresholds.dayCapWarnBps"],
      [{ intervalSeconds: 0 }, "intervalSeconds"],
      [{ webhook: "https://x" }, "webhook"],
    ];
    for (const [change, field] of bad) {
      expect(() => parseConfig({ ...config, ...change })).toThrow(field);
    }
    expect(() => parseConfig(null)).toThrow(ConfigError);
    // Names an object inherits are not thresholds, as JSON.parse gives them.
    for (const key of ["toString", "constructor", "__proto__"]) {
      const file = JSON.parse(
        JSON.stringify(config).replace(/}$/, `,"thresholds":{"${key}":"1"}}`),
      ) as unknown;
      expect(() => parseConfig(file)).toThrow(
        `unknown field thresholds.${key}`,
      );
    }
  });

  it("--simnet-demo raises every kind of alert its story reaches", async () => {
    const result = await runMonitorDemo(await initSimnet());
    const all = result.sections.flatMap((s) => s.alerts);
    expect(result.sections).toHaveLength(9);
    expect(new Set(all.map((a) => a.id)).size).toBe(all.length);
    expect(new Set(codes(all))).toStrictEqual(
      new Set<AlertCode>([
        "DEPOSIT",
        "WITHDRAWAL",
        "AGENT_SET",
        "VAULT_PAUSED",
        "POLICY_SET",
        "TOKEN_CAPS_SET",
        "PRICE_BOUNDS_SET",
        "TOKEN_ALLOW_CHANGED",
        "ADAPTER_ALLOW_CHANGED",
        "SWAP",
        "SWAP_NEAR_FLOOR",
        "DAY_CAP_NEAR",
        "APPROVAL_THRESHOLD_SET",
        "SWAP_REQUESTED",
        "SWAP_REQUEST_REJECTED",
        "SWAP_REQUEST_CANCELLED",
        "SWAP_REQUEST_EXPIRED",
        "TRADE_FIRST_IN_DIRECTION",
        "TRADE_BURST",
        "CALL_REFUSED",
        "ORACLE_AGING",
        "ORACLE_STALE",
        "POLICY_EXPIRING",
        "POLICY_EXPIRED",
      ]),
    );
    // Setting the threshold narrows what the agent does alone; clearing it
    // widens that again.
    expect(
      all
        .filter((a) => a.code === "APPROVAL_THRESHOLD_SET")
        .map((a) => [a.severity, a.details.change]),
    ).toStrictEqual([
      ["info", "set"],
      ["warning", "cleared"],
    ]);
    expect(
      all.filter((a) => a.code === "SWAP").map((a) => a.details.approved),
    ).toStrictEqual([false, false, false, false, true]);
    // The three refusals of scripts/demo.ts, the swap the approval band sent
    // to request-swap, then the stale-price one.
    expect(
      all
        .filter((a) => a.code === "CALL_REFUSED")
        .map((a) => a.details.errorName),
    ).toStrictEqual([
      "ERR-TRADE-CAP-EXCEEDED",
      "ERR-INSUFFICIENT-BALANCE",
      "ERR-VAULT-PAUSED",
      "ERR-APPROVAL-REQUIRED",
      "ERR-PRICE-STALE",
    ]);
    // The first owner withdrew everything; the second did not.
    expect(result.owners).toHaveLength(1);
    expect(result.owners[0]!.owner).toBe(accounts.get("wallet_3"));
    // The digest of the same story; tests/monitor-digest.test.ts has the rest.
    const trades = Object.fromEntries(
      result.digest.owners.map((o) => [o.owner, o.trades]),
    );
    expect(trades[accounts.get("wallet_1")!]).toMatchObject({
      count: 2,
      approved: 0,
    });
    expect(trades[accounts.get("wallet_3")!]).toMatchObject({
      count: 3,
      approved: 1,
    });
  });
});
