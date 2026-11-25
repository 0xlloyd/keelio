import {
  simnetClient,
  type ReadOnlyClient,
  type SimnetLike,
} from "@keelio/sdk";
import type { ClarityValue } from "@stacks/transactions";

/** One print event of the vault contract. */
export interface JournalRecord {
  burnHeight: bigint;
  /** The print tuple. */
  value: ClarityValue;
}

/** What the MCP tools read from a chain. Injected; never built by the server. */
export interface KeelioChain extends ReadOnlyClient {
  burnHeight(): bigint | Promise<bigint>;
  /**
   * `stacks-block-time * 1000` of the latest block. A swap runs in a later
   * block, so this is the oracle check's best guess at its time.
   */
  blockTimeMs(): bigint | Promise<bigint>;
  /** The vault contract's print events, oldest first. */
  vaultEvents(): readonly JournalRecord[] | Promise<readonly JournalRecord[]>;
}

/** A contract event as the Clarinet simnet reports it. */
export interface SimnetEvent {
  event: string;
  data: { contract_identifier?: string; value?: ClarityValue };
}

/** The values `vault` printed, in order, among one simnet call's events. */
export function vaultPrints(
  events: readonly SimnetEvent[],
  vault: string,
): ClarityValue[] {
  return events.flatMap((e) =>
    e.event === "print_event" &&
    e.data.contract_identifier === vault &&
    e.data.value !== undefined
      ? [e.data.value]
      : [],
  );
}

/** The part of the Clarinet simnet that `simnetChain` uses. */
export interface SimnetChainLike extends SimnetLike {
  readonly deployer: string;
  readonly burnBlockHeight: number;
  /** The latest block's `stacks-block-time`, in seconds. */
  getBlockTime(): bigint | number;
  callPublicFn(
    contract: string,
    fn: string,
    args: ClarityValue[],
    sender: string,
  ): { result: ClarityValue; events: SimnetEvent[] };
}

export interface SimnetChain extends KeelioChain {
  /**
   * Calls `simnet.callPublicFn` and, when the result is `(ok …)`, records the
   * vault contract's print events at the burn height of the call.
   */
  callPublicFn(
    contract: string,
    fn: string,
    args: ClarityValue[],
    sender: string,
  ): { result: ClarityValue; events: SimnetEvent[] };
}

/**
 * A `KeelioChain` over the Clarinet simnet. The simnet keeps no event history,
 * so the journal holds only the calls made through this object's
 * `callPublicFn`; calls made on the simnet directly are missing from it.
 *
 * `vault` is the vault's full contract id, `${simnet.deployer}.keelio-vault` by
 * default. Only print events from that contract are recorded.
 */
export function simnetChain(
  simnet: SimnetChainLike,
  sender: string,
  vault = `${simnet.deployer}.keelio-vault`,
): SimnetChain {
  const reader = simnetClient(simnet, sender);
  const journal: JournalRecord[] = [];
  return {
    callReadOnly: reader.callReadOnly,
    burnHeight: () => BigInt(simnet.burnBlockHeight),
    blockTimeMs: () => BigInt(simnet.getBlockTime()) * 1000n,
    vaultEvents: () => [...journal],
    callPublicFn(contract, fn, args, from) {
      const burnHeight = BigInt(simnet.burnBlockHeight);
      const res = simnet.callPublicFn(contract, fn, args, from);
      if (res.result.type === "ok") {
        for (const value of vaultPrints(res.events, vault)) {
          journal.push({ burnHeight, value });
        }
      }
      return res;
    },
  };
}
