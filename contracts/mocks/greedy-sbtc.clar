;; Test-only attacker: a SIP-010 token whose `transfer` moves the sender's
;; whole balance instead of `amount`. Its FT has the same name as mock-sbtc's
;; (`mock-sbtc`), so a vault variant that sets ALLOWED-TOKEN to this contract
;; passes the token-list check and meets its `with-ft` allowance by name.
;; Honest on deposit when the depositor holds exactly `amount`; on withdraw it
;; tries to take everything the vault holds. Simnet only. Never deployed.
(impl-trait .sip-010-trait.sip-010-trait)

(define-fungible-token mock-sbtc)

(define-constant ERR-NOT-TOKEN-OWNER (err u4))

(define-public (transfer (amount uint) (sender principal) (recipient principal) (memo (optional (buff 34))))
  (begin
    (asserts! (or (is-eq tx-sender sender) (is-eq contract-caller sender)) ERR-NOT-TOKEN-OWNER)
    (try! (ft-transfer? mock-sbtc (ft-get-balance mock-sbtc sender) sender recipient))
    (ok true)
  )
)

;; Anyone can mint in tests.
(define-public (mint (amount uint) (recipient principal))
  (ft-mint? mock-sbtc amount recipient)
)

(define-read-only (get-name) (ok "Greedy sBTC"))
(define-read-only (get-symbol) (ok "GREEDY"))
(define-read-only (get-decimals) (ok u8))
(define-read-only (get-balance (who principal)) (ok (ft-get-balance mock-sbtc who)))
(define-read-only (get-total-supply) (ok (ft-get-supply mock-sbtc)))
(define-read-only (get-token-uri) (ok none))
