# Error codes

Every `(err uN)` a Keelio contract can return, in one place. Codes never change meaning once listed.

`request-swap` and `approve-swap` run `execute-swap`'s checks through the same code, so where a row
below says `execute-swap`, the same code comes back from them for the same reason: `request-swap`
for `u100`, `u101` and `u108` to `u114`, and `approve-swap` for every `execute-swap` code except
`u126`.

| Contract          | Code   | Constant                       | Meaning                                                                                                                                                                            |
| ----------------- | ------ | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mock-sbtc`       | `u4`   | `ERR-NOT-TOKEN-OWNER`          | The sender does not own the tokens it sent                                                                                                                                         |
| `mock-usd`        | `u4`   | `ERR-NOT-TOKEN-OWNER`          | The sender does not own the tokens it sent                                                                                                                                         |
| `mock-dex`        | `u100` | `ERR-ZERO-AMOUNT`              | The amount in, or the floored amount out, is zero                                                                                                                                  |
| `mock-dex`        | `u101` | `ERR-BELOW-MIN-OUT`            | The output is below the caller's `min-out`                                                                                                                                         |
| `mock-dex`        | `u102` | `ERR-INSUFFICIENT-RESERVES`    | The DEX holds less `token-out` than the swap would send                                                                                                                            |
| `mock-dex`        | `u103` | `ERR-INVALID-RATE`             | The rate numerator or denominator is zero                                                                                                                                          |
| `mock-oracle`     | `u300` | `ERR-ORACLE-DOWN`              | `get-value` while the mock is set to fail (`set-failing true`)                                                                                                                     |
| `bitflow-adapter` | `u200` | `ERR-PAIR-NOT-SUPPORTED`       | `token-in`/`token-out` is not sBTC→USDCx or USDCx→sBTC                                                                                                                             |
| `bitflow-adapter` | `u201` | `ERR-ZERO-AMOUNT`              | `amount-in` is 0                                                                                                                                                                   |
| `bitflow-adapter` | `u202` | `ERR-ZERO-MIN-OUT`             | `min-out` is 0                                                                                                                                                                     |
| `bitflow-adapter` | `u203` | `ERR-DEX-FAILED`               | The Bitflow router returned an error (its own code is not passed through)                                                                                                          |
| `bitflow-adapter` | `u204` | `ERR-PARTIAL-FILL`             | The router spent less than `amount-in`                                                                                                                                             |
| `bitflow-adapter` | `u205` | `ERR-BELOW-MIN-OUT`            | The adapter's measured `token-out` balance rose by less than `min-out`                                                                                                             |
| `bitflow-adapter` | `u206` | `ERR-ALLOWANCE-EXCEEDED`       | A call inside the adapter's `as-contract?` tried to move more than its allowance, or another asset                                                                                 |
| `bitflow-adapter` | `u207` | `ERR-TRANSFER-FAILED`          | A token refused the pull of the input from the caller or the payout to `recipient`                                                                                                 |
| `keelio-vault`    | `u100` | `ERR-ZERO-AMOUNT`              | `deposit`, `withdraw` or `execute-swap` called with amount 0                                                                                                                       |
| `keelio-vault`    | `u101` | `ERR-INSUFFICIENT-BALANCE`     | `withdraw` amount exceeds the caller's ledger balance for that token, or `execute-swap` `amount-in` exceeds the owner's ledger balance of `token-in`                               |
| `keelio-vault`    | `u102` | `ERR-TOKEN-NOT-ALLOWED`        | `deposit` or `withdraw` called with a token outside the vault's fixed token set (`ALLOWED-TOKEN`, `QUOTE-TOKEN`)                                                                   |
| `keelio-vault`    | `u103` | `ERR-AGENT-IS-OWNER`           | `set-agent` called with the caller's own principal as the agent                                                                                                                    |
| `keelio-vault`    | `u104` | `ERR-ALLOWANCE-EXCEEDED`       | `withdraw`'s token transfer tried to move more than `amount` of that token, or `execute-swap`'s adapter call tried to move more than `amount-in` of `token-in`, or any other asset |
| `keelio-vault`    | `u105` | `ERR-INVALID-POLICY`           | `set-token-caps` called with `max-per-day` below `max-per-trade` for that token                                                                                                    |
| `keelio-vault`    | `u106` | `ERR-TOKEN-NOT-SUPPORTED`      | `allow-token`, `set-token-caps` or `set-approval-threshold` called with a token outside the vault's fixed token set                                                                |
| `keelio-vault`    | `u107` | `ERR-ADAPTER-NOT-SUPPORTED`    | `allow-adapter` called with an adapter outside the vault's fixed adapter set                                                                                                       |
| `keelio-vault`    | `u108` | `ERR-NOT-AGENT`                | `execute-swap` caller (`contract-caller`) is not the owner's stored agent, or the owner has no agent                                                                               |
| `keelio-vault`    | `u109` | `ERR-VAULT-PAUSED`             | `execute-swap` called while the owner's vault is paused                                                                                                                            |
| `keelio-vault`    | `u110` | `ERR-POLICY-EXPIRED`           | `execute-swap` called after the policy's `expires-at` burn height (or with no policy, which reads as `expires-at` 0)                                                               |
| `keelio-vault`    | `u111` | `ERR-SWAP-TOKEN-NOT-ALLOWED`   | `execute-swap` `token-in` or `token-out` is outside the fixed token set or not on the owner's list                                                                                 |
| `keelio-vault`    | `u112` | `ERR-SAME-TOKEN`               | `execute-swap` called with the same token in and out                                                                                                                               |
| `keelio-vault`    | `u113` | `ERR-SWAP-ADAPTER-NOT-ALLOWED` | `execute-swap` adapter is outside the fixed adapter set or not on the owner's list                                                                                                 |
| `keelio-vault`    | `u114` | `ERR-TRADE-CAP-EXCEEDED`       | `execute-swap` `amount-in` is above `token-in`'s `max-per-trade` (u0, so any amount, when the owner never set caps for `token-in`)                                                 |
| `keelio-vault`    | `u115` | `ERR-DAY-CAP-EXCEEDED`         | `execute-swap` would take `token-in`'s window total (the owner's `token-in` sold over the last 144 burn blocks) above `token-in`'s `max-per-day`                                   |
| `keelio-vault`    | `u116` | `ERR-COOLDOWN-ACTIVE`          | `execute-swap` called fewer than `cooldown-blocks` burn blocks after the owner's last trade                                                                                        |
| `keelio-vault`    | `u117` | `ERR-ADAPTER-FAILED`           | The adapter's `swap` returned an error (its own code is not passed through)                                                                                                        |
| `keelio-vault`    | `u118` | `ERR-BELOW-MIN-OUT`            | The vault's measured `token-out` balance rose by less than `min-out`, not counting a deposit made during the adapter call                                                          |
| `keelio-vault`    | `u119` | `ERR-PRICE-BOUNDS-UNSET`       | `execute-swap` when the owner's `max-slippage-bps` or `max-price-age` is u0 (never set reads u0). Checked before the oracle is called                                              |
| `keelio-vault`    | `u120` | `ERR-INVALID-PRICE-BOUNDS`     | `set-price-bounds` called with `max-slippage-bps` of 10000 or more                                                                                                                 |
| `keelio-vault`    | `u121` | `ERR-ORACLE-FAILED`            | The oracle's `get-value` returned an error (its own code is not passed through)                                                                                                    |
| `keelio-vault`    | `u122` | `ERR-PRICE-ZERO`               | The oracle's price is 0 (DIA returns 0 for a key it never set)                                                                                                                     |
| `keelio-vault`    | `u123` | `ERR-PRICE-STALE`              | The oracle's timestamp is more than `max-price-age` ms before, or after, `stacks-block-time` × 1000                                                                                |
| `keelio-vault`    | `u124` | `ERR-PRICE-OVERFLOW`           | Computing the oracle floor would pass the largest `uint`                                                                                                                           |
| `keelio-vault`    | `u125` | `ERR-BELOW-ORACLE-FLOOR`       | `execute-swap` `min-out` is below the floor computed from the oracle price, the tokens' decimals and `max-slippage-bps`                                                            |
| `keelio-vault`    | `u126` | `ERR-APPROVAL-REQUIRED`        | `execute-swap` `amount-in` is above the owner's approval threshold for `token-in`. Checked after `u114` and before `u115`. The agent calls `request-swap` instead                  |
| `keelio-vault`    | `u127` | `ERR-APPROVAL-NOT-NEEDED`      | `request-swap` when the owner set no approval threshold for `token-in`, or `amount-in` is at or below it. The agent calls `execute-swap` instead                                   |
| `keelio-vault`    | `u128` | `ERR-REQUEST-PENDING`          | `request-swap` while the owner already has a request that has not expired                                                                                                          |
| `keelio-vault`    | `u129` | `ERR-NO-PENDING-SWAP`          | `approve-swap` or `reject-swap` when the caller has no pending request, or `cancel-swap-request` when `owner` has none                                                             |
| `keelio-vault`    | `u130` | `ERR-REQUEST-EXPIRED`          | `approve-swap` after the request's `expires-at` burn height (`requested-at` + 6)                                                                                                   |
| `keelio-vault`    | `u131` | `ERR-REQUEST-MISMATCH`         | `approve-swap` called with an adapter, `token-in`, `token-out`, `amount-in`, `min-out` or `requested-at` that is not the stored request's                                          |
| `keelio-vault`    | `u132` | `ERR-REQUEST-AGENT-CHANGED`    | `approve-swap` when the agent that made the request is no longer the owner's agent                                                                                                 |
| `keelio-vault`    | `u133` | `ERR-NOT-REQUESTER`            | `cancel-swap-request` caller (`contract-caller`) is not the agent that made the request                                                                                            |

## keelio-vault refusals in plain words

What the owner dashboard prints first when `keelio-vault` refuses a call. The code and the constant
above stay the fact of record; the dashboard shows them beside these words.

| Code   | In plain words                            |
| ------ | ----------------------------------------- |
| `u100` | The amount is zero                        |
| `u101` | More than the vault holds                 |
| `u102` | This vault does not accept that token     |
| `u103` | The agent cannot be the owner             |
| `u104` | Tried to move more than the call allows   |
| `u105` | The day cap is below the trade cap        |
| `u106` | This vault does not support that token    |
| `u107` | This vault does not support that adapter  |
| `u108` | The caller is not the named agent         |
| `u109` | The vault is paused                       |
| `u110` | The policy has expired                    |
| `u111` | A token is not on your swap list          |
| `u112` | Token in and token out are the same       |
| `u113` | The adapter is not on your list           |
| `u114` | Over the per-trade cap                    |
| `u115` | Over the day cap                          |
| `u116` | The cooldown is still running             |
| `u117` | The swap adapter failed                   |
| `u118` | Received less than the minimum out        |
| `u119` | The price bounds are not set              |
| `u120` | The slippage bound is too high            |
| `u121` | The price oracle failed                   |
| `u122` | The oracle price is zero                  |
| `u123` | The oracle price is too old               |
| `u124` | The price calculation overflowed          |
| `u125` | The minimum out is below the oracle floor |
| `u126` | This trade needs the owner's approval     |
| `u127` | This trade does not need approval         |
| `u128` | A request is already waiting              |
| `u129` | There is no request waiting               |
| `u130` | The request has expired                   |
| `u131` | This is not the request that is waiting   |
| `u132` | The agent that asked has been replaced    |
| `u133` | The caller did not make this request      |
