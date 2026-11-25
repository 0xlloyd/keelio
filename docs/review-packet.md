# Review packet: `keelio-vault` and `bitflow-adapter`

**Draft, 17 November 2026.** For an independent reviewer. It says what to review, how to run it,
what we claim, and where we think the claims are weakest. No one outside the project has reviewed
this code yet; that review is a roadmap milestone and item 1 of `docs/mainnet-readiness.md`.

`[TO FILL: reviewer, dates, the commit hash under review, and how findings are sent.]`

## Scope

| File                                      | Lines | Clarity | In scope                                  |
| ----------------------------------------- | ----- | ------- | ----------------------------------------- |
| `contracts/keelio-vault.clar`             | 1003  | 6       | Yes. The product.                         |
| `contracts/adapters/bitflow-adapter.clar` | 177   | 4       | Yes. The one live adapter.                |
| `contracts/traits/*.clar`                 | 31    | 3       | Yes, as interfaces.                       |
| `contracts/mocks/*`, `contracts/probes/*` |       |         | No. Test fixtures. Read them as evidence. |
| `packages/sdk`, `packages/mcp`            |       |         | Second priority. See "Off-chain" below.   |

Nothing is deployed. Everything runs on the Clarinet simnet. `bitflow-adapter` runs on a simnet
that reads Bitflow's mainnet contract state at a pinned height (`docs/bitflow.md`).

## Run it

```bash
pnpm install
pnpm run check         # format, lint, types, all offline tests, the site build
pnpm run test:online   # the Bitflow adapter against mainnet contract state, read only
pnpm run demo          # the owner, the agent and three refusals
pnpm run check-deploy  # the deploy configuration check
```

Node 22.18 or later and pnpm. No key, no account and, apart from `test:online`, no network.

## The contract in one page

One contract, one ledger per owner. Public functions:

| Function                       | Who may call it             | Moves tokens |
| ------------------------------ | --------------------------- | ------------ |
| `deposit`, `withdraw`          | Anyone, on their own ledger | Yes          |
| `set-agent`, `remove-agent`    | Anyone, on their own ledger | No           |
| `pause`, `unpause`             | Anyone, on their own ledger | No           |
| `set-policy`, `set-token-caps` | Anyone, on their own ledger | No           |
| `allow-token`, `allow-adapter` | Anyone, on their own ledger | No           |
| `set-price-bounds`             | Anyone, on their own ledger | No           |
| `execute-swap (owner …)`       | The agent that owner named  | Yes          |

`execute-swap` is the only state-changing function that takes an owner argument. The caller is
always `contract-caller`, never `tx-sender`. There is no admin, no data var for configuration and
no upgrade path. The tokens, the adapter, the oracle and the price scale are seven constants in one
block at the top of the file (`docs/clarity-4.md`, "Deploy note").

Every call to a token or the adapter runs inside `as-contract?` with an allowance of exactly the
amount in question. The vault credits a swap by the change in its own token balance, not by what
the adapter returns.

## What we claim

These are the claims to break. Each has tests, cited by name in `docs/threat-model.md`.

1. **The agent cannot take funds out.** No sequence of calls by the agent moves an owner's tokens
   anywhere but through the fixed adapter, as a swap, inside the policy.
2. **Only the owner withdraws, and always can.** Paused or not, with or without an agent, whatever
   the policy says.
3. **The caps hold.** Per token: no trade above `max-per-trade`, and no 144-burn-block window
   above `max-per-day`. The cooldown and the expiry hold at their edge blocks.
4. **No swap settles below the oracle floor.** `min-out` below the oracle price less
   `max-slippage-bps` is refused, a stale price is refused, unset bounds are refused, and the vault
   refuses a swap that returns less than `min-out`. No path skips the check.
5. **The adapter can move at most `amount-in` of the input token** and nothing else, and cannot
   make the vault credit more than arrived.
6. **One owner cannot touch another's ledger**, directly or through a contract a user is lured
   into calling.
7. **The sum of the ledgers for a token never exceeds the vault's balance of it**, given tokens in
   the fixed set behave as SIP-010 tokens.
8. **Error codes are stable and distinct.** Each `(err uN)` is one named constant, listed in
   `docs/errors.md`; an adapter's error is never readable as a vault code.

Evidence beyond the unit tests: `tests/keelio-vault-property.test.ts` runs 200 seeded random call
sequences by the owner, the agent and two strangers and checks claims 1, 3, 4 and 7 after every
call. `tests/keelio-vault-mutants.test.ts` removes each rule from a copy of the vault in turn and
shows the run catches it.

## What we accept, and want checked

Listed in full in `docs/threat-model.md` and `docs/mainnet-readiness.md`. In short: a lost owner
key locks the ledger (T5); the adapter is trusted with `amount-in` per trade (T2d); one price
source with one updater key, no confidence band and no peg check (T3); loss up to
`max-per-day` × `max-slippage-bps` / 10000 per token per window inside the floor; a fixed-set token
that turns dishonest; tokens sent straight to the vault are stranded; the contract cannot be
patched.

Tell us if any of these is worse than stated, or if one we call handled belongs here.

## Where we would look first

We wrote this code quickly, with an automated pipeline. These are the places we trust least.

- **`as-contract?` allowances.** Clarity 6 is new. `docs/clarity-4.md` and
  `docs/clarity-version.md` record what we observed on the simnet; we have not seen it on a node.
  Is `with-ft` with the asset name constants the right bound in every call, and does a failed
  allowance always roll back as we assume?
- **Balance-delta accounting in `execute-swap`.** The order of the balance reads, the adapter call
  and the ledger writes, and what a token with a transfer hook or a callback (T2e) could do between
  them.
- **Oracle arithmetic.** The floor in both directions, rounding in the owner's favour,
  `PRICE-SCALE`, overflow (`ERR-PRICE-OVERFLOW`) and a timestamp ahead of the block.
- **The 144-block window.** How the rolling window drops old entries, and the boundary figure the
  threat model states for T6: up to 2 × `max-per-day` within 145 consecutive burn blocks. Check
  that figure is the true worst case.
- **`bitflow-adapter`.** It receives the input from the vault, swaps as itself and forwards the
  output. Check the pool and router are fixed, nothing can be left in the adapter for someone else
  to take, and a partial fill is handled.
- **`contract-caller` everywhere.** Any place `tx-sender` would have been safer, or where the two
  differ in a way we missed.
- **The deploy configuration.** What `pnpm run check-deploy` cannot see, and what a wrong constant
  does after deployment.

## Off-chain

`checkIntent` in `packages/sdk` repeats the contract's checks so an agent can avoid paying for a
refused call. It is advisory: nothing off-chain counts as handling a threat. The useful question
there is whether a call built by the SDK can carry post-conditions that are looser than the call
needs, or that a wallet would show misleadingly. `tests/sdk-build-tx.test.ts` holds what we assert.

## What we will do with findings

Each finding gets an issue, and is either fixed with a test that fails without the fix, or
accepted in writing with the worst case in base units. The findings and our answers are published
in this repo. `[TO FILL: where, and by when.]`
