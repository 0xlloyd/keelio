# Keelio

Risk-limited sBTC vaults for trading agents on Stacks.

An owner deposits sBTC into a Clarity vault and sets limits. A trading agent can swap inside those
limits and can never withdraw. The contract enforces the limits, so they hold even if the agent is
compromised.

**Status:** early prototype. Everything runs on a local simnet. Nothing is deployed and no real
funds are involved.

Read [docs/frame.md](docs/frame.md) for what Keelio is, who it is for and what v0 covers.

## Run it

Needs Node 22.18+ and pnpm.

```bash
pnpm install
pnpm run check
```

`pnpm run check` runs the formatter check, the linter, the type checker and the contract tests, then
builds and checks the public site. The tests start a Clarinet simnet in-process, so no Clarinet
install and no network access are needed.

The Bitflow adapter tests and the Bitflow demo's test read mainnet contract state through Hiro's
public API (read only), so they are not part of `pnpm run check`. Run them with
`pnpm run test:online`.

## See it work

One run on the simnet: an owner opens a vault with caps for each token, its agent sells sBTC and
buys half of it back inside those caps, the contract refuses a trade over the cap, a withdrawal by
the agent and a trade after the pause, and the owner takes everything back.

```bash
pnpm run demo
```

pnpm prints its own command line first. The block below is the script's output.

```text
Keelio demo: an owner, an agent and a refused trade
A fresh in-process simnet with its throwaway accounts. Nothing is signed or broadcast.

Setup (simnet-only mocks, not part of Keelio)
  mint 1.00000000 mock sBTC to owner: (ok true)
  mint 1000000.000000 mock USD to mock-dex: (ok true)
  set the mock-dex rate to 900 USD base units per sat: (ok true)
  set the mock-oracle BTC/USD price to 90000.00000000 USD, timestamped now: (ok true)

1. The owner opens the vault
  deposit 1.00000000 sBTC: (ok u100000000)
  set-agent to agent: (ok true)
  set-token-caps mock-sbtc 0.10000000 sBTC per trade, 0.30000000 sBTC per day: (ok true)
  set-token-caps mock-usd 10000.000000 USD per trade, 30000.000000 USD per day: (ok true)
  set-policy no cooldown, for the next 1000 burn blocks, for both tokens: (ok true)
  allow-token mock-sbtc: (ok true)
  allow-token mock-usd: (ok true)
  allow-adapter mock-dex: (ok true)
  set-price-bounds 100 bps below the oracle price at most, a price at most 3600000 ms old: (ok true)
  Each token has its own caps in its own base units.
  Every swap must ask for at least the oracle price less 1%, or the vault refuses it.

2. The agent swaps 0.10000000 sBTC for USD on mock-dex
  checkIntent: ok, no policy rule refuses
  execute-swap: (ok u9000000000), 9000.000000 USD received

3. The agent buys sBTC back
  mock: set the mock-dex rate to 1 sat per 900 USD base units: (ok true)
  The agent swaps 4500.000000 USD for at least 0.05000000 sBTC, inside the USD caps.
  checkIntent: ok, no policy rule refuses
  execute-swap: (ok u5000000), 0.05000000 sBTC received

4. The agent tries 0.50000000 sBTC
  checkIntent: TRADE_CAP_EXCEEDED (u114): the amount is above the per-trade cap for token in
  execute-swap: (err u114) ERR-TRADE-CAP-EXCEEDED
  The contract refuses the trade for the same rule checkIntent named.

5. The agent tries to withdraw 0.10000000 sBTC
  checkIntent covers swaps only, so nothing checks this call in advance.
  withdraw: (err u101) ERR-INSUFFICIENT-BALANCE
  withdraw takes no owner argument and pays out only the caller's own ledger; the agent has none.
  The owner's vault still holds 0.95000000 sBTC and 4500.000000 USD.

6. The owner pauses the vault
  pause: (ok true)
  The agent tries 0.10000000 sBTC, inside both caps.
  checkIntent: VAULT_PAUSED (u109): the vault is paused
  execute-swap: (err u109) ERR-VAULT-PAUSED

7. The owner withdraws everything while the vault is still paused
  withdraw 0.95000000 sBTC: (ok u0)
  withdraw 4500.000000 USD: (ok u0)
  vault ledger: 0.00000000 sBTC, 0.000000 USD, paused: true
  owner wallet: 0.95000000 sBTC, 4500.000000 USD
  agent wallet: 0.00000000 sBTC

Journal: every keelio-vault print event, in order
  deposit          owner: 1.00000000 sBTC, ledger 1.00000000 sBTC
  set-agent        owner: agent=agent paused=false
  set-token-caps   owner: token=mock-sbtc max-per-trade=0.10000000 sBTC max-per-day=0.30000000 sBTC
  set-token-caps   owner: token=mock-usd max-per-trade=10000.000000 USD max-per-day=30000.000000 USD
  set-policy       owner: cooldown-blocks=0, expires 1000 burn blocks after it was set
  allow-token      owner: token=mock-sbtc allowed=true
  allow-token      owner: token=mock-usd allowed=true
  allow-adapter    owner: adapter=mock-dex allowed=true
  set-price-bounds owner: max-slippage-bps=100 max-price-age=3600000 ms
  execute-swap     owner: agent sold 0.10000000 sBTC for 9000.000000 USD on mock-dex (min 9000.000000 USD), ledger 0.90000000 sBTC and 9000.000000 USD, day total 0.10000000 sBTC
  execute-swap     owner: agent sold 4500.000000 USD for 0.05000000 sBTC on mock-dex (min 0.05000000 sBTC), ledger 4500.000000 USD and 0.95000000 sBTC, day total 4500.000000 USD
  pause            owner: agent=agent paused=true
  withdraw         owner: 0.95000000 sBTC, ledger 0.00000000 sBTC
  withdraw         owner: 4500.000000 USD, ledger 0.000000 USD
The refused calls printed nothing: a call that returns an error leaves no journal entry.

Each built call also carries post-conditions for a wallet; the simnet does not check them.
```

### The same story on Bitflow

```bash
pnpm run demo:bitflow
```

This runs the same steps, but the agent's trades go through `contracts/adapters/bitflow-adapter.clar`
to Bitflow's mainnet sBTC/USDCx pool. It needs the network: the simnet reads mainnet contract state
through Hiro's public API, read only, at the height pinned in `tests/bitflow-remote/Clarinet.toml`.
Every call still runs in the local simnet, on a copy of `keelio-vault` configured for sBTC, USDCx and
the adapter. Nothing is signed or broadcast, and no funds are real. The script prints the amounts
the pool paid at that height, so its output is not fixed here. The mock oracle stands in for a
price feed and is set to the pool's own active-bin price. See `docs/bitflow.md` for the adapter.

## Owner dashboard

`apps/dashboard` is the owner dashboard. It has two modes. The default is a local simulation, and
it is the only mode that has ever been run. The testnet mode is built and tested with stand-ins,
but it has never talked to a real wallet or a deployed vault.

### Simulation mode (the default)

The page runs the real vault contract on a Clarinet simnet inside the page, with mock tokens. It
connects to no wallet and no network, signs nothing and broadcasts nothing, and no funds are real.
Reloading the page starts a new simnet.

```bash
pnpm run dashboard
```

Then open the address Vite prints. You act as the owner: deposit, withdraw, name or remove the
agent, pause and unpause, and set the cooldown and expiry, each token's caps, the price bounds and
the token and adapter allow lists. Every form builds its call with the SDK and shows a review step
first: the function, its arguments in base units and in words, and the call's post-conditions. The
simnet enforces those post-conditions when you confirm. A refusal shows the contract's error code
and its name from `docs/errors.md`. The simulation controls let a second simnet account trade as
the agent, mine burn blocks and set the mock oracle's price, and the journal lists every event,
newest first.

### Testnet mode (built, never run on testnet)

The dashboard talks to a chain only through the `ChainSession` interface in
`apps/dashboard/src/chain.ts`. `apps/dashboard/src/wallet-chain.ts` is a second implementation of
it, for testnet. The forms, the review step and the panels are the same code in both modes.

What is built:

- **Reads.** The vault is read through the SDK's `stacksApiClient` and `readVault`. The burn
  height, the block time and the owner's own token balances come from the Stacks API.
- **Calls.** After the review step, the call the SDK built goes to the owner's wallet through
  `@stacks/connect` (pinned at 8.2.7, a dependency of the dashboard only): its function, its
  arguments, its post-conditions and Deny mode, unchanged. The wallet signs and broadcasts. This
  repo never does either and holds no key. The page then follows the transaction to a result: done,
  refused with the contract's error code, or aborted by a post-condition. While it waits it shows
  the transaction id, and after 10 minutes it stops waiting and leaves the id on the page.
- **A check on the wallet.** When the API first lists the transaction, the page compares its
  contract, function, arguments, post-conditions and mode with the call that was reviewed, and says
  so if they differ. This runs after the wallet has broadcast, so it reports a changed call and
  cannot prevent one.
- **The journal.** The vault contract's print events are read from the API, kept to this owner and
  listed oldest first.
- **A mainnet guard.** The mode refuses to start if the config names mainnet (a network of
  `mainnet`, an `SP` or `SM` address, or a mainnet API URL), if the node reports mainnet's network
  id, or if the wallet answers with a mainnet address. Mainnet is outside this version.
- **No simulation controls.** Acting as the agent, mining blocks and setting the oracle price exist
  only in the simulation and are removed from the page in testnet mode.

What has never been run:

- It has never been connected to a real wallet. The wallet library's own `request` function is
  tested against a stand-in for a wallet, which receives the SDK's post-conditions and Deny mode
  intact. Whether a real wallet shows and enforces them has not been seen. The library's README
  says wallets it calls "Xverse-like" do not support post-conditions on a contract call, so the
  page offers only Leather.
- It has never read a deployed vault. The tests answer the read-only calls from the Clarinet simnet
  and every other request in shapes recorded from the public mainnet API
  (`tests/fixtures/stacks-api/extended.json`). No request has gone to a testnet API.
- No transaction has been signed or broadcast, on any network.

To point it at testnet, after the owner has deployed `keelio-vault` there (see
`pnpm run check-deploy`; the deployment is the owner's decision and action):

1. Copy `apps/dashboard/testnet.config.example.json` to `apps/dashboard/testnet.config.json`. Git
   ignores the copy.
2. Fill in the vault's contract id, each token's contract id, asset name and decimals, the adapter
   and its pool, the oracle, the vault's `PRICE-SCALE` and the testnet API URL. These must equal the
   vault's deploy constants: the contract has no getter for them.
3. Run `pnpm run dashboard` and open the address Vite prints with `?mode=testnet` added, or follow
   the link at the top of the page.

Without that file the wallet library and the API client are not part of the page at all, and
`?mode=testnet` only lists what is missing. With an incomplete file it lists each missing field.
The banner at the top of the page always says which mode it is in.

## Build an agent on it

[docs/integration-guide.md](docs/integration-guide.md) is for agent builders: what the vault
guarantees and what it does not, the loop an agent runs through the SDK or the MCP server, how to
handle refusals, and what changes on a real network. Its worked example is a rule-based rebalancer
in `examples/agent`, with no model call and no network access:

```bash
pnpm run example:agent
```

## Watch a vault

`packages/monitor` reads the vault's journal and its refused calls and writes one JSON alert per
line to stdout: every swap and how far above the oracle floor it settled, refusals with their
error code, a stale oracle, owner actions that change risk, deposits and withdrawals, and a policy
about to expire. `pnpm run monitor -- --simnet-demo` runs it over the demo's story on the simnet.
It has not watched a deployed vault, because there is none, and it sends nothing anywhere: piping
stdout to an alerting system is the operator's job. [docs/monitoring.md](docs/monitoring.md) lists
each alert, what the monitor cannot see, and a draft plan for telling owners to withdraw if a flaw
is found.

## Public site

`apps/site` builds one static page that says what Keelio is. Every figure on it comes from the repo:
the test count from the last full test run, the error-code count from `docs/errors.md`, and the
text from `docs/frame.md`, `docs/roadmap.md`, `docs/mcp-tools.md` and this README.

```bash
pnpm run test && pnpm run site:build
```

The page is `apps/site/dist/index.html`. Open it in a browser, or serve it with
`pnpm run site:preview`. `site:build` refuses a test report from a failed or partial run, and
`pnpm run site:test` checks the built page.

### keelio.xyz

`pnpm run test && pnpm run web:build` builds everything served at <https://keelio.xyz> into
`dist/web`: the page at `/`, the web demo at `/demo/` and the owner dashboard at `/dashboard/`, with
a `_headers` file of security headers for Cloudflare Pages. Both apps run a simnet in the browser:
the hosted dashboard is built without a testnet config, so it has no wallet code and makes no
network call. `pnpm run web:preview` serves the build on `http://localhost:4173` under the same
Content-Security-Policy.

`pnpm run web:deploy` runs the full check, builds `dist/web` and publishes it to the Cloudflare
Pages project `keelio` with wrangler, as whoever ran `pnpm exec wrangler login` on this machine.
There is no deploy workflow: no workflow in this repo may read a secret
(`tests/supply-chain.test.ts`). It publishes web files only. No contract is deployed, signed or
broadcast.

## License

MIT
