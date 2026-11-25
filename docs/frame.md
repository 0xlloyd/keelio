# Keelio: product frame

Keelio lets a Bitcoin holder hand sBTC to a trading agent without handing over custody. The owner
deposits into a Clarity vault and sets limits. The agent can trade inside those limits and can never
withdraw. The limits are enforced by the contract, so they hold even if the agent, its model or its
server is compromised.

## Who it is for

- **Holders** who want an agent to trade or rebalance their sBTC but will not give a bot their keys.
- **Agent builders** on Stacks who need a safe way to accept user funds. They integrate the SDK or
  the MCP server instead of writing custody code.
- **Protocols** (DEXs, lending) that want agent-driven volume without being blamed for agent losses.

## The problem

Today an agent that trades needs a hot wallet holding the user's funds. One prompt injection, leaked
key or bad model output can drain it. Off-chain risk checks (the kind our own trading bot uses on
Hyperliquid) only protect a user who trusts the server that runs them.

## Why Stacks

- **sBTC** is the asset people actually want an agent to manage.
- **Clarity** is decidable and has no reentrancy, so a small vault contract can be read and reasoned
  about in full. Post-conditions let the wallet show the worst case before the owner signs.
- **Bitcoin finality** for the journal: every agent action is a contract event anyone can audit.

## What v0 does

1. **Vault contract (`keelio-vault`)**: one contract, one vault per owner. It is written in Clarity 6
   (epoch 4.0) and calls tokens and adapters inside `as-contract?` allowances (see
   `docs/clarity-4.md`); the version decision is in `docs/clarity-version.md`.
   - The owner deposits and withdraws SIP-010 tokens at any time. Only the owner can withdraw.
   - The owner names one agent principal, and can replace or remove it.
   - The owner sets a policy: allowed tokens, allowed swap adapters, a cap per trade, a cap per day
     (144 burn blocks), a cooldown between trades, and an expiry height. In v0 the tokens and the
     one adapter come from a set fixed at deploy time; an owner's lists can only narrow it.
   - A kill switch (pause) stops the agent at once. Withdrawals still work while paused.
   - The agent calls `execute-swap`. The vault checks the policy, moves the tokens to the adapter
     itself, and requires that at least `min-out` of the output token came back to the vault.
     Tokens never pass through the agent.
   - The vault reads a BTC/USD price from one oracle fixed at deploy time, and refuses a `min-out`
     below that price less the owner's `max-slippage-bps`, or a price older than the owner's
     `max-price-age`. An owner who never set these bounds may not have the agent trade.
   - The owner can set an approval threshold per input token. A trade above it, and within the cap
     per trade, is refused from the agent alone: the agent records it with `request-swap`, and it
     runs only if the owner calls `approve-swap` within 6 burn blocks, with every check run again
     at that moment. The approval names the request by its trade and the burn height it was made
     at, so it cannot run any other request. The owner can reject a request and the agent can withdraw it.
   - Every action prints a structured event. The events are the trading journal.
2. **Swap adapters**: a small trait any DEX can implement. v0 ships a mock DEX for tests. The first
   live adapter, for Bitflow, is a roadmap milestone (see `docs/roadmap.md`).
3. **SDK (`packages/sdk`)**: typed reads, transaction builders, and `checkIntent`, which runs the
   same policy checks off-chain so an agent knows a trade will be refused before it pays a fee
   (`checkRequest` and `checkApproval` do the same for the approval calls). It also carries
   risk-based sizing: quantity = capital × risk % ÷ |entry − stop|.
4. **MCP server (`packages/mcp`)**: tools any agent can call: read the vault, check a trade, build
   the swap transaction or a request for the owner's approval, read the journal. It builds only
   the agent's calls; approving is the owner's act.

## What v0 does not do

- No second price source. The oracle floor trusts one BTC/USD feed, with no confidence band, and
  does not see sBTC or the quote token lose its peg (see `docs/threat-model.md`, T3).
- No strategies. Keelio is the guardrail, not the trader.
- No mainnet deployment and no real funds. Everything runs on the local simnet.
- No custody by us at any point. Keelio never holds keys.

## Rules for everyone who works on this repo

- **Simnet only.** Never deploy to testnet or mainnet, and never sign or broadcast a real
  transaction. A deployment is the owner's decision and the owner's action.
  One exception: a local devnet on the developer's own machine may be used to check that a node
  enforces the SDK's post-conditions, which the simnet does not. It uses only the throwaway keys
  in `settings/Devnet.toml` and never connects to testnet or mainnet.
- **No real keys.** The only keys in the repo are the throwaway ones in `settings/Simnet.toml` and
  `settings/Devnet.toml`.
- **The contract is the product.** A policy check that exists only off-chain is a bug.
- **Every contract function has a test for the refusal as well as the success.**
- **Error codes are stable.** Each `(err uN)` is declared once as a named constant and listed in
  `docs/errors.md`.
- **Amounts are in base units** (sats for sBTC) and are `uint` on-chain, `bigint` in TypeScript.
  Never use floating point for an amount.

## Layout

```
contracts/            Clarity contracts
  traits/             sip-010, swap-adapter and oracle traits
  mocks/              mock sBTC, mock quote token, mock DEX, mock oracle (tests only)
  adapters/           live swap adapters (Bitflow)
tests/                contract tests (vitest + the Clarinet simnet)
packages/sdk/         TypeScript SDK
packages/mcp/         MCP server
packages/monitor/     journal monitor (alerts to stdout; see docs/monitoring.md)
apps/                 owner dashboard and web demo (simnet in the browser), public site
examples/agent/       an example trading agent over the SDK and the MCP server
scripts/              the demos, the monitor's runner and the deploy-config check
docs/                 frame, errors, events, threat model, runbooks, roadmap
```
