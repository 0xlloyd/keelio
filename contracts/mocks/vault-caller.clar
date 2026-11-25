;; Test-only intermediary: a contract an owner might be lured into calling.
;; It calls `keelio-vault.withdraw`, so the vault sees this contract as
;; `contract-caller` and must debit only this contract's own ledger entry.
;; The `*-via` passthroughs do the same for the agent, kill-switch and policy
;; setters, and for `execute-swap`, where an agent calling through it must be
;; refused.
;; Simnet only. Never deployed.
(use-trait sip-010-trait .sip-010-trait.sip-010-trait)
(use-trait swap-adapter-trait .swap-adapter-trait.swap-adapter-trait)

(define-public (withdraw-via (token <sip-010-trait>) (amount uint))
  (contract-call? .keelio-vault withdraw token amount)
)

(define-public (set-agent-via (agent principal))
  (contract-call? .keelio-vault set-agent agent)
)

(define-public (remove-agent-via)
  (contract-call? .keelio-vault remove-agent)
)

(define-public (pause-via)
  (contract-call? .keelio-vault pause)
)

(define-public (unpause-via)
  (contract-call? .keelio-vault unpause)
)

(define-public (set-policy-via (cooldown-blocks uint) (expires-at uint))
  (contract-call? .keelio-vault set-policy cooldown-blocks expires-at)
)

(define-public (set-token-caps-via (token principal) (max-per-trade uint) (max-per-day uint))
  (contract-call? .keelio-vault set-token-caps token max-per-trade max-per-day)
)

(define-public (allow-token-via (token principal) (allowed bool))
  (contract-call? .keelio-vault allow-token token allowed)
)

(define-public (allow-adapter-via (adapter principal) (allowed bool))
  (contract-call? .keelio-vault allow-adapter adapter allowed)
)

(define-public (execute-swap-via (owner principal) (adapter <swap-adapter-trait>) (token-in <sip-010-trait>) (token-out <sip-010-trait>) (amount-in uint) (min-out uint))
  (contract-call? .keelio-vault execute-swap owner adapter token-in token-out amount-in min-out)
)

(define-public (deposit-via (token <sip-010-trait>) (amount uint))
  (contract-call? .keelio-vault deposit token amount)
)
