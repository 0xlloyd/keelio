// The approval band's owner side: the pending request in plain words, the
// SDK's prediction for approving it, and the two calls the owner can send.
// No DOM, so tests run it in Node. Integer maths only.
import {
  buildApproveSwap,
  buildRejectSwap,
  type VaultCall,
} from "../../../packages/sdk/src/build-tx.js";
import {
  APPROVAL_WINDOW_BLOCKS,
  checkApproval,
  minOutFloor,
  pendingSwapExpired,
  type ApprovalCheck,
  type ApprovalTerms,
  type PendingSwap,
  type VaultState,
} from "../../../packages/sdk/src/vault.js";
import type { ChainConfig, ChainRead } from "./chain.js";
import {
  amountOf,
  blocksAsTime,
  blocksWords,
  capitalise,
  label,
  refusalReason,
  type ErrorTable,
} from "./format.js";

/** The read as the state the SDK's checks take. */
export function stateOf(read: ChainRead): VaultState {
  return { ...read.vault, burnHeight: read.burnHeight, nowMs: read.nowMs };
}

/**
 * What `approve-swap` must repeat of a request: its five trade fields and
 * the burn height it was made at, which binds the approval to that request.
 */
export function termsOf(pending: PendingSwap): ApprovalTerms {
  return {
    adapter: pending.adapter,
    tokenIn: pending.tokenIn,
    tokenOut: pending.tokenOut,
    amountIn: pending.amountIn,
    minOut: pending.minOut,
    requestedAt: pending.requestedAt,
  };
}

/**
 * Whether two reads hold the same request: the same agent, trade and burn
 * height. `expired` is left out, since it is the read's opinion of the
 * request and not part of it.
 */
export function samePending(a: PendingSwap, b: PendingSwap): boolean {
  return (
    a.agent === b.agent &&
    a.adapter === b.adapter &&
    a.tokenIn === b.tokenIn &&
    a.tokenOut === b.tokenOut &&
    a.amountIn === b.amountIn &&
    a.minOut === b.minOut &&
    a.requestedAt === b.requestedAt &&
    a.expiresAt === b.expiresAt
  );
}

/** Why approving now would be refused, in plain words first. */
export interface PredictedRefusal {
  /** "Approving now would be refused: the cooldown is still running". */
  headline: string;
  /** The contract's code, for example "u116". */
  code: string;
  /** The error's constant, when docs/errors.md lists the code. */
  name: string | null;
  /** The owner's own numbers behind it, when a number explains it. */
  reason: string | null;
}

export interface PendingView {
  pending: PendingSwap;
  /** The request can no longer be approved at the read's burn height. */
  expired: boolean;
  /** Burn blocks after this one in which it can still be approved. */
  blocksLeft: bigint;
  /** One line that says what is being asked. */
  headline: string;
  /** Who asks, what for, the oracle floor and the time left, as sentences. */
  lines: string[];
  /** `checkApproval` for exactly the stored request, at this read. */
  check: ApprovalCheck;
  /** Set when `check` refuses and the request has not expired. */
  refusal: PredictedRefusal | null;
}

const lowerFirst = (text: string): string =>
  text.charAt(0).toLowerCase() + text.slice(1);

/** A refusal the SDK predicts, with the plain words docs/errors.md gives it. */
export function predictedRefusal(
  check: ApprovalCheck,
  pending: PendingSwap,
  read: ChainRead,
  config: ChainConfig,
  errors: ErrorTable,
): PredictedRefusal | null {
  if (check.ok) return null;
  const known = errors.get(check.errorCode.toString());
  return {
    headline: `Approving now would be refused: ${
      known === undefined ? check.message : lowerFirst(known.plain)
    }`,
    code: `u${check.errorCode}`,
    name: known?.name ?? null,
    reason: refusalReason(
      BigInt(check.errorCode),
      { tokenIn: pending.tokenIn, amountIn: pending.amountIn },
      read,
      config,
    ),
  };
}

/** How the request's minimum compares with the oracle floor at this read. */
function floorLine(
  state: VaultState,
  pending: PendingSwap,
  config: ChainConfig,
  errors: ErrorTable,
): string {
  const floor = minOutFloor(state, pending.tokenIn, pending.amountIn);
  if (!floor.ok) {
    const known = errors.get(floor.errorCode.toString());
    return `The oracle floor cannot be worked out right now: ${
      known === undefined ? floor.message : lowerFirst(known.plain)
    } (u${floor.errorCode}). The vault checks the floor again when you approve.`;
  }
  const least = amountOf(config, pending.tokenOut, floor.floor);
  if (pending.minOut < floor.floor) {
    return `At the oracle's price now, the least the vault accepts for this sale is ${least}. The request's minimum is ${floor.floor - pending.minOut} base units below that, so the vault would refuse it.`;
  }
  return pending.minOut === floor.floor
    ? `At the oracle's price now, the least the vault accepts for this sale is ${least}. The request's minimum is exactly that.`
    : `At the oracle's price now, the least the vault accepts for this sale is ${least}. The request's minimum is ${pending.minOut - floor.floor} base units above that.`;
}

/**
 * The owner's stored request as the page shows it, or `null` when there is
 * none. An expired request is still returned: the contract keeps it until it
 * is rejected, withdrawn or overwritten.
 */
export function pendingView(
  read: ChainRead,
  config: ChainConfig,
  errors: ErrorTable,
): PendingView | null {
  const pending = read.vault.pendingSwap;
  if (pending === null) return null;
  const state = stateOf(read);
  const expired = pendingSwapExpired(pending, read.burnHeight);
  const blocksLeft = expired ? 0n : pending.expiresAt - read.burnHeight;
  const who = label(config, pending.agent);
  const asker =
    who === pending.agent ? pending.agent : `${who} (${pending.agent})`;
  const selling = amountOf(config, pending.tokenIn, pending.amountIn);
  const least = amountOf(config, pending.tokenOut, pending.minOut);
  const check = checkApproval(state, termsOf(pending));

  const lines = [
    `${capitalise(asker)} ${expired ? "asked" : "asks"} to sell ${selling} for at least ${least} on ${label(config, pending.adapter)}.`,
    expired
      ? `It asked at burn height ${pending.requestedAt}. Nothing moved, and nothing was counted against your caps.`
      : `It asked at burn height ${pending.requestedAt}. Nothing has moved, and nothing counts against your caps until you approve.`,
  ];
  if (expired) {
    lines.push(
      `It expired: it could be approved up to burn height ${pending.expiresAt} (${APPROVAL_WINDOW_BLOCKS} burn blocks after the request), and it is now ${read.burnHeight}. It can no longer run. Reject it to clear it; the agent can also ask again, which replaces it.`,
    );
  } else {
    lines.push(
      floorLine(state, pending, config, errors),
      blocksLeft === 0n
        ? `This is the last burn block you can approve it in (burn height ${pending.expiresAt}).`
        : `You can approve it for ${blocksWords(blocksLeft)} more, up to burn height ${pending.expiresAt}. It is now ${read.burnHeight}.`,
      "If you approve, the vault runs every check again at that moment: the caps, the cooldown, the balance and the oracle floor.",
    );
  }
  return {
    pending,
    expired,
    blocksLeft,
    headline: expired
      ? "A request from the agent has expired"
      : `The agent is waiting for your approval: ${
          blocksLeft === 0n
            ? "this is the last burn block"
            : `${blocksLeft} burn ${blocksLeft === 1n ? "block" : "blocks"} left (${blocksAsTime(blocksLeft)})`
        }`,
    lines,
    check,
    refusal: expired
      ? null
      : predictedRefusal(check, pending, read, config, errors),
  };
}

/**
 * `approve-swap` for exactly the request `pending`, with its post-conditions.
 * `pending` is the request the owner was shown: the call carries its
 * `requestedAt`, so the contract refuses it (u131) if another request is
 * stored when it arrives, even one for the same trade.
 */
export function approveCall(
  config: ChainConfig,
  pending: PendingSwap,
): VaultCall {
  return buildApproveSwap(config.tx, termsOf(pending));
}

/** What the page does when the owner presses Approve under a request. */
export type ApprovalDecision =
  /** `shown` is still the stored request and would run: review `call`. */
  | { kind: "send"; view: PendingView }
  /** Nothing is stored any more. */
  | { kind: "gone" }
  /**
   * Another request is stored than the one the owner was shown. Nothing is
   * sent: `view` is the stored one, to be drawn for the owner to read, and
   * `lines` say what differs.
   */
  | { kind: "changed"; view: PendingView; lines: string[] }
  | { kind: "expired"; view: PendingView }
  | { kind: "refused"; view: PendingView; refusal: PredictedRefusal };

/** How the stored request differs from the one shown, as sentences. */
function changeLines(
  shown: PendingSwap,
  now: PendingSwap,
  config: ChainConfig,
): string[] {
  const ask = (p: PendingSwap): string =>
    `sell ${amountOf(config, p.tokenIn, p.amountIn)} for at least ${amountOf(config, p.tokenOut, p.minOut)} on ${label(config, p.adapter)}`;
  const sameTrade =
    shown.adapter === now.adapter &&
    shown.tokenIn === now.tokenIn &&
    shown.tokenOut === now.tokenOut &&
    shown.amountIn === now.amountIn &&
    shown.minOut === now.minOut;
  const lines: string[] = [];
  if (!sameTrade) {
    lines.push(
      `You were shown a request to ${ask(shown)}. The request stored now is to ${ask(now)}.`,
    );
  }
  if (shown.requestedAt !== now.requestedAt) {
    lines.push(
      sameTrade
        ? `It asks for the same trade, but it is a new request: it was made at burn height ${now.requestedAt}, and the one you were shown was made at ${shown.requestedAt}. Its time to approve runs to burn height ${now.expiresAt}, not ${shown.expiresAt}.`
        : `It was made at burn height ${now.requestedAt}; the one you were shown was made at ${shown.requestedAt}.`,
    );
  }
  if (shown.agent !== now.agent) {
    lines.push(
      `It is from ${now.agent}; the one you were shown was from ${shown.agent}.`,
    );
  }
  return lines;
}

/**
 * Decides an Approve press. `shown` is the request the owner read on the
 * page and `read` is a fresh read. The approval is only ever for `shown`:
 * if the fresh read holds another request, even the same trade made again at
 * another height, nothing is sent and the owner is shown the new one. The
 * fresh read is used to refuse early, never to pick what is approved.
 */
export function approvalDecision(
  shown: PendingSwap,
  read: ChainRead,
  config: ChainConfig,
  errors: ErrorTable,
): ApprovalDecision {
  const view = pendingView(read, config, errors);
  if (view === null) return { kind: "gone" };
  if (!samePending(shown, view.pending)) {
    return {
      kind: "changed",
      view,
      lines: [
        "The agent's request changed after this page showed it to you, so nothing was sent.",
        ...changeLines(shown, view.pending, config),
        "The request stored now is shown above. Read it, and approve it only if it is one you want.",
      ],
    };
  }
  if (view.expired) return { kind: "expired", view };
  if (view.refusal !== null) {
    return { kind: "refused", view, refusal: view.refusal };
  }
  return { kind: "send", view };
}

/** `reject-swap`: removes the stored request, expired or not. */
export function rejectCall(config: ChainConfig): VaultCall {
  return buildRejectSwap(config.tx);
}
