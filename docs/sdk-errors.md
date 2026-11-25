# SDK error codes

`sizePosition` throws a `SizingError` with one of these stable `code` values. Contract error codes
are in [errors.md](errors.md).

| Code                 | Thrown when                                                         | Meaning                                                                 |
| -------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `NON_POSITIVE_INPUT` | `capital`, `riskBps`, `entry`, `stop` or `lotSize` is `0n` or below | Every input must be above zero. Checked first.                          |
| `RISK_ABOVE_CEILING` | `riskBps` is above `200n`                                           | Risk per trade is capped at 2% of capital. Checked second.              |
| `ENTRY_EQUALS_STOP`  | `entry` equals `stop`                                               | The stop distance is zero, so no size can be worked out. Checked third. |

## `checkIntent`

`checkIntent(state, intent)` returns `{ ok: true }` or `{ ok: false, rule, errorCode, message }`. It
checks in the order `execute-swap` does and returns the first rule that refuses. `errorCode` is the
code the contract returns; see [errors.md](errors.md) for each one.

| Order | `rule`                 | Contract code |
| ----- | ---------------------- | ------------- |
| 1     | `NOT_AGENT`            | `u108`        |
| 2     | `VAULT_PAUSED`         | `u109`        |
| 3     | `POLICY_EXPIRED`       | `u110`        |
| 4     | `TOKEN_NOT_ALLOWED`    | `u111`        |
| 5     | `SAME_TOKEN`           | `u112`        |
| 6     | `ADAPTER_NOT_ALLOWED`  | `u113`        |
| 7     | `ZERO_AMOUNT`          | `u100`        |
| 8     | `TRADE_CAP_EXCEEDED`   | `u114`        |
| 9     | `APPROVAL_REQUIRED`    | `u126`        |
| 10    | `DAY_CAP_EXCEEDED`     | `u115`        |
| 11    | `COOLDOWN_ACTIVE`      | `u116`        |
| 12    | `INSUFFICIENT_BALANCE` | `u101`        |
| 13    | `PRICE_BOUNDS_UNSET`   | `u119`        |
| 14    | `ORACLE_FAILED`        | `u121`        |
| 15    | `PRICE_ZERO`           | `u122`        |
| 16    | `PRICE_STALE`          | `u123`        |
| 17    | `PRICE_OVERFLOW`       | `u124`        |
| 18    | `BELOW_ORACLE_FLOOR`   | `u125`        |

The SDK exports this table as `RULES`, and every rule name's code as `RULE_CODES`.

Rule 9 refuses an `amountIn` above `state.approvalThresholds[tokenIn]`, the owner's approval
threshold for the input token. A `null` or missing entry is no threshold, and never refuses; a
state with no `approvalThresholds` at all reads the same way, so a state built before the band
existed is checked as before. The refusal's message says to send the trade with `request-swap`
instead: see `checkRequest` below.

Rules 13 to 17 are `minOutFloor(state, tokenIn, amountIn)`, which returns `{ ok: true, floor }` or
the refusal. It uses the contract's arithmetic: every product is checked against `2^128 - 1`, and
the floor is rounded up once. Rule 18 refuses an `intent.minOut` below that floor. `minOutFloor`
throws a `RangeError` for a `maxSlippageBps` of `10000` or more, which the contract can never hold.

A refusal by rule 8, 9, 10, 11 or 12 also carries `suggestion`, from `suggestSize(state, tokenIn)`:
`{ maxAmountIn, limitedBy, limits, cooldownEndsAt, dayWindowClearBy, approvalThreshold,
maxDirectAmountIn, directLimitedBy }`. `maxAmountIn` is the largest `amountIn` that passes rules 8,
10 and 12 at `state.burnHeight`, and `0n` when none does. `maxDirectAmountIn` is the largest that
also passes rule 9: the smaller of `maxAmountIn` and `approvalThreshold`, and the largest amount
`execute-swap` accepts from the agent alone. An amount between the two passes only with the owner's
approval. `directLimitedBy` is the rule that refuses `maxDirectAmountIn + 1n`. With no threshold
(`approvalThreshold: null`) the two amounts are equal. No other refusal has the field, and `rule`,
`errorCode` and `message` are as before.

`ok: true` means no rule refuses the trade. It does not predict `u104` (allowance exceeded), `u117`
(adapter failed) or `u118` (below `min-out`): the contract decides those after it calls the
adapter.

The caller supplies two of the inputs:

- `burnHeight`: read `usage` and pass `burnHeight` at the same burn height.
- `nowMs`: `stacks-block-time × 1000` of the block the swap runs in. On the simnet,
  `BigInt(simnet.getBlockTime()) * 1000n` is the latest block's time. Before the swap's block
  exists this is a prediction, so near `maxPriceAge` the contract can still answer `u123` when
  `checkIntent` said `ok: true`, or the reverse.

`readVault` fills `approvalThresholds` from `get-approval-threshold` for each `config.tokens` entry
(`null` for none) and `pendingSwap` from `get-pending-swap` (`null` for none, and returned whether
or not it has expired). Given `{ burnHeight }` as its fourth argument, it sets
`pendingSwap.expired` to `burnHeight > expiresAt`; without one the flag is `null`, because the SDK
has no call for the burn height. `pendingSwapExpired(pendingSwap, burnHeight)` is the same test.

`readVault` fills `priceBounds` from `get-price-bounds` and `oracle.price` from the oracle's
`get-value "BTC/USD"`. `oracle.sbtcToken` and `oracle.priceScale` are copied from `VaultConfig`,
which must match the vault's `ALLOWED-TOKEN` and `PRICE-SCALE`. The contract has no getter for
either, so a wrong value makes `checkIntent` disagree with the contract without any error.

## `checkRequest`

`checkRequest(state, intent)` predicts `request-swap`, the agent's call for a trade above the
owner's approval threshold. It returns `{ ok: true }` or the same refusal shape as `checkIntent`,
checking in the contract's order. The SDK exports the table as `REQUEST_RULES`.

| Order | `rule`                 | Contract code |
| ----- | ---------------------- | ------------- |
| 1     | `NOT_AGENT`            | `u108`        |
| 2     | `VAULT_PAUSED`         | `u109`        |
| 3     | `POLICY_EXPIRED`       | `u110`        |
| 4     | `TOKEN_NOT_ALLOWED`    | `u111`        |
| 5     | `SAME_TOKEN`           | `u112`        |
| 6     | `ADAPTER_NOT_ALLOWED`  | `u113`        |
| 7     | `ZERO_AMOUNT`          | `u100`        |
| 8     | `TRADE_CAP_EXCEEDED`   | `u114`        |
| 9     | `APPROVAL_NOT_NEEDED`  | `u127`        |
| 10    | `INSUFFICIENT_BALANCE` | `u101`        |
| 11    | `REQUEST_PENDING`      | `u128`        |

Rule 9 is the reverse of `checkIntent`'s rule 9: the owner set no threshold for `tokenIn`, or
`amountIn` is at or below it, so the agent sends `execute-swap`. Rule 11 refuses while
`state.pendingSwap` has not expired at `state.burnHeight`: a request made at burn height H is
pending through H + 6, and from H + 7 a new request overwrites it. Rules 8 and 10 carry
`suggestion`.

`ok: true` means the request would be stored. It does not mean the trade will run: `request-swap`
does not check the day cap, the cooldown or the oracle floor, and `minOut` is not compared with the
oracle until the owner approves.

## `checkApproval`

`checkApproval(state, trade)` predicts `approve-swap` for the owner whose vault `state` is. `trade`
is `{ adapter, tokenIn, tokenOut, amountIn, minOut, requestedAt }` (the type `ApprovalTerms`): the
five trade fields and the `requestedAt` of the request the owner read. The caller is the owner, so
there is no `caller`. The SDK exports the first four rules as `APPROVAL_RULES`.

| Order | `rule`                  | Contract code |
| ----- | ----------------------- | ------------- |
| 1     | `NO_PENDING_SWAP`       | `u129`        |
| 2     | `REQUEST_EXPIRED`       | `u130`        |
| 3     | `REQUEST_MISMATCH`      | `u131`        |
| 4     | `REQUEST_AGENT_CHANGED` | `u132`        |

Rule 2 refuses when `state.burnHeight` is above the request's `expiresAt`: a request made at H is
approvable through H + 6 and refused at H + 7. Rule 3 refuses a `trade` that differs from the
stored request in any of its five trade fields or in `requestedAt`, so an approval built for the
request made at one burn height is refused for a later request with the same trade. Take
`requestedAt` from the read the owner reviewed: copied from `state.pendingSwap` at the moment of
the check, it always matches and binds nothing. After rule 4 it runs every rule of `checkIntent` except
`APPROVAL_REQUIRED`, in the same order and through the same code, with the request's agent as the
caller: an approval is checked against the caps, the cooldown, the ledger and the oracle floor as
they stand when the owner approves. As for `checkIntent`, `ok: true` does not predict `u104`,
`u117` or `u118`.

`checkCancelRequest(state, caller)` predicts `cancel-swap-request` (`CANCEL_RULES`):
`NO_PENDING_SWAP` (`u129`) when the owner has no stored request, expired or not, then
`NOT_REQUESTER` (`u133`) when `caller` is not the agent that made it. `reject-swap`, the owner's
call, can only fail with `u129`.

## Transaction builders

The `build*` functions (`buildDeposit`, `buildExecuteSwap` and the others) check their inputs before
building anything and throw a `TxBuildError` with one of these stable `code` values. They do not
repeat the contract's policy rules: the contract refuses those with its own codes, and `checkIntent`
covers swaps.

A built `VaultCall` is JSON-safe: `JSON.parse(JSON.stringify(call))` deep-equals it, because each
post-condition `amount` and each `uint` argument's `value` is a decimal string. The SDK exports the
post-condition bound as `MAX_POST_CONDITION_AMOUNT` (`2n ** 64n - 1n`).

| Code                   | Thrown when                                                                                                                                                                                                                                                                                      | Meaning                                                                                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INVALID_AMOUNT`       | `amount` or `amountIn` is `0n` or below; `minOut`, a policy field, a price bound or an approval threshold is below `0n`; any of them is above `2n ** 128n - 1n` or is not a `bigint` (a threshold may be `null`); `amount` (deposit, withdraw), `amountIn` or `minOut` is above `2n ** 64n - 1n` | Every amount must fit a Clarity `uint`. Amounts that move tokens must also be above zero. Post-condition amounts are u64 on the wire.                                                                                                       |
| `INVALID_PRICE_BOUNDS` | set-price-bounds only: `maxSlippageBps` is `10000n` or more                                                                                                                                                                                                                                      | The contract refuses it with `u120`: at `10000` bps the floor would be 0. `0n` in either field is valid and means "may not trade".                                                                                                          |
| `INVALID_PRINCIPAL`    | `owner` or `agent` is not a valid principal; `config.vault`, `token`, `adapter`, `tokenIn` or `tokenOut` is not a valid contract id `ADDR.name`; in execute-swap, `config.adapters[<adapter>].pool` is not a valid contract id, or equals `config.vault` or the adapter                          | A standard address must pass `validateStacksAddress`. A contract name must be a Clarity name of 1 to 40 characters.                                                                                                                         |
| `UNKNOWN_ADAPTER`      | execute-swap only, after both asset names are found: `config.adapters` is missing, has no own entry for `adapter`, or the entry is not an object whose `pool` is a string or `null`                                                                                                              | The SDK needs each adapter's route (`{ pool: null }` when the adapter pays out from its own balance, or the pool it trades through) to cover every transfer of the swap, and never guesses it. The other builders ignore `config.adapters`. |
| `UNKNOWN_ASSET`        | `config.assetNames` has no own entry for the token a post-condition needs (`token` in deposit and withdraw, `tokenIn` and `tokenOut` in execute-swap), or the entry is not a Clarity name                                                                                                        | The SDK needs each token's `define-fungible-token` name for its post-conditions and never guesses it. `buildAllowToken` needs no asset name.                                                                                                |

The approval band has five builders. Three move nothing, so their calls are in deny mode with no
post-conditions and any transfer aborts them: `buildSetApprovalThreshold(config, { token,
threshold })` (owner; `threshold: null` clears it and `0n` means every trade needs approval),
`buildRequestSwap(config, input)` (agent; `buildExecuteSwap`'s input) and
`buildCancelSwapRequest(config, { owner })` (the agent that made the request), with
`buildRejectSwap(config)` for the owner. `buildRequestSwap` needs no asset name and no adapter
route, and holds `amountIn` and `minOut` to `2n ** 64n - 1n` as `buildExecuteSwap` does, because
the approval of the request carries them in post-conditions. `buildApproveSwap(config, { adapter,
tokenIn, tokenOut, amountIn, minOut, requestedAt })` (owner) moves tokens exactly as `execute-swap`
does, so its post-conditions are `buildExecuteSwap`'s for the same trade, and it throws
`UNKNOWN_ASSET` and `UNKNOWN_ADAPTER` in the same cases. `requestedAt` is the burn height of the
request the owner read (`pendingSwap.requestedAt`), a `bigint` from 0 to `2n ** 128n - 1n`, or it
throws `INVALID_AMOUNT`. It is the call's sixth argument, and the contract refuses with u131 unless
the stored request was made at that height.

`buildLeave` throws the same `TxBuildError`s as the `buildPause` and `buildWithdraw` calls it is
made of. The journal helpers (`parseJournal`, `accountabilityRecords`, `tradeWarnings`,
`agentHistory`) add no error type: they skip what they cannot read and return an empty or
`known: false` result instead of throwing.

## Journal helpers

`accountabilityRecords` gives each trade an `issues` list of `{ code, message }`. It is empty when
every limit was found in the journal and the trade is inside each one. The contract cannot accept a
trade outside its limits, so a code means the journal given is incomplete or out of order.

| Code                      | Meaning                                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `NO_AGENT_EVENT`          | No `set-agent` or `remove-agent` event before the trade                                                     |
| `AGENT_MISMATCH`          | The trade's agent is not the one the latest `set-agent` named                                               |
| `NO_POLICY_EVENT`         | No `set-policy` event before the trade                                                                      |
| `NO_CAPS_EVENT`           | No `set-token-caps` event for the token sold before the trade                                               |
| `NO_PRICE_BOUNDS_EVENT`   | No `set-price-bounds` event before the trade                                                                |
| `TOKEN_IN_NOT_ALLOWED`    | The token sold is not allowed by the events replayed                                                        |
| `TOKEN_OUT_NOT_ALLOWED`   | The token bought is not allowed by the events replayed                                                      |
| `ADAPTER_NOT_ALLOWED`     | The adapter is not allowed by the events replayed                                                           |
| `AFTER_EXPIRY`            | The trade ran after the expiry replayed                                                                     |
| `OVER_TRADE_CAP`          | The amount sold is above the per-trade cap replayed                                                         |
| `OVER_DAY_CAP`            | The window total is above the daily cap replayed                                                            |
| `BELOW_ORACLE_FLOOR`      | The minimum out is below the oracle floor, or less than the minimum arrived                                 |
| `OVER_APPROVAL_THRESHOLD` | An `execute-swap` (sent by the agent alone) sold more than the approval threshold replayed for its token    |
| `NO_REQUEST_EVENT`        | An `approve-swap` whose `request-swap` event, with the same `requested-at`, is not in the journal before it |

A trade is an `execute-swap` event or an `approve-swap` event. `swapEvent` reads both, with
`approved` and `requestedAt` telling them apart, so `tradeWarnings` and `agentHistory` count an
approved trade as a trade. An approved trade above the threshold is not an issue: the approval is
what the threshold asks for. A journal with no `set-approval-threshold` event for the token reads
as no threshold, which is also not an issue.

## Stacks API client

`stacksApiClient({ baseUrl, sender, fetch, timeoutMs })` throws a `StacksApiError` with one of these
stable `code` values, from the builder or from `callReadOnly`. `timeoutMs` (default
`DEFAULT_TIMEOUT_MS`, 10 000) bounds each read, request and body together; at the deadline the
request's `signal` is aborted and the read fails with `HTTP_ERROR`. The error also carries `status` (the HTTP
status, or `null`), `detail` (the node's `cause`, or `null`) and `value` (the decoded `(err …)`, or
`null`). Messages hold the status and URL path only, never the response body or the node's `cause`.

| Code                 | Thrown when                                                                                                                                                                                                                                   | Meaning                                                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `INVALID_OPTION`     | `baseUrl` is not an `http:` or `https:` URL or has a query or fragment, `fetch` is not a function, `timeoutMs` is not a whole number from 1 to `MAX_TIMEOUT_MS` (2^31 - 1), `fn` is not a Clarity name, or an argument is not a Clarity value | The input is refused before any request.                                                                                        |
| `INVALID_PRINCIPAL`  | `sender` is not a Stacks address or contract id, or `contract` is not a full contract id `ADDR.name` (a bare name such as `keelio-vault` is refused)                                                                                          | A contract name must be 1 to 40 characters of letters, digits, `-` and `_`, starting with a letter. Checked before any request. |
| `HTTP_ERROR`         | `fetch` rejects (`status` is `null`, the rejection is `cause`), including a redirect; the read passes `timeoutMs` (`status` is `null`); or the response is not `ok` (`status` is set)                                                         | The node could not be reached or answered with an HTTP error.                                                                   |
| `MALFORMED_RESPONSE` | The body is not JSON, has no boolean `okay`, or has a `result` that is not `0x` hex of one whole Clarity value                                                                                                                                | The node's answer can't be trusted, so nothing is returned.                                                                     |
| `CALL_FAILED`        | The node answers `okay: false`                                                                                                                                                                                                                | The node refused the call, for example for a missing contract. Its `cause` is on `detail`, cut to 200 characters.               |
| `CLARITY_ERROR`      | The decoded result is `(err …)`                                                                                                                                                                                                               | The function returned an error value, which is on `value`.                                                                      |

`simnetClient` returns an `(err …)` result as it is, while `stacksApiClient` throws `CLARITY_ERROR`
for it. No `keelio-vault` read-only function returns a response type. The oracle's `get-value` does,
and `readVault` maps both forms of its `(err …)` to `oracle.price: null`, so it gives the same result
through both clients. Any other failure of the oracle read, such as an `HTTP_ERROR`, still throws.

## MCP tool errors

The `@keelio/mcp` tools return a tool result with `isError: true` and
`{ "error": { "code", "field", "message" } }` instead of throwing. See [mcp-tools.md](mcp-tools.md)
for when each one is returned.

| Code                | Meaning                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INVALID_PRINCIPAL` | A principal input is malformed, or a standard address where a contract id is due                                                                                          |
| `INVALID_AMOUNT`    | An amount is not a decimal string of digits, or is above `2^128 - 1`; for `keelio_build_swap` and `keelio_build_swap_request`, `amountIn` or `minOut` is above `2^64 - 1` |
| `INVALID_INPUT`     | `limit` is out of range, or a field is missing or has the wrong JSON type                                                                                                 |
| `UNKNOWN_ADAPTER`   | The server's `tx.adapters` has no route for `adapter`; `field` is `"adapter"`                                                                                             |
| `UNKNOWN_ASSET`     | The server's `tx.assetNames` has no asset name for `tokenIn` or `tokenOut`                                                                                                |
| `CHAIN_ERROR`       | A chain read or anything else failed; `field` is `null`                                                                                                                   |
