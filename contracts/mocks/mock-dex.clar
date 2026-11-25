;; Test double for a DEX adapter. Reserves are its own token balances.
;; Simnet and devnet only. Never deployed to mainnet.
(impl-trait .swap-adapter-trait.swap-adapter-trait)
(use-trait sip-010 .sip-010-trait.sip-010-trait)

(define-constant ERR-ZERO-AMOUNT (err u100))
(define-constant ERR-BELOW-MIN-OUT (err u101))
(define-constant ERR-INSUFFICIENT-RESERVES (err u102))
(define-constant ERR-INVALID-RATE (err u103))

(define-data-var rate-num uint u1)
(define-data-var rate-den uint u1)

;; How much of `out` the DEX keeps back. It still reports the full `out`, so a
;; caller that trusts the return value is fooled. Tests use it to show the vault
;; credits what actually arrived. 0 by default: nothing is kept.
(define-data-var skim uint u0)

;; Open in tests.
(define-public (set-rate (num uint) (den uint))
  (begin
    (asserts! (and (> num u0) (> den u0)) ERR-INVALID-RATE)
    (var-set rate-num num)
    (var-set rate-den den)
    (ok true)
  )
)

;; Open in tests. Any test that sets skim resets it to 0.
(define-public (set-skim (amount uint))
  (begin
    (var-set skim amount)
    (ok true)
  )
)

(define-read-only (get-rate)
  { num: (var-get rate-num), den: (var-get rate-den) }
)

(define-public (swap (token-in <sip-010>) (token-out <sip-010>) (amount-in uint) (min-out uint) (recipient principal))
  (let (
      (out (/ (* amount-in (var-get rate-num)) (var-get rate-den)))
      (reserve (try! (contract-call? token-out get-balance (as-contract tx-sender))))
    )
    (asserts! (> amount-in u0) ERR-ZERO-AMOUNT)
    (asserts! (> out u0) ERR-ZERO-AMOUNT)
    (asserts! (>= out min-out) ERR-BELOW-MIN-OUT)
    (asserts! (>= reserve out) ERR-INSUFFICIENT-RESERVES)
    (try! (contract-call? token-in transfer amount-in contract-caller (as-contract tx-sender) none))
    (let ((delivered (if (>= (var-get skim) out) u0 (- out (var-get skim)))))
      (if (> delivered u0)
        (try! (as-contract (contract-call? token-out transfer delivered tx-sender recipient none)))
        true
      )
    )
    (ok out)
  )
)
