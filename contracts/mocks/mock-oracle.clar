;; Simnet only, test stand-in for DIA. Never deployed to mainnet.
;; Same `get-value` shape as DIA's `dia-oracle`: `value` has 8 decimals and
;; `timestamp` is in milliseconds. A key that was never set reads
;; { value: u0, timestamp: u0 }, as DIA's does.
(impl-trait .oracle-trait.oracle-trait)

(define-constant ERR-ORACLE-DOWN (err u300))

(define-map prices
  (string-ascii 32)
  {
    value: uint,
    timestamp: uint,
  }
)

;; While true, `get-value` returns ERR-ORACLE-DOWN. Any test that sets it
;; resets it to false.
(define-data-var failing bool false)

(define-read-only (get-value (key (string-ascii 32)))
  (if (var-get failing)
    ERR-ORACLE-DOWN
    (ok (default-to {
      value: u0,
      timestamp: u0,
    }
      (map-get? prices key)
    ))
  )
)

(define-private (now-ms)
  (* stacks-block-time u1000)
)

;; Open in tests. Sets an absolute timestamp in milliseconds.
(define-public (set-value
    (key (string-ascii 32))
    (value uint)
    (timestamp uint)
  )
  (begin
    (map-set prices key {
      value: value,
      timestamp: timestamp,
    })
    (ok true)
  )
)

;; Open in tests. The price was published `age-ms` before this block.
(define-public (set-value-aged
    (key (string-ascii 32))
    (value uint)
    (age-ms uint)
  )
  (set-value key value (- (now-ms) age-ms))
)

;; Open in tests. The price carries a timestamp `ahead-ms` after this block.
(define-public (set-value-ahead
    (key (string-ascii 32))
    (value uint)
    (ahead-ms uint)
  )
  (set-value key value (+ (now-ms) ahead-ms))
)

;; Open in tests.
(define-public (set-failing (on bool))
  (begin
    (var-set failing on)
    (ok true)
  )
)
