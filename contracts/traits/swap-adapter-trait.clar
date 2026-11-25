;; Swap adapter: any DEX that can swap one SIP-010 token for another implements this.
;; Returns the amount of token-out sent to the recipient.
(use-trait sip-010 .sip-010-trait.sip-010-trait)

(define-trait swap-adapter-trait
  (
    (swap (<sip-010> <sip-010> uint uint principal) (response uint uint))
  )
)
