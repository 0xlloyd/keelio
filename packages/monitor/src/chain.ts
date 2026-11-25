import {
  simnetChain,
  type KeelioChain,
  type SimnetChain,
  type SimnetChainLike,
} from "@keelio/mcp";
import type { ClarityValue } from "@stacks/transactions";

/**
 * A call to a public function of the vault contract that did not succeed. A
 * refused call prints nothing, so it is never in the journal: on a network it
 * is a failed transaction whose contract call names the vault.
 */
export interface RefusedCall {
  burnHeight: bigint;
  /** The principal that sent the call. */
  sender: string;
  functionName: string;
  args: readonly ClarityValue[];
  /**
   * `response` when the function returned `(err …)`; `post-condition` when
   * the transaction was aborted by a post-condition instead.
   */
  reason: "response" | "post-condition";
  /** The function's result. Not an `(err …)` for a post-condition abort. */
  result: ClarityValue;
  /** The transaction id on a network, `null` on the simnet. */
  txId: string | null;
}

/** What the monitor reads from a chain. Injected; the monitor builds none. */
export interface MonitorChain extends KeelioChain {
  /**
   * The vault's full contract id, `ADDR.name`: the principal whose token
   * balances `LEDGER_SHORTFALL` reads. `VaultConfig.vault` will not do, as
   * on the simnet it may be the bare contract name.
   */
  readonly vault: string;
  /**
   * Every failed call made straight to the vault contract, oldest first. A
   * call that reaches the vault through another contract is not listed.
   */
  vaultRefusals(): readonly RefusedCall[] | Promise<readonly RefusedCall[]>;
}

export interface SimnetMonitorChain extends MonitorChain {
  /**
   * Calls `simnet.callPublicFn`. A vault call that returns `(ok …)` has its
   * print events journalled; one that returns `(err …)` is recorded as a
   * refusal. Calls made on the simnet directly are seen by neither.
   */
  callPublicFn: SimnetChain["callPublicFn"];
}

/**
 * A `MonitorChain` over the Clarinet simnet: `simnetChain` from `@keelio/mcp`
 * plus a record of the refused vault calls. `vault` is the vault's full
 * contract id, `${simnet.deployer}.keelio-vault` by default.
 */
export function monitorSimnetChain(
  simnet: SimnetChainLike,
  sender: string,
  vault = `${simnet.deployer}.keelio-vault`,
): SimnetMonitorChain {
  const inner = simnetChain(simnet, sender, vault);
  const refusals: RefusedCall[] = [];
  return {
    vault,
    callReadOnly: inner.callReadOnly,
    burnHeight: inner.burnHeight,
    blockTimeMs: inner.blockTimeMs,
    vaultEvents: inner.vaultEvents,
    vaultRefusals: () => [...refusals],
    callPublicFn(contract, fn, args, from) {
      const burnHeight = BigInt(simnet.burnBlockHeight);
      const res = inner.callPublicFn(contract, fn, args, from);
      // The simnet takes a bare name for a contract of its deployer.
      const id = contract.includes(".")
        ? contract
        : `${simnet.deployer}.${contract}`;
      if (id === vault && res.result.type === "err") {
        refusals.push({
          burnHeight,
          sender: from,
          functionName: fn,
          args: [...args],
          reason: "response",
          result: res.result,
          txId: null,
        });
      }
      return res;
    },
  };
}
