import {
  eventRef,
  swapEvent,
  swapRequestEvent,
  textField,
  type EventRef,
  type JournalEvent,
} from "./journal.js";

// What the journal says about one agent principal across every owner's
// vault. The journal holds only calls that succeeded, so refused calls are
// not counted here: the SDK has no reader for failed transactions.

/** One owner that has named the agent with `set-agent`. */
export interface AgentOwner {
  owner: string;
  /** The owner's first `set-agent` naming this agent. */
  firstNamedAt: EventRef;
  /** Whether the owner's latest `set-agent` or `remove-agent` still names it. */
  current: boolean;
  /**
   * The event that ended the latest naming (a `remove-agent`, or a
   * `set-agent` naming someone else), or `null` while `current` is true.
   */
  endedAt: EventRef | null;
}

/**
 * The agent's trades selling one token: the swaps it sent alone and the
 * ones it requested and the owner approved.
 */
export interface AgentVolume {
  tokenIn: string;
  swaps: bigint;
  /** The sum of `amount-in`, in the token's base units. */
  amountIn: bigint;
}

/**
 * What became of the agent's `request-swap` calls, for any owner. A request
 * that is none of approved, rejected or cancelled expired, was overwritten
 * by a later request after expiring, or is still pending.
 */
export interface AgentRequests {
  /** How many `request-swap` events it sent. */
  made: bigint;
  /** How many of its requests an owner approved (`approve-swap` events). */
  approved: bigint;
  /** How many an owner rejected (`reject-swap` events). */
  rejected: bigint;
  /** How many it withdrew itself (`cancel-swap-request` events). */
  cancelled: bigint;
}

export type AgentHistory =
  | {
      /** No event in the journal given names this principal as an agent. */
      known: false;
      agent: string;
    }
  | {
      known: true;
      agent: string;
      /**
       * The first event that names it as an agent: a `set-agent`, an
       * `execute-swap` or `request-swap` it sent, an `approve-swap`,
       * `reject-swap` or `cancel-swap-request` of a request it made, or a
       * `pause` or `unpause` that prints it.
       */
      firstSeen: EventRef;
      /** The owners that have named it, in the order they first did. */
      owners: AgentOwner[];
      /**
       * How many trades it made, for any owner: the `execute-swap` events it
       * sent and the `approve-swap` events of trades it requested.
       */
      swaps: bigint;
      /** Per input token, in the order first sold. Empty before any swap. */
      volume: AgentVolume[];
      /** Its latest trade, executed or approved, or `null` before any. */
      lastTrade: EventRef | null;
      /** How many of `swaps` an owner approved: `requests.approved`. */
      approvedSwaps: bigint;
      /** Its requests for trades above an owner's approval threshold. */
      requests: AgentRequests;
    };

/**
 * What the journal of the whole contract (every owner, oldest first) shows
 * about `agent`. A principal no event names returns `{ known: false }`, not
 * an error. Events with a name this function does not know are skipped.
 */
export function agentHistory(
  events: readonly JournalEvent[],
  agent: string,
): AgentHistory {
  let firstSeen: EventRef | null = null;
  let lastTrade: EventRef | null = null;
  let swaps = 0n;
  const owners = new Map<string, AgentOwner>();
  const volume = new Map<string, AgentVolume>();
  const requests: AgentRequests = {
    made: 0n,
    approved: 0n,
    rejected: 0n,
    cancelled: 0n,
  };

  for (const event of events) {
    const ref = eventRef(event);
    const owner = textField(event, "owner");
    switch (event.event) {
      case "set-agent":
      case "remove-agent": {
        if (owner === undefined) break;
        const named = event.fields.agent === agent;
        const entry = owners.get(owner);
        if (named) {
          firstSeen ??= ref;
          if (entry === undefined) {
            owners.set(owner, {
              owner,
              firstNamedAt: ref,
              current: true,
              endedAt: null,
            });
          } else {
            entry.current = true;
            entry.endedAt = null;
          }
        } else if (entry !== undefined && entry.current) {
          entry.current = false;
          entry.endedAt = ref;
        }
        break;
      }
      case "pause":
      case "unpause":
        if (event.fields.agent === agent) firstSeen ??= ref;
        break;
      case "request-swap":
      case "reject-swap":
      case "cancel-swap-request": {
        const request = swapRequestEvent(event);
        if (request === null || request.agent !== agent) break;
        firstSeen ??= ref;
        if (request.kind === "requested") requests.made += 1n;
        else requests[request.kind] += 1n;
        break;
      }
      case "execute-swap":
      case "approve-swap": {
        const swap = swapEvent(event);
        if (swap === null || swap.agent !== agent) break;
        firstSeen ??= ref;
        lastTrade = ref;
        swaps += 1n;
        if (swap.approved) requests.approved += 1n;
        const sold = volume.get(swap.tokenIn);
        if (sold === undefined) {
          volume.set(swap.tokenIn, {
            tokenIn: swap.tokenIn,
            swaps: 1n,
            amountIn: swap.amountIn,
          });
        } else {
          sold.swaps += 1n;
          sold.amountIn += swap.amountIn;
        }
        break;
      }
      default:
        break;
    }
  }

  if (firstSeen === null) return { known: false, agent };
  return {
    known: true,
    agent,
    firstSeen,
    owners: [...owners.values()],
    swaps,
    volume: [...volume.values()],
    lastTrade,
    approvedSwaps: requests.approved,
    requests,
  };
}
