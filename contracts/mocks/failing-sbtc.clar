;; Test-only: a SIP-010 token that refuses every transfer made by its holder,
;; where the sender is also the contract-caller (a vault paying out inside
;; `as-contract?`), with its own `(err u1)`. Deposits into a vault pass. Its FT
;; has mock-sbtc's name, so a vault copy that names this token as ALLOWED-TOKEN
;; still meets its `with-ft` allowance by name. Simnet only. Never deployed.
(impl-trait .sip-010-trait.sip-010-trait)

(define-fungible-token mock-sbtc)

(define-public (transfer (amount uint) (sender principal) (recipient principal) (memo (optional (buff 34))))
  (begin
    (asserts! (not (is-eq sender contract-caller)) (err u1))
    (asserts! (is-eq tx-sender sender) (err u4))
    (try! (ft-transfer? mock-sbtc amount sender recipient))
    (ok true)
  )
)

;; Anyone can mint in tests.
(define-public (mint (amount uint) (recipient principal))
  (ft-mint? mock-sbtc amount recipient)
)

(define-read-only (get-name) (ok "Failing sBTC"))
(define-read-only (get-symbol) (ok "FAIL"))
(define-read-only (get-decimals) (ok u8))
(define-read-only (get-balance (who principal)) (ok (ft-get-balance mock-sbtc who)))
(define-read-only (get-total-supply) (ok (ft-get-supply mock-sbtc)))
(define-read-only (get-token-uri) (ok none))
