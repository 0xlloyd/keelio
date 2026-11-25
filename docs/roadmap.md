# Keelio: roadmap

Four milestones over about eleven weeks. Each ends with something a reviewer can run. Deployments
are made by the owner, on testnet only. Nothing here is on mainnet, and
`docs/mainnet-readiness.md` lists what must be true before any real funds.

### Milestone 1: a vault that can be deployed (weeks 1 to 3)

- A cap per token, so a limit set in sats applies only to sBTC and the quote token has its own.
- Tokens, asset names and the adapter set in one place, with a deployment check that refuses a
  mismatched asset name before any deposit is possible.
- A Stacks API chain client for the SDK and the MCP server, so both can read a real network.
- The vault deployed to testnet by the owner, with one deposit and one withdrawal.

**Done when:** `pnpm run check` passes with the new per-token cap tests; the buy-back leg of the
demo succeeds under a policy sized for each token; the testnet contract id and the two transaction
ids are in the repo; the MCP `keelio_get_vault` tool returns that testnet vault.

**Status, 17 November 2026:** built and tested on the simnet: per-token caps, the single
configuration block with `pnpm run check-deploy`, the Clarity version decision (moved to Clarity 6,
`docs/clarity-version.md`) and the Stacks API client. Left: the testnet deployment, deposit and
withdrawal, which are the owner's actions, and pointing `keelio_get_vault` at that vault. The
steps are written down in `docs/testnet-runbook.md`; none has been run.

### Milestone 2: one live DEX adapter (weeks 3 to 6)

- An adapter for one Bitflow sBTC pool, implementing the existing adapter trait. Bitflow is the
  main sBTC venue today. ALEX has no sBTC pool that we could find, and Velar's sBTC pool is close
  to idle, so neither is a sensible first adapter.
- First choice of pool: sBTC/USDCx on Bitflow's DLMM router, which avoids an STX leg. Fallback:
  the sBTC/STX pool on `xyk-core-v-1-2` (`swap-x-for-y`), if a contract can route through
  Bitflow's STX wrapper. The first week of the milestone settles which.
- One adapter contract per pool, with the pool fixed inside it. Bitflow debits and credits
  `tx-sender`, so the adapter receives the input from the vault, swaps as itself and forwards the
  output. That keeps the vault's allowance and the SDK's post-conditions true as written.
- Adapter tests run on the simnet against Bitflow's own mainnet contracts, not the mock.
- A swap inside a policy and a refused one outside it, shown against those contracts.

**Done when:** the adapter's tests pass against Bitflow's contracts; the threat-model rows for the
adapter (T2a to T2f) cite tests that run against it; the demo runs its trade through the Bitflow
adapter; a written note says whether Bitflow can be exercised on testnet and, if it can, the two
testnet transaction ids are in the repo.

**Status, 17 November 2026:** built and tested: `bitflow-adapter` for the sBTC/USDCx DLMM pool,
with tests against Bitflow's mainnet contracts and the T2a to T2f rows citing them. The written
note is `docs/bitflow.md`, section 6: Bitflow has no testnet deployment of this pool, so there are
no testnet transaction ids to give. The demo runs its trades through the Bitflow adapter:
`pnpm run demo:bitflow` (`scripts/demo-bitflow.ts`) tells the story of `pnpm run demo` against the
same mainnet pool, read only, in the local simnet, and `tests/demo-bitflow.test.ts` checks it under
`pnpm run test:online`. `pnpm run demo` itself stays offline on the mock DEX.

### Milestone 3: oracle-bounded slippage (weeks 6 to 9)

- The owner sets a maximum slippage in basis points. The vault reads a reference price and refuses
  a swap whose `min-out` is below that bound, whatever the agent asks for.
- A maximum price age enforced in the contract. A stale price refuses the trade; it never falls back
  to no check.
- Planned source: DIA's `BTC/USD` feed on Stacks, read through a small oracle trait so the source
  can change. On 15 November 2026 its mainnet value was 48 seconds old. The Pyth BTC/USD price
  stored on Stacks was last published on 21 August 2026, so we do not plan to depend on it.
- `checkIntent` and the MCP tools gain the same rule, with the same error code.

**Done when:** threat T3 moves from planned to handled with tests cited by name; a test shows a
swap with `min-out` 0 is refused; a test shows a stale price refuses the trade; the property test
adds the claim that no swap settles below the bound.

Known limits we will state: DIA has one updater key and no confidence value, and a BTC price does
not see an sBTC de-peg.

**Status, 17 November 2026:** built and tested: the floor and the maximum age in the vault (DIA
behind an oracle trait), the same rule in `checkIntent` and the MCP tools, T3 handled with tests
cited by name, and the property test's floor claim. Left: nothing on the simnet; on testnet it
needs the Milestone 1 deployment.

### Milestone 4: owner dashboard, review and release (weeks 9 to 11)

- A web dashboard for owners on testnet: connect a wallet, deposit, set the policy, name the agent,
  pause, withdraw, and read the journal. Every call shows its post-conditions before signing.
- An independent review of the vault and the adapter, with the findings and our responses
  published in the repo.
- Integration guide for agent builders: SDK and MCP server, with a worked example agent.
- A mainnet-readiness report: what is handled, what is accepted, and what must be true before any
  real funds are involved. Mainnet deployment is outside this roadmap.

**Done when:** a reviewer can complete the full demo flow from the dashboard on testnet; the review
findings are published with each one fixed or accepted in writing; the guide's example runs from a
clean checkout.

**Status, 17 November 2026:** partly built, on the simnet only. The dashboard runs every owner
action on a simnet in the page, with the post-conditions shown before each call; its testnet
session is built and has only met a stand-in wallet. The integration guide and a worked example
agent are written, and the example runs from a clean checkout. The mainnet-readiness report is
drafted (`docs/mainnet-readiness.md`), with a journal monitor towards its item 9. The reviewer's
packet is drafted (`docs/review-packet.md`). Left: the dashboard flow on testnet, which needs the
Milestone 1 deployment and a real wallet, and the independent review, which has not started.
