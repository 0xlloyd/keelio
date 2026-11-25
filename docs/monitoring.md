# Monitoring: the journal monitor

`packages/monitor` reads the vault's journal and the calls the vault refused, and turns them into
alerts. It is the "someone watches it" tool of `docs/mainnet-readiness.md`, item 9. It only reads:
it never signs or broadcasts a transaction, holds no key, and sends nothing anywhere: alerts go to
stdout, and the owner digest to stdout or to a file you name.

**Where it stands.** It runs today on the in-process simnet, where every alert below has a test.
No Keelio vault is deployed, so it has never watched one on a network. The Stacks API reader is
written and tested against replies recorded from another mainnet contract, not against a vault.
Item 9 stays unmet until the monitor runs against a deployed vault and the plan at the end of this
page is filled in.

## What it watches

Each poll reads five things from the chain, through one interface (`MonitorChain`):

1. **The journal**: the vault contract's print events, oldest first (`docs/events.md`). All of
   them are read: the 12 of the owner's and the agent's ordinary calls, and the five of the
   approval band (`set-approval-threshold`, `request-swap`, `approve-swap`, `reject-swap`,
   `cancel-swap-request`). A trade is an `execute-swap` or an `approve-swap`: an approved trade
   prints `approve-swap` and no `execute-swap`, and the monitor treats the two alike for balances,
   the floor checks, the day total and the unusual-trade alerts. The records before the cursor are
   kept in hand as the history each new trade is compared with.
2. **The refused calls**: calls made straight to the vault that failed. A refused call prints
   nothing, so it is never in the journal. On the simnet the harness records each `(err …)`
   result; on a network they are the failed transactions whose contract call names the vault.
3. **Each owner's vault**, with the SDK's `readVault`: agent, paused flag, policy, balances, price
   bounds and the oracle's current price. The owners are the ones the journal has named.
4. **The burn height and the block time** of the latest block.
5. **Each token's solvency**: the vault's `get-ledger-total` of the token (every owner's ledger
   added up) and the token's own `get-balance` of the vault contract. The ledger total is read
   before and after the balance and the lower one is used, so one block (a deposit, withdrawal or swap)
   landing between two of the reads cannot make the vault look short. A real shortfall lasts, so a
   poll that misses it while blocks land reports it at the next one.

The core (`evaluate` in `packages/monitor/src/evaluate.ts`) is a pure function of those readings
and the state saved by the previous poll. It has no clock, network or file access, so the same
readings always give the same alerts.

## Alerts

Every alert is one JSON object on one line:

```json
{
  "id": "event:9:SWAP",
  "code": "SWAP",
  "severity": "info",
  "owner": "ST1…",
  "burnHeight": "3",
  "message": "agent ST2… sold 10000000 of ….mock-sbtc for 9000000000 of ….mock-usd on ….mock-dex; 101 bps above the floor 8910000000",
  "details": {
    "amountIn": "10000000",
    "amountOut": "9000000000",
    "minOutFloor": "8910000000",
    "aboveFloorBps": "101"
  }
}
```

- `code` is stable: it never changes meaning once listed here.
- `severity` is `info` (it happened, as allowed), `warning` (look at it) or `critical` (act now).
- `owner` is the vault owner. It is `null` only for a journal record that names none and for
  `LEDGER_SHORTFALL`, which is about the whole vault contract.
- Amounts and heights are decimal strings of base units. Nothing is a floating-point number.
- `id` is the same whenever the same journal entry, refused call or condition is reported again,
  so a consumer can drop a repeat (see "Restarts").

The "serves" column names the row of `docs/threat-model.md` the alert helps a person notice. The
contract enforces the limits; the monitor only tells someone that a limit was reached or changed.

### From the journal

One alert per journal entry, in journal order. A trade can raise up to three, and then the
unusual-trade alerts of the next table.

| Code                     | Severity | Raised when                                                                                                                                                                                                                                                                             | Serves                                                                                       |
| ------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `DEPOSIT`                | info     | An owner deposits. Gives the amount and the ledger balance after it.                                                                                                                                                                                                                    | The list of owners with a balance, for the plan below                                        |
| `WITHDRAWAL`             | info     | An owner withdraws.                                                                                                                                                                                                                                                                     | The same list. Only the owner's key can withdraw (T8), so an unexpected one means that key   |
| `AGENT_SET`              | warning  | An owner names or replaces the agent.                                                                                                                                                                                                                                                   | T1: who can trade changed                                                                    |
| `AGENT_REMOVED`          | info     | An owner removes the agent.                                                                                                                                                                                                                                                             | T1: the response to a stolen agent key                                                       |
| `VAULT_PAUSED`           | info     | An owner pauses.                                                                                                                                                                                                                                                                        | T1: the kill switch was used                                                                 |
| `VAULT_UNPAUSED`         | warning  | An owner unpauses.                                                                                                                                                                                                                                                                      | T1: the agent can trade again                                                                |
| `POLICY_SET`             | warning  | An owner sets the cooldown and expiry.                                                                                                                                                                                                                                                  | T1, T5: a long expiry is a long unattended run                                               |
| `TOKEN_CAPS_SET`         | warning  | An owner sets one token's per-trade and per-day caps.                                                                                                                                                                                                                                   | T1, T3: the caps bound the loss                                                              |
| `PRICE_BOUNDS_SET`       | warning  | An owner sets `max-slippage-bps` and `max-price-age`.                                                                                                                                                                                                                                   | T3: the bounds set the floor                                                                 |
| `TOKEN_ALLOW_CHANGED`    | warning  | An owner allows a token. `info` when the owner revokes one.                                                                                                                                                                                                                             | T4                                                                                           |
| `ADAPTER_ALLOW_CHANGED`  | warning  | An owner allows the adapter. `info` when the owner revokes it.                                                                                                                                                                                                                          | T2d: the adapter is trusted with `amount-in`                                                 |
| `SWAP`                   | info     | A trade completes: the agent's `execute-swap`, or the owner's `approve-swap` of the agent's request. Gives both amounts, the adapter, the floor, how many bps above the floor it settled, and `approved` (with `requestedAt`) for an approved one.                                      | T1, T3: every agent action is seen                                                           |
| `SWAP_NEAR_FLOOR`        | warning  | A swap's `amount-out` is at most `nearFloorBps` above its `min-out-floor`.                                                                                                                                                                                                              | T3, T2d: the owner is getting close to the worst price the vault allows                      |
| `SWAP_BELOW_FLOOR`       | critical | A journalled swap's `amount-out` is below its `min-out-floor` or its `min-out`. The contract refuses such a swap (u125, u118).                                                                                                                                                          | A flaw in the contract: this is a trigger for the plan below                                 |
| `DAY_CAP_NEAR`           | warning  | A swap leaves `day-total` at or above `dayCapWarnBps` of the input token's `max-per-day`, as the journal last showed that cap.                                                                                                                                                          | T1, T6: an agent spending its whole allowance                                                |
| `APPROVAL_THRESHOLD_SET` | warning  | An owner clears a token's approval threshold, or raises it: more of the agent's trades run without the owner. `info` when the owner sets one where there was none, lowers it, or sets what was already there. `details.change` is `set`, `lowered`, `raised`, `cleared` or `unchanged`. | T9: the band on single large trades changed                                                  |
| `SWAP_REQUESTED`         | warning  | The agent records a trade above the owner's approval threshold (`request-swap`). Gives the trade and `expiresAt`, the last burn height the owner can approve at (6 burn blocks after the request). Nothing has moved. `replacedRequestedAt` names an expired request it overwrote.      | T9a, T9b: the owner has something to approve, and little time                                |
| `SWAP_REQUEST_REJECTED`  | info     | The owner removes the pending request without running it (`reject-swap`). `expired` says whether it had already expired.                                                                                                                                                                | T9: the owner said no                                                                        |
| `SWAP_REQUEST_CANCELLED` | info     | The agent withdraws its own request (`cancel-swap-request`). `expired` as above.                                                                                                                                                                                                        | T9a: an agent making and withdrawing requests fills the journal                              |
| `UNKNOWN_EVENT`          | warning  | A journal record is not a tuple the monitor can read, or has an event name it does not know.                                                                                                                                                                                            | The monitor and the contract disagree about the journal; do not trust silence after this one |

`SWAP_BELOW_FLOOR` cannot be raised on the simnet through the contract, because the contract
refuses the swap. Its test hands the core a hand-written journal record.

### Unusual trades

Advisory, and `info` for that reason: they say a trade was unlike the vault's earlier ones, not
that anything was wrong with it. The contract enforces none of this. Each is raised with the
`SWAP` of the trade it describes, at most once per trade, by the rules and defaults of the SDK's
pre-trade `tradeWarnings` (`packages/sdk/src/warnings.ts`), asked after the fact: the trade is
compared with the same owner's earlier trades in the journal, approved ones included, and never
with itself.

| Code                       | Severity | Raised when                                                                                                                                               | Serves                                                    |
| -------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `TRADE_FIRST_IN_DIRECTION` | info     | The owner's vault has never sold this token for that one before. A vault's first trade always raises it.                                                  | T1: an agent doing something it has not done before       |
| `TRADE_LARGE`              | info     | `amount-in` is more than `tradeSizeMultiple` times the median `amount-in` of the vault's earlier trades in the same direction. Gives the median.          | T1: a size out of line with the vault's history           |
| `TRADE_BURST`              | info     | The trade is at least the `tradeBurstTrades`-th of the vault's trades, in any direction, within `tradeBurstBlocks` burn blocks. Raised for each such one. | T1, T9f: many trades in a row, each under a per-trade bar |
| `TRADE_AFTER_QUIET`        | info     | The vault's trade before this one, in any direction, is at least `tradeQuietBlocks` burn blocks back.                                                     | T1: an agent waking up                                    |

The median of an even number of trades is the mean of the middle two, rounded down. Everything is
whole base units.

### From refused calls

| Code           | Severity | Raised when                                                                                                                                                                                                                                                                                                                                              | Serves                                                                                                    |
| -------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `CALL_REFUSED` | warning  | A call made straight to the vault returns `(err uN)`, or is aborted by a post-condition. Gives the function, the sender, the code and its constant from `docs/errors.md`, and the transaction id if any.                                                                                                                                                 | T1 (an agent pushing at its limits), T8 (a stranger trying an owner's vault), T3 (u121 to u125)           |
|                | info     | The code is u126 (`ERR-APPROVAL-REQUIRED`) or u127 (`ERR-APPROVAL-NOT-NEEDED`): the approval band sent the agent to the other function. `execute-swap` above the threshold is refused and the agent calls `request-swap`; `request-swap` at or below it is refused and the agent calls `execute-swap`. Nothing was tried that the owner's limits forbid. | T9: expected of an agent that does not predict the band                                                   |
|                | critical | The code is u104 (`ERR-ALLOWANCE-EXCEEDED`) or u118 (`ERR-BELOW-MIN-OUT`): the adapter tried to take more than its allowance, or reported success and delivered less than `min-out`.                                                                                                                                                                     | T2a, T2b, T2c: the vault stopped it, but the adapter fixed at deploy time is misbehaving and stays in use |

For `execute-swap`, `request-swap` and `cancel-swap-request` the alert's `owner` is the owner named
in the call. For every other function it is the sender, since those functions act on the sender's
own vault.

The other refusals of the approval band are warnings like any refusal: u128 (a second request
while one waits), u129 (nothing to approve, reject or withdraw), u130 (an approval after the
request expired) and u133 (someone other than the requesting agent tried to withdraw a request).
Two deserve a look when they appear. u131 (`ERR-REQUEST-MISMATCH`) means the owner signed an
approval for a request that is not the one stored, by its trade or by its `requested-at`: the agent
replaced its request or withdrew it and made it again, or what the owner was shown was not the
request (T9c). u132 (`ERR-REQUEST-AGENT-CHANGED`) means the owner tried to
approve a request left by an agent they have since removed or replaced (T9d).

### Lasting conditions

These describe the state at a poll, not one journal entry. Each is raised once when it becomes
true, and again only after a poll has seen it false. They are checked only for a vault an agent
could trade: an agent is set, the vault is not paused, and some ledger balance is above zero. The
two oracle conditions are also skipped for an owner whose price bounds are unset, because the
vault already refuses that owner's swaps (u119).

| Code                   | Severity | Raised when                                                                                                                                                           | Serves                                                                                  |
| ---------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `ORACLE_AGING`         | warning  | The oracle price's distance from block time is at or above `oracleAgeWarnBps` of the owner's `max-price-age`, and not yet past it.                                    | T3: the single feed may have stopped                                                    |
| `ORACLE_STALE`         | critical | That distance is past the owner's `max-price-age`. The vault refuses this owner's swaps with u123. A timestamp ahead of the block counts too.                         | T3: the agent cannot trade, and the one price source is not updating                    |
| `ORACLE_UNAVAILABLE`   | critical | The oracle's `get-value` returns an error, or a price of 0. The vault refuses swaps with u121 or u122.                                                                | T3                                                                                      |
| `POLICY_EXPIRING`      | warning  | At most `expiryWarnBlocks` burn blocks are left before `expires-at`.                                                                                                  | T5: the owner must renew, or the agent stops                                            |
| `POLICY_EXPIRED`       | warning  | The burn height is past `expires-at` (or no policy was ever set). The vault refuses swaps with u110.                                                                  | T5: expected for a lost key; for a live owner, the agent has stopped without being told |
| `SWAP_REQUEST_EXPIRED` | warning  | The burn height is past the `expires-at` of a request the journal has not shown approved, rejected, withdrawn or replaced. The owner can no longer approve it (u130). | T9b: the owner did not see the request, or chose not to answer                          |

`SWAP_REQUEST_EXPIRED` differs from the others in two ways. It comes from the journal and the burn
height alone, so it is checked for every vault, paused or not. And it is raised once per request,
not once per spell: a second request left unanswered raises it again, with the request's height in
its `id`.

### The vault's solvency

Checked at every poll for each token in the config, whether or not any agent can trade: a
shortfall means some owner's `withdraw` will fail, and pausing does not change that. Raised once
per token when it becomes true, and again only after a poll has seen it false.

| Code               | Severity | Raised when                                                                                                            | Serves                                                                                                |
| ------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `LEDGER_SHORTFALL` | critical | The token's `get-balance` of the vault contract is below the vault's `get-ledger-total` of it. Gives both and the gap. | A flaw in the contract or a dishonest token: owners cannot all withdraw. A trigger for the plan below |

The contract keeps the vault's balance at or above the ledgers for honest SIP-010 tokens (the ledger invariant
at the top of `contracts/keelio-vault.clar`; T2e in `tests/keelio-vault-threats.test.ts`), so the simnet
cannot reach this alert through the contract. Its tests read the real ledger total and a token
balance made to read low. A balance above the ledgers is expected and raises nothing: tokens sent
straight to the vault are stranded there (T4).

### Thresholds

| Name                | Default | Meaning                                                                                                         |
| ------------------- | ------- | --------------------------------------------------------------------------------------------------------------- |
| `nearFloorBps`      | 50      | `SWAP_NEAR_FLOOR` at or below this many bps above the floor                                                     |
| `dayCapWarnBps`     | 8000    | `DAY_CAP_NEAR` at or above this share of `max-per-day`                                                          |
| `oracleAgeWarnBps`  | 8000    | `ORACLE_AGING` at or above this share of the owner's `max-price-age`                                            |
| `expiryWarnBlocks`  | 144     | `POLICY_EXPIRING` with at most this many burn blocks left                                                       |
| `tradeSizeMultiple` | 3       | `TRADE_LARGE` above this many times the median earlier trade in the same direction                              |
| `tradeBurstTrades`  | 3       | `TRADE_BURST` from this many of the vault's trades inside the window below. 1 or less turns it off              |
| `tradeBurstBlocks`  | 6       | The window of `TRADE_BURST`, in burn blocks (about an hour)                                                     |
| `tradeQuietBlocks`  | 1008    | `TRADE_AFTER_QUIET` when the trade before is at least this many burn blocks back (about a week). 0 turns it off |

The defaults are guesses made before any vault has run on a network. Set them from what the
oracle's update cadence and the DEX's spread turn out to be (`docs/mainnet-readiness.md`, item 5).
The four `trade…` defaults are the SDK's `DEFAULT_WARNING_THRESHOLDS`, so an agent that asks
`tradeWarnings` before a trade is told what the monitor will say after it.

The approval window itself is not a threshold: 6 burn blocks is the contract's `APPROVAL-WINDOW`,
and the monitor reads each request's `expires-at` from the journal.

## Run it

### On the simnet, from a clean checkout

```bash
pnpm install
pnpm run monitor -- --simnet-demo
```

This runs the story of `pnpm run demo` (`scripts/demo.ts`, unchanged) with the monitor watching,
then a second owner's vault that reaches the alerts the first story does not: a swap near the
floor, a day window near its cap, an approval threshold with requests that are approved, rejected,
withdrawn and left to expire, a burst of trades, an oracle price that ages and goes stale, and a
policy that expires. It does not reach `TRADE_LARGE` or `TRADE_AFTER_QUIET`; their tests do
(`tests/monitor-unusual.test.ts`). The alerts are the JSON lines on stdout. The headings between them are on stderr, so
`pnpm run --silent monitor -- --simnet-demo 2>/dev/null` gives the alerts alone.

### Against a network

Not possible yet: there is no vault to point it at. When there is one, the runner takes a config
file that names everything about the deployment. Nothing has a default.

```json
{
  "apiUrl": "<the Stacks API root>",
  "sender": "<any Stacks address; the simulated caller for read-only calls, it signs nothing>",
  "vault": "<ADDR.keelio-vault>",
  "tokens": ["<the vault's ALLOWED-TOKEN>", "<the vault's QUOTE-TOKEN>"],
  "adapters": ["<the vault's ALLOWED-ADAPTER>"],
  "oracle": "<the vault's ORACLE>",
  "sbtcToken": "<the vault's ALLOWED-TOKEN>",
  "priceScale": "<the vault's PRICE-SCALE, as a decimal string>",
  "intervalSeconds": 30,
  "thresholds": { "nearFloorBps": "50" }
}
```

```bash
pnpm run --silent monitor -- --config monitor.config.json --state monitor.state.json | your-alerting
```

- `intervalSeconds` and `thresholds` are optional. Threshold values are decimal strings.
- `--once` polls once and exits, for a scheduler.
- The vault has no getter for its deploy constants, so a wrong token, adapter, oracle or price
  scale is not detected. Take them from the deployed source (`pnpm run check-deploy`).
- **Outbound sends are yours.** The monitor writes alerts to stdout and nothing else: no webhook,
  no email, no pager. Pipe stdout to the alerting you already run, and filter on `severity` there.
  The digest below is the same: text on stdout or in a file, delivered by you.
- A failed poll is logged to stderr and tried again at the next interval. It saves nothing, so
  nothing is skipped.
- Every request to the API, read-only calls and lists alike, gives up after 10 seconds
  (`timeoutMs` of `stacksApiChain`, the SDK's `DEFAULT_TIMEOUT_MS`) and fails the poll. A node
  that stops answering cannot stall the monitor into silence.

### Digest

The owner digest is a summary in plain words of each owner's vault over a range of burn heights:
the trades made (how many, the totals sold per input token and bought per output token, and how
many the owner approved), the approval requests made and how they ended, the request waiting now
and the last burn height it can be approved at, the calls refused and why (in the words of
`docs/errors.md`, with the code and its constant beside them), how much of each token's day cap
is used and left, the agent in place, whether the vault is paused, when the policy expires and how
many burn blocks remain, and the alerts of the range grouped by severity.

```bash
pnpm run --silent monitor -- --simnet-demo --digest
pnpm run --silent monitor -- --config monitor.config.json --digest --from 880000 --to 880143 --out digest.txt
```

- `--digest` reads the chain once, writes the digest and exits. It writes no alerts and reads and
  writes no state file, so it can run beside a polling monitor without moving its cursor. Run it
  from a scheduler for a periodic digest; `--from` and `--to` of 144 burn blocks is about a day.
- `--from` and `--to` are burn heights, both included. Left out, they are 0 and the current burn
  height: the whole journal.
- `--out <file>` writes the digest to the file instead of stdout, replacing it. `--json` writes
  the structured digest (`Digest` in `packages/monitor/src/digest.ts`) as one JSON object instead
  of text.
- **It is sent nowhere.** Mailing the file, or posting it, is yours to do.
- Amounts are base units as decimal strings. The monitor knows no token's decimals.
- The same chain gives the same digest: there is no wall-clock time in it, only burn heights.
- The trades, requests, refusals and alerts are those inside the range. The request waiting, the
  caps, the agent, the pause flag and the policy are the vault as read when the digest is made,
  whatever the range.
- The alerts are the ones a monitor started with no state file would raise at that read: every
  journal and refused-call alert at its own burn height, and the lasting conditions and
  `LEDGER_SHORTFALL` that hold at the read, at the read's burn height.
- An address that only had a call refused (a stranger trying `withdraw`) gets an entry too, with
  no vault lines.

From the simnet demo, the second owner's entry, with addresses shortened and most alert lines
left out:

```text
Keelio vault digest: burn heights 0 to 304. Vaults read at burn height 304. Amounts are base units.

Owner STHJ…
  Trades: 3, of which 1 approved by the owner.
    Sold 210000 of ….mock-sbtc in 3 trades.
    Bought 188120000 of ….mock-usd.
  Approval requests: 4 made, 1 approved, 1 rejected, 1 withdrawn by the agent.
  Expired without an answer: agent ST26… asks to sell 10000 of ….mock-sbtc for at least 8910000 of ….mock-usd. It could be approved up to burn height 9 and can no longer run.
  Calls refused: 2.
    1 × This trade needs the owner's approval (u126 ERR-APPROVAL-REQUIRED): execute-swap.
    1 × The oracle price is too old (u123 ERR-PRICE-STALE): execute-swap.
  Day caps, over the last 144 burn blocks:
    ….mock-sbtc: 0 of 250000 used, 250000 left.
    ….mock-usd: no cap set, so the agent cannot sell it.
  Agent: ST26….
  The vault is not paused.
  Policy: expired at burn height 303, 1 burn block ago. The agent cannot trade.
  Alerts: 1 critical, 19 warning, 10 info.
    critical, burn height 304, ORACLE_STALE: the oracle price is 179960001 ms from block time, past max-price-age 3600000: agent ST26… cannot trade
    warning, burn height 3, SWAP_REQUESTED: agent ST26… asks to sell 10000 of ….mock-sbtc for at least 8910000 of ….mock-usd on ….mock-dex: above the approval threshold, so it runs only if the owner approves by burn height 9
    warning, burn height 304, SWAP_REQUEST_EXPIRED: agent ST26…'s request to sell 10000 of ….mock-sbtc expired unanswered at burn height 9: it can no longer be approved
    info: 1 APPROVAL_THRESHOLD_SET, 1 CALL_REFUSED, 1 DEPOSIT, 3 SWAP, 1 SWAP_REQUEST_CANCELLED, 1 SWAP_REQUEST_REJECTED, 1 TRADE_BURST, 1 TRADE_FIRST_IN_DIRECTION.
```

A request still inside its window reads "Waiting for the owner's approval: agent … asks to sell …
It can be approved up to burn height N, M burn blocks from now."

### Restarts

The state file holds the cursor (how many journal records and refused calls have been processed),
the conditions already reported (by owner, and the tokens already reported short), and each
owner's last journalled balances, caps and approval thresholds, and the request still open with
whether its expiry was reported. A restart picks up from it. A state file written before the
approval band existed is read as having no threshold and no request.

- Alerts are written before the state is saved. A crash between the two makes the next start
  write the same alerts again, with the same `id`s. An alert can repeat; it is never skipped.
- The first run with no state file reads the journal from its beginning and raises an alert for
  every entry in it.
- A state file whose cursor is past the chain (another vault's file, or a reorg that removed
  entries) stops the poll with an error instead of guessing.
- The unusual-trade alerts keep nothing in the state file. Each belongs to one journal entry, so
  the cursor alone decides whether it is raised: a trade before the cursor is history and raises
  nothing after a restart, and a trade after it is compared with the whole journal before it,
  whichever run read that.
- Delete the state file only if you want every alert again.

## What it cannot see

- **A deployed vault, so far.** `stacksApiChain` reads the print events
  (`/extended/v1/contract/{id}/events`), places each by its transaction (`/extended/v1/tx/{id}`),
  and lists failed calls (`/extended/v1/address/{id}/transactions`). Its tests replay replies
  recorded from `https://api.hiro.so` for a mainnet token contract
  (`tests/fixtures/stacks-api/monitor.json`). They pin the reply shapes. They do not show a Keelio
  journal read from a network, and the first run against a testnet vault is the first real test.
- **Refused calls that go through another contract.** A failed transaction is listed only when
  its contract call names the vault. A contract that calls the vault and is refused is missed, on
  the simnet and on a network alike. Successful calls through another contract are seen, because
  their prints are in the journal.
- **Anything between polls that leaves no trace.** A journal entry is never missed. A lasting
  condition that begins and ends between two polls is: an oracle that was stale for a minute
  between polls 30 seconds apart is caught, one stale for a second may not be.
- **Reorgs.** The cursor counts entries in chain order. A reorg that drops or reorders entries
  already processed is not handled: the poll stops if the chain is now shorter, and otherwise can
  repeat or miss an entry. A network deployment should read only blocks it treats as final.
- **Cost of a long history.** On a network each poll reads the whole event list and the whole
  transaction list again. That is fine for a pilot and wrong for a busy vault.
- **The oracle's truth.** The monitor checks the price's age, not the price. A fresh, wrong price
  raises nothing (T3, accepted residuals), and neither does sBTC or the quote token losing its peg.
- **The adapter's routing (T2d).** A swap that settles above the floor raises only `SWAP`, however
  the adapter got there.
- **Tokens sent straight to the vault (T4)** and **a lost owner key (T5).** Neither prints an
  event. A lost key shows only as silence, then `POLICY_EXPIRING` and `POLICY_EXPIRED`.
- **A request that expires between two polls and is gone by the second.** `SWAP_REQUEST_EXPIRED`
  is a reading at a poll. If a request expires and is then rejected, withdrawn or overwritten by a
  new one before the next poll, that alert is not raised. The journal alerts still say so:
  `SWAP_REQUEST_REJECTED` and `SWAP_REQUEST_CANCELLED` carry `expired`, and the `SWAP_REQUESTED`
  that overwrote it carries `replacedRequestedAt`.
- **The owner's approval threshold and pending request as the contract stores them.** Both are
  followed from the journal (`set-approval-threshold`, `request-swap` and the three events that
  end a request), not read with `get-approval-threshold` or `get-pending-swap`. They agree with
  the contract as long as the journal is whole; after `UNKNOWN_EVENT` do not rely on them.
- **Whether an unusual trade was a bad one.** `TRADE_…` alerts compare sizes and heights with the
  vault's own history. A new vault has none, so its first trades raise `TRADE_FIRST_IN_DIRECTION`
  and little else; an agent that always trades large is never `TRADE_LARGE`; and an agent that
  splits one sale into trades under the approval threshold (T9f) shows only as `TRADE_BURST`, and
  only if the trades fall inside `tradeBurstBlocks`.
- **Lasting conditions of the past, in a digest.** A digest made now shows the oracle, policy and
  solvency conditions that hold now. An oracle that was stale for an hour inside the range and has
  recovered is not in it; the polling monitor's own output is the record of that.
- **Order between the two lists.** Within one poll, journal alerts come first, then refused calls,
  then lasting conditions. Use `burnHeight` to place a refusal among the journal entries.
- **Whether anyone is listening.** The monitor does not alert on its own silence. Whoever runs it
  must notice when it stops.

## If a flaw is found: telling owners to withdraw

> **DRAFT. Not in force.** This section is a skeleton for the owner of the project to complete.
> Every `[TO FILL]` is a decision or a fact that has not been made or recorded. Nothing here is a
> commitment until they are filled in and this notice is removed.

### What can and cannot be done

- `keelio-vault` is immutable and has no admin (`docs/threat-model.md`, T7). No one can pause all
  vaults, patch the contract, or move anyone's funds. The project cannot withdraw for an owner.
- The only remedy is that **each owner withdraws their own funds**, with their own key.
  `withdraw` works while a vault is paused, with no agent, and after the policy has expired.
- Each owner can also stop their agent at once with `pause` or `remove-agent`. That stops trading.
  It does not protect against a flaw in `withdraw` or the ledger itself.
- An owner who has lost their key cannot be helped (T5).
- A notice is public the moment it is sent. For a flaw that can be used to take funds, telling
  owners also tells attackers, so the order and wording below matter.

### What the monitor contributes

- **The list of owners to reach.** The state file holds every owner's last journalled balance per
  token. `ownersWithBalance` (`packages/monitor/src/evaluate.ts`) returns the owners whose ledger
  is above zero, with the amounts in base units; `pnpm run monitor -- --simnet-demo` prints that
  list at its end. It comes from the journal alone and can be rebuilt by anyone from the chain.
- **Addresses, not people.** The list is Stacks principals. The contract knows nothing else about
  an owner. Reaching the person behind an address needs a channel they chose to give: `[TO FILL]`.
- **Progress.** After a notice, each `WITHDRAWAL` alert shows an owner leaving, and the list shows
  who has not.
- **Some triggers.** `SWAP_BELOW_FLOOR`, `LEDGER_SHORTFALL`, a critical `CALL_REFUSED` (u104,
  u118) and `UNKNOWN_EVENT` are signs that the contract, the adapter or the journal is not behaving as
  specified. Most flaws will not announce themselves this way: expect the report to come from a
  person.

### Steps

1. **Receive the report.** Where a flaw is reported: `[TO FILL: a private contact for security
reports]`. Who reads it and how fast: `[TO FILL]`.
2. **Confirm it.** Reproduce the flaw on the simnet with a failing test. Who does this: `[TO FILL]`.
   Write down what is at risk in base units: which function, whose funds, and whether `withdraw`
   itself is affected.
3. **Decide.** Who decides that owners are told to withdraw: `[TO FILL: a named person, and a
named second for when they cannot be reached]`. What they weigh: whether funds can be taken
   or only locked, whether it is being used already, and whether telling owners makes it worse.
4. **List the owners.** Run the monitor to the chain tip and take `ownersWithBalance`. Check the
   total against the vault contract's token balances (`LEDGER_SHORTFALL` compares the contract's
   own `get-ledger-total` with them at every poll).
5. **Tell them.** Through: `[TO FILL: the channels owners were told to watch when they deposited]`.
   The notice says what to do first (`pause`, then `withdraw` every token), where the withdraw
   flow is (`[TO FILL]`), what is known, and what is not. It does not ask anyone for a key or a
   seed phrase, and says so. Who writes and sends it: `[TO FILL]`.
6. **Watch the withdrawals.** Track `WITHDRAWAL` alerts against the list. How and how often owners
   who have not moved are told again: `[TO FILL]`.
7. **Stop new deposits.** The contract cannot refuse them. What the project controls is its own
   interfaces: the dashboard and the documentation. Who takes the deposit flow down or marks it:
   `[TO FILL]`.
8. **Write it up.** What happened, what was lost if anything, and what changes, in this repo:
   `[TO FILL: where, and within how long]`.

### Open decisions

- How owners register a way to be reached, and whether depositing without one is discouraged:
  `[TO FILL]`.
- Whether a flaw is disclosed before or after owners have had time to withdraw, and how long that
  time is: `[TO FILL]`.
- Whether anyone is paid for reporting a flaw: `[TO FILL]`.
- Who runs the monitor, where, and who is told when it stops: `[TO FILL]`.
- What owners are told if the flaw is in `withdraw` itself, where the remedy above does not work:
  `[TO FILL]`.
