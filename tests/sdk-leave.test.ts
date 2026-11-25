import { initSimnet } from "@stacks/clarinet-sdk";
import { Cl } from "@stacks/transactions";
import { describe, expect, it } from "vitest";
import {
  buildLeave,
  buildPause,
  buildWithdraw,
  MAX_POST_CONDITION_AMOUNT,
  readVault,
  simnetClient,
  TxBuildError,
  type LeaveStep,
  type TxConfig,
  type VaultConfig,
} from "../packages/sdk/src/index.js";
import { PRICE_SCALE } from "./oracle-fixture.js";
import { vaultHarness } from "./sdk-fixture.js";

const simnet = await initSimnet();
const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const alice = accounts.get("wallet_1")!;
const bob = accounts.get("wallet_2")!;
const carol = accounts.get("wallet_3")!;
const dave = accounts.get("wallet_4")!;
const h = vaultHarness(simnet);
const { vaultId, sbtc, usd, dex } = h;

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

/** A principal's own balance of a token, outside the vault. */
function held(token: "mock-sbtc" | "mock-usd", who: string): bigint {
  const res = simnet.callReadOnlyFn(
    token,
    "get-balance",
    [Cl.principal(who)],
    deployer,
  ).result;
  if (res.type !== "ok" || res.value.type !== "uint") {
    throw new Error("get-balance did not return (ok uint)");
  }
  return BigInt(res.value.value);
}

/** Sends each step in order as `sender`, as a wallet would. */
function run(steps: LeaveStep[], sender: string) {
  return steps.map(
    ({ call }) =>
      simnet.callPublicFn(
        `${call.contractAddress}.${call.contractName}`,
        call.functionName,
        call.functionArgs,
        sender,
      ).result,
  );
}

h.fundDex();

describe("buildLeave", () => {
  it("pauses, then withdraws every token: both ledgers end at zero", async () => {
    const DEPOSIT = 1_000_000n;
    const SOLD = 10_000n;
    h.setUpOwner({
      owner: alice,
      agent: bob,
      deposit: DEPOSIT,
      maxPerTrade: 100_000n,
      maxPerDay: 500_000n,
    });
    // A trade leaves Alice holding both tokens in the vault.
    expect(h.swap(bob, alice, SOLD).result.type).toBe("ok");
    const read = await readVault(client, readConfig, alice);
    expect(read.balances).toStrictEqual({
      [sbtc]: DEPOSIT - SOLD,
      [usd]: SOLD * 900n,
    });
    const before = {
      sbtc: held("mock-sbtc", alice),
      usd: held("mock-usd", alice),
    };

    const steps = buildLeave(config, read);
    expect(steps).toStrictEqual([
      { kind: "pause", call: buildPause(config) },
      {
        kind: "withdraw",
        token: sbtc,
        amount: DEPOSIT - SOLD,
        call: buildWithdraw(config, { token: sbtc, amount: DEPOSIT - SOLD }),
      },
      {
        kind: "withdraw",
        token: usd,
        amount: SOLD * 900n,
        call: buildWithdraw(config, { token: usd, amount: SOLD * 900n }),
      },
    ]);
    // Each withdrawal carries the builder's post-condition: the vault sends
    // exactly the balance of that token, in deny mode.
    expect(
      steps.map((s) => [s.call.postConditionMode, s.call.postConditions]),
    ).toStrictEqual([
      ["deny", []],
      [
        "deny",
        [
          {
            type: "ft-postcondition",
            address: vaultId,
            condition: "eq",
            amount: (DEPOSIT - SOLD).toString(),
            asset: `${sbtc}::mock-sbtc`,
          },
        ],
      ],
      [
        "deny",
        [
          {
            type: "ft-postcondition",
            address: vaultId,
            condition: "eq",
            amount: (SOLD * 900n).toString(),
            asset: `${usd}::mock-usd`,
          },
        ],
      ],
    ]);

    expect(run(steps, alice)).toStrictEqual([
      Cl.ok(Cl.bool(true)),
      Cl.ok(Cl.uint(0)),
      Cl.ok(Cl.uint(0)),
    ]);

    const after = await readVault(client, readConfig, alice);
    expect(after.balances).toStrictEqual({ [sbtc]: 0n, [usd]: 0n });
    expect(after.vault).toStrictEqual({ agent: bob, paused: true });
    // The tokens are back with the owner.
    expect(held("mock-sbtc", alice)).toBe(before.sbtc + DEPOSIT - SOLD);
    expect(held("mock-usd", alice)).toBe(before.usd + SOLD * 900n);
    // The agent is stopped.
    expect(h.swap(bob, alice, 1n).result).toStrictEqual(Cl.error(Cl.uint(109)));
    // Leaving again is the pause alone, and it still succeeds.
    const again = buildLeave(config, after);
    expect(again).toStrictEqual([{ kind: "pause", call: buildPause(config) }]);
    expect(run(again, alice)).toStrictEqual([Cl.ok(Cl.bool(true))]);
  });

  it("builds no withdrawal for a token with a zero balance", async () => {
    h.setUpOwner({
      owner: carol,
      agent: bob,
      deposit: 777n,
      maxPerTrade: 100n,
      maxPerDay: 100n,
    });
    const read = await readVault(client, readConfig, carol);
    expect(read.balances).toStrictEqual({ [sbtc]: 777n, [usd]: 0n });
    const steps = buildLeave(config, read);
    expect(steps.map((s) => s.kind)).toStrictEqual(["pause", "withdraw"]);
    expect(steps[1]).toMatchObject({ token: sbtc, amount: 777n });
    const before = held("mock-sbtc", carol);
    expect(run(steps, carol)).toStrictEqual([
      Cl.ok(Cl.bool(true)),
      Cl.ok(Cl.uint(0)),
    ]);
    expect(held("mock-sbtc", carol)).toBe(before + 777n);
    expect((await readVault(client, readConfig, carol)).balances).toStrictEqual(
      {
        [sbtc]: 0n,
        [usd]: 0n,
      },
    );
  });

  it("is the pause alone for an owner with nothing in the vault", async () => {
    const read = await readVault(client, readConfig, dave);
    expect(read.balances).toStrictEqual({ [sbtc]: 0n, [usd]: 0n });
    const steps = buildLeave(config, read);
    expect(steps).toStrictEqual([{ kind: "pause", call: buildPause(config) }]);
    expect(run(steps, dave)).toStrictEqual([Cl.ok(Cl.bool(true))]);
    expect(buildLeave(config, { balances: {} })).toStrictEqual(steps);
  });

  it("takes out only the caller's own ledger", async () => {
    // Carol's plan sent by Dave: the pause is Dave's own, and the withdrawal
    // is refused, because the ledger it reads is the sender's.
    h.mint("mock-sbtc", 50n, carol);
    h.ok(carol, "deposit", [Cl.principal(sbtc), Cl.uint(50n)]);
    const steps = buildLeave(
      config,
      await readVault(client, readConfig, carol),
    );
    expect(run(steps, dave)).toStrictEqual([
      Cl.ok(Cl.bool(true)),
      Cl.error(Cl.uint(101)),
    ]);
    expect((await readVault(client, readConfig, carol)).balances[sbtc]).toBe(
      50n,
    );
  });

  it("refuses a stale plan without moving anything", async () => {
    // Built from a read, then the balance falls before it is sent.
    const read = await readVault(client, readConfig, carol);
    h.ok(carol, "withdraw", [Cl.principal(sbtc), Cl.uint(1n)]);
    const before = held("mock-sbtc", carol);
    expect(run(buildLeave(config, read), carol)).toStrictEqual([
      Cl.ok(Cl.bool(true)),
      Cl.error(Cl.uint(101)),
    ]);
    expect(held("mock-sbtc", carol)).toBe(before);
    // Built again from a fresh read, it empties the ledger.
    const fresh = buildLeave(
      config,
      await readVault(client, readConfig, carol),
    );
    expect(run(fresh, carol).at(-1)).toStrictEqual(Cl.ok(Cl.uint(0)));
  });

  it("splits a balance no single post-condition can carry", () => {
    const max = MAX_POST_CONDITION_AMOUNT;
    const steps = buildLeave(config, {
      balances: { [sbtc]: max * 2n + 5n, [usd]: max },
    });
    expect(
      steps.map((s) => (s.kind === "withdraw" ? [s.token, s.amount] : s.kind)),
    ).toStrictEqual([
      "pause",
      [sbtc, max],
      [sbtc, max],
      [sbtc, 5n],
      [usd, max],
    ]);
    for (const step of steps.slice(1)) {
      expect(step.call.postConditions).toHaveLength(1);
    }
  });

  it("throws the builders' errors", () => {
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        if (e instanceof TxBuildError) return e.code;
        throw e;
      }
      return null;
    };
    const other = `${deployer}.evil-token`;
    expect(code(() => buildLeave(config, { balances: { [other]: 1n } }))).toBe(
      "UNKNOWN_ASSET",
    );
    // A token the vault config has no name for is fine while it holds nothing.
    expect(
      code(() => buildLeave(config, { balances: { [other]: 0n } })),
    ).toBeNull();
    expect(
      code(() => buildLeave(config, { balances: { "not a token": 1n } })),
    ).toBe("INVALID_PRINCIPAL");
    expect(code(() => buildLeave(config, { balances: { [sbtc]: -1n } }))).toBe(
      "INVALID_AMOUNT",
    );
    expect(
      code(() =>
        buildLeave({ ...config, vault: "keelio-vault" }, { balances: {} }),
      ),
    ).toBe("INVALID_PRINCIPAL");
  });

  it("does not change its inputs", async () => {
    const read = await readVault(client, readConfig, alice);
    const before = structuredClone(read);
    buildLeave(config, read);
    expect(read).toStrictEqual(before);
  });
});
