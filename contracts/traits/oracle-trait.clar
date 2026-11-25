;; Price oracle: the shape of DIA's `dia-oracle.get-value`. `value` is the
;; price with 8 decimals (USD per BTC for "BTC/USD"); `timestamp` is in
;; milliseconds.
(define-trait oracle-trait
  (
    (get-value ((string-ascii 32)) (response { value: uint, timestamp: uint } uint))
  )
)
