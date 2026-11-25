# Mainnet readiness: `keelio-vault` v0

**Draft, 17 November 2026. Verdict: not ready for real funds.** This report says what is handled,
what is accepted, and what must be true before any real funds are involved. It is a summary: the
evidence is in `docs/threat-model.md`, and where the two disagree the threat model is right.
Deploying is the owner's decision and the owner's action (`docs/frame.md`).

## Where it stands

- Everything runs on the local simnet. Nothing is deployed to testnet or mainnet, and no
  transaction has ever been signed or broadcast.
- `pnpm run check` passes: 913 tests offline, and 28 more against Bitflow's mainnet contract state
  (read only) under `pnpm run test:online`.
- The code was written in two days by an automated pipeline. No one outside the project has
  reviewed it.

## Handled by the contract

Each line is a threat-model row with status "handled" and tests cited by name.

| Threat                                        | What stops it                                                                                  |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| T1: the agent's key is stolen                 | The agent can only swap, inside per-token caps, a cooldown and an expiry. It cannot withdraw.  |
| T2a to T2c, T2e, T2f: the adapter misbehaves  | The vault credits only what arrived, and the adapter's allowance is exactly `amount-in`.       |
| T3: a bad price inside the caps               | `min-out` below the oracle floor, or a stale price, refuses the swap. No path skips the check. |
| T4: a token outside the fixed set             | Refused before it is called.                                                                   |
| T6: burn-height edges of the 144-block window | The window, cooldown and expiry edges are tested block by block.                               |
| T7: the deployer                              | No admin function, no mutable configuration, no upgrade.                                       |
| T8: a stranger or a phishing contract         | Owner and agent are `contract-caller`, never `tx-sender`.                                      |

## Accepted in v0

These are not stopped. An owner who deposits accepts them.

- **A lost owner key (T5).** There is no recovery. The whole ledger is locked for good, and the
  agent keeps trading until `expires-at`.
- **The adapter is trusted with `amount-in` per trade (T2d).** The allowance bounds the amount and
  the asset, not where the adapter sends it.
- **One price source (T3 residuals).** DIA's feed has a single updater key and no confidence band.
  A BTC/USD price does not see sBTC or the quote token lose its peg. Whoever controls the feed
  controls the floor.
- **Loss inside the floor (T3).** Per token, each 144-block window can lose up to
  `max-per-day` × `max-slippage-bps` / 10000 of value at the oracle price.
- **A fixed-set token that turns dishonest (T4)** can break the ledger invariant up to its whole
  vault balance.
- **Stranded tokens (T4).** Tokens sent straight to the vault, not through `deposit`, are lost.
- **An immutable contract.** A flaw cannot be patched. The remedy is that owners withdraw, which
  works while paused, and move to a new contract.

## Must be true before any real funds

None of these is true today.

1. **Independent review.** A reviewer outside the project has read `keelio-vault` and
   `bitflow-adapter`, and every finding is fixed or accepted in writing in this repo. A packet
   for that reviewer is drafted in `docs/review-packet.md`; no reviewer is engaged.
2. **Testnet run.** The vault is deployed to testnet by the owner, with a deposit, a policy, an
   agent swap, a refused swap, a pause and a withdrawal, and the transaction ids are in the repo.
   The simnet does not enforce post-conditions as a node does; a local devnet check covers that
   (`docs/frame.md`), and testnet should confirm it. The owner's steps are in
   `docs/testnet-runbook.md`; none has been run.
3. **The deploy configuration is checked.** `pnpm run check-deploy` passes for the mainnet token,
   adapter and oracle ids, including the price scale against the tokens' decimals.
4. **The live path is exercised on a node.** `bitflow-adapter` has only run on a simulation of
   mainnet state, because Bitflow has no testnet deployment of its pool (`docs/bitflow.md`). The
   first mainnet swap is therefore the first real one. It should be the owner's own, at a size they
   can lose.
5. **The oracle is checked on mainnet.** The DIA key, its decimals and its update cadence are read
   from mainnet on the day, and `max-price-age` is chosen against that cadence.
6. **The T5 decision is revisited.** No recovery was decided for v0 on 16 November 2026, with a
   note to revisit before mainnet.
7. **Deposits are capped at first.** The contract has no global deposit cap. Either add one in the
   mainnet version or state the limit as guidance and accept that the contract will not enforce it.
8. **Owners can act without writing code.** A dashboard or wallet flow exists for deposit, policy,
   pause and withdraw, and shows each call's post-conditions before signing.
   Still unmet. What exists: `apps/dashboard` does all of this on a simnet in the page, and a
   testnet session for it is built. What does not: that session has only run against a stand-in
   wallet and recorded API replies. Met when an owner completes the flow on testnet with a real
   wallet and sees the post-conditions in it.
9. **Someone watches it.** The journal is read by a monitor that alerts on swaps, refusals and a
   stale oracle, and there is a written plan for telling owners to withdraw if a flaw is found.
   Still unmet. What exists (`docs/monitoring.md`): a monitor, `packages/monitor`, that raises
   those alerts and others on the simnet, with a test for each, and a runner
   (`pnpm run monitor`) that keeps its cursor across restarts and writes alerts to stdout only.
   What does not: it has never read a deployed vault, because there is none, and its Stacks API
   reader is tested only against replies recorded from another contract; no one runs it or
   receives its alerts; and the withdrawal plan is a draft whose decision-maker, contact
   channels and timings are all still `[TO FILL]`. Met when it runs against the deployed vault,
   its output reaches a person, and the plan is filled in by the owner.
10. **The legal position is known.** Whether offering the vault to others has regulatory
    consequences where the owner operates is the owner's question to settle, not the repo's.

## Open follow-ups

Listed in `docs/threat-model.md`, "Follow-ups": wider oracle checks, the oracle price in the
journal and a way to recover stranded tokens.
