# Journal events

Every successful public call on `keelio-vault` prints exactly one tuple. Together they are the vault's
journal. A call that returns an error prints nothing, so the journal holds only what happened.

- `event` is the first field of every tuple and is a string.
- `owner` is the vault owner: the `contract-caller` of `deposit`, `withdraw`, `set-agent`,
  `remove-agent`, `pause`, `unpause`, `set-policy`, `set-token-caps`, `allow-token`, `allow-adapter`,
  `set-price-bounds`, `set-approval-threshold`, `approve-swap` and `reject-swap`. For `execute-swap`,
  `request-swap` and `cancel-swap-request` it is the owner whose vault the call is about, and the
  caller is the agent.
- Amounts and balances are `uint` in base units.
- The tokens print nothing for a transfer without a memo, so each event is the only print in its call.

## `deposit`

Prints when the owner moves a token into the vault.

| Field     | Type      | Meaning                                   |
| --------- | --------- | ----------------------------------------- |
| `event`   | string    | `"deposit"`                               |
| `owner`   | principal | The vault owner                           |
| `token`   | principal | The token contract                        |
| `amount`  | uint      | Amount deposited                          |
| `balance` | uint      | The owner's ledger balance after the call |

## `withdraw`

Prints when the owner takes a token out of the vault.

| Field     | Type      | Meaning                                   |
| --------- | --------- | ----------------------------------------- |
| `event`   | string    | `"withdraw"`                              |
| `owner`   | principal | The vault owner                           |
| `token`   | principal | The token contract                        |
| `amount`  | uint      | Amount withdrawn                          |
| `balance` | uint      | The owner's ledger balance after the call |

## `set-agent`

Prints when the owner names an agent, replacing any earlier one. The `paused` flag is kept.

| Field    | Type               | Meaning                      |
| -------- | ------------------ | ---------------------------- |
| `event`  | string             | `"set-agent"`                |
| `owner`  | principal          | The vault owner              |
| `agent`  | optional principal | The new agent, always `some` |
| `paused` | bool               | The vault's paused flag      |

## `remove-agent`

Prints when the owner removes the agent. It never fails, and it prints again if there was no agent.

| Field    | Type               | Meaning                 |
| -------- | ------------------ | ----------------------- |
| `event`  | string             | `"remove-agent"`        |
| `owner`  | principal          | The vault owner         |
| `agent`  | optional principal | Always `none`           |
| `paused` | bool               | The vault's paused flag |

## `pause`

Prints when the owner stops the agent. It never fails and prints again if already paused.

| Field    | Type               | Meaning                   |
| -------- | ------------------ | ------------------------- |
| `event`  | string             | `"pause"`                 |
| `owner`  | principal          | The vault owner           |
| `agent`  | optional principal | The current agent, if any |
| `paused` | bool               | Always `true`             |

## `unpause`

Prints when the owner lets the agent trade again. It never fails and prints again if not paused.

| Field    | Type               | Meaning                   |
| -------- | ------------------ | ------------------------- |
| `event`  | string             | `"unpause"`               |
| `owner`  | principal          | The vault owner           |
| `agent`  | optional principal | The current agent, if any |
| `paused` | bool               | Always `false`            |

## `set-policy`

Prints when the owner sets their cooldown and expiry, which both tokens share. It never touches any
token's caps: those come from `set-token-caps`. Together the two events carry every field the
single `set-policy` event carried before job 026.

| Field             | Type      | Meaning                                                   |
| ----------------- | --------- | --------------------------------------------------------- |
| `event`           | string    | `"set-policy"`                                            |
| `owner`           | principal | The vault owner                                           |
| `cooldown-blocks` | uint      | Burn blocks required between trades, in either token      |
| `expires-at`      | uint      | Last burn height the agent may trade at, for either token |

## `set-token-caps`

Prints when the owner sets one token's caps. It never touches the cooldown, the expiry or the other
token's caps.

| Field           | Type      | Meaning                                    |
| --------------- | --------- | ------------------------------------------ |
| `event`         | string    | `"set-token-caps"`                         |
| `owner`         | principal | The vault owner                            |
| `token`         | principal | The token the two caps belong to           |
| `max-per-trade` | uint      | Cap on `amount-in` of `token` for one swap |
| `max-per-day`   | uint      | Cap on `token` sold over 144 burn blocks   |

## `allow-token`

Prints when the owner allows or revokes one token for swaps.

| Field     | Type      | Meaning                            |
| --------- | --------- | ---------------------------------- |
| `event`   | string    | `"allow-token"`                    |
| `owner`   | principal | The vault owner                    |
| `token`   | principal | The token contract                 |
| `allowed` | bool      | `true` to allow, `false` to revoke |

## `allow-adapter`

Prints when the owner allows or revokes one swap adapter.

| Field     | Type      | Meaning                            |
| --------- | --------- | ---------------------------------- |
| `event`   | string    | `"allow-adapter"`                  |
| `owner`   | principal | The vault owner                    |
| `adapter` | principal | The adapter contract               |
| `allowed` | bool      | `true` to allow, `false` to revoke |

## `set-price-bounds`

Prints when the owner sets how far below the oracle price a swap may settle and how old the price
may be. Either may be `u0`, which means the agent may not trade.

| Field              | Type      | Meaning                                                        |
| ------------------ | --------- | -------------------------------------------------------------- |
| `event`            | string    | `"set-price-bounds"`                                           |
| `owner`            | principal | The vault owner                                                |
| `max-slippage-bps` | uint      | The floor's discount from the oracle's reference value, in bps |
| `max-price-age`    | uint      | The most the oracle's timestamp may differ from block time, ms |

## `execute-swap`

Prints when the agent completes a swap, after the output has been checked against `min-out`. The
last three fields are what the oracle floor check used, read once in the same call, so the check can
be redone from the journal: `min-out` is never below `min-out-floor`.

| Field              | Type      | Meaning                                                                      |
| ------------------ | --------- | ---------------------------------------------------------------------------- |
| `event`            | string    | `"execute-swap"`                                                             |
| `owner`            | principal | The vault owner whose ledger is traded                                       |
| `agent`            | principal | The agent that called                                                        |
| `adapter`          | principal | The adapter contract                                                         |
| `token-in`         | principal | The token sold                                                               |
| `token-out`        | principal | The token bought                                                             |
| `amount-in`        | uint      | Amount of `token-in` actually spent                                          |
| `min-out`          | uint      | The agent's minimum output                                                   |
| `amount-out`       | uint      | Amount of `token-out` that arrived                                           |
| `balance-in`       | uint      | The owner's ledger of `token-in` after the call                              |
| `balance-out`      | uint      | The owner's ledger of `token-out` after the call                             |
| `day-total`        | uint      | `token-in` spent in the current 144-block window, this trade included        |
| `oracle-price`     | uint      | The oracle's BTC/USD price the floor check read, 8 decimals                  |
| `oracle-timestamp` | uint      | That price's timestamp from the oracle, ms                                   |
| `min-out-floor`    | uint      | The least `min-out` the vault would have accepted, in `token-out` base units |

## `set-approval-threshold`

Prints when the owner sets or clears the amount of one input token above which a trade needs their
approval. Clearing prints too, also when nothing was set.

| Field       | Type          | Meaning                                                                |
| ----------- | ------------- | ---------------------------------------------------------------------- |
| `event`     | string        | `"set-approval-threshold"`                                             |
| `owner`     | principal     | The vault owner                                                        |
| `token`     | principal     | The input token the threshold belongs to                               |
| `threshold` | optional uint | `some`: a trade selling more than this needs approval. `none`: no band |

## `request-swap`

Prints when the agent records a trade that is above the owner's approval threshold. Nothing moves
and nothing is counted against the caps. The fields after `owner` are the stored request, which
`get-pending-swap` returns.

| Field          | Type      | Meaning                                                                   |
| -------------- | --------- | ------------------------------------------------------------------------- |
| `event`        | string    | `"request-swap"`                                                          |
| `owner`        | principal | The vault owner whose ledger would be traded                              |
| `agent`        | principal | The agent that called                                                     |
| `adapter`      | principal | The adapter contract                                                      |
| `token-in`     | principal | The token to sell                                                         |
| `token-out`    | principal | The token to buy                                                          |
| `amount-in`    | uint      | Amount of `token-in` to sell                                              |
| `min-out`      | uint      | The agent's minimum output; not checked against the oracle until approval |
| `requested-at` | uint      | The burn height of the request                                            |
| `expires-at`   | uint      | The last burn height the owner can approve at: `requested-at` + 6         |

## `approve-swap`

Prints when the owner approves their pending request and the swap completes. The caller is the
owner. It carries every field of `execute-swap`, with the same meanings and read in this call, plus
`requested-at`. The call's arguments are the trade's five fields and `requested-at`, and the call
runs only if all six are the stored request's (u131), so the event's `requested-at` is the one the
owner signed. An approved trade prints this event and no `execute-swap` event, so a reader of the
journal counts trades from both.

| Field              | Type      | Meaning                                                                      |
| ------------------ | --------- | ---------------------------------------------------------------------------- |
| `event`            | string    | `"approve-swap"`                                                             |
| `owner`            | principal | The vault owner, who approved                                                |
| `agent`            | principal | The agent that made the request                                              |
| `adapter`          | principal | The adapter contract                                                         |
| `token-in`         | principal | The token sold                                                               |
| `token-out`        | principal | The token bought                                                             |
| `amount-in`        | uint      | Amount of `token-in` actually spent                                          |
| `min-out`          | uint      | The request's minimum output                                                 |
| `amount-out`       | uint      | Amount of `token-out` that arrived                                           |
| `balance-in`       | uint      | The owner's ledger of `token-in` after the call                              |
| `balance-out`      | uint      | The owner's ledger of `token-out` after the call                             |
| `day-total`        | uint      | `token-in` spent in the current 144-block window, this trade included        |
| `oracle-price`     | uint      | The oracle's BTC/USD price the floor check read at approval, 8 decimals      |
| `oracle-timestamp` | uint      | That price's timestamp from the oracle, ms                                   |
| `min-out-floor`    | uint      | The least `min-out` the vault would have accepted, in `token-out` base units |
| `requested-at`     | uint      | The burn height of the request this approval ran                             |

## `reject-swap`

Prints when the owner removes their pending request without running it, expired or not. The fields
are the removed request's, as in `request-swap`.

| Field          | Type      | Meaning                              |
| -------------- | --------- | ------------------------------------ |
| `event`        | string    | `"reject-swap"`                      |
| `owner`        | principal | The vault owner, who rejected        |
| `agent`        | principal | The agent that made the request      |
| `adapter`      | principal | The request's adapter contract       |
| `token-in`     | principal | The request's token to sell          |
| `token-out`    | principal | The request's token to buy           |
| `amount-in`    | uint      | The request's amount of `token-in`   |
| `min-out`      | uint      | The request's minimum output         |
| `requested-at` | uint      | The burn height of the request       |
| `expires-at`   | uint      | The request's last approvable height |

## `cancel-swap-request`

Prints when the agent that made a request withdraws it, expired or not. The fields are the removed
request's, as in `request-swap`.

| Field          | Type      | Meaning                                         |
| -------------- | --------- | ----------------------------------------------- |
| `event`        | string    | `"cancel-swap-request"`                         |
| `owner`        | principal | The vault owner the request was for             |
| `agent`        | principal | The agent that made the request and withdrew it |
| `adapter`      | principal | The request's adapter contract                  |
| `token-in`     | principal | The request's token to sell                     |
| `token-out`    | principal | The request's token to buy                      |
| `amount-in`    | uint      | The request's amount of `token-in`              |
| `min-out`      | uint      | The request's minimum output                    |
| `requested-at` | uint      | The burn height of the request                  |
| `expires-at`   | uint      | The request's last approvable height            |
