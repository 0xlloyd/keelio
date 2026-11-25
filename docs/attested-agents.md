# Attested agents: design note (R9)

Status: design only. Nothing here is built, and nothing in `keelio-vault` v0 depends on it. It answers
item R9 in `docs/requirements-trustshift.md`: an agent is checked once by a reviewer, and every
owner can rely on that check instead of repeating it.

## What it is for

An owner who names an agent today knows one thing about it: its principal. The agent-history read
(R3) adds what the journal shows, and that is nothing for a new agent. An attestation adds a
statement from a named reviewer: "I examined this agent on this date and it met this standard."

It does not make an agent safe. The vault's limits do that, and they hold whether or not the agent
is attested. An attestation only helps an owner choose.

## What an attestation says

| Field       | Type         | Meaning                                                          |
| ----------- | ------------ | ---------------------------------------------------------------- |
| `attester`  | principal    | Who made the statement. It is the caller, so it cannot be forged |
| `agent`     | principal    | The agent principal the statement is about                       |
| `standard`  | string-ascii | Which checklist was applied, by name and version                 |
| `evidence`  | buff 32      | Hash of the reviewer's report, published off-chain               |
| `issued-at` | uint         | Burn height of the statement                                     |
| `expires`   | uint         | Burn height after which it no longer counts                      |
| `revoked`   | bool         | Set by the attester, never unset                                 |

An attestation is about a principal, not about code. The principal's key can sign for different
software tomorrow. This is the main limit of the design, and the dashboard must say so wherever it
shows an attestation.

## Contracts

### `keelio-attestations` (new, separate from the vault)

- `attest (agent) (standard) (evidence) (expires)`: the caller records or replaces their own
  statement about `agent`.
- `revoke (agent)`: the caller revokes their own statement. Nobody else can.
- `get-attestation (attester) (agent)`: read-only.
- `is-attested (attester) (agent)`: read-only, true only when a statement exists, is not revoked
  and has not expired at the current burn height.

There is no admin, no list of approved attesters and no fee. Anyone can attest to anything; a
statement is worth what its attester is worth. Choosing which attester to believe is the owner's
decision, made per vault.

### `keelio-vault` (a later version, not v0)

- The owner may name one required attester: `set-required-attester (optional principal)`.
- When one is set, `execute-swap` (and the approval path) refuses unless
  `is-attested required-attester agent` is true at that moment, with a new error code.
- When none is set, nothing changes. This is the default.

The check runs at trade time, not at `set-agent`, so a revocation or an expiry stops the agent at
once without the owner doing anything.

The attestation contract would be a constant fixed at deploy time, as the oracle and the adapter
are. The vault calls it read-only and outside `as-contract?`, so it can move nothing.

## New trust assumption

The owner who requires an attester trusts that attester to revoke when it should and not to revoke
when it should not.

| Threat                                                       | Effect                                    | Bound                                                                                    |
| ------------------------------------------------------------ | ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| The attester's key is stolen and attests to a bad agent      | None on its own                           | An agent trades only for an owner who named it. The attacker must also be that agent     |
| The attester revokes maliciously or loses its key and lapses | The agent stops trading for those owners  | Withdrawals never depend on the attester. The owner clears the requirement in one call   |
| The agent changes its software after the review              | The attestation is stale but still counts | Not handled. Bounded by the vault's limits, as for any agent. Short `expires` reduces it |
| An attester sells attestations                               | Owners are misled                         | Not handled on-chain. The owner chose the attester                                       |
| The attestation contract is not what it claims               | Trades refused, or the check is empty     | It is a deploy-time constant, reviewed with the vault; it holds no funds                 |

The worst case for funds is unchanged from v0: an attested agent can still do only what the policy
allows. The new worst case is for liveness: an attester can stop an owner's agent. It cannot stop
the owner.

## What this does not cover

- **Zero-knowledge proofs.** The conversation that prompted R9 talks about proving a condition
  without disclosing the data. An attestation here is a public statement with a hashed report. A
  proof that an agent runs given code, checked on-chain, would need attested execution or a
  verifier Clarity does not have. It is out of scope.
- **Identity or KYC of owners.** Keelio knows principals and nothing else.
- **A bond.** An attester or agent builder posting funds that an owner can claim against is a
  separate design (see R7 in `docs/requirements-trustshift.md`).

## Open decisions for the owner

1. Whether one required attester is enough, or the vault should accept any one of a short list.
2. Whether the standard should be pinned by the vault (require `standard` to equal a given string),
   or left to the attester.
3. Who writes the first standard. A checklist for an agent that trades through Keelio could start
   from `docs/integration-guide.md`.
4. Whether this belongs in the vault at all, or only in the dashboard as advice shown next to the
   agent history. The dashboard-only version needs no vault change and no new refusal.
