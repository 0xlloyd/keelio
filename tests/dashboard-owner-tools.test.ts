// The owner dashboard's tools beyond the single-call forms (apps/dashboard):
// the approval band, an agent's history, the accountability record and
// leaving in one action. As in tests/dashboard.test.ts, the simulation's
// chain session is driven in Node on the browser build of the simnet, against
// the real contract. The tests run in order and share the session's state.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultFileStore,
  init,
  initSimnet,
} from "@stacks/clarinet-sdk-browser/dist/esm/browser/src/index.js";
import { Cl } from "@stacks/transactions";
import { beforeAll, describe, expect, it } from "vitest";
import { accountabilityView } from "../apps/dashboard/src/accountability.js";
import {
  agentHistoryView,
  HISTORY_CAUTION,
  isPrincipal,
  NO_HISTORY,
  scopeWords,
} from "../apps/dashboard/src/agent-history.js";
import {
  approvalDecision,
  approveCall,
  pendingView,
  rejectCall,
  samePending,
  termsOf,
} from "../apps/dashboard/src/approval.js";
import type {
  ChainSession,
  JournalRecord,
  Receipt,
} from "../apps/dashboard/src/chain.js";
import {
  fieldHint,
  flowById,
  prepareCall,
  type FlowId,
  type FormValues,
} from "../apps/dashboard/src/flows.js";
import {
  describeReceipt,
  parseErrorTable,
} from "../apps/dashboard/src/format.js";
import { journalEntries, TRADE_EVENTS } from "../apps/dashboard/src/journal.js";
import {
  leavePlan,
  runLeave,
  type LeaveStepState,
} from "../apps/dashboard/src/leave.js";
import { vaultPanel, vaultSummary } from "../apps/dashboard/src/panel.js";
import { reviewCall } from "../apps/dashboard/src/review.js";
import {
  loadProject,
  ORACLE_PRICE,
  startSimnetChain,
  type SimulationSession,
} from "../apps/dashboard/src/simnet-chain.js";
import {
  buildSetApprovalThreshold,
  buildWithdraw,
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
  add(join(root, "settings", "Devnet.toml"));
  for (const path of clarFiles(join(root, "contracts"))) add(path);
  return files;
}

let session: SimulationSession;
let sbtc: string;
let usd: string;
let dex: string;

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
  // 0.5 sBTC in the vault, caps of 0.1 a trade and 0.3 a day, 1% slippage.
  const steps = await session.runExampleSetup();
  expect(steps.every((s) => s.receipt.status === "ok")).toBe(true);
}, 120_000);

async function run(id: FlowId, values: FormValues): Promise<Receipt> {
  const prepared = prepareCall(session, id, values);
  if (!prepared.ok) {
    throw new Error(`form ${id} did not build: ${JSON.stringify(prepared)}`);
  }
  return session.submit(prepared.call);
}

const headline = (receipt: Receipt): string =>
  describeReceipt(receipt, errors).headline;

async function newest(): Promise<string> {
  const entry = journalEntries(
    await session.journal(),
    session.config,
    session.owner,
  )[0]!;
  return `${entry.event}: ${entry.text}`;
}

const view = async () =>
  pendingView(await session.read(), session.config, errors);

/** The agent asks to sell 0.1 sBTC for at least 9000 USD. */
async function request(amountIn = 10_000_000n, minOut = 9_000_000_000n) {
  const outcome = await session.agentRequest({
    tokenIn: sbtc,
    tokenOut: usd,
    amountIn,
    minOut,
  });
  if (!("receipt" in outcome)) throw new Error("the request was not sent");
  return outcome;
}

describe("the approval threshold flow", () => {
  it("shows none before any is set", async () => {
    const read = await session.read();
    expect(read.vault.approvalThresholds).toStrictEqual({
      [sbtc]: null,
      [usd]: null,
    });
    const card = vaultPanel(read, session.config, session.owner)[1]!;
    expect(card.facts).toContainEqual([
      "Approval threshold",
      "none: the agent trades alone up to the per-trade cap",
    ]);
    expect(
      vaultSummary(read, session.config).tokens[0]!.approvalThreshold,
    ).toBeNull();
    expect(pendingView(read, session.config, errors)).toBeNull();
  });

  it("never builds a call from an invalid amount", () => {
    for (const threshold of ["1.5", "-1", "1e3", "abc"]) {
      const prepared = prepareCall(session, "set-approval-threshold", {
        token: sbtc,
        threshold,
      });
      expect(prepared, threshold).toStrictEqual({
        ok: false,
        fieldErrors: {
          threshold:
            "Enter a whole number from 0 to 2^128 - 1, digits only: no sign, decimal point or spaces. Leave it empty for none.",
        },
        formError: null,
      });
    }
    expect(
      prepareCall(session, "set-approval-threshold", {
        token: "not-a-token",
        threshold: "5",
      }),
    ).toMatchObject({ ok: false, fieldErrors: { token: expect.any(String) } });
  });

  it("says what the field's text means", () => {
    const field = flowById("set-approval-threshold").fields[1]!;
    const hint = (threshold: string) =>
      fieldHint(field, { token: sbtc, threshold }, session.config, 0n);
    expect(hint("")).toBe(
      "= none: the agent trades alone up to the per-trade cap",
    );
    expect(hint("0")).toBe(
      "= 0: every trade selling mock sBTC needs your approval",
    );
    expect(hint("5000000")).toBe(
      "= a trade selling more than 5000000 sats of mock sBTC (0.05000000 sBTC) needs your approval",
    );
    expect(hint("0.05")).toBe("");
  });

  it("is refused for a token outside the vault's set with u106", async () => {
    const call = buildSetApprovalThreshold(session.config.tx, {
      token: dex,
      threshold: 1n,
    });
    expect(headline(await session.submit(call))).toBe(
      "Refused: this vault does not support that token",
    );
  });

  it("reviews as a call that moves nothing, then sets the threshold", async () => {
    const prepared = prepareCall(session, "set-approval-threshold", {
      token: sbtc,
      threshold: "5000000",
    });
    if (!prepared.ok) throw new Error("did not build");
    const review = reviewCall(prepared.call, session.config, 0n);
    expect(review.functionName).toBe("set-approval-threshold");
    expect(review.args).toStrictEqual([
      { name: "token", value: `'${sbtc}`, meaning: "mock sBTC" },
      {
        name: "threshold",
        value: "(some u5000000)",
        meaning:
          "a trade selling more than 5000000 sats of mock sBTC (0.05000000 sBTC) needs your approval",
      },
    ]);
    expect(review.postConditions).toStrictEqual([]);
    expect(review.mode).toMatch(/^Deny mode with no post-conditions/);

    expect(await session.submit(prepared.call)).toStrictEqual({
      status: "ok",
      result: Cl.ok(Cl.bool(true)),
    });
    const read = await session.read();
    expect(read.vault.approvalThresholds[sbtc]).toBe(5_000_000n);
    expect(
      vaultPanel(read, session.config, session.owner)[1]!.facts,
    ).toContainEqual([
      "Approval threshold",
      "a trade selling more than 5000000 sats of mock sBTC (0.05000000 sBTC) needs your approval",
    ]);
    expect(await newest()).toBe(
      "set-approval-threshold: The owner set the approval threshold for mock sBTC: a trade selling more than 5000000 sats of mock sBTC (0.05000000 sBTC) needs your approval.",
    );
  });
});

describe("the agent asking for approval", () => {
  it("is refused when it trades above the threshold alone, with u126", async () => {
    const outcome = await session.agentSwap({
      tokenIn: sbtc,
      tokenOut: usd,
      amountIn: 10_000_000n,
      minOut: 9_000_000_000n,
    });
    if (!("receipt" in outcome)) throw new Error("not sent");
    expect(outcome.check).toMatchObject({ ok: false, errorCode: 126 });
    expect(headline(outcome.receipt)).toBe(
      "Refused: this trade needs the owner's approval",
    );
  });

  it("is refused a request it does not need, with u127", async () => {
    const outcome = await request(5_000_000n, 4_500_000_000n);
    expect(outcome.check).toMatchObject({ ok: false, errorCode: 127 });
    expect(headline(outcome.receipt)).toBe(
      "Refused: this trade does not need approval",
    );
    expect(await view()).toBeNull();
  });

  it("stores a request above the threshold, and nothing moves", async () => {
    const before = await session.read();
    const outcome = await request();
    expect(outcome.check).toStrictEqual({ ok: true });
    expect(outcome.receipt.status).toBe("ok");
    const read = await session.read();
    expect(read.vault.balances).toStrictEqual(before.vault.balances);
    expect(read.vault.usage).toStrictEqual(before.vault.usage);
    expect(read.vault.pendingSwap).toMatchObject({
      agent: session.agent,
      adapter: dex,
      tokenIn: sbtc,
      tokenOut: usd,
      amountIn: 10_000_000n,
      minOut: 9_000_000_000n,
      requestedAt: read.burnHeight,
      expiresAt: read.burnHeight + 6n,
    });
    expect(await newest()).toBe(
      "request-swap: The agent asked for your approval to sell 10000000 sats of mock sBTC (0.10000000 sBTC) for at least 9000000000 base units of mock USD (9000.000000 USD) on mock-dex." +
        ` Nothing moved. You can approve it up to burn height ${read.burnHeight + 6n}.`,
    );
  });

  it("is refused a second request while one waits, with u128", async () => {
    const outcome = await request(9_000_000n, 8_100_000_000n);
    expect(outcome.check).toMatchObject({ ok: false, errorCode: 128 });
    expect(headline(outcome.receipt)).toBe(
      "Refused: a request is already waiting",
    );
  });
});

describe("the pending request, as the owner sees it", () => {
  it("says who asks, for what, against the oracle floor, and for how long", async () => {
    const read = await session.read();
    const pending = pendingView(read, session.config, errors)!;
    expect(pending.expired).toBe(false);
    expect(pending.blocksLeft).toBe(6n);
    expect(pending.headline).toBe(
      "The agent is waiting for your approval: 6 burn blocks left (about 1 hour)",
    );
    expect(pending.lines).toStrictEqual([
      `The agent (${session.agent}) asks to sell 10000000 sats of mock sBTC (0.10000000 sBTC) for at least 9000000000 base units of mock USD (9000.000000 USD) on mock-dex.`,
      `It asked at burn height ${read.burnHeight}. Nothing has moved, and nothing counts against your caps until you approve.`,
      // 0.1 sBTC at $90,000 less 1% is 8910 USD.
      "At the oracle's price now, the least the vault accepts for this sale is 8910000000 base units of mock USD (8910.000000 USD). The request's minimum is 90000000 base units above that.",
      `You can approve it for 6 burn blocks (about 1 hour) more, up to burn height ${read.burnHeight + 6n}. It is now ${read.burnHeight}.`,
      "If you approve, the vault runs every check again at that moment: the caps, the cooldown, the balance and the oracle floor.",
    ]);
    expect(pending.check).toStrictEqual({ ok: true });
    expect(pending.refusal).toBeNull();
  });

  it("predicts a refusal in plain words while the vault is paused, and the contract agrees", async () => {
    expect((await run("pause", {})).status).toBe("ok");
    const read = await session.read();
    const pending = pendingView(read, session.config, errors)!;
    expect(pending.refusal).toStrictEqual({
      headline: "Approving now would be refused: the vault is paused",
      code: "u109",
      name: "ERR-VAULT-PAUSED",
      reason: "You paused the vault. Unpause it to let the agent trade again.",
    });
    // The page does not send this call. Sent anyway, the contract refuses it
    // with the predicted code.
    const sent = await session.submit(
      approveCall(session.config, pending.pending),
    );
    expect(sent).toMatchObject({
      status: "refused",
      result: Cl.error(Cl.uint(109)),
    });
    expect((await session.read()).vault.pendingSwap).not.toBeNull();
    expect((await run("unpause", {})).status).toBe("ok");
    expect((await view())!.refusal).toBeNull();
  });

  it("predicts a refusal when the oracle floor has risen above the request's minimum", async () => {
    // $100,000 a BTC: 0.1 sBTC less 1% is now 9900 USD.
    await session.setOraclePrice(10_000_000_000_000n);
    const pending = (await view())!;
    expect(pending.lines[2]).toBe(
      "At the oracle's price now, the least the vault accepts for this sale is 9900000000 base units of mock USD (9900.000000 USD). The request's minimum is 900000000 base units below that, so the vault would refuse it.",
    );
    expect(pending.refusal).toMatchObject({
      headline:
        "Approving now would be refused: the minimum out is below the oracle floor",
      code: "u125",
      name: "ERR-BELOW-ORACLE-FLOOR",
      reason: null,
    });
    const sent = await session.submit(
      approveCall(session.config, pending.pending),
    );
    expect(headline(sent)).toBe(
      "Refused: the minimum out is below the oracle floor",
    );
    await session.setOraclePrice(ORACLE_PRICE);
    expect((await view())!.refusal).toBeNull();
  });

  it("approves exactly the stored request, with a swap's post-conditions", async () => {
    const before = await session.read();
    const pending = pendingView(before, session.config, errors)!;
    expect(termsOf(pending.pending)).toStrictEqual({
      adapter: dex,
      tokenIn: sbtc,
      tokenOut: usd,
      amountIn: 10_000_000n,
      minOut: 9_000_000_000n,
      requestedAt: pending.pending.requestedAt,
    });
    // A fresh read holding the request that was shown lets it through.
    expect(
      approvalDecision(pending.pending, before, session.config, errors),
    ).toStrictEqual({ kind: "send", view: pending });
    const call = approveCall(session.config, pending.pending);
    const review = reviewCall(call, session.config, before.burnHeight);
    expect(review.functionName).toBe("approve-swap");
    expect(review.args.map((a) => [a.name, a.value])).toStrictEqual([
      ["adapter", `'${dex}`],
      ["token-in", `'${sbtc}`],
      ["token-out", `'${usd}`],
      ["amount-in", "u10000000"],
      ["min-out", "u9000000000"],
      ["requested-at", `u${pending.pending.requestedAt}`],
    ]);
    expect(review.args[3]!.meaning).toBe(
      "10000000 sats of mock sBTC (0.10000000 sBTC)",
    );
    expect(review.args[5]!.meaning).toBe(
      `the request the agent made at burn height ${pending.pending.requestedAt}, and no other`,
    );
    expect(review.postConditions.map((pc) => pc.text)).toStrictEqual([
      "The vault sends at most 10000000 sats of mock sBTC (0.10000000 sBTC).",
      "mock-dex sends at least 9000000000 base units of mock USD (9000.000000 USD).",
    ]);
    expect(review.mode).toMatch(/^Deny mode: any token transfer/);

    expect(await session.submit(call)).toStrictEqual({
      status: "ok",
      result: Cl.ok(Cl.uint(9_000_000_000n)),
    });
    const read = await session.read();
    expect(read.vault.pendingSwap).toBeNull();
    expect(read.vault.balances).toStrictEqual({
      [sbtc]: 40_000_000n,
      [usd]: 9_000_000_000n,
    });
    expect(read.vault.usage.dayTotals[sbtc]).toBe(10_000_000n);
    expect(pendingView(read, session.config, errors)).toBeNull();
    expect(await newest()).toBe(
      `approve-swap: The owner approved the request the agent made at burn height ${pending.pending.requestedAt}:` +
        " the vault sold 10000000 sats of mock sBTC (0.10000000 sBTC) for 9000000000 base units of mock USD (9000.000000 USD) on mock-dex." +
        " The least the request would accept was 9000000000 base units of mock USD (9000.000000 USD)." +
        " Vault balances after: 40000000 sats of mock sBTC (0.40000000 sBTC) and 9000000000 base units of mock USD (9000.000000 USD)." +
        " Sold in this day window: 10000000 sats of mock sBTC (0.10000000 sBTC).",
    );
    // The page marks it as a trade, as it does an execute-swap.
    expect(TRADE_EVENTS.has("approve-swap")).toBe(true);
    expect(TRADE_EVENTS.has("execute-swap")).toBe(true);
    expect(TRADE_EVENTS.has("request-swap")).toBe(false);
  });

  it("is refused an approval with nothing waiting, with u129", async () => {
    const stale = approveCall(session.config, {
      agent: session.agent,
      adapter: dex,
      tokenIn: sbtc,
      tokenOut: usd,
      amountIn: 10_000_000n,
      minOut: 9_000_000_000n,
      requestedAt: 0n,
      expiresAt: 6n,
      expired: null,
    });
    expect(headline(await session.submit(stale))).toBe(
      "Refused: there is no request waiting",
    );
    expect(headline(await session.submit(rejectCall(session.config)))).toBe(
      "Refused: there is no request waiting",
    );
  });

  it("rejects a request: nothing moves and the request is gone", async () => {
    expect((await request(8_000_000n, 7_200_000_000n)).receipt.status).toBe(
      "ok",
    );
    const before = await session.read();
    const call = rejectCall(session.config);
    const review = reviewCall(call, session.config, before.burnHeight);
    expect(review.functionName).toBe("reject-swap");
    expect(review.args).toStrictEqual([]);
    expect(review.postConditions).toStrictEqual([]);
    expect(await session.submit(call)).toMatchObject({ status: "ok" });
    const read = await session.read();
    expect(read.vault.pendingSwap).toBeNull();
    expect(read.vault.balances).toStrictEqual(before.vault.balances);
    expect(await newest()).toBe(
      `reject-swap: The owner rejected the request the agent made at burn height ${before.burnHeight}` +
        " to sell 8000000 sats of mock sBTC (0.08000000 sBTC) for at least 7200000000 base units of mock USD (7200.000000 USD). Nothing moved.",
    );
  });

  it("shows an expired request as expired, refuses its approval with u130, and clears it by rejecting", async () => {
    expect((await request()).receipt.status).toBe("ok");
    const requestedAt = (await session.read()).burnHeight;
    await session.advanceBurnBlocks(6);
    const last = (await view())!;
    expect(last.expired).toBe(false);
    expect(last.blocksLeft).toBe(0n);
    expect(last.headline).toBe(
      "The agent is waiting for your approval: this is the last burn block",
    );
    expect(last.lines[3]).toBe(
      `This is the last burn block you can approve it in (burn height ${requestedAt + 6n}).`,
    );

    await session.advanceBurnBlocks(1);
    await session.setOraclePrice(ORACLE_PRICE);
    const read = await session.read();
    const pending = pendingView(read, session.config, errors)!;
    expect(pending.expired).toBe(true);
    expect(pending.headline).toBe("A request from the agent has expired");
    expect(pending.lines.at(-1)).toBe(
      `It expired: it could be approved up to burn height ${requestedAt + 6n} (6 burn blocks after the request), and it is now ${requestedAt + 7n}. It can no longer run. Reject it to clear it; the agent can also ask again, which replaces it.`,
    );
    expect(pending.lines).toHaveLength(3);
    expect(pending.check).toMatchObject({ ok: false, errorCode: 130 });
    // The page offers only Reject, so it shows no prediction for Approve.
    expect(pending.refusal).toBeNull();
    expect(
      headline(
        await session.submit(approveCall(session.config, pending.pending)),
      ),
    ).toBe("Refused: the request has expired");
    expect(read.vault.balances[sbtc]).toBe(40_000_000n);

    expect(await session.submit(rejectCall(session.config))).toMatchObject({
      status: "ok",
    });
    expect(await view()).toBeNull();
  });

  it("lets the agent withdraw its own request, and refuses that with nothing waiting", async () => {
    expect((await request()).receipt.status).toBe("ok");
    const requestedAt = (await session.read()).burnHeight;
    const done = await session.agentCancelRequest();
    expect(done.check).toStrictEqual({ ok: true });
    expect(done.receipt.status).toBe("ok");
    expect(await view()).toBeNull();
    expect(await newest()).toBe(
      `cancel-swap-request: The agent withdrew the request it made at burn height ${requestedAt}` +
        " to sell 10000000 sats of mock sBTC (0.10000000 sBTC) for at least 9000000000 base units of mock USD (9000.000000 USD). Nothing moved.",
    );
    const again = await session.agentCancelRequest();
    expect(again.check).toMatchObject({ ok: false, errorCode: 129 });
    expect(headline(again.receipt)).toBe(
      "Refused: there is no request waiting",
    );
  });

  it("does not approve a request that changed after it was shown: the same trade asked again", async () => {
    expect((await request()).receipt.status).toBe("ok");
    const first = await session.read();
    const shown = pendingView(first, session.config, errors)!.pending;
    // The call the page would hand to the wallet for the request shown.
    const signed = approveCall(session.config, shown);
    expect(approvalDecision(shown, first, session.config, errors).kind).toBe(
      "send",
    );

    // The agent withdraws the request and asks again for the same trade,
    // two burn blocks later: a new request with a new window.
    await session.advanceBurnBlocks(2);
    expect((await session.agentCancelRequest()).receipt.status).toBe("ok");
    expect((await request()).receipt.status).toBe("ok");
    const read = await session.read();
    const stored = read.vault.pendingSwap!;
    expect(termsOf(stored)).toStrictEqual({
      ...termsOf(shown),
      requestedAt: shown.requestedAt + 2n,
    });
    expect(samePending(shown, stored)).toBe(false);
    expect(samePending(stored, { ...stored, expired: true })).toBe(true);

    // Approve, pressed under the request that was shown: nothing is sent,
    // and the stored request is handed back to be drawn and read.
    const decision = approvalDecision(shown, read, session.config, errors);
    if (decision.kind !== "changed") throw new Error(decision.kind);
    expect(decision.view.pending).toStrictEqual(stored);
    expect(decision.lines).toStrictEqual([
      "The agent's request changed after this page showed it to you, so nothing was sent.",
      `It asks for the same trade, but it is a new request: it was made at burn height ${stored.requestedAt}, and the one you were shown was made at ${shown.requestedAt}. Its time to approve runs to burn height ${stored.expiresAt}, not ${shown.expiresAt}.`,
      "The request stored now is shown above. Read it, and approve it only if it is one you want.",
    ]);

    // A call already handed to the wallet for the first request is refused
    // by the contract, and nothing moves.
    expect(headline(await session.submit(signed))).toBe(
      "Refused: this is not the request that is waiting",
    );
    const after = await session.read();
    expect(after.vault.balances).toStrictEqual(first.vault.balances);
    expect(after.vault.pendingSwap).toStrictEqual(stored);
    // Pressed under the request stored now, Approve goes ahead.
    expect(approvalDecision(stored, after, session.config, errors).kind).toBe(
      "send",
    );
  });

  it("does not approve a request that changed after it was shown: another trade, or none", async () => {
    const shown = (await view())!.pending;
    expect((await session.agentCancelRequest()).receipt.status).toBe("ok");
    expect(
      approvalDecision(shown, await session.read(), session.config, errors),
    ).toStrictEqual({ kind: "gone" });

    expect((await request(8_000_000n, 7_200_000_000n)).receipt.status).toBe(
      "ok",
    );
    const read = await session.read();
    // The same burn block as the request shown, so only the trade differs.
    expect(read.vault.pendingSwap!.requestedAt).toBe(shown.requestedAt);
    const decision = approvalDecision(shown, read, session.config, errors);
    if (decision.kind !== "changed") throw new Error(decision.kind);
    expect(decision.lines).toStrictEqual([
      "The agent's request changed after this page showed it to you, so nothing was sent.",
      "You were shown a request to sell 10000000 sats of mock sBTC (0.10000000 sBTC) for at least 9000000000 base units of mock USD (9000.000000 USD) on mock-dex. The request stored now is to sell 8000000 sats of mock sBTC (0.08000000 sBTC) for at least 7200000000 base units of mock USD (7200.000000 USD) on mock-dex.",
      "The request stored now is shown above. Read it, and approve it only if it is one you want.",
    ]);
    expect(
      headline(await session.submit(approveCall(session.config, shown))),
    ).toBe("Refused: this is not the request that is waiting");

    // An expired request, and one the SDK predicts a refusal for, stop too.
    expect((await run("pause", {})).status).toBe("ok");
    const paused = approvalDecision(
      read.vault.pendingSwap!,
      await session.read(),
      session.config,
      errors,
    );
    if (paused.kind !== "refused") throw new Error(paused.kind);
    expect(paused.refusal.code).toBe("u109");
    expect((await run("unpause", {})).status).toBe("ok");
    await session.advanceBurnBlocks(7);
    expect(
      approvalDecision(
        read.vault.pendingSwap!,
        await session.read(),
        session.config,
        errors,
      ).kind,
    ).toBe("expired");
    expect((await session.agentCancelRequest()).receipt.status).toBe("ok");
    await session.setOraclePrice(ORACLE_PRICE);
    expect(await view()).toBeNull();
  });

  it("clears the threshold from an empty field, and the agent trades alone again", async () => {
    const prepared = prepareCall(session, "set-approval-threshold", {
      token: sbtc,
      threshold: " ",
    });
    if (!prepared.ok) throw new Error("did not build");
    expect(reviewCall(prepared.call, session.config, 0n).args[1]).toStrictEqual(
      {
        name: "threshold",
        value: "none",
        meaning: "none: the agent trades alone up to the per-trade cap",
      },
    );
    expect((await session.submit(prepared.call)).status).toBe("ok");
    expect((await session.read()).vault.approvalThresholds[sbtc]).toBeNull();
    expect(await newest()).toBe(
      "set-approval-threshold: The owner cleared the approval threshold for mock sBTC. The agent trades alone up to the per-trade cap.",
    );
    const outcome = await session.agentSwap({
      tokenIn: sbtc,
      tokenOut: usd,
      amountIn: 10_000_000n,
      minOut: 9_000_000_000n,
    });
    expect("receipt" in outcome && outcome.receipt.status).toBe("ok");
  });
});

describe("an agent's history before the owner signs", () => {
  it("looks nothing up for text that is not a principal", async () => {
    const journal = await session.journal();
    for (const text of ["", "  ", "not-an-address", "ST123", "SP"]) {
      expect(isPrincipal(text), text).toBe(false);
      expect(
        agentHistoryView(journal, text, session.config, "contract"),
        text,
      ).toBeNull();
    }
    expect(isPrincipal(session.agent)).toBe(true);
    expect(isPrincipal(dex)).toBe(true);
  });

  it("says a principal the journal never names has no history", async () => {
    const journal = await session.journal();
    // The deployer never appears as an agent.
    const fresh = session.config.tx.vault.split(".")[0]!;
    expect(
      agentHistoryView(journal, ` ${fresh} `, session.config, "contract"),
    ).toStrictEqual({
      agent: fresh,
      known: false,
      headline: NO_HISTORY,
      facts: [],
      scope: `Read: the whole journal of this vault contract, every owner's vault (${journal.length} events). Calls the contract refused are not in a journal.`,
      caution: HISTORY_CAUTION,
    });
    expect(NO_HISTORY).toBe(
      "No history: this principal has never appeared in this vault contract's journal.",
    );
    // An empty journal knows no one.
    expect(
      agentHistoryView([], session.agent, session.config, "contract"),
    ).toMatchObject({ known: false, headline: NO_HISTORY, facts: [] });
  });

  it("reports the agent's record from the whole journal", async () => {
    const journal = await session.journal();
    const first = journal.find(
      (r) =>
        r.value.type === "tuple" &&
        Cl.prettyPrint(r.value.value.event!) === '"set-agent"',
    )!;
    const last = journal.findLast(
      (r) =>
        r.value.type === "tuple" &&
        TRADE_EVENTS.has(
          Cl.prettyPrint(r.value.value.event!).replaceAll('"', ""),
        ),
    )!;
    const history = agentHistoryView(
      journal,
      session.agent,
      session.config,
      "contract",
    )!;
    expect(history.known).toBe(true);
    expect(history.headline).toBe(
      `This principal appears in the journal, first at burn height ${first.burnHeight}.`,
    );
    expect(history.facts).toStrictEqual([
      ["First seen", `burn height ${first.burnHeight}`],
      ["Vaults that name it now", "1 of the 1 vault that ever named it"],
      ["Trades", "2: 1 sent alone, 1 approved by an owner"],
      [
        "Sold, mock sBTC",
        "20000000 sats of mock sBTC (0.20000000 sBTC) in 2 trades",
      ],
      [
        "Requests for approval",
        "7 made: 1 approved, 2 rejected, 4 withdrawn by the agent, 0 expired, replaced or still waiting",
      ],
      ["Last trade", `burn height ${last.burnHeight}`],
    ]);
    // The fixed line is always there, known or not.
    expect(history.caution).toBe(HISTORY_CAUTION);
    expect(HISTORY_CAUTION).toMatch(/^This is history, not a guarantee\./);
    expect(HISTORY_CAUTION).toMatch(/What protects you is the vault's limits/);
  });

  it("says what was read when the mode reads only the owner's events", async () => {
    const journal = await session.journal();
    const history = agentHistoryView(
      journal,
      session.agent,
      session.config,
      "owner",
    )!;
    expect(history.scope).toBe(
      `Read: only your own vault's events on this vault contract (${journal.length} events). This mode does not read other owners' events, so trades this principal made for other vaults are not counted here. Calls the contract refused are not in a journal.`,
    );
    expect(scopeWords("owner", 1)).toMatch(/\(1 event\)/);
    const fresh = session.config.tx.vault.split(".")[0]!;
    expect(
      agentHistoryView(journal, fresh, session.config, "owner")!.headline,
    ).toBe(
      "No history: this principal has never appeared in your own vault's journal.",
    );
  });

  it("the sessions say which journal they give", () => {
    expect(session.journalScope).toBe("contract");
  });
});

describe("the accountability record", () => {
  it("is empty, and says so, before any trade", () => {
    const empty = accountabilityView(
      [],
      session.config,
      session.owner,
      "simulation",
    );
    expect(empty.rows).toStrictEqual([]);
    expect(empty.summary).toBe(
      "No trades yet: the journal holds no execute-swap or approve-swap event for this owner.",
    );
    expect(empty.markdown.text).toContain("The journal given holds no trades.");
    expect(JSON.parse(empty.json.text)).toMatchObject({ trades: [] });
  });

  it("lists each trade with who sent it and the limits in force", async () => {
    const journal = await session.journal();
    const record = accountabilityView(
      journal,
      session.config,
      session.owner,
      "simulation",
    );
    expect(record.summary).toBe(
      "2 trades, oldest first. Every limit was found in the journal, and each trade is inside each one.",
    );
    expect(record.rows).toHaveLength(2);
    const [approved, alone] = record.rows as [
      (typeof record.rows)[number],
      (typeof record.rows)[number],
    ];
    expect(approved.title).toMatch(/^Trade 1, burn height \d+$/);
    expect(approved.who).toMatch(
      new RegExp(
        `^Approved by the owner \\(approve-swap\\)\\. ${session.agent} \\(the agent\\) requested it at burn height \\d+\\.$`,
      ),
    );
    expect(approved.what).toBe(
      "Sold 10000000 sats of mock sBTC (0.10000000 sBTC) for 9000000000 base units of mock USD (9000.000000 USD) on mock-dex. The least it would accept was 9000000000 base units of mock USD (9000.000000 USD); the vault's oracle floor was 8910000000 base units of mock USD (8910.000000 USD).",
    );
    expect(approved.limits).toStrictEqual([
      "Caps for the token sold: 10000000 sats of mock sBTC (0.10000000 sBTC) per trade, 30000000 sats of mock sBTC (0.30000000 sBTC) per day (144 burn blocks). Sold in the window, this trade included: 10000000 sats of mock sBTC (0.10000000 sBTC).",
      expect.stringMatching(
        /^Cooldown 0 burn blocks \(none\); expiry at burn height \d+\.$/,
      ),
      "Price bounds: at most 100 bps (1.00%) below the oracle price; price at most 3600000 ms (60 minutes) old.",
      "Approval threshold for the token sold: a trade selling more than 5000000 sats of mock sBTC (0.05000000 sBTC) needs your approval.",
      `Agent named by the owner: ${session.agent}.`,
    ]);
    expect(approved.issues).toStrictEqual([]);
    expect(alone.who).toBe(
      `Sent by the agent alone (execute-swap): ${session.agent} (the agent).`,
    );
    // By then the owner had cleared the threshold.
    expect(alone.limits[3]).toBe(
      "Approval threshold for the token sold: none: the agent trades alone up to the per-trade cap.",
    );
    expect(alone.issues).toStrictEqual([]);
  });

  it("gives the two files to save: the SDK's Markdown report and its JSON", async () => {
    const record = accountabilityView(
      await session.journal(),
      session.config,
      session.owner,
      "simulation",
    );
    expect(record.markdown.name).toBe(
      `keelio-accountability-${session.owner}.md`,
    );
    expect(record.markdown.type).toBe("text/markdown;charset=utf-8");
    expect(record.markdown.text).toMatch(
      new RegExp(`^# Keelio accountability record for ${session.owner}\n`),
    );
    expect(record.markdown.text).toContain("2 trades, oldest first.");
    expect(record.markdown.text).toContain(
      "- Authority: approved by the owner (`approve-swap`).",
    );
    expect(record.markdown.text).toContain(
      "- Authority: sent by the agent alone (`execute-swap`)",
    );
    expect(record.markdown.text).toContain(
      `Vault contract: \`${session.config.tx.vault}\`. Network: a local simulation (simnet): mock tokens, nothing deployed.`,
    );
    expect(record.json.name).toBe(
      `keelio-accountability-${session.owner}.json`,
    );
    expect(record.json.type).toBe("application/json");
    const data = JSON.parse(record.json.text) as {
      owner: string;
      vault: string;
      network: string;
      trades: { swap: { amountIn: string; approved: boolean } }[];
    };
    expect(data.owner).toBe(session.owner);
    expect(data.vault).toBe(session.config.tx.vault);
    expect(data.network).toBe("simnet");
    // Amounts are decimal strings, never JSON numbers.
    expect(
      data.trades.map((t) => [t.swap.amountIn, t.swap.approved]),
    ).toStrictEqual([
      ["10000000", true],
      ["10000000", false],
    ]);
    expect(
      accountabilityView(
        await session.journal(),
        session.config,
        session.owner,
        "testnet",
      ).markdown.text,
    ).toContain("Network: Stacks testnet.");
  });

  it("leaves out another owner's trades, and marks a trade the journal cannot account for", async () => {
    const journal = await session.journal();
    const other = session.config.tx.vault.split(".")[0]!;
    expect(
      accountabilityView(journal, session.config, other, "simulation").rows,
    ).toStrictEqual([]);
    // Only the trades, without the events that set their limits.
    const trades: JournalRecord[] = journal.filter(
      (r) =>
        r.value.type === "tuple" &&
        TRADE_EVENTS.has(
          Cl.prettyPrint(r.value.value.event!).replaceAll('"', ""),
        ),
    );
    const partial = accountabilityView(
      trades,
      session.config,
      session.owner,
      "simulation",
    );
    expect(partial.summary).toBe(
      "2 trades, oldest first. The replay found issues: see the marked trades.",
    );
    expect(partial.rows[0]!.issues).toContain(
      "NO_AGENT_EVENT: the journal has no set-agent event before this trade.",
    );
    expect(partial.rows[0]!.limits[0]).toBe(
      "Caps for the token sold: not found in the journal.",
    );
  });
});

describe("leaving in one action", () => {
  it("plans a pause, then one withdrawal for each token the vault holds", async () => {
    const read = await session.read();
    expect(read.vault.balances).toStrictEqual({
      [sbtc]: 30_000_000n,
      [usd]: 18_000_000_000n,
    });
    const plan = leavePlan(session.config, read, "simulation");
    expect(plan.steps.map((s) => [s.kind, s.title])).toStrictEqual([
      ["pause", "Pause the agent: it cannot trade from then on"],
      [
        "withdraw",
        "Withdraw 30000000 sats of mock sBTC (0.30000000 sBTC) to your account",
      ],
      [
        "withdraw",
        "Withdraw 18000000000 base units of mock USD (18000.000000 USD) to your account",
      ],
    ]);
    expect(plan.steps.map((s) => s.call.functionName)).toStrictEqual([
      "pause",
      "withdraw",
      "withdraw",
    ]);
    expect(plan.summary).toBe(
      "Pauses the agent, then withdraws everything the vault holds to your account, in 2 withdrawals.",
    );
    expect(plan.signatures).toBe(
      "3 calls on the simnet, sent one after another",
    );
    // In wallet mode each step is its own signature, said before starting.
    expect(leavePlan(session.config, read, "testnet").signatures).toBe(
      "3 signatures: each step is a separate transaction your wallet shows you",
    );
    // Each withdrawal carries its own post-condition for the review step.
    expect(
      reviewCall(plan.steps[1]!.call, session.config, 0n).postConditions.map(
        (pc) => pc.text,
      ),
    ).toStrictEqual([
      "The vault sends exactly 30000000 sats of mock sBTC (0.30000000 sBTC).",
    ]);
  });

  it("stops with the contract's refusal and sends nothing after it", async () => {
    const read = await session.read();
    const plan = leavePlan(session.config, read, "simulation", false);
    // A withdrawal the vault cannot cover, then one it could.
    const steps = [
      {
        ...plan.steps[0]!,
        call: buildWithdraw(session.config.tx, {
          token: sbtc,
          amount: 30_000_001n,
        }),
      },
      plan.steps[1]!,
    ];
    const seen: [number, LeaveStepState["status"]][] = [];
    const outcome = await runLeave(session, { ...plan, steps }, (i, state) =>
      seen.push([i, state.status]),
    );
    expect(outcome).toMatchObject({ status: "stopped", at: 0 });
    if (outcome.status !== "stopped") throw new Error("unreachable");
    expect(headline(outcome.receipt)).toBe(
      "Refused: more than the vault holds",
    );
    expect(seen).toStrictEqual([
      [0, "sending"],
      [0, "stopped"],
    ]);
    expect((await session.read()).vault.balances).toStrictEqual(
      read.vault.balances,
    );
  });

  it("stops when a step cannot be sent, as when the owner declines in the wallet", async () => {
    const read = await session.read();
    const declined: ChainSession = {
      ...session,
      submit: async () => {
        throw new Error("Not sent. The wallet did not sign the call");
      },
    };
    const seen: LeaveStepState[] = [];
    const outcome = await runLeave(
      declined,
      leavePlan(session.config, read, "testnet"),
      (_, state) => seen.push(state),
    );
    expect(outcome).toStrictEqual({
      status: "failed",
      at: 0,
      message: "Not sent. The wallet did not sign the call",
    });
    expect(seen.map((s) => s.status)).toStrictEqual(["sending", "failed"]);
    expect((await session.read()).vault.vault.paused).toBe(false);
  });

  it("sends no withdrawal when the balances changed before the pause, and offers the new amounts", async () => {
    const stale = leavePlan(session.config, await session.read(), "simulation");
    // The agent trades after the owner's review and before the pause.
    const traded = await session.agentSwap({
      tokenIn: sbtc,
      tokenOut: usd,
      amountIn: 1_000_000n,
      minOut: 900_000_000n,
    });
    expect("receipt" in traded && traded.receipt.status).toBe("ok");
    const seen: [number, LeaveStepState["status"]][] = [];
    const outcome = await runLeave(session, stale, (i, state) =>
      seen.push([i, state.status]),
    );
    expect(outcome.status).toBe("changed");
    if (outcome.status !== "changed") throw new Error("unreachable");
    expect(seen).toStrictEqual([
      [0, "sending"],
      [0, "done"],
    ]);
    const read = await session.read();
    expect(read.vault.vault.paused).toBe(true);
    expect(read.vault.balances).toStrictEqual({
      [sbtc]: 29_000_000n,
      [usd]: 18_900_000_000n,
    });
    expect(outcome.plan.steps.map((s) => s.title)).toStrictEqual([
      "Withdraw 29000000 sats of mock sBTC (0.29000000 sBTC) to your account",
      "Withdraw 18900000000 base units of mock USD (18900.000000 USD) to your account",
    ]);
    expect(outcome.plan.summary).toBe(
      "Withdraws everything the vault holds to your account, in 2 withdrawals.",
    );
  });

  it("pauses and withdraws everything, in order, with progress for each step", async () => {
    expect((await run("unpause", {})).status).toBe("ok");
    const before = await session.read();
    const plan = leavePlan(session.config, before, "simulation");
    const seen: [number, LeaveStepState["status"]][] = [];
    const outcome = await runLeave(session, plan, (i, state) =>
      seen.push([i, state.status]),
    );
    expect(outcome).toStrictEqual({ status: "done" });
    expect(seen).toStrictEqual([
      [0, "sending"],
      [0, "done"],
      [1, "sending"],
      [1, "done"],
      [2, "sending"],
      [2, "done"],
    ]);
    const read = await session.read();
    expect(read.vault.vault.paused).toBe(true);
    expect(read.vault.balances).toStrictEqual({ [sbtc]: 0n, [usd]: 0n });
    expect(read.wallet).toStrictEqual({
      [sbtc]: before.wallet[sbtc]! + 29_000_000n,
      [usd]: before.wallet[usd]! + 18_900_000_000n,
    });
    const texts = journalEntries(
      await session.journal(),
      session.config,
      session.owner,
    )
      .slice(0, 3)
      .map((e) => e.event);
    expect(texts).toStrictEqual(["withdraw", "withdraw", "pause"]);
    // The agent is stopped: it cannot trade what is no longer there, or at all.
    const after = await session.agentSwap({
      tokenIn: sbtc,
      tokenOut: usd,
      amountIn: 1n,
      minOut: 0n,
    });
    expect("receipt" in after && headline(after.receipt)).toBe(
      "Refused: the vault is paused",
    );
  });

  it("is only a pause when the vault is empty", async () => {
    const read = await session.read();
    const plan = leavePlan(session.config, read, "testnet");
    expect(plan.steps.map((s) => s.kind)).toStrictEqual(["pause"]);
    expect(plan.summary).toBe(
      "The vault holds nothing, so this only pauses the agent.",
    );
    expect(plan.signatures).toBe(
      "1 signature: your wallet shows you the transaction",
    );
    const none = leavePlan(session.config, read, "simulation", false);
    expect(none.steps).toStrictEqual([]);
    expect(none.summary).toBe(
      "The vault holds nothing, so there is nothing left to withdraw.",
    );
    expect(await runLeave(session, plan)).toStrictEqual({ status: "done" });
    expect(await runLeave(session, none)).toStrictEqual({ status: "done" });
  });
});
