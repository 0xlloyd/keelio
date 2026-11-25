import {
  buildPause,
  buildWithdraw,
  MAX_POST_CONDITION_AMOUNT,
  type TxConfig,
  type VaultCall,
} from "./build-tx.js";
import type { Balances } from "./vault.js";

// Leaving in one action: the calls an owner signs, in order, to stop the
// agent and take every token out. Built with the SDK's own builders, so each
// call carries their post-conditions. Nothing here signs or sends.

/** One call of the leave sequence. */
export type LeaveStep =
  | { kind: "pause"; call: VaultCall }
  | {
      kind: "withdraw";
      token: string;
      /** The amount this call withdraws, in the token's base units. */
      amount: bigint;
      call: VaultCall;
    };

/**
 * The ordered calls that stop the agent and empty the owner's ledger:
 * `pause` first, then one `withdraw` of the full balance for each token in
 * `read.balances` whose balance is above zero, in that record's order. A
 * zero balance produces no call, so an empty vault gives the `pause` alone.
 * A balance above `MAX_POST_CONDITION_AMOUNT` (2^64 - 1) is split into
 * several withdrawals, because one post-condition cannot carry more.
 *
 * The owner signs and sends them in order. The amounts are the balances as
 * read: if the agent trades before the `pause` is mined they are stale, and
 * a withdrawal above the ledger is refused with u101 while one below it
 * leaves the rest. Read the vault again once the `pause` is mined and build
 * again; `pause` never fails, so repeating it is safe.
 *
 * Throws a `TxBuildError` as `buildPause` and `buildWithdraw` do: for a
 * malformed `config.vault` or token id, a token with no asset name, or a
 * balance that is not a `bigint` or is below zero.
 */
export function buildLeave(
  config: TxConfig,
  read: { balances: Balances },
): LeaveStep[] {
  const steps: LeaveStep[] = [{ kind: "pause", call: buildPause(config) }];
  for (const [token, balance] of Object.entries(read.balances)) {
    if (balance === 0n) continue;
    let left = balance;
    do {
      const amount =
        left > MAX_POST_CONDITION_AMOUNT ? MAX_POST_CONDITION_AMOUNT : left;
      // buildWithdraw refuses a non-bigint or negative amount.
      const call = buildWithdraw(config, { token, amount });
      steps.push({ kind: "withdraw", token, amount, call });
      left -= amount;
    } while (left > 0n);
  }
  return steps;
}
