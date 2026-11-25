// The owner dashboard's logic layer (apps/dashboard), driven in Node on the
// browser build of the simnet, as tests/demo-web.test.ts drives the demo.
// The tests of one session run in order and share its state.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
// The package has a `module` field and no `main` or `exports`, which Node and
// Vite's SSR resolver both skip, so the test imports its entry file by path.
import {
  defaultFileStore,
  init,
  initSimnet,
} from "@stacks/clarinet-sdk-browser/dist/esm/browser/src/index.js";
import { Cl, type PostCondition } from "@stacks/transactions";
import { beforeAll, describe, expect, it } from "vitest";
import type { Receipt } from "../apps/dashboard/src/chain.js";
import {
  fieldHint,
  flowById,
  FLOWS,
  MAX_UINT,
  parseUint,
  prepareCall,
  type FlowId,
  type FormValues,
} from "../apps/dashboard/src/flows.js";
import {
  blocksAsTime,
  blocksWords,
  bpsWords,
  capUseWords,
  compact,
  describeReceipt,
  expiryWords,
  msWords,
  parseErrorTable,
  refusalReason,
} from "../apps/dashboard/src/format.js";
import { journalEntries } from "../apps/dashboard/src/journal.js";
import { vaultPanel, vaultSummary } from "../apps/dashboard/src/panel.js";
import {
  describePostCondition,
  reviewCall,
} from "../apps/dashboard/src/review.js";
import {
  loadProject,
  startSimnetChain,
  type SimulationSession,
} from "../apps/dashboard/src/simnet-chain.js";
import { ERROR_NAMES } from "../apps/demo/src/session.js";
import {
  buildAllowAdapter,
  buildAllowToken,
  buildDeposit,
  buildExecuteSwap,
  buildPause,
  buildSetPolicy,
  buildSetTokenCaps,
  buildWithdraw,
  type VaultCall,
} from "../packages/sdk/src/build-tx.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const errors = parseErrorTable(
  readFileSync(join(root, "docs", "errors.md"), "utf8"),
);

function clarFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return clarFiles(path);
    return entry.name.endsWith(".clar") ? [path] : [];
  });
}

function projectFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  const add = (path: string) => {
    files[relative(root, path).split(sep).join("/")] = readFileSync(
      path,
      "utf8",
    );
  };
  add(join(root, "Clarinet.toml"));
  // The browser build reads the accounts from Devnet.toml, not Simnet.toml.
  add(join(root, "settings", "Devnet.toml"));
  for (const path of clarFiles(join(root, "contracts"))) add(path);
  return files;
}

let session: SimulationSession;
let sbtc: string;
let usd: string;
let dex: string;
let deployer: string;

beforeAll(async () => {
  const wasm = readFileSync(
    fileURLToPath(
      import.meta
        .resolve("@stacks/clarinet-sdk-wasm-browser/clarinet_sdk_bg.wasm"),
    ),
  );
  await init({ module_or_path: wasm });
  loadProject(defaultFileStore, projectFiles());
  session = await startSimnetChain(await initSimnet());
  sbtc = session.config.tokens[0]!.id;
  usd = session.config.tokens[1]!.id;
  dex = session.config.adapters[0]!.id;
  deployer = session.config.tx.vault.split(".")[0]!;
}, 120_000);

/** Fills a form, checks it builds, and submits it as the review step would. */
async function run(id: FlowId, values: FormValues): Promise<Receipt> {
  const prepared = prepareCall(session, id, values);
  if (!prepared.ok) {
    throw new Error(`form ${id} did not build: ${JSON.stringify(prepared)}`);
  }
  return session.submit(prepared.call);
}

const headline = (receipt: Receipt): string =>
  describeReceipt(receipt, errors).headline;

async function journalTexts(): Promise<string[]> {
  return journalEntries(
    await session.journal(),
    session.config,
    session.owner,
  ).map((e) => `${e.event}: ${e.text}`);
}

async function trade(amountIn: bigint, minOut: bigint, sell = true) {
  const outcome = await session.agentSwap({
    tokenIn: sell ? sbtc : usd,
    tokenOut: sell ? usd : sbtc,
    amountIn,
    minOut,
  });
  if (!("receipt" in outcome)) throw new Error("the swap was not sent");
  return outcome;
}

describe("the simulation session at the start", () => {
  it("has an owner, an agent, a funded owner account and an empty vault", async () => {
    expect(session.owner).toMatch(/^ST/);
    expect(session.agent).toMatch(/^ST/);
    expect(session.owner).not.toBe(session.agent);
    expect(session.config.tx.vault).toMatch(/\.keelio-vault$/);
    const read = await session.read();
    expect(read.wallet).toStrictEqual({ [sbtc]: 100_000_000n, [usd]: 0n });
    expect(read.vault.balances).toStrictEqual({ [sbtc]: 0n, [usd]: 0n });
    expect(read.vault.vault).toStrictEqual({ agent: null, paused: false });
    expect(await session.journal()).toStrictEqual([]);
  });
});

describe("owner flows on the simnet, each with its refusal", () => {
  it("deposit: refused above the account's balance, then accepted", async () => {
    const refused = await run("deposit", { token: sbtc, amount: "200000000" });
    expect(refused).toMatchObject({
      status: "refused",
      result: Cl.error(Cl.uint(1)),
    });
    const text = describeReceipt(refused, errors);
    expect(text.kind).toBe("refused");
    expect(text.headline).toBe("Refused by the contract");
    expect(text.returned).toBe("(err u1)");
    expect(text.details[0]).toBe("Nothing changed.");
    expect(text.details[1]).toMatch(/not a keelio-vault code.*token contract/);
    // The simnet reported the refusal as a failed "sends exactly" condition.
    expect(refused.status === "refused" && refused.postCondition).toMatch(
      /^Post-condition check failure.*200000000 SentEq 0$/,
    );
    expect((await session.read()).vault.balances[sbtc]).toBe(0n);
    expect(await session.journal()).toStrictEqual([]);

    const done = await run("deposit", { token: sbtc, amount: "50000000" });
    expect(done).toStrictEqual({
      status: "ok",
      result: Cl.ok(Cl.uint(50_000_000n)),
    });
    expect(describeReceipt(done, errors)).toMatchObject({
      headline: "Done",
      returned: "(ok u50000000)",
    });
    const read = await session.read();
    expect(read.vault.balances[sbtc]).toBe(50_000_000n);
    expect(read.wallet[sbtc]).toBe(50_000_000n);
    expect(await journalTexts()).toStrictEqual([
      "deposit: The owner deposited 50000000 sats of mock sBTC (0.50000000 sBTC). Vault balance after: 50000000 sats of mock sBTC (0.50000000 sBTC).",
    ]);
  });

  it("withdraw: refused above the ledger with u101, then accepted", async () => {
    const refused = await run("withdraw", { token: sbtc, amount: "50000001" });
    expect(headline(refused)).toBe("Refused: more than the vault holds");
    expect((await session.read()).vault.balances[sbtc]).toBe(50_000_000n);

    const done = await run("withdraw", { token: sbtc, amount: "10000000" });
    expect(done).toStrictEqual({
      status: "ok",
      result: Cl.ok(Cl.uint(40_000_000n)),
    });
    const read = await session.read();
    expect(read.vault.balances[sbtc]).toBe(40_000_000n);
    expect(read.wallet[sbtc]).toBe(60_000_000n);
    expect((await journalTexts())[0]).toBe(
      "withdraw: The owner withdrew 10000000 sats of mock sBTC (0.10000000 sBTC). Vault balance after: 40000000 sats of mock sBTC (0.40000000 sBTC).",
    );
  });

  it("set-agent: refuses the owner with u103, then names the agent", async () => {
    const refused = await run("set-agent", { agent: session.owner });
    expect(headline(refused)).toBe("Refused: the agent cannot be the owner");
    expect(describeReceipt(refused, errors)).toMatchObject({
      returned: "(err u103)",
      name: "ERR-AGENT-IS-OWNER",
    });
    expect(describeReceipt(refused, errors).details).toStrictEqual([
      "Nothing changed.",
      "ERR-AGENT-IS-OWNER: set-agent called with the caller's own principal as the agent.",
    ]);
    expect((await session.read()).vault.vault.agent).toBeNull();

    expect((await run("set-agent", { agent: session.agent })).status).toBe(
      "ok",
    );
    expect((await session.read()).vault.vault.agent).toBe(session.agent);
    expect((await journalTexts())[0]).toBe(
      `set-agent: The owner named ${session.agent} (the agent) as the agent. The vault is not paused.`,
    );
  });

  it("set-token-caps: refuses a day cap below the trade cap with u105, then sets both tokens", async () => {
    const refused = await run("set-token-caps", {
      token: sbtc,
      maxPerTrade: "10",
      maxPerDay: "5",
    });
    expect(headline(refused)).toBe(
      "Refused: the day cap is below the trade cap",
    );
    // A token outside the vault's set cannot come from the form's select.
    const unsupported = await session.submit(
      buildSetTokenCaps(session.config.tx, {
        token: `${deployer}.evil-token`,
        maxPerTrade: 1n,
        maxPerDay: 1n,
      }),
    );
    expect(headline(unsupported)).toBe(
      "Refused: this vault does not support that token",
    );

    expect(
      await run("set-token-caps", {
        token: sbtc,
        maxPerTrade: "10000000",
        maxPerDay: "30000000",
      }),
    ).toStrictEqual({ status: "ok", result: Cl.ok(Cl.bool(true)) });
    expect(
      (
        await run("set-token-caps", {
          token: usd,
          maxPerTrade: "10000000000",
          maxPerDay: "30000000000",
        })
      ).status,
    ).toBe("ok");
    expect((await session.read()).vault.policy.caps).toStrictEqual({
      [sbtc]: { maxPerTrade: 10_000_000n, maxPerDay: 30_000_000n },
      [usd]: { maxPerTrade: 10_000_000_000n, maxPerDay: 30_000_000_000n },
    });
    expect((await journalTexts())[1]).toBe(
      "set-token-caps: The owner set the caps for mock sBTC: 10000000 sats of mock sBTC (0.10000000 sBTC) per trade, 30000000 sats of mock sBTC (0.30000000 sBTC) per day (144 burn blocks).",
    );
  });

  it("set-policy: sets the cooldown and expiry (the contract never refuses it)", async () => {
    const { burnHeight } = await session.read();
    const expiresAt = burnHeight + 1000n;
    expect(
      (
        await run("set-policy", {
          cooldownBlocks: "0",
          expiresAt: expiresAt.toString(),
        })
      ).status,
    ).toBe("ok");
    const { policy } = (await session.read()).vault;
    expect(policy.cooldownBlocks).toBe(0n);
    expect(policy.expiresAt).toBe(expiresAt);
    expect((await journalTexts())[0]).toBe(
      `set-policy: The owner set the cooldown to 0 burn blocks (none) and the expiry to burn height ${expiresAt}.`,
    );
  });

  it("set-price-bounds: 10000 bps never reaches the chain, then sets the bounds", async () => {
    const before = (await session.journal()).length;
    const invalid = prepareCall(session, "set-price-bounds", {
      maxSlippageBps: "10000",
      maxPriceAge: "3600000",
    });
    expect(invalid).toStrictEqual({
      ok: false,
      fieldErrors: {
        maxSlippageBps:
          "Enter a whole number from 0 to 9999, digits only: no sign, decimal point or spaces.",
      },
      formError: null,
    });
    expect(errors.get("120")?.name).toBe("ERR-INVALID-PRICE-BOUNDS");

    expect(
      (
        await run("set-price-bounds", {
          maxSlippageBps: "100",
          maxPriceAge: "3600000",
        })
      ).status,
    ).toBe("ok");
    expect((await session.read()).vault.priceBounds).toStrictEqual({
      maxSlippageBps: 100n,
      maxPriceAge: 3_600_000n,
    });
    expect(await session.journal()).toHaveLength(before + 1);
    expect((await journalTexts())[0]).toBe(
      "set-price-bounds: The owner set the price bounds: a swap may settle at most 100 bps (1.00%) below the oracle price, and the price may be at most 3600000 ms (60 minutes) old.",
    );
  });

  it("allow-token: refuses a token outside the vault's set with u106, then allows both", async () => {
    const refused = await session.submit(
      buildAllowToken(session.config.tx, {
        token: `${deployer}.evil-token`,
        allowed: true,
      }),
    );
    expect(headline(refused)).toBe(
      "Refused: this vault does not support that token",
    );
    // The form itself offers only the vault's tokens.
    expect(
      prepareCall(session, "allow-token", {
        token: `${deployer}.evil-token`,
        allowed: "allow",
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { token: "Choose one of the vault's tokens." },
    });

    for (const token of [sbtc, usd]) {
      expect(
        (await run("allow-token", { token, allowed: "allow" })).status,
      ).toBe("ok");
    }
    expect((await session.read()).vault.policy.allowedTokens).toStrictEqual([
      sbtc,
      usd,
    ]);
    expect((await journalTexts())[0]).toBe(
      "allow-token: The owner allowed mock USD for swaps.",
    );
  });

  it("allow-adapter: refuses another contract with u107, then allows mock-dex", async () => {
    const refused = await session.submit(
      buildAllowAdapter(session.config.tx, {
        adapter: `${deployer}.vault-caller`,
        allowed: true,
      }),
    );
    expect(headline(refused)).toBe(
      "Refused: this vault does not support that adapter",
    );
    expect(
      (await run("allow-adapter", { adapter: dex, allowed: "allow" })).status,
    ).toBe("ok");
    expect((await session.read()).vault.policy.allowedAdapters).toStrictEqual([
      dex,
    ]);
    expect((await journalTexts())[0]).toBe(
      "allow-adapter: The owner allowed the adapter mock-dex.",
    );
  });
});

describe("the simulated agent", () => {
  it("trades inside the policy, and the journal shows it first", async () => {
    const outcome = await trade(10_000_000n, 9_000_000_000n);
    expect(outcome.check).toStrictEqual({ ok: true });
    expect(outcome.receipt).toStrictEqual({
      status: "ok",
      result: Cl.ok(Cl.uint(9_000_000_000n)),
    });
    const read = await session.read();
    expect(read.vault.balances).toStrictEqual({
      [sbtc]: 30_000_000n,
      [usd]: 9_000_000_000n,
    });
    // Nothing passed through the agent or the owner's own account.
    expect(read.wallet).toStrictEqual({ [sbtc]: 60_000_000n, [usd]: 0n });
    expect((await journalTexts())[0]).toBe(
      "execute-swap: The agent sold 10000000 sats of mock sBTC (0.10000000 sBTC)" +
        " for 9000000000 base units of mock USD (9000.000000 USD) on mock-dex." +
        " The least it would accept was 9000000000 base units of mock USD (9000.000000 USD)." +
        " Vault balances after: 30000000 sats of mock sBTC (0.30000000 sBTC) and 9000000000 base units of mock USD (9000.000000 USD)." +
        " Sold in this day window: 10000000 sats of mock sBTC (0.10000000 sBTC).",
    );
    const sbtcCard = vaultPanel(read, session.config, session.owner)[1]!;
    expect(sbtcCard.title).toBe("mock sBTC");
    expect(sbtcCard.facts).toContainEqual([
      "Day window (last 144 burn blocks)",
      "10000000 of 30000000 sats used (33%), 20000000 left (0.20000000 sBTC)",
    ]);
    // The headline figures are the same read, as numbers.
    const summary = vaultSummary(read, session.config);
    expect(summary).toMatchObject({ paused: false, blocksLeft: 1000n });
    expect(summary.tokens[0]).toMatchObject({
      inVault: 30_000_000n,
      dayUsed: 10_000_000n,
      dayLeft: 20_000_000n,
      dayPercent: 33,
      allowed: true,
    });
    const token = summary.tokens[0]!.token;
    expect(compact(token, 30_000_000n)).toBe("0.30");
    expect(compact(token, 12_345_678n)).toBe("0.12345678");
    expect(compact(token, 0n)).toBe("0.00");
  });

  it("is refused above the per-trade cap with u114, as checkIntent said", async () => {
    const before = (await session.journal()).length;
    const outcome = await trade(10_000_001n, 0n);
    expect(outcome.check).toMatchObject({ ok: false, errorCode: 114 });
    expect(headline(outcome.receipt)).toBe("Refused: over the per-trade cap");
    // The agent console adds the owner's own numbers to that refusal.
    const read = await session.read();
    const ask = { tokenIn: sbtc, amountIn: 10_000_001n };
    expect(refusalReason(114n, ask, read, session.config)).toBe(
      "The agent asked to sell 0.10000001 sBTC. Your cap is 0.10 sBTC per trade.",
    );
    expect(refusalReason(109n, ask, read, session.config)).toBe(
      "You paused the vault. Unpause it to let the agent trade again.",
    );
    expect(refusalReason(125n, ask, read, session.config)).toBeNull();
    expect(await session.journal()).toHaveLength(before);
  });

  it("is refused below the oracle floor with u125", async () => {
    const outcome = await trade(10_000_000n, 8_909_999_999n);
    expect(headline(outcome.receipt)).toBe(
      "Refused: the minimum out is below the oracle floor",
    );
  });

  it("buys sBTC back with USD", async () => {
    const outcome = await trade(4_500_000_000n, 4_950_000n, false);
    expect(outcome.receipt).toStrictEqual({
      status: "ok",
      result: Cl.ok(Cl.uint(5_000_000n)),
    });
    expect((await session.read()).vault.balances).toStrictEqual({
      [sbtc]: 35_000_000n,
      [usd]: 4_500_000_000n,
    });
  });

  it("reports a builder refusal instead of sending", async () => {
    const outcome = await session.agentSwap({
      tokenIn: sbtc,
      tokenOut: usd,
      amountIn: 0n,
      minOut: 0n,
    });
    expect(outcome.check).toMatchObject({ ok: false, rule: "ZERO_AMOUNT" });
    expect(outcome).toHaveProperty("buildError");
    expect(outcome).not.toHaveProperty("receipt");
  });
});

describe("the kill switch and the agent's removal", () => {
  it("pause: stops the agent with u109 and leaves withdrawals working", async () => {
    expect((await run("pause", {})).status).toBe("ok");
    expect((await session.read()).vault.vault.paused).toBe(true);
    expect((await journalTexts())[0]).toBe(
      "pause: The owner paused the vault. The agent cannot trade; withdrawals still work.",
    );

    const outcome = await trade(1_000_000n, 900_000_000n);
    expect(outcome.check).toMatchObject({ ok: false, errorCode: 109 });
    expect(headline(outcome.receipt)).toBe("Refused: the vault is paused");
    expect(
      (await run("withdraw", { token: sbtc, amount: "5000000" })).status,
    ).toBe("ok");
  });

  it("unpause: lets the agent trade again", async () => {
    expect((await run("unpause", {})).status).toBe("ok");
    expect((await session.read()).vault.vault.paused).toBe(false);
    expect((await trade(1_000_000n, 900_000_000n)).receipt.status).toBe("ok");
  });

  it("remove-agent: the old agent is refused with u108", async () => {
    expect((await run("remove-agent", {})).status).toBe("ok");
    expect((await session.read()).vault.vault.agent).toBeNull();
    expect((await journalTexts())[0]).toBe(
      "remove-agent: The owner removed the agent. No one can trade for this vault. The vault is not paused.",
    );
    const outcome = await trade(1_000_000n, 900_000_000n);
    expect(headline(outcome.receipt)).toBe(
      "Refused: the caller is not the named agent",
    );
    expect((await run("set-agent", { agent: session.agent })).status).toBe(
      "ok",
    );
  });
});

describe("post-conditions on the simnet", () => {
  it("abort a call that moves more than its post-condition allows", async () => {
    const before = await session.read();
    const records = (await session.journal()).length;
    const honest = buildDeposit(session.config.tx, {
      owner: session.owner,
      token: sbtc,
      amount: 100n,
    });
    // The call deposits 100, but its condition says the owner sends exactly 1.
    const condition = honest.postConditions[0]!;
    if (condition.type !== "ft-postcondition") throw new Error("not ft");
    const tampered: VaultCall = {
      ...honest,
      postConditions: [{ ...condition, amount: "1" }],
    };
    const receipt = await session.submit(tampered);
    expect(receipt.status).toBe("aborted");
    const text = describeReceipt(receipt, errors);
    expect(text.headline).toBe("Rolled back by a post-condition");
    expect(text.details[0]).toBe(
      "The transaction was rolled back and nothing changed.",
    );
    expect(text.details[1]).toMatch(/^Post-condition check failure/);
    const after = await session.read();
    expect(after.vault.balances).toStrictEqual(before.vault.balances);
    expect(after.wallet).toStrictEqual(before.wallet);
    expect(await session.journal()).toHaveLength(records);
  });

  it("abort a withdrawal sent with no post-condition, in Deny mode", async () => {
    const before = (await session.read()).vault.balances;
    const call = buildWithdraw(session.config.tx, { token: sbtc, amount: 1n });
    const receipt = await session.submit({ ...call, postConditions: [] });
    expect(receipt.status).toBe("aborted");
    expect((await session.read()).vault.balances).toStrictEqual(before);
  });
});

describe("the simnet's clock", () => {
  it("ages the oracle price until the agent is refused with u123, and a new price fixes it", async () => {
    const start = (await session.read()).burnHeight;
    expect(await session.advanceBurnBlocks(10)).toBe(start + 10n);
    const read = await session.read();
    expect(read.burnHeight).toBe(start + 10n);
    const oracleFact = vaultPanel(
      read,
      session.config,
      session.owner,
    )[0]!.facts.find(([name]) => name === "Oracle price")!;
    expect(oracleFact[1]).toMatch(/too old, the agent may not trade$/);

    const stale = await trade(1_000_000n, 900_000_000n);
    expect(stale.check).toMatchObject({ ok: false, errorCode: 123 });
    expect(headline(stale.receipt)).toBe(
      "Refused: the oracle price is too old",
    );

    expect((await session.setOraclePrice(9_000_000_000_000n)).status).toBe(
      "ok",
    );
    expect((await trade(1_000_000n, 900_000_000n)).receipt.status).toBe("ok");
  });

  it("passes the policy's expiry, and the agent is refused with u110", async () => {
    const { burnHeight } = await session.read();
    expect(
      (
        await run("set-policy", {
          cooldownBlocks: "0",
          expiresAt: burnHeight.toString(),
        })
      ).status,
    ).toBe("ok");
    await session.advanceBurnBlocks(1);
    const read = await session.read();
    expect(
      vaultPanel(read, session.config, session.owner)[0]!.facts,
    ).toContainEqual([
      "Policy expires",
      `burn height ${burnHeight}: expired 1 burn block ago, the agent may not trade`,
    ]);
    const outcome = await trade(1_000_000n, 0n);
    expect(headline(outcome.receipt)).toBe("Refused: the policy has expired");
  });

  it("refuses a block count that is not a whole number above zero", async () => {
    await expect(session.advanceBurnBlocks(0)).rejects.toThrow(RangeError);
    await expect(session.advanceBurnBlocks(1.5)).rejects.toThrow(RangeError);
  });
});

describe("the example setup", () => {
  it("sends its nine owner calls, all ok, and the agent can then trade", async () => {
    const before = (await session.journal()).length;
    const steps = await session.runExampleSetup();
    expect(steps.map((s) => s.call.functionName)).toStrictEqual([
      "deposit",
      "set-agent",
      "set-token-caps",
      "set-token-caps",
      "set-policy",
      "allow-token",
      "allow-token",
      "allow-adapter",
      "set-price-bounds",
    ]);
    expect(steps.map((s) => s.receipt.status)).toStrictEqual(
      Array.from({ length: 9 }, () => "ok"),
    );
    expect(await session.journal()).toHaveLength(before + 9);
    await session.setOraclePrice(9_000_000_000_000n);
    expect((await trade(1_000_000n, 900_000_000n)).receipt.status).toBe("ok");
  });
});

describe("input validation", () => {
  it("parseUint refuses anything but whole numbers in range", () => {
    for (const text of ["", "1.5", "-1", "1e3", " ", "0x10", "+1", "1 2"]) {
      expect(parseUint(text, 0n, MAX_UINT), JSON.stringify(text)).toBeNull();
    }
    expect(parseUint("0", 1n, MAX_UINT)).toBeNull();
    expect(parseUint((MAX_UINT + 1n).toString(), 0n, MAX_UINT)).toBeNull();
    expect(parseUint(" 42 ", 0n, MAX_UINT)).toBe(42n);
    expect(parseUint(MAX_UINT.toString(), 0n, MAX_UINT)).toBe(MAX_UINT);
  });

  it("never builds a call from an invalid amount", () => {
    for (const amount of [
      "",
      "0",
      "-5",
      "1.5",
      "1e3",
      "18446744073709551616",
    ]) {
      const prepared = prepareCall(session, "deposit", { token: sbtc, amount });
      expect(prepared, JSON.stringify(amount)).toStrictEqual({
        ok: false,
        fieldErrors: {
          amount:
            "Enter a whole number from 1 to 2^64 - 1, digits only: no sign, decimal point or spaces.",
        },
        formError: null,
      });
    }
  });

  it("marks every invalid field of a form", () => {
    const prepared = prepareCall(session, "set-token-caps", {
      token: "",
      maxPerTrade: "1.0",
      maxPerDay: "-1",
    });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) throw new Error("unreachable");
    expect(Object.keys(prepared.fieldErrors)).toStrictEqual([
      "token",
      "maxPerTrade",
      "maxPerDay",
    ]);
  });

  it("refuses an agent that is not a Stacks address", () => {
    for (const agent of ["", "not-an-address", "ST123", `${session.agent}x`]) {
      const prepared = prepareCall(session, "set-agent", { agent });
      expect(prepared, agent).toMatchObject({ ok: false });
      if (prepared.ok) throw new Error("unreachable");
      expect(prepared.fieldErrors.agent).toMatch(/^Enter a/);
    }
  });

  it("builds every flow's call with the SDK, to the vault, in Deny mode", () => {
    const values: Record<FlowId, FormValues> = {
      deposit: { token: sbtc, amount: "1" },
      withdraw: { token: sbtc, amount: "1" },
      "set-agent": { agent: session.agent },
      "remove-agent": {},
      pause: {},
      unpause: {},
      "set-policy": { cooldownBlocks: "6", expiresAt: "500" },
      "set-token-caps": { token: usd, maxPerTrade: "1", maxPerDay: "2" },
      "set-price-bounds": { maxSlippageBps: "50", maxPriceAge: "60000" },
      "set-approval-threshold": { token: usd, threshold: "5" },
      "allow-token": { token: usd, allowed: "revoke" },
      "allow-adapter": { adapter: dex, allowed: "revoke" },
    };
    expect(FLOWS.map((f) => f.id).sort()).toStrictEqual(
      Object.keys(values).sort(),
    );
    for (const flow of FLOWS) {
      const prepared = prepareCall(session, flow.id, values[flow.id]);
      if (!prepared.ok) throw new Error(`${flow.id} did not build`);
      expect(prepared.call.functionName).toBe(flow.id);
      expect(
        `${prepared.call.contractAddress}.${prepared.call.contractName}`,
      ).toBe(session.config.tx.vault);
      expect(prepared.call.postConditionMode).toBe("deny");
    }
  });

  it("says what a field's text means, or nothing when it is invalid", () => {
    const hint = (id: FlowId, name: string, values: FormValues) =>
      fieldHint(
        flowById(id).fields.find((f) => f.name === name)!,
        values,
        session.config,
        100n,
      );
    expect(hint("deposit", "amount", { token: sbtc, amount: "50000000" })).toBe(
      "= 0.50000000 sBTC",
    );
    expect(hint("deposit", "amount", { token: usd, amount: "1500000" })).toBe(
      "= 1.500000 USD",
    );
    expect(hint("deposit", "amount", { token: sbtc, amount: "0.5" })).toBe("");
    expect(hint("set-policy", "expiresAt", { expiresAt: "244" })).toBe(
      "= burn height 244: 144 burn blocks from now (about 1 day)",
    );
    expect(
      hint("set-price-bounds", "maxSlippageBps", { maxSlippageBps: "0" }),
    ).toBe("= 0: the agent may not trade");
  });
});

describe("the review step, from the SDK builders' real output", () => {
  const review = (call: VaultCall) => reviewCall(call, session.config, 100n);

  it("deposit: the owner sends exactly the amount", () => {
    const call = buildDeposit(session.config.tx, {
      owner: session.owner,
      token: sbtc,
      amount: 50_000_000n,
    });
    expect(review(call)).toStrictEqual({
      contract: session.config.tx.vault,
      functionName: "deposit",
      args: [
        { name: "token", value: `'${sbtc}`, meaning: "mock sBTC" },
        {
          name: "amount",
          value: "u50000000",
          meaning: "50000000 sats of mock sBTC (0.50000000 sBTC)",
        },
      ],
      postConditions: [
        {
          text: "The owner sends exactly 50000000 sats of mock sBTC (0.50000000 sBTC).",
          raw: JSON.stringify(call.postConditions[0]),
        },
      ],
      mode: "Deny mode: any token transfer these lines do not cover rolls the whole transaction back.",
    });
    expect(JSON.parse(review(call).postConditions[0]!.raw)).toStrictEqual({
      type: "ft-postcondition",
      address: session.owner,
      condition: "eq",
      amount: "50000000",
      asset: `${sbtc}::mock-sbtc`,
    });
  });

  it("withdraw: the vault sends exactly the amount", () => {
    const call = buildWithdraw(session.config.tx, {
      token: usd,
      amount: 1_500_000n,
    });
    expect(review(call).postConditions.map((pc) => pc.text)).toStrictEqual([
      "The vault sends exactly 1500000 base units of mock USD (1.500000 USD).",
    ]);
  });

  it("execute-swap on mock-dex: the vault at most, the adapter at least", () => {
    const call = buildExecuteSwap(session.config.tx, {
      owner: session.owner,
      adapter: dex,
      tokenIn: sbtc,
      tokenOut: usd,
      amountIn: 10_000_000n,
      minOut: 8_910_000_000n,
    });
    const text = review(call);
    expect(text.postConditions.map((pc) => pc.text)).toStrictEqual([
      "The vault sends at most 10000000 sats of mock sBTC (0.10000000 sBTC).",
      "mock-dex sends at least 8910000000 base units of mock USD (8910.000000 USD).",
    ]);
    expect(text.args.map((a) => [a.name, a.meaning])).toStrictEqual([
      ["owner", "the owner"],
      ["adapter", "mock-dex"],
      ["token-in", "mock sBTC"],
      ["token-out", "mock USD"],
      ["amount-in", "10000000 sats of mock sBTC (0.10000000 sBTC)"],
      ["min-out", "8910000000 base units of mock USD (8910.000000 USD)"],
    ]);
  });

  it("execute-swap through a pool: all four lines, an unnamed principal in full", () => {
    const pool = `${deployer}.some-pool`;
    const call = buildExecuteSwap(
      { ...session.config.tx, adapters: { [dex]: { pool } } },
      {
        owner: session.owner,
        adapter: dex,
        tokenIn: usd,
        tokenOut: sbtc,
        amountIn: 9_000_000n,
        minOut: 9_900n,
      },
    );
    expect(review(call).postConditions.map((pc) => pc.text)).toStrictEqual([
      "The vault sends at most 9000000 base units of mock USD (9.000000 USD).",
      "mock-dex sends at most 9000000 base units of mock USD (9.000000 USD).",
      `${pool} sends at least 9900 sats of mock sBTC (0.00009900 sBTC).`,
      "mock-dex sends at least 9900 sats of mock sBTC (0.00009900 sBTC).",
    ]);
  });

  it("a call with no post-conditions may move nothing", () => {
    const text = review(buildPause(session.config.tx));
    expect(text.args).toStrictEqual([]);
    expect(text.postConditions).toStrictEqual([]);
    expect(text.mode).toBe(
      "Deny mode with no post-conditions: this call may not move any token. If it tried to, the whole transaction would be rolled back.",
    );
  });

  it("set-policy and set-token-caps: arguments in words", () => {
    expect(
      review(
        buildSetPolicy(session.config.tx, {
          cooldownBlocks: 6n,
          expiresAt: 1100n,
        }),
      ).args,
    ).toStrictEqual([
      {
        name: "cooldown-blocks",
        value: "u6",
        meaning: "6 burn blocks (about 1 hour)",
      },
      {
        name: "expires-at",
        value: "u1100",
        meaning:
          "burn height 1100: 1000 burn blocks from now (about 6 days 22 hours)",
      },
    ]);
    expect(
      review(
        buildSetTokenCaps(session.config.tx, {
          token: usd,
          maxPerTrade: 1_000_000n,
          maxPerDay: 2_000_000n,
        }),
      ).args.map((a) => a.meaning),
    ).toStrictEqual([
      "mock USD",
      "1000000 base units of mock USD (1.000000 USD)",
      "2000000 base units of mock USD (2.000000 USD)",
    ]);
  });

  it("prints a post-condition it does not know instead of dropping it", () => {
    const stx: PostCondition = {
      type: "stx-postcondition",
      address: session.owner,
      condition: "eq",
      amount: "5",
    };
    expect(describePostCondition(stx, session.config)).toBe(
      `Unrecognised post-condition: ${JSON.stringify(stx)}`,
    );
  });
});

describe("the journal", () => {
  it("is newest first and holds only this owner's events", () => {
    const event = (owner: string, amount: bigint) => ({
      burnHeight: amount,
      value: Cl.tuple({
        event: Cl.stringAscii("deposit"),
        owner: Cl.principal(owner),
        token: Cl.principal(sbtc),
        amount: Cl.uint(amount),
        balance: Cl.uint(amount),
      }),
    });
    const entries = journalEntries(
      [
        event(session.owner, 1n),
        event(session.agent, 2n),
        event(session.owner, 3n),
      ],
      session.config,
      session.owner,
    );
    expect(entries.map((e) => e.burnHeight)).toStrictEqual([3n, 1n]);
    expect(entries[0]!.event).toBe("deposit");
  });

  it("prints an event it does not know as Clarity", () => {
    const [entry] = journalEntries(
      [
        {
          burnHeight: 7n,
          value: Cl.tuple({
            event: Cl.stringAscii("new-event"),
            owner: Cl.principal(session.owner),
          }),
        },
      ],
      session.config,
      session.owner,
    );
    expect(entry!.event).toBe("new-event");
    expect(entry!.text).toContain("new-event");
  });

  it("prints an unknown event with no owner field as Clarity", () => {
    const [entry] = journalEntries(
      [
        {
          burnHeight: 8n,
          value: Cl.tuple({
            event: Cl.stringAscii("ownerless"),
            height: Cl.uint(8),
          }),
        },
      ],
      session.config,
      session.owner,
    );
    expect(entry!.event).toBe("ownerless");
    expect(entry!.text).toContain("ownerless");
  });
});

describe("words for numbers", () => {
  it("turns burn blocks into rough time with integer maths", () => {
    expect(blocksAsTime(1n)).toBe("about 10 minutes");
    expect(blocksAsTime(6n)).toBe("about 1 hour");
    expect(blocksAsTime(7n)).toBe("about 1 hour 10 minutes");
    expect(blocksAsTime(144n)).toBe("about 1 day");
    expect(blocksAsTime(1000n)).toBe("about 6 days 22 hours");
    expect(blocksWords(0n)).toBe("0 burn blocks (none)");
    expect(blocksWords(1n)).toBe("1 burn block (about 10 minutes)");
  });

  it("prints basis points and milliseconds", () => {
    expect(bpsWords(100n)).toBe("100 bps (1.00%)");
    expect(bpsWords(9999n)).toBe("9999 bps (99.99%)");
    expect(msWords(3_600_000n)).toBe("3600000 ms (60 minutes)");
    expect(msWords(1500n)).toBe("1500 ms (1.500 s)");
    expect(msWords(0n)).toBe("0 ms (0.000 s)");
  });

  it("places an expiry against the burn height", () => {
    expect(expiryWords(0n, 5n)).toBe(
      "not set (burn height 0): the agent may not trade",
    );
    expect(expiryWords(5n, 5n)).toBe(
      "burn height 5: this is the last block the agent may trade in",
    );
    expect(expiryWords(4n, 6n)).toBe(
      "burn height 4: expired 2 burn blocks ago, the agent may not trade",
    );
  });

  it("says how much of a day cap is used", () => {
    const token = session.config.tokens[0]!;
    expect(capUseWords(token, 0n, 0n)).toBe(
      "no cap set: the agent may not sell mock sBTC",
    );
    expect(capUseWords(token, 30n, 30n)).toBe(
      "30 of 30 sats used (100%), 0 left (0.00000000 sBTC)",
    );
  });
});

describe("the error table", () => {
  it("is every keelio-vault row of docs/errors.md, with the demo's names", () => {
    expect(errors.size).toBe(34);
    expect(
      Object.fromEntries([...errors].map(([code, e]) => [code, e.name])),
    ).toStrictEqual(ERROR_NAMES);
    expect(errors.get("109")).toStrictEqual({
      code: "109",
      name: "ERR-VAULT-PAUSED",
      meaning: "execute-swap called while the owner's vault is paused",
      plain: "The vault is paused",
    });
    for (const error of errors.values()) {
      expect(error.plain, `u${error.code}`).not.toBe("");
    }
  });

  it("prints a code outside the table without a name", () => {
    expect(
      describeReceipt(
        { status: "refused", result: Cl.error(Cl.uint(999)) },
        errors,
      ),
    ).toStrictEqual({
      kind: "refused",
      headline: "Refused by the contract",
      returned: "(err u999)",
      details: [
        "Nothing changed.",
        "u999 is not a keelio-vault code. It came from a contract the vault called.",
      ],
    });
  });
});

describe("loadProject", () => {
  it("writes each file under /project", () => {
    const store = new Map<string, string>();
    loadProject(store, { "Clarinet.toml": "manifest" });
    expect([...store.entries()]).toStrictEqual([
      ["/project/Clarinet.toml", "manifest"],
    ]);
  });
});
