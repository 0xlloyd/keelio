# Testnet runbook: the owner's steps for Milestone 1

**Draft, 17 November 2026. None of this has been run.** Deploying, signing and broadcasting are the
owner's decision and the owner's action (`docs/frame.md`), so this is a checklist for the owner to
follow by hand. Nothing in the repo deploys for you. The Clarinet commands below were not run when
this was written: the Clarinet CLI is not installed in the development environment, by the same
rule. Check each against `clarinet --help` before trusting it.

What the roadmap's Milestone 1 asks for: the vault on testnet, one deposit, one withdrawal, the
contract id and the two transaction ids in the repo, and `keelio_get_vault` returning that vault.

## 1. What goes on testnet

Bitflow has no testnet deployment of the pool `bitflow-adapter` uses (`docs/bitflow.md`, section
6), so the live adapter cannot run there. The testnet deployment therefore uses the mock tokens,
mock DEX and mock oracle, with the vault's configuration block unchanged:

| Contract             | Why                                                          |
| -------------------- | ------------------------------------------------------------ |
| `sip-010-trait`      | The token trait the vault and the mocks use.                 |
| `swap-adapter-trait` | The adapter trait.                                           |
| `oracle-trait`       | The oracle trait.                                            |
| `mock-sbtc`          | `ALLOWED-TOKEN`. 8 decimals.                                 |
| `mock-usd`           | `QUOTE-TOKEN`. 6 decimals.                                   |
| `mock-dex`           | `ALLOWED-ADAPTER`.                                           |
| `mock-oracle`        | `ORACLE`. Clarity 4, epoch 4.0.                              |
| `keelio-vault`       | The vault. Clarity 6, epoch 4.0. `PRICE-SCALE u10000000000`. |

Do not deploy the other contracts in `Clarinet.toml` (`evil-token`, `greedy-sbtc`, `failing-sbtc`,
`vault-caller`, `bitflow-adapter`, `bitflow-probe`). They are test fixtures or name mainnet
principals.

**State this wherever the testnet ids are published:** the mocks are open. Anyone can mint
`mock-sbtc` and `mock-usd`, set the `mock-dex` rate and set the `mock-oracle` price. The testnet
vault shows that the vault's own rules hold on a node. It shows nothing about a real token, DEX or
price feed.

The alternative, testnet sBTC as `ALLOWED-TOKEN`, needs a quote token, an adapter and an oracle
that exist on testnet. We did not find them, so it is not the plan. `[TO FILL: confirm, or name
them.]`

## 2. Before deploying

- [ ] `pnpm install && pnpm run check` passes on the commit you will deploy. Record the commit hash.
- [ ] `pnpm run check-deploy` passes. With the configuration block unchanged it reads the mocks.
- [ ] Testnet runs epoch 4.0, which Clarity 6 needs. On 17 November 2026 it did: the public
      testnet node's `/v2/pox` listed `Epoch40` from burn height 2702, at burn height 39458. Check
      again on the day:
      `curl -s https://api.testnet.hiro.so/v2/pox`
- [ ] A new testnet-only key, made for this and holding nothing else. Fund it from the testnet STX
      faucet. Never reuse a mainnet key.
- [ ] `settings/Testnet.toml` holds that key's mnemonic. The file is in `.gitignore`. Check
      `git status` shows nothing new under `settings/` before every commit.
- [ ] The repo rule still stands for everyone but you: no agent, script or CI job deploys.

## 3. Deploy

Not run here. Verify against your Clarinet version.

```bash
clarinet deployments generate --testnet --low-cost
```

Open `deployments/default.testnet-plan.yaml` and remove every contract that is not in the table in
section 1. Check that `keelio-vault` is published at Clarity 6 and after the three traits, the two
tokens, `mock-dex` and `mock-oracle`. `deployments/` is in `.gitignore`.

```bash
clarinet deployments apply --testnet
```

Record, for section 6:

- the deployer address and each contract id,
- the transaction id of each publish,
- the commit hash the source came from.

Then confirm the deployed source is the repo's source:

```bash
curl -s "https://api.testnet.hiro.so/v2/contracts/source/<deployer>/keelio-vault?proof=0"
```

The `source` field must equal `contracts/keelio-vault.clar` at the recorded commit, byte for byte.

## 4. One deposit and one withdrawal

Use a second testnet key as the owner, so the deployer is shown to have no special power.

1. Mint mock sBTC to the owner: `mock-sbtc.mint(amount, owner)`. Anyone may call it.
2. Deposit: build the call with the SDK's `buildDeposit` and sign it in your wallet. The call
   carries a post-condition in Deny mode: the owner sends exactly `amount` of `mock-sbtc`. Check
   that your wallet shows it before signing.
3. Read the vault (section 5) and see the ledger hold `amount`.
4. Withdraw: `buildWithdraw`, signed the same way. Its post-condition: the vault sends exactly
   `amount`.
5. Record both transaction ids.

This is also the first time a public node, not the simnet, enforces the SDK's post-conditions. If
a wallet or the node rejects a built call, record the call and the message:
that is a finding, not a nuisance.

The dashboard (`apps/dashboard`) is the intended way to do steps 2 to 4 once its testnet session
has been run against this deployment. Until then, build the calls with the SDK from a script that
prints them, and sign in the wallet.

## 5. Point `keelio_get_vault` at it

The SDK's `stacksApiClient` and the MCP server read a real network through the Stacks API. Give
them the testnet API URL, the vault id and the token, adapter and oracle ids from section 3 (see
`docs/integration-guide.md` and `docs/mcp-tools.md` for the configuration), then call
`keelio_get_vault` for the owner after the deposit and after the withdrawal. Record both answers.

This is the first read of a deployed vault by the API client. `docs/roadmap.md` lists
"the Stacks API client is untested against a live vault" as a limit; this step removes it.

## 6. What to put in the repo

Add `docs/testnet.md` with:

- [ ] the date, the commit hash and the Clarinet version,
- [ ] the deployer address and the eight contract ids,
- [ ] the publish transaction ids,
- [ ] the deposit and withdrawal transaction ids, with amounts in base units,
- [ ] the two `keelio_get_vault` answers,
- [ ] the open-mocks statement from section 1,
- [ ] anything that did not behave as the simnet did.

Then update the Milestone 1 status line in `docs/roadmap.md` and item 2 of
`docs/mainnet-readiness.md`.

## 7. The rest of the readiness run

`docs/mainnet-readiness.md` item 2 asks for more than Milestone 1: a policy, an agent swap, a
refused swap, a pause and a withdrawal, all on testnet. With the mocks deployed, that is the story
of `pnpm run demo`, call for call, with a third testnet key as the agent. Do it in the same
session and record those transaction ids too. A refused call is a failed transaction on a node and
costs its fee.
