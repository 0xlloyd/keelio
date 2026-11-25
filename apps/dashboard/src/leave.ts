// Leaving in one action: pause, then withdraw every token. The steps come
// from the SDK's `buildLeave`; this file words them and sends them in order
// through a `ChainSession`. No DOM, so tests run it in Node.
import type { VaultCall } from "../../../packages/sdk/src/build-tx.js";
import { buildLeave } from "../../../packages/sdk/src/leave.js";
import type {
  ChainConfig,
  ChainRead,
  ChainSession,
  Receipt,
  SubmitProgress,
} from "./chain.js";
import { amountOf } from "./format.js";

export interface LeaveStepView {
  kind: "pause" | "withdraw";
  /** "Pause the agent" or "Withdraw 0.50000000 sBTC …". */
  title: string;
  call: VaultCall;
}

export interface LeavePlan {
  steps: LeaveStepView[];
  /** What the owner is about to do, said before anything is sent. */
  summary: string;
  /** How many times the owner confirms: "3 signatures" on testnet. */
  signatures: string;
}

const plural = (n: number, word: string): string =>
  `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The plan from one read: `pause`, then one withdrawal of the full balance
 * per token the vault holds. `withPause: false` leaves the pause out, for
 * building the withdrawals again after the pause has been sent.
 */
export function leavePlan(
  config: ChainConfig,
  read: ChainRead,
  kind: ChainSession["kind"],
  withPause = true,
): LeavePlan {
  const steps = buildLeave(config.tx, { balances: read.vault.balances })
    .filter((step) => withPause || step.kind !== "pause")
    .map((step): LeaveStepView =>
      step.kind === "pause"
        ? {
            kind: "pause",
            title: "Pause the agent: it cannot trade from then on",
            call: step.call,
          }
        : {
            kind: "withdraw",
            title: `Withdraw ${amountOf(config, step.token, step.amount)} to your account`,
            call: step.call,
          },
    );
  const withdrawals = steps.filter((s) => s.kind === "withdraw").length;
  const signatures =
    kind === "simulation"
      ? steps.length === 1
        ? "1 call on the simnet"
        : `${plural(steps.length, "call")} on the simnet, sent one after another`
      : steps.length === 1
        ? "1 signature: your wallet shows you the transaction"
        : `${plural(steps.length, "signature")}: each step is a separate transaction your wallet shows you`;
  return {
    steps,
    signatures,
    summary:
      withdrawals === 0
        ? steps.length === 0
          ? "The vault holds nothing, so there is nothing left to withdraw."
          : "The vault holds nothing, so this only pauses the agent."
        : `${withPause ? "Pauses the agent, then withdraws" : "Withdraws"} everything the vault holds to your account, in ${plural(withdrawals, "withdrawal")}.`,
  };
}

/** Where one step is. */
export type LeaveStepState =
  | { status: "sending" }
  | { status: "waiting"; progress: SubmitProgress }
  | { status: "done"; receipt: Receipt }
  | { status: "stopped"; receipt: Receipt }
  | { status: "failed"; message: string };

export type LeaveResult =
  /** Every step returned `ok`. */
  | { status: "done" }
  /** Step `at` was refused or rolled back; the later ones were not sent. */
  | { status: "stopped"; at: number; receipt: Receipt }
  /** Step `at` could not be sent or followed; the later ones were not sent. */
  | { status: "failed"; at: number; message: string }
  /**
   * The pause went through, and the vault's balances are no longer the ones
   * the owner reviewed (the agent traded first). No withdrawal was sent:
   * `plan` holds the withdrawals for the balances as they are now.
   */
  | { status: "changed"; plan: LeavePlan };

const sameCalls = (a: readonly VaultCall[], b: readonly VaultCall[]): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * Sends the plan's steps in order and stops at the first that is not `ok`.
 * After a `pause` the vault is read again: if its balances no longer match
 * the reviewed withdrawals, nothing more is sent and the fresh plan is
 * returned for the owner to review. `onStep` is told each step's state.
 */
export async function runLeave(
  session: ChainSession,
  plan: LeavePlan,
  onStep: (index: number, state: LeaveStepState) => void = () => {},
): Promise<LeaveResult> {
  for (const [index, step] of plan.steps.entries()) {
    onStep(index, { status: "sending" });
    let receipt: Receipt;
    try {
      receipt = await session.submit(step.call, (progress) =>
        onStep(index, { status: "waiting", progress }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onStep(index, { status: "failed", message });
      return { status: "failed", at: index, message };
    }
    if (receipt.status !== "ok") {
      onStep(index, { status: "stopped", receipt });
      return { status: "stopped", at: index, receipt };
    }
    onStep(index, { status: "done", receipt });
    if (step.kind === "pause") {
      let fresh: LeavePlan;
      try {
        fresh = leavePlan(
          session.config,
          await session.read(),
          session.kind,
          false,
        );
      } catch (error) {
        const message = `The agent is paused, but the vault could not be read again, so no withdrawal was sent: ${error instanceof Error ? error.message : String(error)}`;
        return { status: "failed", at: index, message };
      }
      const rest = plan.steps.slice(index + 1).map((s) => s.call);
      if (
        !sameCalls(
          rest,
          fresh.steps.map((s) => s.call),
        )
      ) {
        return { status: "changed", plan: fresh };
      }
    }
  }
  return { status: "done" };
}
