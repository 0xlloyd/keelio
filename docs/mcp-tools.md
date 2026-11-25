# MCP tools

`@keelio/mcp` (`packages/mcp`) is a Model Context Protocol server. An agent connected to it can read a
vault, check a swap against the vault's policy, get an unsigned `execute-swap` call, ask the owner
to approve a trade above their approval threshold, read the journal, look up an agent's history,
get an accountability record, and size a position.

```ts
import { createServer, runStdio, simnetChain } from "@keelio/mcp";

const chain = simnetChain(simnet, deployer);
await runStdio({ chain, read, tx });
```

- `chain` is a `KeelioChain`: the SDK's `ReadOnlyClient` plus `burnHeight()`, `blockTimeMs()` (the
  latest block's `stacks-block-time × 1000`) and `vaultEvents()`. The server never builds one.
  `runStdio` throws `keelio-mcp: a chain client must be injected` without it, or when one of these is
  missing.
- `read` is the SDK's `VaultConfig`: the vault id, the tokens and adapters to read, and the vault's
  deploy constants `oracle`, `sbtcToken` and `priceScale`, which must equal its `ORACLE`,
  `ALLOWED-TOKEN` and `PRICE-SCALE`.
- `tx` is the SDK's `TxConfig` (the full vault id, each token's asset name, and each adapter's route
  in `adapters`, for example `{ [mockDex]: { pool: null } }`).
- `simnetChain(simnet, sender)` is the only `KeelioChain` today. The Clarinet simnet keeps no event
  history, so its journal holds only the calls made through its own `callPublicFn`.

Every tool but `keelio_size_position` and `keelio_agent_history` takes the vault **owner** principal.
Every amount, balance, count and height, in input and output, is a **decimal string** of base units.
The only JSON numbers are `errorCode`, `limit` and an event reference's `index` (its position in
the journal, counted from 0).

Each principal input is read in its canonical spelling. c32 reads `O` as `0` and `I` or `L` as `1`,
so the contract treats `ST1…` and `STI…` as one principal; the tools do too, and echo the canonical
spelling (the one `Cl.prettyPrint` gives) in their output.

The server never signs, sends or holds a key. Its check is advisory: the vault contract enforces
every rule itself.

The server is the agent's tool, so every call it builds is one the agent sends: `execute-swap`,
`request-swap` and `cancel-swap-request`. It builds none of the owner's calls. Approving or
rejecting a request (`approve-swap`, `reject-swap`) and setting the threshold
(`set-approval-threshold`) are the owner's acts, made from the owner's dashboard with the owner's
wallet; the SDK has builders for them (`buildApproveSwap`, `buildRejectSwap`,
`buildSetApprovalThreshold`).

## `keelio_get_vault`

Input: `{ owner }`.

```json
{
  "owner": "ST1…",
  "burnHeight": "147",
  "agent": "ST2…",
  "paused": false,
  "policy": {
    "cooldownBlocks": "0",
    "expiresAt": "1000000",
    "caps": {
      "ST….mock-sbtc": { "maxPerTrade": "100000", "maxPerDay": "1000000000" },
      "ST….mock-usd": { "maxPerTrade": "0", "maxPerDay": "0" }
    },
    "allowedTokens": ["ST….mock-sbtc", "ST….mock-usd"],
    "allowedAdapters": ["ST….mock-dex"]
  },
  "usage": {
    "dayTotals": { "ST….mock-sbtc": "0", "ST….mock-usd": "0" },
    "lastTradeHeight": null
  },
  "balances": { "ST….mock-sbtc": "1000000", "ST….mock-usd": "0" },
  "dayRemaining": { "ST….mock-sbtc": "1000000000", "ST….mock-usd": "0" },
  "approvalThresholds": { "ST….mock-sbtc": "20000", "ST….mock-usd": null },
  "pendingSwap": {
    "agent": "ST2…",
    "adapter": "ST….mock-dex",
    "tokenIn": "ST….mock-sbtc",
    "tokenOut": "ST….mock-usd",
    "amountIn": "50000",
    "minOut": "44550000",
    "requestedAt": "145",
    "expiresAt": "151",
    "expired": false
  }
}
```

- `policy.caps` and `usage.dayTotals` are keyed by input token, in that token's base units. A token
  with caps of `"0"`, which is what a token the owner never set reads as, may not be sold.
- `cooldownBlocks`, `expiresAt` and `lastTradeHeight` are the owner's, shared by both tokens.
- `dayRemaining` has an entry for every token. Each is that token's `maxPerDay - dayTotal`, or
  `"0"` when its `dayTotal >= maxPerDay`.
- `burnHeight` is the height the read was taken at.
- `approvalThresholds` has an entry for every token, keyed by input token. A trade selling more
  than a token's threshold needs the owner's approval: `execute-swap` refuses it with `u126`, and
  the agent sends it as a request (`keelio_build_swap_request`). `null` means the owner set no
  threshold, so no amount needs approval. `"0"` means every trade selling that token does.
- `pendingSwap` is the owner's stored request, or `null`. An owner has at most one. `expiresAt` is
  the last burn height the owner can approve at (`requestedAt` + 6), and `expired` is
  `burnHeight > expiresAt`. The contract keeps an expired request until a new request overwrites
  it, the owner rejects it or the agent withdraws it, so `expired: true` is a normal read. There is
  no separate `keelio_pending_swap` tool: this field is the whole of `get-pending-swap`.
- An owner with no vault gets the empty values (`agent: null`, balances `"0"`, thresholds `null`,
  `pendingSwap: null`), not an error.

## `keelio_check_trade`

Input: `{ owner, agent, adapter, tokenIn, tokenOut, amountIn, minOut }`.

The tool reads the vault, the burn height and the latest block's time, then runs the SDK's
`checkIntent` with `caller = agent`. `agent` must be the vault's agent: any other principal, the owner included, is refused with
`NOT_AGENT`.

- Passes: `{ "ok": true, "burnHeight": "147", "warnings": [] }`.
- Refused:
  `{ "ok": false, "rule": "TRADE_CAP_EXCEEDED", "errorCode": 114, "message": "…", "burnHeight": "147", "suggestion": { … }, "warnings": [] }`.
  `rule` and `errorCode` are listed in [sdk-errors.md](sdk-errors.md#checkintent). A refusal is a
  normal result, not a tool error.

### `suggestion`: a size that would pass

A refusal for size or timing (`u114`, `u126`, `u115`, `u116`, `u101`) also carries `suggestion`,
the SDK's `suggestSize` for `tokenIn`. No other refusal has the key.

```json
{
  "maxAmountIn": "100000",
  "limitedBy": "TRADE_CAP_EXCEEDED",
  "limits": { "perTrade": "100000", "dayRoom": "250000", "balance": "1000000" },
  "cooldownEndsAt": null,
  "dayWindowClearBy": null,
  "approvalThreshold": "20000",
  "maxDirectAmountIn": "20000",
  "directLimitedBy": "APPROVAL_REQUIRED"
}
```

- `maxAmountIn` is the largest `amountIn` that passes the per-trade cap, the day cap and the ledger
  balance at `burnHeight`, the smallest of the three `limits`; `"0"` when none does. `limitedBy` is
  the rule that refuses one more.
- `maxDirectAmountIn` is the largest `amountIn` `execute-swap` accepts from the agent alone: the
  smaller of `maxAmountIn` and `approvalThreshold`. An amount above it, up to `maxAmountIn`, passes
  only with the owner's approval. With no threshold (`approvalThreshold: null`) the two are equal.
  `directLimitedBy` is the rule that refuses `maxDirectAmountIn` plus one.
- `cooldownEndsAt` is the first burn height the cooldown no longer refuses at, or `null` when it is
  not refusing. `dayWindowClearBy` is a height by which the whole day cap is free again if nobody
  trades in between, or `null`.
- The oracle floor rises with the amount, so set `minOut` again for a new `amountIn`.

### `u126`: the trade needs the owner's approval

A trade inside the per-trade cap and above the owner's approval threshold is refused with rule
`APPROVAL_REQUIRED`, `errorCode` 126, and the extra key `"requestNeeded": true`. The agent cannot
send it with `execute-swap`. It either sends a smaller trade (`suggestion.maxDirectAmountIn`) or
builds a request with [`keelio_build_swap_request`](#keelio_build_swap_request).

### `warnings`: how the trade compares with the vault's past

`warnings` is the SDK's `tradeWarnings` for this trade against the journal (`chain.vaultEvents()`),
at `burnHeight` and with the default thresholds. It is on every answer, passing or refused, and is
`[]` when nothing applies. A trade the owner approved (`approve-swap`) counts as a past trade.

| `kind`                     | When                                                             | Other fields                                                  |
| -------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------- |
| `FIRST_TRADE_IN_DIRECTION` | The vault never sold `tokenIn` for `tokenOut`                    | `tokenIn`, `tokenOut`                                         |
| `LARGE_TRADE`              | `amountIn` is more than 3 times the median past amount, same way | `amountIn`, `baseline`, `basis`, `sizeMultiple`, `pastTrades` |
| `BURST`                    | This would be at least the 3rd trade within 6 burn blocks        | `trades`, `burstBlocks`                                       |
| `QUIET_PERIOD`             | The vault's last trade is 1008 burn blocks or more back          | `lastTradeHeight`, `blocksSince`, `quietBlocks`               |

Each warning also has a `message`. Warnings are advisory: they never change `ok`, `rule` or
`errorCode`, and the contract enforces none of them. If the journal cannot be read, the verdict is
returned as usual with `"warnings": null` and the reason in `"warningsError"`.

### What `ok: true` covers

`ok: true` means no policy or oracle rule refuses the trade: the check covers the oracle floor
(`u119` and `u121` to `u125`), so a `minOut` below the oracle price less the owner's max slippage
is refused with `BELOW_ORACLE_FLOOR`. It does not predict `u104` (allowance exceeded), `u117`
(adapter failed) or `u118` (below `min-out`): the contract decides those after it calls the
adapter. The oracle price's age is measured against the latest block's time, while the swap runs
in a later block, so near the owner's max price age the contract can still refuse with `u123`.

## `keelio_build_swap`

Input: `{ owner, agent, adapter, tokenIn, tokenOut, amountIn, minOut }`.

The tool runs the same check as `keelio_check_trade` on every call. Nothing in the input can skip it.

- Refused: the same refusal object as `keelio_check_trade`, `suggestion` and `requestNeeded`
  included, without `warnings` (the build does not read the journal) and with no `call` key.
  Nothing is built. A trade above the owner's approval threshold is refused here with `u126`: build
  it with `keelio_build_swap_request` instead.
- Passes: `{ "ok": true, "burnHeight": "147", "call": { … } }`, where `call` is the SDK's
  `buildExecuteSwap` result in the format below.

The call is unsigned. The agent principal must sign and send it from its own wallet.

### The `call` format

```json
{
  "contractAddress": "ST…",
  "contractName": "keelio-vault",
  "functionName": "execute-swap",
  "functionArgs": ["051a…", "061a…", "…"],
  "functionArgsRepr": ["'ST1…", "'ST….mock-dex", "…", "u10000", "u9000000"],
  "postConditions": [
    {
      "type": "ft-postcondition",
      "address": "ST….keelio-vault",
      "condition": "lte",
      "amount": "10000",
      "asset": "ST….mock-sbtc::mock-sbtc"
    },
    {
      "type": "ft-postcondition",
      "address": "ST….mock-dex",
      "condition": "gte",
      "amount": "9000000",
      "asset": "ST….mock-usd::mock-usd"
    }
  ],
  "postConditionMode": "deny"
}
```

- `functionArgs[i]` is `Cl.serialize(arg)`, the hex consensus encoding.
- `functionArgsRepr[i]` is `Cl.prettyPrint(arg)`, for people only. Never build a call from it.
- A post-condition `amount` is a decimal string. The other fields are those of `@stacks/transactions`.
- The example is for `mock-dex`, whose route in `tx.adapters` is `{ pool: null }`: it pays out from
  its own balance, so the call has two post-conditions. An adapter whose route names a pool (for
  `bitflow-adapter`, `{ pool: "SM1….dlmm-pool-sbtc-usdcx-v-1-bps-10" }`) gets four, in this order:
  the vault sends at most `amountIn` of `tokenIn`, the adapter sends at most `amountIn` of `tokenIn`
  (to the pool), the pool sends at least `minOut` of `tokenOut` (to the adapter), and the adapter
  sends at least `minOut` of `tokenOut` (to the vault). No post-condition names the agent.

To turn it back into `ContractCallOptions` fields:

```ts
import { Cl } from "@stacks/transactions";

const functionArgs = call.functionArgs.map((hex) => Cl.deserialize(hex));
const postConditions = call.postConditions.map((pc) => ({
  ...pc,
  amount: BigInt(pc.amount),
}));
```

## `keelio_build_swap_request`

Input: `{ owner, agent, adapter, tokenIn, tokenOut, amountIn, minOut }`, as for `keelio_build_swap`.

For a trade above the owner's approval threshold. The tool reads the vault and runs the SDK's
`checkRequest` with `caller = agent` on every call: the checks of `request-swap`, in the contract's
order ([sdk-errors.md](sdk-errors.md#checkrequest)). Nothing in the input can skip it.

- Refused: `{ "ok": false, "rule": "APPROVAL_NOT_NEEDED", "errorCode": 127, "message": "…", "burnHeight": "147" }`,
  with no `call` key. The rules a request adds to the policy rules (`u108` to `u114`, `u101`):
  - `APPROVAL_NOT_NEEDED` (`u127`): the owner set no threshold for `tokenIn`, or `amountIn` is at
    or below it. Use `keelio_build_swap`.
  - `REQUEST_PENDING` (`u128`): the owner already has a request that has not expired. An owner has
    one at a time. Wait for the owner, withdraw it with `keelio_build_cancel_request`, or wait for it
    to expire: a request made at burn height H is refused through H + 6 and can be replaced at
    H + 7.
  - A `TRADE_CAP_EXCEEDED` or `INSUFFICIENT_BALANCE` refusal carries `suggestion`, as above.
- Passes: `{ "ok": true, "burnHeight": "147", "call": { … } }`, where `call` is the SDK's
  `buildRequestSwap` result in [the `call` format](#the-call-format): `functionName` is
  `"request-swap"`, the arguments are `execute-swap`'s, and `postConditions` is `[]` with
  `postConditionMode: "deny"`, because a request moves no tokens and any transfer aborts it.

The call is unsigned. The agent signs and sends it from its own wallet; once mined, the request is
stored and `keelio_get_vault` shows it as `pendingSwap`.

`ok: true` means the request would be stored, not that the trade will run. A request moves
nothing and counts against no cap. The swap runs only when the owner calls `approve-swap` within 6
burn blocks of the request, and every check of `execute-swap` except the threshold runs again at
that moment: the day cap, the cooldown, the ledger and the oracle floor against the request's
`minOut`. `minOut` is not checked against the oracle when the request is made, so set it as for a
direct trade. What became of a request:

- **Approved:** `keelio_journal` shows an `approve-swap` event with the trade's amounts and
  `requested-at`, and no `execute-swap` event. `pendingSwap` is `null` again. The owner's approval
  names the request by its trade and its `requested-at`, so withdrawing a request and making it
  again does not keep an approval alive: one signed for the old request is refused with u131.
- **Rejected by the owner:** a `reject-swap` event; `pendingSwap` is `null`.
- **Expired:** no event. `pendingSwap.expired` is `true` from burn height `expiresAt` + 1, and a
  new request can be built.

## `keelio_build_cancel_request`

Input: `{ owner, agent }`. `agent` is the principal that will send the call.

Builds the call that withdraws the owner's stored request, expired or not. The tool runs the SDK's
`checkCancelRequest` first.

- Refused, with no `call` key:
  `{ "ok": false, "rule": "NO_PENDING_SWAP", "errorCode": 129, "message": "…", "burnHeight": "147" }`
  when the owner has no stored request, or rule `NOT_REQUESTER` (`u133`) when `agent` is not the
  agent that made it. Only the requester can withdraw a request, whether or not it is still the
  vault's agent; the owner removes one with `reject-swap`.
- Passes: `{ "ok": true, "burnHeight": "147", "call": { … } }`, the SDK's `buildCancelSwapRequest`
  result: `functionName` `"cancel-swap-request"`, one argument (the owner), no post-conditions,
  deny mode. Unsigned: the agent signs and sends it.

## `keelio_size_position`

Input: `{ capital, riskBps, entry, stop, lotSize }`, all decimal strings. `capital` is in quote
units, `riskBps` is basis points of capital, `entry` and `stop` are quote units per whole asset,
and `lotSize` is in asset base units.

The tool only computes a size, with the SDK's `sizePosition`. It does not read the vault and does
not check the policy, so a size is not permission to trade: run `keelio_check_trade` for that.

- Input:
  `{ "capital": "1000000", "riskBps": "100", "entry": "50000", "stop": "49000", "lotSize": "1" }`
- Success: `{ "ok": true, "quantity": "1000000000", "riskAmount": "10000" }`.
- Zero quantity: when the size rounds down to zero lots the result is still a success,
  `{ "ok": true, "quantity": "0", "riskAmount": "0" }`.
- Refusal: `{ "ok": false, "code": "RISK_ABOVE_CEILING", "message": "…" }`. A refusal is a normal
  result, not a tool error. `code` is one of `NON_POSITIVE_INPUT`, `RISK_ABOVE_CEILING` (above 200
  basis points) or `ENTRY_EQUALS_STOP`, listed in [sdk-errors.md](sdk-errors.md).

A malformed amount is a tool error, as for the other tools (see Errors).

## `keelio_journal`

Input: `{ owner, limit? }`. `limit` is an integer from 1 to 500 and defaults to 50.

Returns `{ owner, events }`: the owner's [journal events](events.md), newest first, at most `limit`.

```json
{
  "owner": "ST1…",
  "events": [
    {
      "burnHeight": "147",
      "event": "execute-swap",
      "adapter": "ST….mock-dex",
      "agent": "ST2…",
      "amount-in": "10000",
      "amount-out": "9000000",
      "balance-in": "990000",
      "balance-out": "9000000",
      "day-total": "10000",
      "min-out": "8910000",
      "min-out-floor": "8910000",
      "oracle-price": "9000000000000",
      "oracle-timestamp": "1763280000000",
      "owner": "ST1…",
      "token-in": "ST….mock-sbtc",
      "token-out": "ST….mock-usd"
    }
  ]
}
```

- The fields keep their kebab-case names from [events.md](events.md).
- A `uint` becomes a decimal string, a principal its string, a `bool` a boolean, an optional
  principal its string or `null`, and a string-ascii its string.
- Other owners' events are left out. An owner with no events gets `events: []`.
- The approval band's events are `set-approval-threshold`, `request-swap`, `approve-swap`,
  `reject-swap` and `cancel-swap-request`. A trade is an `execute-swap` event or an `approve-swap`
  event, never both: count trades from both.

## `keelio_agent_history`

Input: `{ agent }`, the agent principal to look up. It takes no owner: the SDK's `agentHistory`
reads the journal of the whole contract, every owner's events.

```json
{
  "known": true,
  "agent": "ST2…",
  "firstSeen": { "index": 1, "burnHeight": "145", "txId": null },
  "owners": [
    {
      "owner": "ST1…",
      "firstNamedAt": { "index": 1, "burnHeight": "145", "txId": null },
      "current": true,
      "endedAt": null
    }
  ],
  "swaps": "2",
  "volume": [{ "tokenIn": "ST….mock-sbtc", "swaps": "2", "amountIn": "60000" }],
  "lastTrade": { "index": 11, "burnHeight": "146", "txId": null },
  "approvedSwaps": "1",
  "requests": {
    "made": "3",
    "approved": "1",
    "rejected": "1",
    "cancelled": "1"
  }
}
```

- `owners` lists each owner that named the agent with `set-agent`, in the order they first did.
  `current` is whether that owner's latest `set-agent` or `remove-agent` still names it, and
  `endedAt` is the event that ended it.
- `swaps` counts the agent's trades for any owner: the `execute-swap` events it sent and the
  `approve-swap` events of trades it requested. `approvedSwaps` is how many of them an owner
  approved. `volume` is per input token, in the order first sold.
- `requests` counts its `request-swap` events and what became of them. A request that is none of
  approved, rejected or cancelled expired or is still pending.
- An event reference is `{ index, burnHeight, txId }`: `index` is the event's position in the
  contract's journal, a JSON number; `txId` is `null` when the chain reader gives none.
- A principal no event names as an agent returns `{ "known": false, "agent": "ST…" }`, not an
  error. An owner is not an agent.
- The journal holds only calls that succeeded, so refused calls are not counted. A short history
  says little: anyone can make a new principal.

## `keelio_accountability`

Input: `{ owner, limit? }`. `limit` is an integer from 1 to 500 and defaults to 50.

For each of the owner's trades, the limits that were in force when it ran, rebuilt by replaying
the journal with the SDK's `accountabilityRecords`. Returns
`{ owner, totalTrades, records, report }`:

- `totalTrades` is how many trades the journal holds for the owner, a decimal string.
- `records` is the most recent `limit` of them, oldest first, as `accountabilityJson` gives them.
- `report` is the same records as Markdown (`renderAccountabilityReport`), which also reads as
  plain text.

One record:

```json
{
  "swap": {
    "ref": { "index": 11, "burnHeight": "146", "txId": null },
    "owner": "ST1…",
    "agent": "ST2…",
    "adapter": "ST….mock-dex",
    "tokenIn": "ST….mock-sbtc",
    "tokenOut": "ST….mock-usd",
    "amountIn": "50000",
    "minOut": "44550000",
    "amountOut": "45000000",
    "balanceIn": "940000",
    "balanceOut": "54000000",
    "dayTotal": "60000",
    "oraclePrice": "9000000000000",
    "oracleTimestamp": "1763280000000",
    "minOutFloor": "44550000",
    "approved": true,
    "requestedAt": "145"
  },
  "request": { "index": 10, "burnHeight": "145", "txId": null },
  "policy": {
    "agent": { "agent": "ST2…", "setBy": { "index": 1, "burnHeight": "145", "txId": null } },
    "terms": { "cooldownBlocks": "0", "expiresAt": "1000000", "setBy": { … } },
    "caps": { "token": "ST….mock-sbtc", "maxPerTrade": "100000", "maxPerDay": "250000", "setBy": { … } },
    "priceBounds": { "maxSlippageBps": "100", "maxPriceAge": "3600000", "setBy": { … } },
    "approvalThreshold": { "token": "ST….mock-sbtc", "threshold": "20000", "setBy": { … } },
    "tokens": [{ "id": "ST….mock-sbtc", "allowed": true, "setBy": { … } }],
    "adapters": [{ "id": "ST….mock-dex", "allowed": true, "setBy": { … } }]
  },
  "issues": []
}
```

- `swap.approved` is `true` for a trade the agent requested and the owner approved (an
  `approve-swap` event), with `requestedAt` the request's burn height and `request` the
  `request-swap` event it ran. For a trade the agent sent alone (`execute-swap`) they are `false`,
  `null` and `null`. The report prints this as "approved by the owner" or "sent by the agent
  alone".
- `policy.approvalThreshold` is the input token's threshold by the latest `set-approval-threshold`
  for it, with `threshold: null` when that event cleared it. The whole entry is `null` when the
  journal has no such event before the trade: no threshold, so no trade needed approval.
- Every other `policy` entry is `null` when the journal read holds no event that set it.
- `issues` is `[]` when every limit was found and the trade is inside each one. The contract
  cannot accept a trade outside its limits, so an entry (`{ code, message }`) means the journal
  read is incomplete or out of order. The codes are in [sdk-errors.md](sdk-errors.md#journal-helpers).
- The whole journal is replayed whatever the `limit`, so an `index` is always a position in the
  contract's journal. An owner with no trades gets `totalTrades: "0"`, `records: []` and a report
  that says so.

## Errors

A bad input returns a tool result with `isError: true`. Its one text content is the JSON
`{ "error": { "code", "field", "message" } }`, and the same object is in `structuredContent`.
`field` is the input key, for example `"amountIn"`, or `null` for `CHAIN_ERROR`.

| Code                | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INVALID_PRINCIPAL` | `owner` or `agent` is not a standard address or contract id (in any tool that takes one); `adapter`, `tokenIn` or `tokenOut` is not a contract id `ADDR.name`. An address must pass `validateStacksAddress`; a contract name must be a Clarity name of 1 to 40 characters.                                                                                                                                                                                                    |
| `INVALID_AMOUNT`    | `amountIn`, `minOut` or a `keelio_size_position` field does not match `^[0-9]+$` (no sign, decimal point, exponent or whitespace), or is above `2^128 - 1`. `"0"` is valid input: a zero `amountIn` is refused by the check with rule `ZERO_AMOUNT`. `keelio_build_swap` and `keelio_build_swap_request`: `amountIn` or `minOut` above `2^64 - 1` (a post-condition amount must fit u64, and the owner's approval of a request carries both); checked after the policy check. |
| `INVALID_INPUT`     | `limit` is not an integer from 1 to 500, or a required field is missing or has the wrong JSON type.                                                                                                                                                                                                                                                                                                                                                                           |
| `UNKNOWN_ADAPTER`   | `keelio_build_swap`: the server's `tx.adapters` has no route for `adapter`, an adapter the policy allows (from the SDK's `TxBuildError`). `field` is `"adapter"`. The check runs first, so a refused trade still returns its refusal.                                                                                                                                                                                                                                         |
| `UNKNOWN_ASSET`     | `keelio_build_swap`: the server's `tx.assetNames` has no asset name for `tokenIn` or `tokenOut` (from the SDK's `TxBuildError`).                                                                                                                                                                                                                                                                                                                                              |
| `CHAIN_ERROR`       | Anything else that failed, such as a chain read. `message` is the error's message. The server keeps serving.                                                                                                                                                                                                                                                                                                                                                                  |

A field with the wrong JSON type (a number for `amountIn`) or a missing required field (a call
without `minOut`) may be refused by the MCP SDK's own schema check first, as a tool error with a
plain-text message or a rejected call, before these codes apply.
