;; Test stand-in for sBTC: a SIP-010 token with 8 decimals and an open mint.
;; Simnet and devnet only. Never deployed to mainnet.
(impl-trait .sip-010-trait.sip-010-trait)

(define-fungible-token mock-sbtc)

(define-constant ERR-NOT-TOKEN-OWNER (err u4))

(define-public (transfer (amount uint) (sender principal) (recipient principal) (memo (optional (buff 34))))
  (begin
    (asserts! (or (is-eq tx-sender sender) (is-eq contract-caller sender)) ERR-NOT-TOKEN-OWNER)
    (try! (ft-transfer? mock-sbtc amount sender recipient))
    (match memo to-print (print to-print) 0x)
    (ok true)
  )
)

;; Anyone can mint in tests.
(define-public (mint (amount uint) (recipient principal))
  (ft-mint? mock-sbtc amount recipient)
)

(define-read-only (get-name) (ok "Mock sBTC"))
(define-read-only (get-symbol) (ok "sBTC"))
(define-read-only (get-decimals) (ok u8))
(define-read-only (get-balance (who principal)) (ok (ft-get-balance mock-sbtc who)))
(define-read-only (get-total-supply) (ok (ft-get-supply mock-sbtc)))
(define-read-only (get-token-uri) (ok none))
