;; bitflow-adapter: the swap adapter for Bitflow's sBTC/USDCx DLMM pool.
;; Simnet only: never deploy.
;;
;; Pool    SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-sbtc-usdcx-v-1-bps-10
;; Router  SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-swap-router-v-1-2
;; In the pool, sBTC is x and USDCx is y.
;;
;; `swap` pulls `amount-in` from `contract-caller` (the vault, never the wallet
;; behind it), swaps on Bitflow as itself inside `as-contract?`, and sends what
;; arrived to `recipient`. It holds no balance between calls.
;;
;; Decisions:
;; - The payout is the rise in this contract's own balance of the output token
;;   during the call (the delta), not everything it holds (a sweep). Tokens
;;   someone sends here directly are never paid to a recipient, and the
;;   router's reported `out` is not trusted for the transfer. Such tokens are
;;   stranded: no function can move them.
;; - The router's deadline is `none`. A deadline computed here from
;;   `stacks-block-time` is in the same transaction, so it always passes and
;;   protects nothing. A real deadline must be signed by the agent, and the
;;   trait has no argument for one.
;; - A partial fill is refused, not refunded, so no input is ever left here
;;   and the vault's measured `spent` is always `amount-in`.
;;
;; `contract-call?` needs a literal contract, so the principals below are also
;; written out at each call site. tests/bitflow-adapter.test.ts checks that
;; every literal matches its constant.

(impl-trait .swap-adapter-trait.swap-adapter-trait)
(use-trait sip-010-trait .sip-010-trait.sip-010-trait)

(define-constant ERR-PAIR-NOT-SUPPORTED (err u200))
(define-constant ERR-ZERO-AMOUNT (err u201))
(define-constant ERR-ZERO-MIN-OUT (err u202))
(define-constant ERR-DEX-FAILED (err u203))
(define-constant ERR-PARTIAL-FILL (err u204))
(define-constant ERR-BELOW-MIN-OUT (err u205))
(define-constant ERR-ALLOWANCE-EXCEEDED (err u206))
(define-constant ERR-TRANSFER-FAILED (err u207))

(define-constant ROUTER 'SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-swap-router-v-1-2)
(define-constant POOL 'SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-sbtc-usdcx-v-1-bps-10)
;; Each token is its contract followed by its `define-fungible-token` name.
(define-constant SBTC 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token)
(define-constant SBTC-FT "sbtc-token")
(define-constant USDCX 'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx)
(define-constant USDCX-FT "usdcx-token")

;; This contract's balance of the output token: USDCx when selling sBTC.
;; Both tokens' `get-balance` only ever returns `ok`, so its error type is
;; indeterminate and `try!` cannot be used; `unwrap-panic` never fires here.
(define-private (balance-out (sell-sbtc bool))
  (if sell-sbtc
    (unwrap-panic (contract-call? 'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx
      get-balance current-contract
    ))
    (unwrap-panic (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
      get-balance current-contract
    ))
  )
)

(define-public (swap
    (token-in <sip-010-trait>)
    (token-out <sip-010-trait>)
    (amount-in uint)
    (min-out uint)
    (recipient principal)
  )
  (let (
      (caller contract-caller)
      (in-id (contract-of token-in))
      (out-id (contract-of token-out))
      (sell-sbtc (and (is-eq in-id SBTC) (is-eq out-id USDCX)))
    )
    ;; Before any `contract-call?`. This also refuses the same token twice.
    (asserts! (or sell-sbtc (and (is-eq in-id USDCX) (is-eq out-id SBTC)))
      ERR-PAIR-NOT-SUPPORTED
    )
    (asserts! (> amount-in u0) ERR-ZERO-AMOUNT)
    ;; The DLMM router accepts a floor of 0, so refuse it here.
    (asserts! (> min-out u0) ERR-ZERO-MIN-OUT)
    (let ((before-out (balance-out sell-sbtc)))
      ;; Pull the input from `contract-caller`, outside `as-contract?`, never
      ;; from `tx-sender`. The token sees this adapter as its
      ;; `contract-caller`, so it accepts the pull only when the caller is
      ;; also `tx-sender`: the vault is, inside its own `as-contract?`. A
      ;; contract between a wallet and this adapter is the caller, so only it
      ;; could be debited, never the wallet, and the token refuses it.
      (unwrap!
        (if sell-sbtc
          (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
            transfer amount-in caller current-contract none
          )
          (contract-call? 'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx
            transfer amount-in caller current-contract none
          )
        )
        ERR-TRANSFER-FAILED
      )
      ;; Swap as this contract: it may send at most `amount-in` of the input
      ;; token and none of the output token or any other asset. A router error
      ;; leaves `swap` through the inner `unwrap!` as ERR-DEX-FAILED, so
      ;; Bitflow's codes never come out of this contract. An allowance
      ;; violation (err u0, u1 or u128) becomes ERR-ALLOWANCE-EXCEEDED.
      (let ((filled (unwrap!
          (if sell-sbtc
            (as-contract? ((with-ft SBTC SBTC-FT amount-in) (with-ft USDCX USDCX-FT u0))
              (unwrap!
                (contract-call?
                  'SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-swap-router-v-1-2
                  swap-x-for-y-simple-multi
                  'SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-sbtc-usdcx-v-1-bps-10
                  'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
                  'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx amount-in
                  min-out none
                )
                ERR-DEX-FAILED
              )
            )
            (as-contract? ((with-ft SBTC SBTC-FT u0) (with-ft USDCX USDCX-FT amount-in))
              (unwrap!
                (contract-call?
                  'SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-swap-router-v-1-2
                  swap-y-for-x-simple-multi
                  'SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-sbtc-usdcx-v-1-bps-10
                  'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
                  'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx amount-in
                  min-out none
                )
                ERR-DEX-FAILED
              )
            )
          )
          ERR-ALLOWANCE-EXCEEDED
        )))
        ;; A partial fill would leave input here: refuse it rather than refund.
        (asserts! (is-eq (get in filled) amount-in) ERR-PARTIAL-FILL)
        (let (
            (after-out (balance-out sell-sbtc))
            ;; What arrived during this call, never what was already here.
            (received (if (> after-out before-out)
              (- after-out before-out)
              u0
            ))
          )
          (asserts! (>= received min-out) ERR-BELOW-MIN-OUT)
          ;; Pay out exactly `received` of the output token and none of the
          ;; input token.
          (unwrap!
            (if sell-sbtc
              (as-contract? ((with-ft SBTC SBTC-FT u0) (with-ft USDCX USDCX-FT received))
                (unwrap!
                  (contract-call? 'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx
                    transfer received current-contract recipient none
                  )
                  ERR-TRANSFER-FAILED
                )
              )
              (as-contract? ((with-ft SBTC SBTC-FT received) (with-ft USDCX USDCX-FT u0))
                (unwrap!
                  (contract-call?
                    'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
                    transfer received current-contract recipient none
                  )
                  ERR-TRANSFER-FAILED
                )
              )
            )
            ERR-ALLOWANCE-EXCEEDED
          )
          (ok received)
        )
      )
    )
  )
)
