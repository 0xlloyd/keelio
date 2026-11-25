# Candidate requirements from the TRUSTSHIFT conversation

Source: Anthony Pompliano's interview with William Mougayar, author of "TRUSTSHIFT", titled "How AI
Agents Will Change Bitcoin?" (<https://www.youtube.com/watch?v=QZbEiQ7zrmg>). The part about AI
agents runs from about 15:30 to 24:30. This was taken from the video's auto-generated captions on
25 November 2026, so wording is paraphrased and timestamps are approximate.

Each item follows the rules in `docs/frame.md`: a policy check that exists only off-chain is a
bug, so anything called a limit must be enforced by `keelio-vault`.

## Status

R1 to R8 were built on 25 November 2026, on the simnet only. R9 is a design note. Each item's
"Today" line says what exists. Nothing is deployed, and the contract change in R1 has had no
independent review.

| Item | Built in                                                           |
| ---- | ------------------------------------------------------------------ |
| R1   | `keelio-vault`, SDK, MCP server, monitor, dashboard, example agent |
| R2   | SDK (`tradeWarnings`), `keelio_check_trade`, monitor               |
| R3   | SDK (`agentHistory`), `keelio_agent_history`, dashboard            |
| R4   | dashboard (`apps/dashboard/src/plain-policy.ts`)                   |
| R5   | SDK (`suggestSize`, `checkIntent`), `keelio_check_trade`           |
| R6   | monitor (`--digest`)                                               |
| R7   | SDK (`accountabilityRecords`), `keelio_accountability`, dashboard  |
| R8   | SDK (`buildLeave`), dashboard                                      |
| R9   | design only: `docs/attested-agents.md`                             |

## What was said

| Time  | Point                                                                                                                                                              |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0:00  | Trust is moving from institutions to public infrastructure, which costs a fraction of a third party.                                                               |
| 16:00 | AI should be the interface to wallets. Natural language is "step one". Small platforms do it; no large wallet does.                                                |
| 18:00 | Security is table stakes and must not cost ease of use.                                                                                                            |
| 18:10 | A "semantic firewall": before a transaction goes, check the address, stop and ask on a large amount, ask whether this was done before, suggest a smaller amount.   |
| 20:00 | Pompliano: the agent becomes the interface and accounts become databases. Agents should be proactive and end with "do you want me to confirm?".                    |
| 23:30 | Liability is the frontier. Institutions limit agents because nobody knows who pays for a mistake. In the Air Canada case, the company that deployed the agent did. |
| 28:00 | Bitcoin holders should make BTC productive in DeFi. His route is WBTC on Ethereum.                                                                                 |
| 40:00 | Self-custody must become easy. Disconnect and the assets are still yours, but today "you're your own support line".                                                |
| 44:00 | Prove a condition without disclosing the data, verified once by an authority that is native on-chain.                                                              |

## How this positions Keelio

- Mougayar's semantic firewall is advisory: an AI questions the user. Keelio's limits are enforced by
  the contract and hold even if the agent is compromised. Keelio is the enforced half of the idea, and
  the advisory half (items 2, 3 and 5 below) can sit on top of it.
- He sends Bitcoin holders to WBTC on Ethereum. Keelio with sBTC lets them put BTC to work under an
  agent without leaving Bitcoin finality or giving up custody.
- The liability question is the objection a protocol or an agent builder will raise first. The
  journal is Keelio's answer, and item 7 makes it usable in a dispute.

## Requirements

### R1. Owner-approval band

A trade above an owner-set threshold, and at or below the per-trade cap, is not executed by the
agent's call. It is recorded as pending and runs only when the owner approves it. Pending trades
expire.

- **Source:** "it might stop you and ask you" (18:30); "do you want me to confirm?" (23:00).
- **Today:** built in `keelio-vault`: `set-approval-threshold`, `request-swap`, `approve-swap`,
  `reject-swap`, `cancel-swap-request` and `get-pending-swap` (`tests/keelio-vault-approval.test.ts`).
  The SDK predicts and builds every call (`checkIntent` u126, `checkRequest`, `checkApproval`), the
  MCP server builds the agent's request and never the owner's approval, the monitor alerts on a
  request and on one that expires unanswered, and the dashboard shows a pending request with
  Approve and Reject. A request lasts 6 burn blocks. An approval names the request by its trade and
  the burn height it was made at, so it cannot run a later request for the same trade (u131).
- **Where:** `keelio-vault` (new policy field, pending-trade map, `approve-trade`, new events and
  error codes), then the SDK's `checkIntent`, the MCP tools and the dashboard.
- **Decided in the build:** every `execute-swap` check, the oracle floor included, runs again at
  approval; a trade counts against the daily cap and cooldown when approved, not when requested;
  one request may be pending per owner; the owner's approval names the amount and `min-out`, so the
  agent cannot swap the request under it (`docs/threat-model.md`, T9a to T9f).

### R2. First-time and unusual-trade flags

Flag a trade that is the vault's first use of a token direction, is far larger than the vault's
history, or comes in a burst after a quiet period.

- **Source:** "have you done it before" (19:10).
- **Today:** built. `keelio_check_trade` returns a `warnings` list from the SDK's `tradeWarnings`
  (`checkIntent` itself has no journal, so the warnings are a separate function). The monitor raises four advisory `info` alerts with a
  trade (`execute-swap` or `approve-swap`): `TRADE_FIRST_IN_DIRECTION`, `TRADE_LARGE`,
  `TRADE_BURST` and `TRADE_AFTER_QUIET`, by the rules and default thresholds of the SDK's
  `tradeWarnings`, with the thresholds in the monitor's config (`docs/monitoring.md`, "Unusual
  trades").
- **Where:** `packages/monitor` (new named alerts and thresholds), and a `warnings` list in the
  result of `checkIntent` and `keelio_check_trade`.
- **Note:** advisory only. A flag never blocks a trade; R1 is the blocking version.

### R3. Counterparty history before the owner signs

Before the owner names an agent principal, the dashboard shows what is known about it: its age, the
vaults it already trades for, its refused calls and any alerts the monitor has raised against it.

- **Source:** "this address is suspicious maybe" (18:50).
- **Today:** built. The set-agent form and its review step show the SDK's `agentHistory` for the
  principal, or "No history", always with the line that history is not a guarantee. The simulation
  reads the whole contract's journal; wallet mode reads only the owner's own events and says so.
  There is no count of refused calls: the SDK has no reader for failed transactions.
- **Where:** dashboard and SDK reads over the journal. No contract change.
- **Note:** advisory, and it must say so. History is not a guarantee, and a fresh principal has
  none. Adapters are fixed at deploy time, so this applies to agents only.

### R4. Policy setup in plain language

The owner describes the limits in a sentence. The dashboard turns that into exact policy values,
shows them with the worst-case loss per trade and per day, and the owner signs the ordinary
`set-policy` and `set-price-bounds` transactions.

- **Source:** "AI should be used as an interface for wallets" (16:30).
- **Today:** built with a rule-based parser, not a model: the dashboard runs in the browser with no
  key. A sentence becomes a table of exact values with the worst case per trade and per day and a
  list of what was not understood. Accepting it only fills the existing forms.
- **Where:** dashboard only.
- **Constraint:** the model proposes and never signs. What the owner approves is the exact values,
  with post-conditions, not the sentence.

### R5. Suggest a size that would pass

When `checkIntent` predicts a refusal on a cap, it also returns the largest amount that would pass
now, and when the cooldown or the daily window frees more.

- **Source:** "are you sure you don't want to send a smaller amount" (19:05).
- **Today:** built. A size or cooldown refusal from `checkIntent` carries a `suggestion`: the
  largest amount that passes, the largest the agent may send without approval, and when the
  cooldown ends. Tests show the contract accepts the suggested amount and refuses one more.
- **Where:** `packages/sdk` and `keelio_check_trade`. Amounts stay `bigint`.

### R6. Owner digest

A periodic summary in plain words: what the agent did, what was refused and why, how much of each
cap is left, and when the policy expires.

- **Source:** Pompliano's "reactive to proactive" (22:30).
- **Today:** `pnpm run monitor -- --digest` writes a per-owner digest for a range of burn heights
  to stdout or a file: trades, requests waiting for approval, refused calls in plain words, day
  caps used and left, the agent, the pause flag, the policy's expiry and the alerts of the range
  (`docs/monitoring.md`, "Digest"). The monitor still sends nothing ("Outbound sends are yours");
  running it on a schedule and delivering it are left to whoever runs the monitor.
- **Where:** `packages/monitor` as a digest written to stdout or a file. Delivery stays with whoever
  runs the monitor.

### R7. Accountability record

Any trade can be traced to the agent that made it and the limits in force when it ran, and an owner
can export that as a report.

- **Source:** the Air Canada case (24:00): whoever deploys the agent answers for it.
- **Today:** built by replay. `accountabilityRecords` gives, per trade, who sent it (the agent alone
  or approved by the owner), the limits in force and the events that set them, and flags a trade
  outside them or a journal with gaps. The dashboard downloads it as Markdown and JSON. Events
  still carry no policy counter.
- **Where:** an SDK function that replays the journal and returns, per trade, the policy that
  applied; an export in the dashboard. A policy counter in the events would make this direct but is
  a contract change.
- **Later, separately:** a bond that an agent builder posts and an owner can claim against. This is
  a new contract and a new threat model, not part of this item.

### R8. Leaving made easy

One action in the dashboard pauses the agent and withdraws every token to the owner.

- **Source:** "once you push the disconnect button, your assets are still with you" (41:30);
  "you're your own support line" (43:00).
- **Today:** built. The dashboard's "Pause the agent and withdraw everything" reviews the steps
  from `buildLeave` and submits them in order, one signature each in wallet mode. If the agent
  traded before the pause landed, it stops and shows a fresh plan.
- **Where:** dashboard and an SDK helper that builds the sequence.
- **Not included:** a recovery principal for a lost owner key. That was decided against for v0 on
  16 November 2026 (`docs/threat-model.md`, T5). This conversation is an argument for revisiting it
  before mainnet, not for reversing it now.

### R9. Attested agents

A registry where a reviewer attests once to an agent, and an owner's policy can require an
attestation before that agent may trade.

- **Source:** "verify me once, don't verify me ten times" (48:20).
- **Today:** a design note, `docs/attested-agents.md`. No code.
- **Where:** a new contract and a new trust assumption (the attester). Later than v0.

## Against the roadmap

These items were built ahead of the plan in `docs/roadmap.md`, which still describes the
vault without them. Two things there are the owner's to decide:

- R1 changed `keelio-vault`. The independent review in Milestone 4 must cover the approval band, or
  the band must be left out of the deployed version.
- The application's description of the prototype (contract size, the number of MCP tools, "the only
  state-changing function that takes an owner argument is `execute-swap`") is now out of date.
