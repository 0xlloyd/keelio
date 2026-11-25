# Integration guide for agent builders

This guide is for someone building a trading agent on Stacks who has not seen this repository. It
shows how an agent uses a Keelio vault through the TypeScript SDK and through the MCP server, with a
worked example you can run: `examples/agent`.

Every code block marked `ts` below is copied from the example's source.
`tests/example-agent.test.ts` fails if one of them is no longer found there, so the guide cannot
drift from code that runs.

## What Keelio is, in one paragraph

An owner deposits sBTC and a quote token into the `keelio-vault` contract, names one agent principal
and sets a policy. The agent trades with one function, `execute-swap`, and the contract checks the
policy on every call. The agent never holds the tokens: the vault sends the input to a swap adapter
and takes the output back itself. Your agent needs its own Stacks key to sign `execute-swap` calls,
and that key has no power to withdraw. An owner can also set an amount above which a trade needs
their approval: the agent then asks with `request-swap`, and the trade runs only when the owner
approves it.

## Status

Read this before planning around Keelio.

- Everything runs on Clarinet's in-process simnet. `keelio-vault` is not deployed to testnet or
  mainnet, so there is no contract address to point an agent at today.
- The packages are private workspace packages (`@keelio/sdk`, `@keelio/mcp`). They are not published to
  npm. You use them from a checkout of this repository.
- The vault has not had an independent review. One is planned
  ([roadmap.md](roadmap.md), Milestone 4).
- The only swap adapter on the default simnet is `mock-dex`, a test double. The Bitflow adapter is
  tested against mainnet contract state read into a simnet (`pnpm run test:online`), not against a
  live network.

## What the vault guarantees

These are enforced by the contract, and each has a test named in
[threat-model.md](threat-model.md). They hold whatever your agent, its model or its server does.

- **The agent cannot withdraw.** `withdraw` pays out only the caller's own ledger, and the agent has
  none. Swap input goes from the vault to the adapter and the output comes back to the vault.
- **Caps per input token.** Each trade is at most that token's `max-per-trade`, and the total sold
  over the last 144 burn blocks is at most its `max-per-day`. A token whose caps were never set
  cannot be sold.
- **Cooldown and expiry.** A trade is refused fewer than `cooldown-blocks` burn blocks after the
  owner's last one, and after the policy's `expires-at` burn height.
- **An approval band, if the owner sets one.** With an approval threshold for an input token, a
  trade selling more than it is refused from the agent alone (u126). The agent records it with
  `request-swap`, which moves nothing, and it runs only if the owner calls `approve-swap` within 6
  burn blocks, with every other check run again at that moment.
- **The owner's stop is immediate.** Pausing, or removing or replacing the agent, refuses the next
  `execute-swap`. The owner can withdraw at any time, paused or not.
- **A price floor.** The vault refuses a `min-out` below its oracle's BTC/USD price less the
  owner's `max-slippage-bps` (u125), and refuses to trade on a missing, zero or stale price. It
  credits the output that actually arrived, and refuses the swap if that is below `min-out` (u118).
- **A bounded adapter.** The adapter can move at most `amount-in` of the input token and nothing
  else (u104).
- **No admin.** The deployer has no power over any vault after deployment.

## What it does not guarantee

- **That trades are good.** Keelio has no strategy. Inside the floor, a compromised or wrong agent
  can still lose up to `max-slippage-bps` of each trade's value at the oracle price: per input
  token, at most `max-per-day` × `max-slippage-bps` / 10000 per 144-block window (threat T3). Two
  windows can meet, so up to 2 × `max-per-day` can trade within 145 consecutive burn blocks (T6).
- **That the oracle is right.** The floor trusts one BTC/USD feed with one updater key and no
  confidence band. It does not see sBTC lose its peg to BTC or the quote token lose its peg to USD
  (T3, accepted).
- **Where the adapter sends the input.** The allowance bounds the amount and the asset, not the
  recipient. The adapter is fixed at deploy time, so trusting it is a deploy-time choice (T2d,
  accepted).
- **Recovery of a lost owner key.** There is none. The agent keeps trading inside the caps until
  `expires-at`, and nobody can pause it (T5, accepted).
- **Anything off-chain.** The SDK's `checkIntent` and the MCP server's check are advisory and are
  outside the threat model. They save your agent a fee and tell it why; they protect nobody. If
  the `VaultConfig` you give the SDK does not match the deployed vault's constants, `checkIntent`
  disagrees with the contract without raising an error.
- **That the simnet checked the post-conditions.** The SDK attaches post-conditions to every call
  it builds. A Stacks node enforces them; the simnet does not.

## Run the example

Needs Node 22.18 or later and pnpm. From a clean checkout:

```bash
pnpm install --frozen-lockfile
pnpm run example:agent
```

There is no build step: Node runs the TypeScript sources directly. The run uses no network, no
model and no key. It prints two parts (pnpm prints its own command line first):

```text
Keelio example agent, part 1: a rebalancer on the SDK
A fresh in-process simnet with its throwaway accounts. Nothing is signed or broadcast.

Setup (the harness, not the agent)
  The owner deposits 0.50000000 sBTC and 45000.000000 USD and names the agent.
  Caps: 0.05000000 sBTC per trade and 0.15000000 sBTC per day; 5000.000000 USD per trade and 15000.000000 USD per day.
  Cooldown 3 burn blocks. Min-out at most 1.00% below the oracle price.
  The agent holds 50.00% of the vault's value in sBTC, give or take 2.00%,
  asks for the oracle price less 0.30%, and sizes a buy so a 10.00% fall loses at most 0.50%.

Tick 1: 1 burn block later, BTC/USD 90000.00000000
  read:    ledger 0.50000000 sBTC and 45000.000000 USD
  decide:  hold. sBTC is 50.00% of the vault's value; inside the band

Tick 2: 1 burn block later, BTC/USD 100000.00000000
  read:    ledger 0.50000000 sBTC and 45000.000000 USD
  decide:  sBTC is 52.63% of the vault's value, target 50.00%: sell sBTC
  size:    sell 0.02500000 sBTC
  min-out: 2492.500000 USD
  check:   ok, no policy or oracle rule refuses
  build:   execute-swap, deny mode, with post-conditions:
             keelio-vault sends at most 2500000 base units of mock-sbtc
             mock-dex sends at least 2492500000 base units of mock-usd
  send:    (ok)
  journal: execute-swap at burn height 5: sold 0.02500000 sBTC for 2500.000000 USD,
           ledger now 0.47500000 sBTC and 47500.000000 USD, day total 0.02500000 sBTC

Tick 3: 1 burn block later, BTC/USD 80000.00000000
  read:    ledger 0.47500000 sBTC and 47500.000000 USD
  decide:  sBTC is 44.44% of the vault's value, target 50.00%: buy sBTC
  size:    sizePosition allows 0.05343000 sBTC (a 10.00% fall would lose 427.440000 USD)
  size:    spend 4274.400000 USD
  min-out: 0.05326971 sBTC
  check:   refused, COOLDOWN_ACTIVE (u116 ERR-COOLDOWN-ACTIVE): the cooldown since the last trade has not passed
  send:    nothing. No call was built and no fee was paid.

Tick 4: 2 burn blocks later, BTC/USD 80000.00000000
  read:    ledger 0.47500000 sBTC and 47500.000000 USD
  decide:  sBTC is 44.44% of the vault's value, target 50.00%: buy sBTC
  size:    sizePosition allows 0.05343000 sBTC (a 10.00% fall would lose 427.440000 USD)
  size:    spend 4274.400000 USD
  min-out: 0.05326971 sBTC
  check:   ok, no policy or oracle rule refuses
  build:   execute-swap, deny mode, with post-conditions:
             keelio-vault sends at most 4274400000 base units of mock-usd
             mock-dex sends at least 5326971 base units of mock-sbtc
  send:    (ok)
  journal: execute-swap at burn height 8: sold 4274.400000 USD for 0.05343000 sBTC,
           ledger now 43225.600000 USD and 0.52843000 sBTC, day total 4274.400000 USD

Tick 5: 3 burn blocks later, BTC/USD 90000.00000000
  read:    ledger 0.52843000 sBTC and 43225.600000 USD
  decide:  sBTC is 52.38% of the vault's value, target 50.00%: sell sBTC
  size:    sell 0.02407000 sBTC
  min-out: 2159.801100 USD
  check:   ok, no policy or oracle rule refuses
  build:   execute-swap, deny mode, with post-conditions:
             keelio-vault sends at most 2407000 base units of mock-sbtc
             mock-dex sends at least 2159801100 base units of mock-usd
  (the owner's pause is mined just ahead of the agent's transaction)
  send:    (err u109) ERR-VAULT-PAUSED. The contract refused; nothing moved.
  The owner has stopped the agent. It stands down until a read shows otherwise.

Tick 6: 1 burn block later, BTC/USD 90000.00000000
  read:    ledger 0.52843000 sBTC and 43225.600000 USD
  decide:  sBTC is 52.38% of the vault's value, target 50.00%: sell sBTC
  size:    sell 0.02407000 sBTC
  min-out: 2159.801100 USD
  check:   refused, VAULT_PAUSED (u109 ERR-VAULT-PAUSED): the vault is paused
  send:    nothing. No call was built and no fee was paid.
  The owner has stopped the agent. It stands down until a read shows otherwise.

Result
  2 trades, 2 refusals predicted off-chain (no call made), 1 refused by the contract.
  owner's ledger: 0.52843000 sBTC and 43225.600000 USD, paused: true
  agent's wallet: 0.00000000 sBTC and 0.000000 USD. The tokens never pass through it.
  journal: deposit, deposit, set-agent, set-token-caps, set-token-caps, set-policy, allow-token, allow-token, allow-adapter, set-price-bounds, execute-swap, execute-swap, pause
  A refused call prints no event, so the journal holds only what happened.

Keelio example agent, part 2: one buy through the MCP tools
A second fresh simnet, the same owner setup, BTC/USD 90000.00000000.

  keelio_get_vault:     ledger 0.50000000 sBTC and 45000.000000 USD
  keelio_size_position: 0.05000000 sBTC (a 10.00% fall would lose 450.000000 USD)
  The agent will spend 4500.000000 USD.
  keelio_build_swap:    min-out 0.04850000 sBTC (3.00% below the agent's price): refused, BELOW_ORACLE_FLOOR (u125 ERR-BELOW-ORACLE-FLOOR), no call
  keelio_build_swap:    min-out 0.04950000 sBTC (1.00% below the agent's price): ok, an unsigned call
  The call's post-conditions:
    keelio-vault sends at most 4500000000 base units of mock-usd
    mock-dex sends at least 4950000 base units of mock-sbtc
  wallet (simnet):    (ok u5000000)
  keelio_journal:       execute-swap at burn height 4: sold 4500.000000 USD for 0.05000000 sBTC
  owner's ledger: 0.55000000 sBTC and 40500.000000 USD
```

The files, and which of them you would keep:

| File                               | What it is                                                 | On a real network    |
| ---------------------------------- | ---------------------------------------------------------- | -------------------- |
| `examples/agent/agent.ts`          | The agent: read, decide, size, min-out, check, build, send | Keep                 |
| `examples/agent/vault-errors.ts`   | The agent's error codes and their constant names           | Keep                 |
| `examples/agent/mcp-agent.ts`      | The same loop through the MCP tools                        | Keep, if you use MCP |
| `examples/agent/network.ts`        | The agent's chain reads over a Stacks node                 | Start from this      |
| `examples/agent/simnet-harness.ts` | The chain, the owner, the market and the wallet, simulated | Replace              |
| `examples/agent/run.ts`            | The scripted scenario and the printing                     | Replace              |

`agent.ts` imports the SDK and nothing from the simnet. The example imports the SDK by relative
path (`../../packages/sdk/src/index.js`); inside the workspace you can import `@keelio/sdk` instead.

## The two seams

The agent reaches the outside world through two interfaces. Everything simulated sits behind them.

```ts
export interface Chain {
  /** Read-only contract calls: the SDK's `simnetClient` or `stacksApiClient`. */
  client: ReadOnlyClient;
  /** The current burn (Bitcoin) block height. */
  burnHeight(): bigint | Promise<bigint>;
  /** `stacks-block-time * 1000` of the latest block. */
  blockTimeMs(): bigint | Promise<bigint>;
  /** The vault contract's print events, oldest first. */
  journal(): readonly JournalRecord[] | Promise<readonly JournalRecord[]>;
}
```

```ts
export interface Wallet {
  /**
   * Signs `call` as the agent, sends it, waits for it to be mined and returns
   * the transaction's result: `(ok …)` or `(err uN)`.
   */
  submit(call: VaultCall): Promise<ClarityValue>;
}
```

`Wallet` is the whole of the signing story. Keelio never signs or broadcasts a transaction and never
holds a key: the SDK and the MCP server return an unsigned call, and your agent's own wallet code
signs it with the agent's key and sends it. In the example the harness's `submit` is a direct
simnet call with the agent as sender.

## The loop, step by step

One pass is `tick(chain, wallet, config)` in `agent.ts`. It sends at most one transaction.

### 1. Read the vault

```ts
export async function readState(
  chain: Chain,
  config: AgentConfig,
): Promise<VaultState> {
  const burnHeight = await chain.burnHeight();
  const read = await readVault(chain.client, config.read, config.owner);
  const nowMs = await chain.blockTimeMs();
  return { ...read, burnHeight, nowMs };
}
```

`readVault` returns the agent and paused flag, the policy (caps per token, cooldown, expiry, allow
lists), today's usage, the ledger balances, the owner's price bounds and the oracle's price. It
does not return the burn height or the block time, and `checkIntent` needs both, so `readState`
adds them. `config.read` is a `VaultConfig`: the vault id, the tokens and adapters to read, and the
vault's deploy constants `oracle`, `sbtcToken` and `priceScale`. The contract has no getter for the
constants, so you copy them from the deployed source.

### 2. Decide and size

`decide(state, config)` is the strategy, and it is the part Keelio has no opinion on. The example's
is a rebalancer: it values the ledger at the oracle price, and when sBTC's share of that value is
more than `bandBps` from `targetSbtcBps` it trades the difference. It is a pure function of the
state, with no model call, so the run is the same every time.

What carries over to any strategy is how it sizes. The amount is cut to the smallest of the
per-trade cap, what is left of the day's cap, and the ledger balance of the token being sold, so a
well-sized trade is never refused for those. Only the input token's caps count: a sell is limited
by the sBTC caps and a buy by the quote token's.

The SDK's `sizePosition` computes `capital × risk % ÷ |entry − stop|`. It fits a trade that takes
on price risk and has a stop, so the example uses it for buys only: a buy is capped at the size
that loses at most `riskBps` of the vault's value if the price falls `stopBps` from the oracle
price. A sell reduces sBTC exposure and is not sized this way.

```ts
export function riskSizedBuy(
  capital: bigint,
  oraclePrice: bigint,
  config: AgentConfig,
): SizedPosition {
  // Quote base units per whole sBTC, the unit `sizePosition` prices in.
  const entry = (oraclePrice * ASSET_SCALE) / config.read.priceScale;
  const stop = (entry * (BPS - config.stopBps)) / BPS;
  return sizePosition({
    capital,
    riskBps: config.riskBps,
    entry,
    stop,
    lotSize: config.lotSize,
  });
}
```

This is the agent's own rule, on top of the owner's caps. A size from `sizePosition` is not
permission to trade. It throws a `SizingError` for a `riskBps` above 200 (2%), a zero or negative
input, or an entry equal to the stop ([sdk-errors.md](sdk-errors.md)).

In the run, tick 3 wants to spend 4,750 USD to get back to target and `sizePosition` cuts it to
4,274.40 USD.

### 3. Set min-out at or above the oracle floor

```ts
export function minOutFor(
  state: VaultState,
  plan: Plan,
  config: AgentConfig,
): bigint {
  const floor = minOutFloor(state, plan.tokenIn, plan.amountIn);
  const price = state.oracle.price?.value ?? 0n;
  if (!floor.ok || price === 0n) return 0n;
  const scale = state.oracle.priceScale;
  const atOracle =
    plan.side === "sell"
      ? (plan.amountIn * price) / scale
      : (plan.amountIn * scale) / price;
  const wanted = ceilDiv(atOracle * (BPS - config.toleranceBps), BPS);
  return wanted > floor.floor ? wanted : floor.floor;
}
```

`minOutFloor` is the vault's own floor arithmetic: the least `min-out` the contract accepts for
this amount, rounded up. The example asks for more than the floor (the oracle value less the
agent's 0.30%, against the owner's 1.00%) and never for less. On a real network, base `wanted` on
a quote from the DEX you trade on, and keep the comparison with the floor.

### 4 to 7. Check, build, send, read the journal

```ts
// Step 4: run the contract's own checks off-chain, before paying a fee.
const swap = {
  adapter: config.adapter,
  tokenIn: plan.tokenIn,
  tokenOut: plan.tokenOut,
  amountIn: plan.amountIn,
  minOut,
};
const check = checkIntent(state, { caller: config.agent, ...swap });
if (!check.ok && check.rule === "APPROVAL_REQUIRED") {
  // u126: only the owner can run a trade this size. Ask instead.
  return requestApproval(chain, wallet, config, state, plan, swap);
}
if (!check.ok) {
  return {
    kind: "predicted-refusal",
    plan,
    minOut,
    refusal: check,
    errorName: vaultErrorName(check.errorCode),
    standDown: shouldStandDown(check.errorCode),
  };
}

// Step 5: build the unsigned call, with its post-conditions.
const call = buildExecuteSwap(config.tx, { owner: config.owner, ...swap });

// Step 6: the agent's own wallet signs and sends it. The contract decides.
const result = await wallet.submit(call);
if (result.type !== "ok") {
  const errorCode = errorCodeOf(result);
  return {
    kind: "contract-refusal",
    plan,
    minOut,
    call,
    errorCode,
    errorName: errorCode === null ? "UNKNOWN" : vaultErrorName(errorCode),
    standDown: shouldStandDown(errorCode),
  };
}

// Step 7: the journal, not the call's return value, says what happened.
const fill = lastFill(await chain.journal(), {
  owner: config.owner,
  tokenIn: plan.tokenIn,
  minOut,
  sinceBurnHeight: state.burnHeight,
});
return { kind: "traded", plan, minOut, call, fill };
```

**Check.** `checkIntent` runs the checks of `execute-swap` in the contract's order and returns
the first rule that refuses, with the contract's error code. When it refuses, the agent builds
nothing and sends nothing. In the run, tick 3 is refused with `COOLDOWN_ACTIVE` (u116) and tick 6
with `VAULT_PAUSED` (u109), and neither costs a transaction. One refusal is not the end of the
trade: `APPROVAL_REQUIRED` (u126) means the amount is above the owner's approval threshold, and the
agent sends it as a request instead
([below](#a-trade-above-the-owners-approval-threshold)).

**Build.** `buildExecuteSwap` returns an unsigned contract call in deny mode with post-conditions:
the vault sends at most `amountIn` of the input token and the adapter sends at least `minOut` of
the output token. No post-condition names the agent, so a transaction that moved anything out of
the agent's own account would abort. `config.tx` is a `TxConfig`: the vault id, each token's
`define-fungible-token` name, and each adapter's route. The SDK guesses none of them.

**Send.** `wallet.submit` is yours. The contract makes the decision that counts, and it can differ
from the check: in tick 5 the check passes, the owner's pause is mined just ahead of the agent's
transaction, and the contract answers `(err u109)`.

**Journal.** Every successful vault call prints one event ([events.md](events.md)). The agent
takes the amounts from the `execute-swap` event (`amount-out` is what arrived at the vault),
not from the call's return value. A refused call prints nothing. `lastFill` accepts only the event
for the swap just sent (same owner, input token and `min-out`, at or after the height read in step
1), and throws if the journal does not show it yet, so an event index that lags the transaction
cannot pass an older trade off as this one.

## Handling refusals

There are two kinds, and the example handles both without throwing.

| Kind                | Where it comes from            | What it costs     | In the run    |
| ------------------- | ------------------------------ | ----------------- | ------------- |
| `predicted-refusal` | `checkIntent`, before any call | Nothing           | Ticks 3 and 6 |
| `contract-refusal`  | `(err uN)` from `execute-swap` | A transaction fee | Tick 5        |

`checkIntent` returns `{ ok: false, rule, errorCode, message }`; the rules and their order are in
[sdk-errors.md](sdk-errors.md#checkintent). The contract returns `(err uN)`; every code and the
name of its constant is in [errors.md](errors.md). The SDK does not export the constant names, so
the example carries the ones an agent's calls can return in `vault-errors.ts`:

```ts
export function vaultErrorName(code: number): string {
  return Object.hasOwn(EXECUTE_SWAP_ERRORS, code)
    ? EXECUTE_SWAP_ERRORS[code]!
    : `unlisted code u${code}`;
}
```

Three codes can come back from the contract that `checkIntent` never predicts, because the
contract decides them after it calls the adapter: u104 (the adapter tried to move more than its
allowance), u117 (the adapter failed) and u118 (less than `min-out` arrived). The oracle's age is
also checked against a block that does not exist yet when you check, so near the owner's
`max-price-age` the contract can answer u123 after a passing check. Treat `ok: true` as "no known
reason to refuse", and always handle `(err uN)` from the send.

What to do next depends on the code:

```ts
export function shouldStandDown(errorCode: number | null): boolean {
  return errorCode === 108 || errorCode === 109 || errorCode === 110;
}
```

After u108, u109 or u110 the owner has stopped the agent, and sending again only burns fees. Keep
reading (reads are free) and resume when the vault shows the agent, unpaused, with a live policy.
A cooldown, a used-up cap or a stale price clears with time. u125 means your `min-out` is too low
for this owner. u126 means the trade is the owner's to approve: request it, as the next section
shows.

The SDK functions throw only for inputs that are wrong whatever the vault's state:
`TxBuildError` from a builder (a malformed principal, an amount above 2^64 − 1, a token with no
asset name, an adapter with no route), `SizingError` from `sizePosition`, and `StacksApiError`
from the node client. The codes are in [sdk-errors.md](sdk-errors.md). The example lets them
propagate, because each one is a configuration fault to fix, not a market condition to wait out.

## A trade above the owner's approval threshold

An owner can set an approval threshold per input token (`set-approval-threshold`). `readVault`
returns it in `approvalThresholds`, with `null` for a token that has none. A trade selling more
than the threshold, and still inside the per-trade cap, is refused from the agent alone:
`execute-swap` answers u126, and `checkIntent` predicts it as `APPROVAL_REQUIRED`. The run above
has no threshold, so it never happens there; `tests/example-agent.test.ts` runs the agent against
a vault that has one.

The agent does not give up on that trade. It asks the owner:

```ts
const check = checkRequest(state, { caller: config.agent, ...swap });
if (!check.ok) {
  return {
    kind: "predicted-refusal",
    plan,
    minOut,
    refusal: check,
    errorName: vaultErrorName(check.errorCode),
    standDown: shouldStandDown(check.errorCode),
  };
}
const call = buildRequestSwap(config.tx, { owner: config.owner, ...swap });
const result = await wallet.submit(call);
```

**Check.** `checkRequest` runs the checks of `request-swap` in the contract's order: the policy
rules up to the per-trade cap (u108 to u114), then `APPROVAL_NOT_NEEDED` (u127: the amount is at or
below the threshold, or there is none, so send `execute-swap`), the ledger (u101) and
`REQUEST_PENDING` (u128: the owner already has a request that has not expired). An owner has one
request at a time.

**Build and send.** `buildRequestSwap` takes the same trade as `buildExecuteSwap` and returns an
unsigned `request-swap` call in deny mode with no post-conditions: a request moves no tokens, and
the call says so. The agent signs and sends it like any other.

**What a request is.** It is a record, not a trade. Nothing moves, nothing counts against the day
cap and the cooldown does not start. The contract stores the trade and returns `expires-at`, the
request's burn height plus 6. The agent reads it back from the vault:

```ts
const { pendingSwap } = await readVault(
  chain.client,
  config.read,
  config.owner,
);
```

`pendingSwap` is the stored request, or `null`: the agent that made it, the trade, `requestedAt`
and `expiresAt`. Pass `{ burnHeight }` as `readVault`'s fourth argument and it also carries
`expired`. The contract keeps an expired request until something replaces or removes it.

**What happens next is the owner's.** The owner sees the request in the dashboard and has until
`expiresAt` to act. The agent learns the outcome from the vault and the journal:

| Outcome                 | What the agent reads                                                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| The owner approves      | An `approve-swap` event in the journal with the amounts that moved and `requested-at`; `pendingSwap` is `null`       |
| The owner rejects       | A `reject-swap` event; `pendingSwap` is `null`                                                                       |
| Nobody acts             | No event. From burn height `expiresAt` + 1 the request cannot be approved, and `checkRequest` passes a new one       |
| The approval is refused | No event, and the request stays: the owner's `approve-swap` returned an error and can be sent again until it expires |
| The agent asks again    | A new request with a new `requestedAt`. An approval signed for the old one is refused with u131                      |

An approved trade prints `approve-swap` and **no** `execute-swap`, so read fills from both event
names. The SDK's `swapEvent(event)` does: it returns the same fields for either, with `approved`
and `requestedAt` telling them apart.

`approve-swap` runs every check of `execute-swap` again at the moment the owner approves, except
the threshold: the day cap, the cooldown, the ledger, and the oracle floor against the request's
`min-out` and the price at that time. So a request can pass `checkRequest` and still fail to run,
for example when the price has moved above its `min-out` by then. Set `min-out` for a request as
you would for a direct trade, and expect to ask again.

While a request waits, the example agent's next tick is refused in advance with `REQUEST_PENDING`
and sends nothing. To take a request back, the agent that made it sends
`buildCancelSwapRequest(config.tx, { owner })`; `checkCancelRequest(state, agent)` predicts its two
refusals (u129, u133).

The owner's side is three more builders, for an owner's wallet or dashboard and never for the
agent: `buildSetApprovalThreshold`, `buildApproveSwap` (with `execute-swap`'s post-conditions,
because it moves the same tokens the same way) and `buildRejectSwap`. `checkApproval(state, trade)`
predicts `approve-swap` for the owner: u129 to u132, then the swap's own checks
([sdk-errors.md](sdk-errors.md#checkapproval)).

An approval names one request. `buildApproveSwap` and `checkApproval` take the trade's five fields
and `requestedAt`, the burn height of the request the owner read, and the contract refuses with
u131 unless the stored request has all six. So an approval the owner signed cannot run a request
the agent made later, even one for the same trade. An owner's tool must take `requestedAt` from
the `pendingSwap` it showed the owner, not from a new read when the owner signs, and must show the
request again if it has changed by then. The owner dashboard does both
(`apps/dashboard/src/approval.ts`, `approvalDecision`).

For the agent this means a request withdrawn and made again is a new request: an approval already
signed for the old one is refused, and the owner must approve the new one.

To stay under the threshold instead of asking, size to `suggestSize(state, tokenIn).maxDirectAmountIn`,
described below.

## Beyond the loop: five more SDK helpers

These are off-chain helpers. None changes what the contract enforces, and the example agent does
not use them yet. The blocks in this section are marked `typescript`, not `ts`: they are
illustrations, not excerpts from the example. Each helper's tests are in `tests/sdk-*.test.ts`, and
the ones that touch the vault run against the contract on the simnet.

Four of them read the journal. A chain reader hands the SDK print events as
`{ burnHeight, value }` records (`KeelioChain.vaultEvents()` in `@keelio/mcp`, `Chain.journal()` in the
example), with an optional `txId`. `parseJournal(records)` turns them into `JournalEvent`s, oldest
first: `{ index, burnHeight, txId, event, fields }`, where `fields` holds the contract's kebab-case
names with `uint`s as `bigint`s. Every helper below skips an event whose name it does not know, so
a later contract's new events do not break them. `toJsonSafe(value)` copies any of their results
with each `bigint` as a decimal string, ready for `JSON.stringify`.

### A size that would pass

When `checkIntent` refuses for size (u114, u126, u115, u101) or for the cooldown (u116), the
refusal also carries `suggestion`, so an agent can send a smaller trade or wait instead of giving
up.

```typescript
const check = checkIntent(state, intent);
if (!check.ok && check.suggestion !== undefined) {
  const { maxAmountIn, limitedBy, cooldownEndsAt, dayWindowClearBy } =
    check.suggestion;
  // maxAmountIn: the largest amountIn that passes the per-trade cap, the day
  // cap and the ledger balance at state.burnHeight. 0n means none does.
  const { approvalThreshold, maxDirectAmountIn, directLimitedBy } =
    check.suggestion;
  // maxDirectAmountIn: the largest amountIn execute-swap takes from the agent
  // alone. Above it, up to maxAmountIn, the trade needs the owner's approval.
}
```

`maxAmountIn` is exact for the state read: the contract accepts it and refuses one more, with the
rule in `limitedBy`. Set `minOut` again for the new amount, because the oracle floor moves with it
(step 3). `cooldownEndsAt` is the first burn height the cooldown no longer refuses at, or `null`
when it is not refusing. `dayWindowClearBy` is a height by which the whole day cap is free again if
nobody trades in between: the last trade plus 144. Room can come back sooner, but the vault's reads
give the window's total and not each trade's height, so the SDK cannot say when.
`suggestSize(state, tokenIn)` returns the same object without a refusal, for choosing an amount
before the check. The existing fields of the refusal are unchanged.

`maxAmountIn` does not count the owner's approval threshold. `approvalThreshold` is that threshold
for the input token, or `null`, and `maxDirectAmountIn` is the smaller of the two: the contract's
`execute-swap` accepts it and refuses one more, with the rule in `directLimitedBy`
(`APPROVAL_REQUIRED` when the threshold is what stops it). With no threshold, or one at or above
`maxAmountIn`, the two amounts are equal and nothing can be requested.

### Warnings before a trade

`tradeWarnings` compares an intended trade with what this vault's agent has done before. It is for
a monitor or an owner's screen: a trade can be inside every limit and still be out of character.

```typescript
const warnings = tradeWarnings(
  parseJournal(await chain.journal()),
  { owner, tokenIn, tokenOut, amountIn, burnHeight },
  { sizeMultiple: 5n },
);
// [{ kind: "LARGE_TRADE", message, amountIn, baseline, basis, sizeMultiple, pastTrades }]
```

There are four kinds: `FIRST_TRADE_IN_DIRECTION` (the vault never sold this token for that one),
`LARGE_TRADE` (more than `sizeMultiple` times the median, or the largest, past amount in that
direction), `BURST` (this would be at least the `burstTrades`-th trade within `burstBlocks` burn
blocks) and `QUIET_PERIOD` (the last trade is `quietBlocks` or more back). The third argument
overrides any of `DEFAULT_WARNING_THRESHOLDS`: 3 times the median, 3 trades in 6 blocks, 1008
blocks. The list is empty when nothing applies. A trade the owner approved counts as a past trade
like any other. Warnings are advisory and separate from
`checkIntent`, which reads the vault's state and never sees the journal: its verdict is the same
with or without them.

### An accountability record

A trade's event (`execute-swap`, or `approve-swap` for a trade the owner approved) names the agent,
the amounts and the oracle values, but not the limits it ran under. `accountabilityRecords` rebuilds them by replaying the owner's earlier events, and names
the event that set each one.

```typescript
const records = accountabilityRecords(parseJournal(await chain.journal()), {
  owner,
});
const report = renderAccountabilityReport(records, { title: "My vault" });
const json = JSON.stringify(accountabilityJson(records));
```

Each record is `{ swap, request, policy, issues }`. `swap` is the event's own fields, with
`approved: true` and `requestedAt` when the owner approved the trade; `request` then points at the
`request-swap` event it ran. `policy` holds the agent, the cooldown and expiry, the input token's
caps and approval threshold, the price bounds and the token and adapter lists as they stood, each
with `setBy: { index, burnHeight, txId }`. `policy.approvalThreshold` is `null` when the owner
never set one. The report prints "approved by the owner" or "sent by the agent alone" for each
trade. `issues` is empty when every
limit was found and the trade is inside each; the contract cannot accept a trade outside its
limits, so an entry means the journal given is incomplete. `renderAccountabilityReport` writes
Markdown that also reads as plain text, with amounts in base units. A journal with no trades gives
an empty list and a report that says so.

### What is known about an agent

`agentHistory` reads the journal of the whole contract, every owner's events, for one agent
principal.

```typescript
const history = agentHistory(parseJournal(await chain.journal()), agent);
if (history.known) {
  const { firstSeen, owners, swaps, volume, lastTrade } = history;
}
```

It returns where the agent first appears, the owners that named it and whether each still does, how
many trades it made (`swaps`, of which `approvedSwaps` were approved by an owner), the amount sold
per input token, its last trade, and `requests`: how many trades it asked an owner to approve and
how many were approved, rejected or withdrawn. A principal no event names
returns `{ known: false, agent }`, not an error. The journal holds only calls that succeeded, and
the SDK has no reader for failed transactions, so refused calls are not counted. A short history
says little: anyone can make a new principal.

### Leaving in one action

`buildLeave` returns the calls an owner signs, in order, to stop the agent and take everything out:
`pause` first, then one `withdraw` of the full balance per token that has one.

```typescript
const read = await readVault(client, vaultConfig, owner);
for (const step of buildLeave(txConfig, read)) {
  // step.kind is "pause" or "withdraw"; hand step.call to the owner's wallet.
}
```

A token with a zero balance gets no call, so an empty vault gives the `pause` alone. Each call
comes from `buildPause` or `buildWithdraw` and carries that builder's post-conditions. The amounts
are the balances as read. If the agent trades before the `pause` is mined, a withdrawal above the
ledger is refused with u101 and nothing moves; read the vault and build again once the vault shows
paused. The agent stays named: pausing stops it, and `buildRemoveAgent` removes it.

## The same loop through the MCP server

`@keelio/mcp` serves nine tools ([mcp-tools.md](mcp-tools.md)). The loop uses five:
`keelio_get_vault`, `keelio_check_trade`, `keelio_build_swap`, `keelio_journal` and `keelio_size_position`.
The approval band adds `keelio_build_swap_request` and `keelio_build_cancel_request`, and two more read
the journal: `keelio_agent_history` and `keelio_accountability`. An agent that speaks MCP,
usually a model, calls them itself. `mcp-agent.ts` scripts the calls a model would make, so the
example stays deterministic.

Every amount and height is a decimal string of base units, in and out. A refused trade is a normal
result with `ok: false`; `isError: true` means a malformed input or a failed chain read.

```ts
export async function callKeelioTool(
  tools: ToolCaller,
  name: string,
  args: Json,
): Promise<Json> {
  const res = (await tools.callTool({ name, arguments: args })) as {
    isError?: boolean;
    structuredContent?: Json;
  };
  const body = res.structuredContent ?? {};
  if (res.isError === true) {
    throw new Error(`${name} failed: ${JSON.stringify(body.error ?? body)}`);
  }
  return body;
}
```

`keelio_build_swap` runs the same check as `keelio_check_trade` on every call and returns a call only
when it passes, so the agent cannot get a call for a trade the policy refuses:

```ts
let built: Json | null = null;
for (const toleranceBps of config.tolerancesBps) {
  const atPrice = (amountIn * SATS) / price;
  const minOut = (atPrice * (BPS - toleranceBps) + BPS - 1n) / BPS;
  const answer = await callKeelioTool(tools, "keelio_build_swap", {
    owner,
    agent: config.agent,
    adapter: config.adapter,
    tokenIn: quote,
    tokenOut: sbtc,
    amountIn: amountIn.toString(),
    minOut: minOut.toString(),
  });
  if (answer.ok === true) {
    run.attempts.push({ toleranceBps, minOut, refusal: null });
    built = answer.call as Json;
    break;
  }
  const errorCode = answer.errorCode as number;
  const rule = answer.rule as string;
  const errorName = vaultErrorName(errorCode);
  run.attempts.push({
    toleranceBps,
    minOut,
    refusal: { rule, errorCode, errorName },
  });
  if (rule !== "BELOW_ORACLE_FLOOR") break;
}
if (built === null) return run;
```

The tools do not return the vault's oracle price, its price bounds or the floor, so an MCP agent
brings its own price and learns that its `min-out` is too low from the `BELOW_ORACLE_FLOOR`
refusal. In the run the agent first asks for 3% below its price, is refused with no call, and
passes at 1%.

The call the tool returns is unsigned JSON with hex arguments. Turn it back into a call for your
wallet:

```ts
export function decodeCall(call: Json): VaultCall {
  const functionArgs = (call.functionArgs as string[]).map((hex) =>
    Cl.deserialize(hex),
  );
  return {
    contractAddress: call.contractAddress as string,
    contractName: call.contractName as string,
    functionName: call.functionName as string,
    functionArgs,
    postConditions: call.postConditions as PostCondition[],
    postConditionMode: "deny",
  };
}
```

The server never signs and never sends. Use `functionArgs`, not `functionArgsRepr`, which is for
people to read.

### The approval flow through the tools

`mcp-agent.ts` does not script this flow; `tests/mcp-approval.test.ts` runs it against the
contract.

1. `keelio_check_trade` (or `keelio_build_swap`) refuses with rule `APPROVAL_REQUIRED`, `errorCode`
   126 and `"requestNeeded": true`. Its `suggestion.maxDirectAmountIn` is the most the agent could
   send without asking.
2. The agent calls `keelio_build_swap_request` with the same input. The tool runs `request-swap`'s
   checks and returns an unsigned `request-swap` call with no post-conditions, or a refusal: rule
   `APPROVAL_NOT_NEEDED` (u127) if the trade needs no approval after all, `REQUEST_PENDING` (u128)
   if the owner already has a request waiting.
3. The agent signs and sends the call. `keelio_get_vault` now shows the request as `pendingSwap`,
   with `expiresAt` and `expired`.
4. The owner approves or rejects in the dashboard. The server builds neither call: the agent's
   tools cannot approve the agent's own request.
5. The agent reads `keelio_journal`. An `approve-swap` event is the trade: it has the fields of
   `execute-swap` plus `requested-at`, and there is no `execute-swap` event for it. A `reject-swap`
   event means the owner said no. If `pendingSwap.expired` turns `true` with neither, the request
   ran out, and the agent can build a new one or withdraw the old one with
   `keelio_build_cancel_request`.

`keelio_check_trade` also returns `warnings` on every answer: how the trade compares with the vault's
past trades in the journal (the SDK's `tradeWarnings`). They are advisory and never change `ok`.

The server needs a chain to read, and you inject it. The example wires the server to the harness
and connects a client over an in-memory transport:

```ts
const chain: KeelioChain = {
  callReadOnly: harness.chain.client.callReadOnly,
  burnHeight: harness.chain.burnHeight,
  blockTimeMs: harness.chain.blockTimeMs,
  vaultEvents: harness.chain.journal,
};
const server = createServer({ chain, read: harness.read, tx: harness.tx });
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "example-agent", version: "0.0.0" });
await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
```

## What changes on a real network

Nothing in Keelio is deployed, and this repository's own rule is that it never deploys, signs or
broadcasts: a deployment is its owner's decision and action. This section is what you would change
once a vault exists on a network you use.

**The chain.** Replace `simnet-harness.ts` with reads from a node. The SDK's `stacksApiClient`
implements the contract reads over a node's read-only call endpoint. It only reads, and it takes
`fetch` as an argument.

```ts
export function networkChain(options: NetworkChainOptions): Chain {
  const { baseUrl, sender, fetch, burnHeight, blockTimeMs, journal } = options;
  return {
    client: stacksApiClient({ baseUrl, sender, fetch }),
    burnHeight,
    blockTimeMs,
    journal,
  };
}
```

You supply `burnHeight`, `blockTimeMs` and `journal` from your own node or API client: the SDK has
no call for the burn height, the block time or the contract's print events. The test suite runs
the agent's read step through `networkChain` against a stand-in `fetch` that answers from the
simnet; it has not been run against a live node.

**The wallet.** Implement `Wallet.submit` with the wallet or signing library that holds the
agent's key: add the network, fee and nonce to the `VaultCall`, sign, broadcast, wait for the
transaction to be mined and return its result. A `VaultCall` is the subset of
`@stacks/transactions`' contract-call options with none of those four. Keelio has no code for this
step and will not ask for the key.

**The config.** `VaultConfig` and `TxConfig` must describe the deployed vault: full contract ids
(`stacksApiClient` refuses a bare contract name), the vault's `ORACLE`, `ALLOWED-TOKEN` and
`PRICE-SCALE`, each token's asset name, and each adapter's route. `mock-dex` pays out from its own
balance (`{ pool: null }`). An adapter that trades through a pool names it, and the call then
carries four post-conditions instead of two ([mcp-tools.md](mcp-tools.md#the-call-format)).

**Time.** On the simnet the agent's transaction is mined the moment it is sent. On a network the
state you read is at least a block old when your transaction runs, so expect more contract
refusals after a passing check: the owner pauses, another trade uses the day's cap, the price
ages. The loop above already handles each as a `contract-refusal`.

**Price.** The harness points `mock-dex` at the oracle price before each swap, so every fill is
exactly at the oracle value. A real pool has its own price, fees and depth. Quote it, set `min-out`
from the quote, and expect u118 when the pool moves against you between quote and fill.

**Post-conditions.** A node enforces them, in deny mode. The simnet does not check them, so the
example does not show one failing.

**MCP.** The server reads through a `KeelioChain`: the SDK's read-only client plus `burnHeight()`,
`blockTimeMs()` and `vaultEvents()`. The only implementation in the repository is `simnetChain`.
For a network you write one, as the example does from its harness, and pass it to `createServer`
or `runStdio`.
