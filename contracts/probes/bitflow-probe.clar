;; Probe, not product code: swaps on Bitflow's mainnet pools with this contract as the caller.
;; It exists only for tests/bitflow-probe.test.ts, which runs it in a simnet that reads mainnet
;; contract state (see docs/bitflow.md). It holds no logic of its own and defines no errors:
;; every response is Bitflow's, passed through unchanged.
;;
;; Pools and tokens, all on mainnet:
;;   DLMM pool  SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-sbtc-usdcx-v-1-bps-10
;;   XYK pool   SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-sbtc-stx-v-1-1
;;   sBTC       SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
;;   USDCx      SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx
;;   STX wrapper SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2

;; sBTC in, USDCx out, through the DLMM router v-1-1. Returns {in, out}.
(define-public (dlmm-v11-sbtc-for-usdcx (amount uint) (min-out uint))
  (as-contract
    (contract-call? 'SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-swap-router-v-1-1
      swap-x-for-y-simple-multi
      'SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-sbtc-usdcx-v-1-bps-10
      'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
      'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx
      amount min-out)))

;; The same swap through router v-1-2, which adds an optional deadline.
(define-public (dlmm-v12-sbtc-for-usdcx (amount uint) (min-out uint) (deadline (optional uint)))
  (as-contract
    (contract-call? 'SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-swap-router-v-1-2
      swap-x-for-y-simple-multi
      'SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-sbtc-usdcx-v-1-bps-10
      'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
      'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx
      amount min-out deadline)))

;; sBTC in, STX out, through xyk-core-v-1-2. Returns the amount of STX sent.
(define-public (xyk-sbtc-for-stx (amount uint) (min-out uint))
  (as-contract
    (contract-call? 'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-core-v-1-2
      swap-x-for-y
      'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-sbtc-stx-v-1-1
      'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
      'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2
      amount min-out)))

;; STX in, sBTC out, through xyk-core-v-1-2. The STX wrapper debits this contract. Returns the
;; amount of sBTC sent.
(define-public (xyk-stx-for-sbtc (amount uint) (min-out uint))
  (as-contract
    (contract-call? 'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-core-v-1-2
      swap-y-for-x
      'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-sbtc-stx-v-1-1
      'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
      'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2
      amount min-out)))
