;; keelio-vault: per-owner, per-token custody of SIP-010 tokens.
;; Each owner deposits and withdraws their own tokens; the ledger tracks each
;; owner's balance per token in base units. Simnet only: never deploy.
;;
;; The vault holds two tokens: ALLOWED-TOKEN (sBTC) and QUOTE-TOKEN (the quote
;; token). Both are constants fixed at deploy time that no one can change
;; afterwards (there is no admin).
;;
;; Two limits on what a called contract can do (Clarity 6):
;; - `withdraw` calls the token's `transfer` inside `as-contract?` with an
;;   allowance of exactly `amount` of the token being withdrawn and u0 of the
;;   other one. `execute-swap` calls the adapter inside `as-contract?` with an
;;   allowance of exactly `amount-in` of the input token and u0 of the output
;;   token. If a call would move more than that, or any other asset (STX,
;;   another FT, an NFT), the whole call is refused with
;;   ERR-ALLOWANCE-EXCEEDED and rolled back.
;; - Every function refuses any token outside the fixed set, and `execute-swap`
;;   refuses any adapter except ALLOWED-ADAPTER, before any of them is called.
;;   This is the second line of defence. It also covers what the allowance
;;   does not: the allowance limits the amount and the asset, not the
;;   recipient, so a dishonest token or adapter could still send the allowed
;;   amount elsewhere.
;;
;; Limits of the ledger invariant (vault token balance = sum of owners' ledgers,
;; which `get-ledger-total` reads):
;; - It holds only while both tokens are honest SIP-010 tokens.
;; - Tokens sent straight to the vault (not through `deposit`) are stranded:
;;   they make the vault balance exceed the ledgers, and this slice offers no
;;   way to recover them.

(use-trait sip-010-trait .sip-010-trait.sip-010-trait)
(use-trait swap-adapter-trait .swap-adapter-trait.swap-adapter-trait)

(define-constant ERR-ZERO-AMOUNT (err u100))
(define-constant ERR-INSUFFICIENT-BALANCE (err u101))
(define-constant ERR-TOKEN-NOT-ALLOWED (err u102))
(define-constant ERR-AGENT-IS-OWNER (err u103))
(define-constant ERR-ALLOWANCE-EXCEEDED (err u104))

;; Deploy configuration. These seven lines are the only lines a deployment
;; edits. Each token is its contract followed by its asset name: the `-FT`
;; value is the name in the token's `define-fungible-token`, not its SIP-010
;; symbol. `withdraw` and `execute-swap` read these constants in their `with-ft`
;; allowances, and a wrong name refuses every withdrawal of that token, so run
;; `pnpm run check-deploy` before deploying (see docs/clarity-4.md, Deploy
;; note). The mocks stand in for sBTC, the quote token, the swap adapter and
;; the price oracle on the simnet.
;;
;; ALLOWED-TOKEN is the sBTC token the vault holds; QUOTE-TOKEN is the other.
(define-constant ALLOWED-TOKEN .mock-sbtc)
(define-constant ALLOWED-TOKEN-FT "mock-sbtc")
(define-constant QUOTE-TOKEN .mock-usd)
(define-constant QUOTE-TOKEN-FT "mock-usd")
;; The only swap adapter.
(define-constant ALLOWED-ADAPTER .mock-dex)
;; The only price oracle, read through `get-value "BTC/USD"` in DIA's shape:
;; USD per BTC with 8 decimals, timestamp in milliseconds. On mainnet this is
;; DIA's `dia-oracle`.
(define-constant ORACLE .mock-oracle)
;; 10^(8 + sBTC decimals - quote token decimals): turns the oracle's price into
;; quote base units per sat. 10^(8 + 8 - 6) for mock-sbtc and mock-usd, and for
;; sBTC and any 6-decimal quote token.
(define-constant PRICE-SCALE u10000000000)

;; The oracle key, basis points in a whole and the largest uint. Not deploy
;; configuration.
(define-constant ORACLE-KEY "BTC/USD")
(define-constant BPS u10000)
(define-constant MAX-UINT u340282366920938463463374607431768211455)

(define-map balances
  {
    owner: principal,
    token: principal,
  }
  uint
)

(define-read-only (get-balance
    (owner principal)
    (token principal)
  )
  (default-to u0
    (map-get? balances {
      owner: owner,
      token: token,
    })
  )
)

;; The sum of every owner's ledger for each token. `deposit` and `withdraw`
;; move it with the ledger they write, and `execute-swap` with the owner's.
;; `execute-swap` uses it to tell the adapter's payment apart from a deposit
;; or withdrawal made by someone else during the adapter call (T2e): only the
;; part of the vault's balance change that no ledger accounts for is the
;; owner's.
(define-map ledger-totals
  principal
  uint
)

(define-read-only (get-ledger-total (token principal))
  (default-to u0 (map-get? ledger-totals token))
)

(define-public (deposit
    (token <sip-010-trait>)
    (amount uint)
  )
  (let (
      ;; The owner is `contract-caller`, not `tx-sender`: a contract the owner
      ;; happens to call (a phishing contract, or the future agent) is then the
      ;; contract-caller, so it can only ever act on its own ledger entry and
      ;; never on the owner's. `tx-sender` would let it act for the owner.
      (owner contract-caller)
      (token-id (contract-of token))
    )
    (asserts! (is-accepted-token token-id) ERR-TOKEN-NOT-ALLOWED)
    (asserts! (> amount u0) ERR-ZERO-AMOUNT)
    ;; Credit only after the transfer into the vault succeeds.
    (try! (contract-call? token transfer amount owner current-contract none))
    (let ((balance (+ (get-balance owner token-id) amount)))
      (map-set balances {
        owner: owner,
        token: token-id,
      }
        balance
      )
      (map-set ledger-totals token-id (+ (get-ledger-total token-id) amount))
      (print {
        event: "deposit",
        owner: owner,
        token: token-id,
        amount: amount,
        balance: balance,
      })
      (ok balance)
    )
  )
)

(define-public (withdraw
    (token <sip-010-trait>)
    (amount uint)
  )
  (let (
      ;; The owner is `contract-caller`, not `tx-sender`: a contract the owner
      ;; happens to call (a phishing contract, or the future agent) is then the
      ;; contract-caller, so it cannot withdraw the owner's funds. `tx-sender`
      ;; would allow that. The recipient below is this binding, captured
      ;; outside `as-contract?`.
      (owner contract-caller)
      (token-id (contract-of token))
      (current (get-balance owner token-id))
    )
    ;; Checked before `as-contract?` lets the token act as the vault.
    (asserts! (is-accepted-token token-id) ERR-TOKEN-NOT-ALLOWED)
    (asserts! (> amount u0) ERR-ZERO-AMOUNT)
    ;; Check before subtracting so a uint underflow is never a runtime error.
    (asserts! (>= current amount) ERR-INSUFFICIENT-BALANCE)
    (let (
        (balance (- current amount))
        ;; The allowance for the token being withdrawn is `amount`; the other
        ;; fixed-set token gets u0.
        (sbtc-out (if (is-eq token-id ALLOWED-TOKEN)
          amount
          u0
        ))
        (usd-out (if (is-eq token-id QUOTE-TOKEN)
          amount
          u0
        ))
      )
      (map-set balances {
        owner: owner,
        token: token-id,
      }
        balance
      )
      ;; Cannot underflow: the total includes this owner's ledger, which is at
      ;; least `amount`.
      (map-set ledger-totals token-id (- (get-ledger-total token-id) amount))
      ;; The token may move at most `amount` of itself and nothing else.
      ;; A token's own error (for example mock-sbtc's u1) exits `withdraw`
      ;; through the inner `try!` unchanged. An allowance violation comes back
      ;; as a raw `err` of u0 or u128, which `unwrap!` maps to the stable
      ;; ERR-ALLOWANCE-EXCEEDED. Either way the whole call rolls back, debit
      ;; included.
      (unwrap!
        ;; The asset names come from the deploy configuration block at the
        ;; top: a name that doesn't match the token's `define-fungible-token`
        ;; refuses every withdrawal of that token (see docs/clarity-4.md,
        ;; Deploy note).
        (as-contract? ((with-ft ALLOWED-TOKEN ALLOWED-TOKEN-FT sbtc-out) (with-ft QUOTE-TOKEN QUOTE-TOKEN-FT usd-out))
          (try! (contract-call? token transfer amount tx-sender owner none))
        )
        ERR-ALLOWANCE-EXCEEDED
      )
      (print {
        event: "withdraw",
        owner: owner,
        token: token-id,
        amount: amount,
        balance: balance,
      })
      (ok balance)
    )
  )
)

;; Agent and kill switch.
;;
;; Each owner names at most one agent and can pause their vault. The owner is
;; `contract-caller`, as in `deposit` and `withdraw`, never `tx-sender`: a
;; contract the owner calls becomes the owner of its own entry and can never
;; change the signer's. No setter takes an owner argument, so a call can only
;; ever write the caller's own entry. Removing the agent, pausing and
;; unpausing never fail, so the kill switch always works for the owner.
;;
;; `execute-swap` reads both: only the stored agent may trade, and never while
;; the vault is paused. `request-swap` and `approve-swap` read them the same
;; way. `deposit` and `withdraw` work whatever they hold, so
;; the owner can always take funds out. None of these functions touches
;; `balances` or any token.

(define-map vaults
  principal
  {
    agent: (optional principal),
    paused: bool,
  }
)

(define-read-only (get-vault (owner principal))
  (default-to {
    agent: none,
    paused: false,
  }
    (map-get? vaults owner)
  )
)

;; Writes the caller's whole entry and prints it as one journal event.
(define-private (save-vault
    (event (string-ascii 12))
    (owner principal)
    (agent (optional principal))
    (paused bool)
  )
  (begin
    (map-set vaults owner {
      agent: agent,
      paused: paused,
    })
    (print {
      event: event,
      owner: owner,
      agent: agent,
      paused: paused,
    })
    (ok true)
  )
)

(define-public (set-agent (agent principal))
  (let ((owner contract-caller))
    (asserts! (not (is-eq agent owner)) ERR-AGENT-IS-OWNER)
    ;; Replaces any earlier agent completely; keeps only the paused flag.
    (save-vault "set-agent" owner (some agent) (get paused (get-vault owner)))
  )
)

(define-public (remove-agent)
  (let ((owner contract-caller))
    (save-vault "remove-agent" owner none (get paused (get-vault owner)))
  )
)

(define-public (pause)
  (let ((owner contract-caller))
    (save-vault "pause" owner (get agent (get-vault owner)) true)
  )
)

(define-public (unpause)
  (let ((owner contract-caller))
    (save-vault "unpause" owner (get agent (get-vault owner)) false)
  )
)

;; Trading policy.
;;
;; Each owner stores one policy and two allow lists for their agent. The owner
;; is `contract-caller`, as everywhere else in this contract: no function takes
;; an owner argument, so a call only ever writes the caller's own entries, and
;; a contract the owner calls writes its own entries, never the owner's.
;;
;; The tokens and adapters the vault may touch are fixed at deploy time as
;; constants (the configuration block at the top), with no admin and no
;; function that writes them. The vault calls tokens and adapters inside
;; `as-contract?`, which lets the called contract act as the vault. The
;; allowance bounds the amount and the asset but not the recipient, so a
;; caller-chosen contract could still send the vault's tokens elsewhere. So
;; an owner's lists can only narrow the fixed sets, never add to them: the
;; setters refuse anything outside them, and the reads check the fixed sets
;; again.
;;
;; Semantics `execute-swap` enforces:
;; - Zero is the default and means "may not trade": an owner who never set a
;;   policy reads every field as u0, and both lists start empty.
;; - The caps belong to an owner and a token. A token whose caps were never
;;   set reads `max-per-trade` and `max-per-day` as u0, so it may not be sold:
;;   leaving a token out never fails open.
;; - `max-per-trade` is in base units of the input token, per trade.
;; - `max-per-day` is in base units of the input token, summed over that
;;   token's own rolling window of 144 burn blocks, and is never below that
;;   token's `max-per-trade`. Units of different tokens are never added.
;; - `cooldown-blocks` and `expires-at` belong to the owner and are shared by
;;   both tokens. `cooldown-blocks` is the minimum number of burn blocks
;;   between two trades in either token.
;; - `expires-at` is a burn height. The agent may act at burn heights up to and
;;   including `expires-at`, and can do nothing after it.
;;
;; `set-token-caps` writes one token's caps and nothing else. `set-policy`
;; writes the owner-wide `cooldown-blocks` and `expires-at` and nothing else.
;; Neither can change the other's data, so setting one token's caps can never
;; move the agent's expiry. An owner must call both before the agent can trade.
;;
;; `execute-swap` enforces the policy and both lists. None of the functions in
;; this section touches `balances`, `vaults` or any token.

(define-constant ERR-INVALID-POLICY (err u105))
(define-constant ERR-TOKEN-NOT-SUPPORTED (err u106))
(define-constant ERR-ADAPTER-NOT-SUPPORTED (err u107))

(define-private (is-accepted-token (token principal))
  (or (is-eq token ALLOWED-TOKEN) (is-eq token QUOTE-TOKEN))
)

(define-private (is-accepted-adapter (adapter principal))
  (is-eq adapter ALLOWED-ADAPTER)
)

(define-map policies
  principal
  {
    cooldown-blocks: uint,
    expires-at: uint,
  }
)

(define-map token-caps
  {
    owner: principal,
    token: principal,
  }
  {
    max-per-trade: uint,
    max-per-day: uint,
  }
)

(define-map allowed-tokens
  {
    owner: principal,
    token: principal,
  }
  bool
)

(define-map allowed-adapters
  {
    owner: principal,
    adapter: principal,
  }
  bool
)

(define-private (get-caps
    (owner principal)
    (token principal)
  )
  ;; A token outside the fixed set reads u0 whatever is stored, though the
  ;; setter never stores one.
  (if (is-accepted-token token)
    (default-to {
      max-per-trade: u0,
      max-per-day: u0,
    }
      (map-get? token-caps {
        owner: owner,
        token: token,
      })
    )
    {
      max-per-trade: u0,
      max-per-day: u0,
    }
  )
)

;; One token's caps with the owner's cooldown and expiry.
(define-read-only (get-policy
    (owner principal)
    (token principal)
  )
  (let (
      (caps (get-caps owner token))
      (shared (default-to {
        cooldown-blocks: u0,
        expires-at: u0,
      }
        (map-get? policies owner)
      ))
    )
    {
      max-per-trade: (get max-per-trade caps),
      max-per-day: (get max-per-day caps),
      cooldown-blocks: (get cooldown-blocks shared),
      expires-at: (get expires-at shared),
    }
  )
)

;; True only when the token is in the fixed set and the owner allowed it. The
;; fixed-set check repeats the setter's, so no stored entry can grant more.
(define-read-only (is-token-allowed
    (owner principal)
    (token principal)
  )
  (and
    (is-accepted-token token)
    (default-to false
      (map-get? allowed-tokens {
        owner: owner,
        token: token,
      })
    )
  )
)

;; True only when the adapter is in the fixed set and the owner allowed it.
(define-read-only (is-adapter-allowed
    (owner principal)
    (adapter principal)
  )
  (and
    (is-accepted-adapter adapter)
    (default-to false
      (map-get? allowed-adapters {
        owner: owner,
        adapter: adapter,
      })
    )
  )
)

;; Replaces the caller's cooldown and expiry, shared by both tokens. Never
;; touches any token's caps. Never fails.
(define-public (set-policy
    (cooldown-blocks uint)
    (expires-at uint)
  )
  (let ((owner contract-caller))
    (map-set policies owner {
      cooldown-blocks: cooldown-blocks,
      expires-at: expires-at,
    })
    (print {
      event: "set-policy",
      owner: owner,
      cooldown-blocks: cooldown-blocks,
      expires-at: expires-at,
    })
    (ok true)
  )
)

;; Replaces the caller's caps for `token`. Never touches the cooldown, the
;; expiry or the other token's caps. The fixed-set check comes first.
(define-public (set-token-caps
    (token principal)
    (max-per-trade uint)
    (max-per-day uint)
  )
  (let ((owner contract-caller))
    (asserts! (is-accepted-token token) ERR-TOKEN-NOT-SUPPORTED)
    (asserts! (>= max-per-day max-per-trade) ERR-INVALID-POLICY)
    (map-set token-caps {
      owner: owner,
      token: token,
    } {
      max-per-trade: max-per-trade,
      max-per-day: max-per-day,
    })
    (print {
      event: "set-token-caps",
      owner: owner,
      token: token,
      max-per-trade: max-per-trade,
      max-per-day: max-per-day,
    })
    (ok true)
  )
)

;; Sets or clears one token in the caller's list. The fixed-set check comes
;; first, for `allowed` true and false alike.
(define-public (allow-token
    (token principal)
    (allowed bool)
  )
  (let ((owner contract-caller))
    (asserts! (is-accepted-token token) ERR-TOKEN-NOT-SUPPORTED)
    (map-set allowed-tokens {
      owner: owner,
      token: token,
    }
      allowed
    )
    (print {
      event: "allow-token",
      owner: owner,
      token: token,
      allowed: allowed,
    })
    (ok true)
  )
)

;; Sets or clears one adapter in the caller's list. The fixed-set check comes
;; first, for `allowed` true and false alike.
(define-public (allow-adapter
    (adapter principal)
    (allowed bool)
  )
  (let ((owner contract-caller))
    (asserts! (is-accepted-adapter adapter) ERR-ADAPTER-NOT-SUPPORTED)
    (map-set allowed-adapters {
      owner: owner,
      adapter: adapter,
    }
      allowed
    )
    (print {
      event: "allow-adapter",
      owner: owner,
      adapter: adapter,
      allowed: allowed,
    })
    (ok true)
  )
)

;; Price bounds.
;;
;; Each owner sets how far below the oracle's reference value a trade may
;; settle (`max-slippage-bps`, in basis points of the reference) and how old
;; the oracle's price may be (`max-price-age`, in milliseconds, the oracle's
;; unit). The owner is `contract-caller` and there is no owner argument, as in
;; every other setter. Zero is the default and means "may not trade": an owner
;; who never set bounds reads u0/u0, and `execute-swap` refuses while either
;; is u0.
;;
;; The oracle is the constant ORACLE: no function changes it.

(define-constant ERR-PRICE-BOUNDS-UNSET (err u119))
(define-constant ERR-INVALID-PRICE-BOUNDS (err u120))
(define-constant ERR-ORACLE-FAILED (err u121))
(define-constant ERR-PRICE-ZERO (err u122))
(define-constant ERR-PRICE-STALE (err u123))
(define-constant ERR-PRICE-OVERFLOW (err u124))
(define-constant ERR-BELOW-ORACLE-FLOOR (err u125))

(define-map price-bounds
  principal
  {
    max-slippage-bps: uint,
    max-price-age: uint,
  }
)

(define-read-only (get-price-bounds (owner principal))
  (default-to {
    max-slippage-bps: u0,
    max-price-age: u0,
  }
    (map-get? price-bounds owner)
  )
)

;; Replaces the caller's bounds. `max-slippage-bps` of BPS or more is refused:
;; at BPS the floor would be 0, and above it `BPS - max-slippage-bps` would
;; underflow.
(define-public (set-price-bounds
    (max-slippage-bps uint)
    (max-price-age uint)
  )
  (let ((owner contract-caller))
    (asserts! (< max-slippage-bps BPS) ERR-INVALID-PRICE-BOUNDS)
    (map-set price-bounds owner {
      max-slippage-bps: max-slippage-bps,
      max-price-age: max-price-age,
    })
    (print {
      event: "set-price-bounds",
      owner: owner,
      max-slippage-bps: max-slippage-bps,
      max-price-age: max-price-age,
    })
    (ok true)
  )
)

;; x * y, or none when it would pass MAX-UINT, so the floor never hits a
;; runtime overflow abort.
(define-private (checked-mul
    (x uint)
    (y uint)
  )
  (if (and (> x u0) (> y (/ MAX-UINT x)))
    none
    (some (* x y))
  )
)

;; ceil(n / d), as q + (1 if r > 0), never as (n + d - 1) / d, which could
;; overflow. `d` is never 0 here: PRICE-SCALE * BPS, or a price checked > 0
;; times BPS.
(define-private (ceil-div
    (n uint)
    (d uint)
  )
  (+ (/ n d)
    (if (> (mod n d) u0)
      u1
      u0
    ))
)

;; The least `min-out` the vault accepts for selling `a` of `token-in-id`
;; under the owner's `bounds`, as `floor`, with the oracle `price` and
;; `timestamp` it was computed from so `execute-swap` can print them,
;; after the oracle checks in this order: the oracle answers (u121), its price
;; is not 0 (u122) and is fresh (u123), and no product overflows (u124).
;;
;; With P = the oracle price (USD per BTC, 8 decimals), keep = BPS -
;; max-slippage-bps and PRICE-SCALE = 10^(8 + sBTC decimals - quote decimals):
;; - selling sBTC (token-in = ALLOWED-TOKEN), the floor in quote base units is
;;     ceil(a * P * keep / (PRICE-SCALE * BPS))
;; - buying sBTC (token-in = QUOTE-TOKEN), the floor in sats is
;;     ceil(a * PRICE-SCALE * keep / (P * BPS))
;; There is one rounding step and it rounds up, so the floor is never below the
;; exact value and never favours the agent. a > 0, P > 0 and keep >= 1, so the
;; floor is always at least 1. Every product goes through `checked-mul`; the
;; constant PRICE-SCALE * BPS = 10^14 cannot overflow.
;;
;; The price is stale when it is more than `max-price-age` ms away from
;; now-ms = stacks-block-time * 1000, before or after it. Each branch subtracts
;; the smaller from the larger, so neither can underflow. An age exactly equal
;; to `max-price-age` is accepted.
(define-private (oracle-floor
    (token-in-id principal)
    (a uint)
    (bounds {
      max-slippage-bps: uint,
      max-price-age: uint,
    })
  )
  (let (
      (max-price-age (get max-price-age bounds))
      (price (unwrap! (contract-call? ORACLE get-value ORACLE-KEY) ERR-ORACLE-FAILED))
      (p (get value price))
      (timestamp (get timestamp price))
      (now-ms (* stacks-block-time u1000))
      ;; Cannot underflow: `set-price-bounds` refuses BPS or more.
      (keep (- BPS (get max-slippage-bps bounds)))
    )
    (asserts! (> p u0) ERR-PRICE-ZERO)
    (asserts!
      (<=
        (if (<= timestamp now-ms)
          (- now-ms timestamp)
          (- timestamp now-ms)
        )
        max-price-age
      )
      ERR-PRICE-STALE
    )
    (if (is-eq token-in-id ALLOWED-TOKEN)
      (let ((n (unwrap!
          (match (checked-mul a p)
            ap (checked-mul ap keep)
            none
          )
          ERR-PRICE-OVERFLOW
        )))
        (ok {
          floor: (ceil-div n (* PRICE-SCALE BPS)),
          price: p,
          timestamp: timestamp,
        })
      )
      (let (
          (n (unwrap!
            (match (checked-mul a PRICE-SCALE)
              sa (checked-mul sa keep)
              none
            )
            ERR-PRICE-OVERFLOW
          ))
          (d (unwrap! (checked-mul p BPS) ERR-PRICE-OVERFLOW))
        )
        (ok {
          floor: (ceil-div n d),
          price: p,
          timestamp: timestamp,
        })
      )
    )
  )
)

;; Agent swaps.
;;
;; The owner's agent trades the owner's ledger through an allowed adapter. The
;; vault itself sends the input to the adapter and receives the output, so the
;; agent never holds a token. Every check runs before any token or adapter is
;; called, and the first one that fails decides the error. The policy checks
;; come first (u108 to u101). The oracle checks come after them: the owner's
;; price bounds are set (u119), then the oracle, called once and outside
;; `as-contract?`, answers (u121) with a price that is not 0 (u122) and is
;; fresh (u123), the floor does not overflow (u124), and `min-out` is at least
;; the floor (u125). There is no path that skips the floor. One check was added
;; between u114 and u115 without moving any other: the owner's approval
;; threshold (u126, see "Owner-approval band" below). The ledger moves by
;; what the vault's own balances show left and arrived, less any deposit or
;; withdrawal made into the vault during the adapter call, never by the
;; adapter's return value. A refused call changes nothing.
;;
;; `now` is `burn-block-height` throughout. The daily cap is a rolling window
;; of DAY-BLOCKS burn blocks: a trade at height H counts at heights H to
;; H+143 and stops counting at H+144.

(define-constant ERR-NOT-AGENT (err u108))
(define-constant ERR-VAULT-PAUSED (err u109))
(define-constant ERR-POLICY-EXPIRED (err u110))
(define-constant ERR-SWAP-TOKEN-NOT-ALLOWED (err u111))
(define-constant ERR-SAME-TOKEN (err u112))
(define-constant ERR-SWAP-ADAPTER-NOT-ALLOWED (err u113))
(define-constant ERR-TRADE-CAP-EXCEEDED (err u114))
(define-constant ERR-DAY-CAP-EXCEEDED (err u115))
(define-constant ERR-COOLDOWN-ACTIVE (err u116))
(define-constant ERR-ADAPTER-FAILED (err u117))
(define-constant ERR-BELOW-MIN-OUT (err u118))

(define-constant DAY-BLOCKS u144)

;; Each owner's trades in each input token, at most one entry per burn height.
;; Entries older than the window are dropped on the next trade in that token.
;; A trade reads and writes only its `token-in` list, so one token's trades
;; never evict, inflate or prune the other's.
(define-map trade-window
  {
    owner: principal,
    token: principal,
  }
  (list 144 {
    height: uint,
    amount: uint,
  })
)

;; The burn height of each owner's last trade in either token. Kept apart from
;; the windows, because a cooldown can be longer than a window.
(define-map last-trade
  principal
  uint
)

;; `filter` takes no closure, so this reads `burn-block-height` directly. It
;; needs no token: each list already belongs to one token.
;; `height` is never above the current height, so the sum cannot overflow.
(define-private (in-window (entry {
  height: uint,
  amount: uint,
}))
  (> (+ (get height entry) DAY-BLOCKS) burn-block-height)
)

(define-private (add-amount
    (entry {
      height: uint,
      amount: uint,
    })
    (total uint)
  )
  (+ total (get amount entry))
)

(define-private (current-window
    (owner principal)
    (token principal)
  )
  (filter in-window
    (default-to (list)
      (map-get? trade-window {
        owner: owner,
        token: token,
      })
    ))
)

;; The window with this trade added. A second trade in the same burn block
;; (cooldown 0) adds to the last entry instead of appending, so the window
;; holds at most one entry per height. Returns none only if the list would
;; pass 144 entries, which cannot happen: every kept entry is from one of the
;; last 144 heights, and if none is from `now` there are at most 143.
(define-private (add-trade
    (window (list 144 {
      height: uint,
      amount: uint,
    }))
    (now uint)
    (spent uint)
  )
  (match (if (> (len window) u0)
      (element-at? window (- (len window) u1))
      none
    )
    last (if (is-eq (get height last) now)
      (replace-at? window (- (len window) u1) {
        height: now,
        amount: (+ (get amount last) spent),
      })
      (as-max-len? (append window {
        height: now,
        amount: spent,
      })
        u144
      )
    )
    (as-max-len? (append window {
      height: now,
      amount: spent,
    })
      u144
    )
  )
)

;; `last-trade` is the owner's, across both tokens; `day-total` is `token`'s
;; window sum.
(define-read-only (get-trade-state
    (owner principal)
    (token principal)
  )
  {
    last-trade: (map-get? last-trade owner),
    day-total: (fold add-amount (current-window owner token) u0),
  }
)

;; Owner-approval band.
;;
;; An owner may set, per input token, a threshold above which the agent's own
;; call is not enough. With a threshold T for `token-in`:
;; - `amount-in` <= T: `execute-swap` runs as before.
;; - T < `amount-in` <= `max-per-trade`: `execute-swap` refuses with
;;   ERR-APPROVAL-REQUIRED. The agent records the trade with `request-swap`
;;   and it runs only when the owner calls `approve-swap`.
;; - `amount-in` > `max-per-trade`: refused with u114 as before, by every path.
;; No entry means no band, so a vault that never set one behaves exactly as it
;; did before the band existed. A threshold of u0 means every trade in that
;; token needs approval.
;;
;; A request moves nothing, calls no token, adapter or oracle, and does not
;; count against the daily cap or the cooldown: those are checked, and the
;; trade counted, when the owner approves. `approve-swap` runs every check
;; `execute-swap` runs, at approval time, through the same private function
;; (`run-swap`), and skips only the threshold. So the price is read again and
;; the stored `min-out` must still be at or above the oracle floor.
;;
;; Each owner has at most one pending request. It can be approved at burn
;; heights up to and including its `expires-at`, which is `requested-at` +
;; APPROVAL-WINDOW. After that it can only be overwritten by a new request,
;; rejected by the owner or withdrawn by the agent that made it.
;;
;; `approve-swap` takes the whole trade again (adapter, tokens, amounts) and
;; the request's `requested-at`, and refuses unless all six equal the stored
;; request. So the agent cannot replace the request the owner saw with another
;; one before the approval is mined, and an approval is bound to one request:
;; a signed approval cannot run a later request with the same trade, whether
;; the agent withdrew its request and made it again to restart the window or
;; made it long after the one the owner saw was gone.
;; Residual: a request withdrawn and made again inside the same burn block,
;; with the same five trade fields, has the same `requested-at` and still
;; matches. It is the same trade inside the same window, so the owner's
;; approval means what it meant.

(define-constant ERR-APPROVAL-REQUIRED (err u126))
(define-constant ERR-APPROVAL-NOT-NEEDED (err u127))
(define-constant ERR-REQUEST-PENDING (err u128))
(define-constant ERR-NO-PENDING-SWAP (err u129))
(define-constant ERR-REQUEST-EXPIRED (err u130))
(define-constant ERR-REQUEST-MISMATCH (err u131))
(define-constant ERR-REQUEST-AGENT-CHANGED (err u132))
(define-constant ERR-NOT-REQUESTER (err u133))

;; How many burn blocks a request stays approvable after the one it was made
;; in: about an hour of Bitcoin blocks. Long enough for an owner to see the
;; request and sign; short enough that a forgotten request cannot be approved
;; into a market that has moved for a day. The price is checked again at
;; approval whatever the window is.
(define-constant APPROVAL-WINDOW u6)

(define-map approval-thresholds
  {
    owner: principal,
    token: principal,
  }
  uint
)

(define-map pending-swaps
  principal
  {
    agent: principal,
    adapter: principal,
    token-in: principal,
    token-out: principal,
    amount-in: uint,
    min-out: uint,
    requested-at: uint,
    expires-at: uint,
  }
)

;; `none` when the owner set no threshold for `token`: no band.
(define-read-only (get-approval-threshold
    (owner principal)
    (token principal)
  )
  (map-get? approval-thresholds {
    owner: owner,
    token: token,
  })
)

;; The owner's stored request, if any, expired or not: compare `expires-at`
;; with the burn height. An expired request stays until it is overwritten,
;; rejected or withdrawn, and can never be approved.
(define-read-only (get-pending-swap (owner principal))
  (map-get? pending-swaps owner)
)

(define-private (needs-approval
    (owner principal)
    (token principal)
    (amount uint)
  )
  (match (get-approval-threshold owner token)
    threshold (> amount threshold)
    false
  )
)

;; Sets the caller's threshold for `token`, or clears it with `none`. The
;; fixed-set check comes first, for both.
(define-public (set-approval-threshold
    (token principal)
    (threshold (optional uint))
  )
  (let ((owner contract-caller))
    (asserts! (is-accepted-token token) ERR-TOKEN-NOT-SUPPORTED)
    (match threshold
      value (map-set approval-thresholds {
        owner: owner,
        token: token,
      }
        value
      )
      (map-delete approval-thresholds {
        owner: owner,
        token: token,
      })
    )
    (print {
      event: "set-approval-threshold",
      owner: owner,
      token: token,
      threshold: threshold,
    })
    (ok true)
  )
)

;; The policy checks that need no token, adapter or oracle, up to the
;; per-trade cap, in the documented order (u108 to u114). `execute-swap`,
;; `request-swap` and `approve-swap` all run them through here. `agent` is the
;; caller for the first two and the request's agent for `approve-swap`.
(define-private (check-trade
    (owner principal)
    (agent principal)
    (adapter-id principal)
    (token-in-id principal)
    (token-out-id principal)
    (amount-in uint)
  )
  (let (
      (vault (get-vault owner))
      ;; Caps are `token-in`'s only, never `token-out`'s.
      (policy (get-policy owner token-in-id))
    )
    (asserts! (is-eq (get agent vault) (some agent)) ERR-NOT-AGENT)
    (asserts! (not (get paused vault)) ERR-VAULT-PAUSED)
    (asserts! (<= burn-block-height (get expires-at policy)) ERR-POLICY-EXPIRED)
    ;; These reads check the fixed sets as well as the owner's lists, so a
    ;; token or adapter outside them never reaches a `contract-call?`.
    (asserts!
      (and
        (is-token-allowed owner token-in-id)
        (is-token-allowed owner token-out-id)
      )
      ERR-SWAP-TOKEN-NOT-ALLOWED
    )
    (asserts! (not (is-eq token-in-id token-out-id)) ERR-SAME-TOKEN)
    (asserts! (is-adapter-allowed owner adapter-id) ERR-SWAP-ADAPTER-NOT-ALLOWED)
    (asserts! (> amount-in u0) ERR-ZERO-AMOUNT)
    (asserts! (<= amount-in (get max-per-trade policy)) ERR-TRADE-CAP-EXCEEDED)
    (ok true)
  )
)

;; The swap itself, shared by `execute-swap` and `approve-swap` so the two can
;; never drift apart: every check, the adapter call, the ledger accounting,
;; the daily window and `last-trade`. `approved` is false for `execute-swap`
;; and true for `approve-swap`, and decides one thing only: whether the
;; approval threshold applies. That check sits straight after the per-trade
;; cap (u114) and before the daily cap (u115). Returns the journal event
;; without its `event` field; the caller adds it and prints.
(define-private (run-swap
    (owner principal)
    (agent principal)
    (adapter <swap-adapter-trait>)
    (token-in <sip-010-trait>)
    (token-out <sip-010-trait>)
    (amount-in uint)
    (min-out uint)
    (approved bool)
  )
  (let (
      (now burn-block-height)
      (token-in-id (contract-of token-in))
      (token-out-id (contract-of token-out))
      (policy (get-policy owner token-in-id))
      (adapter-id (contract-of adapter))
      ;; The window is `token-in`'s only, never `token-out`'s.
      (window (current-window owner token-in-id))
      (day-total (fold add-amount window u0))
      (max-per-day (get max-per-day policy))
      (bounds (get-price-bounds owner))
    )
    (try! (check-trade owner agent adapter-id token-in-id token-out-id amount-in))
    (asserts! (or approved (not (needs-approval owner token-in-id amount-in)))
      ERR-APPROVAL-REQUIRED
    )
    ;; Subtract, never add, so neither side can overflow.
    (asserts! (<= day-total max-per-day) ERR-DAY-CAP-EXCEEDED)
    (asserts! (<= amount-in (- max-per-day day-total)) ERR-DAY-CAP-EXCEEDED)
    ;; Subtract, never add, so a huge cooldown cannot overflow. Burn heights
    ;; never fall, so `now` is never below `last`.
    (asserts!
      (match (map-get? last-trade owner)
        last (>= (- now last) (get cooldown-blocks policy))
        true
      )
      ERR-COOLDOWN-ACTIVE
    )
    (asserts! (>= (get-balance owner token-in-id) amount-in)
      ERR-INSUFFICIENT-BALANCE
    )
    ;; Unset bounds refuse before the oracle is called.
    (asserts!
      (and
        (> (get max-slippage-bps bounds) u0)
        (> (get max-price-age bounds) u0)
      )
      ERR-PRICE-BOUNDS-UNSET
    )
    ;; Errors from the oracle checks pass through `try!` unchanged. The oracle
    ;; is read once, here; the event below prints what this check used.
    (let ((priced (try! (oracle-floor token-in-id amount-in bounds))))
      (asserts! (>= min-out (get floor priced)) ERR-BELOW-ORACLE-FLOOR)
      (let (
          ;; Both read inside this call, so tokens stranded in the vault earlier
          ;; cannot affect the difference.
          (before-in (try! (contract-call? token-in get-balance current-contract)))
          (before-out (try! (contract-call? token-out get-balance current-contract)))
          (total-in-before (get-ledger-total token-in-id))
          (total-out-before (get-ledger-total token-out-id))
          (sbtc-in (if (is-eq token-in-id ALLOWED-TOKEN)
            amount-in
            u0
          ))
          (usd-in (if (is-eq token-in-id QUOTE-TOKEN)
            amount-in
            u0
          ))
        )
        ;; The adapter may move at most `amount-in` of the input token and none
        ;; of the output token or any other asset. A `with-ft` amount of u0 is
        ;; accepted by Clarity 6 (tested: every swap passes u0 for one token).
        ;; Any adapter error becomes ERR-ADAPTER-FAILED, so adapter codes never
        ;; read as vault codes. An allowance violation becomes
        ;; ERR-ALLOWANCE-EXCEEDED. Either way the whole call rolls back. The
        ;; adapter's return value is never used. The asset names come from the
        ;; deploy configuration block at the top (see docs/clarity-4.md, Deploy
        ;; note).
        (unwrap!
          (as-contract? ((with-ft ALLOWED-TOKEN ALLOWED-TOKEN-FT sbtc-in) (with-ft QUOTE-TOKEN QUOTE-TOKEN-FT usd-in))
            (unwrap!
              (contract-call? adapter swap token-in token-out amount-in min-out
                current-contract
              )
              ERR-ADAPTER-FAILED
            )
          )
          ERR-ALLOWANCE-EXCEEDED
        )
        (let (
            (after-in (try! (contract-call? token-in get-balance current-contract)))
            (after-out (try! (contract-call? token-out get-balance current-contract)))
            (total-in-after (get-ledger-total token-in-id))
            (total-out-after (get-ledger-total token-out-id))
            ;; The balance change less the ledgers' change: a deposit or
            ;; withdrawal someone (the adapter, through a callback) made
            ;; during the call moves both by the same amount, so it never
            ;; counts as the owner's. Each side is a sum, never a
            ;; difference, so nothing underflows; the sums are bounded by
            ;; twice the token's supply.
            (spent (let (
                (gone (+ before-in total-in-after))
                (kept (+ after-in total-in-before))
              )
              (if (> gone kept)
                (- gone kept)
                u0
              )
            ))
            (received (let (
                (came (+ after-out total-out-before))
                (had (+ before-out total-out-after))
              )
              (if (> came had)
                (- came had)
                u0
              )
            ))
          )
          (asserts! (>= received min-out) ERR-BELOW-MIN-OUT)
          (let (
              ;; Cannot underflow: spent <= amount-in (the allowance) and
              ;; amount-in <= the ledger (checked above).
              (balance-in (- (get-balance owner token-in-id) spent))
              (balance-out (+ (get-balance owner token-out-id) received))
              ;; Never ERR-DAY-CAP-EXCEEDED in practice: see `add-trade`.
              (new-window (unwrap! (add-trade window now spent) ERR-DAY-CAP-EXCEEDED))
            )
            (map-set balances {
              owner: owner,
              token: token-in-id,
            }
              balance-in
            )
            (map-set balances {
              owner: owner,
              token: token-out-id,
            }
              balance-out
            )
            ;; Cannot underflow: the total includes the owner's ledger,
            ;; which covers `spent` (above).
            (map-set ledger-totals token-in-id (- total-in-after spent))
            (map-set ledger-totals token-out-id (+ total-out-after received))
            (map-set trade-window {
              owner: owner,
              token: token-in-id,
            }
              new-window
            )
            (map-set last-trade owner now)
            (ok {
              owner: owner,
              agent: agent,
              adapter: adapter-id,
              token-in: token-in-id,
              token-out: token-out-id,
              amount-in: spent,
              min-out: min-out,
              amount-out: received,
              balance-in: balance-in,
              balance-out: balance-out,
              day-total: (+ day-total spent),
              oracle-price: (get price priced),
              oracle-timestamp: (get timestamp priced),
              min-out-floor: (get floor priced),
            })
          )
        )
      )
    )
  )
)

(define-public (execute-swap
    (owner principal)
    (adapter <swap-adapter-trait>)
    (token-in <sip-010-trait>)
    (token-out <sip-010-trait>)
    (amount-in uint)
    (min-out uint)
  )
  ;; The agent is `contract-caller`, never `tx-sender`: a contract the agent
  ;; calls through is then the caller and is refused.
  (let ((done (try! (run-swap owner contract-caller adapter token-in token-out amount-in min-out
      false
    ))))
    (print (merge done { event: "execute-swap" }))
    (ok (get amount-out done))
  )
)

;; The agent records a trade that is above the owner's approval threshold.
;; Same arguments as `execute-swap`. The agent is `contract-caller`. Checks, in
;; order: the policy checks up to the per-trade cap (u108 to u114), the amount
;; is in fact above the threshold (u127: otherwise call `execute-swap`), the
;; owner's ledger covers it (u101), and no unexpired request is pending (u128).
;; An expired request is overwritten. The daily cap, the cooldown and the
;; price are left to `approve-swap`. Returns the request's `expires-at`.
(define-public (request-swap
    (owner principal)
    (adapter <swap-adapter-trait>)
    (token-in <sip-010-trait>)
    (token-out <sip-010-trait>)
    (amount-in uint)
    (min-out uint)
  )
  (let (
      (now burn-block-height)
      (token-in-id (contract-of token-in))
      (request {
        agent: contract-caller,
        adapter: (contract-of adapter),
        token-in: token-in-id,
        token-out: (contract-of token-out),
        amount-in: amount-in,
        min-out: min-out,
        requested-at: now,
        expires-at: (+ now APPROVAL-WINDOW),
      })
    )
    (try! (check-trade owner contract-caller (get adapter request) token-in-id
      (get token-out request) amount-in
    ))
    (asserts! (needs-approval owner token-in-id amount-in)
      ERR-APPROVAL-NOT-NEEDED
    )
    (asserts! (>= (get-balance owner token-in-id) amount-in)
      ERR-INSUFFICIENT-BALANCE
    )
    (asserts!
      (match (map-get? pending-swaps owner)
        pending (> now (get expires-at pending))
        true
      )
      ERR-REQUEST-PENDING
    )
    (map-set pending-swaps owner request)
    (print (merge request {
      event: "request-swap",
      owner: owner,
    }))
    (ok (get expires-at request))
  )
)

;; The owner approves their pending request and the swap runs. The owner is
;; `contract-caller`, so a caller can only ever approve their own request.
;; The arguments are the trade the owner means to approve and `requested-at`,
;; the burn height of the request the owner read. Checks, in order: there is
;; a request (u129), it has not expired (u130), it is exactly the trade in
;; the arguments and was made at `requested-at` (u131), and the agent that
;; made it is still the vault's agent (u132). `requested-at` binds the
;; approval to one request; the only other request it can match is one made
;; in the same burn block with the same trade (see the band's notes above). Then everything `execute-swap` checks, as of now,
;; except the approval threshold. The request is deleted before the adapter
;; is called; a refusal rolls that back with everything else.
(define-public (approve-swap
    (adapter <swap-adapter-trait>)
    (token-in <sip-010-trait>)
    (token-out <sip-010-trait>)
    (amount-in uint)
    (min-out uint)
    (requested-at uint)
  )
  (let (
      (owner contract-caller)
      (request (unwrap! (map-get? pending-swaps owner) ERR-NO-PENDING-SWAP))
      (agent (get agent request))
    )
    (asserts! (<= burn-block-height (get expires-at request))
      ERR-REQUEST-EXPIRED
    )
    (asserts!
      (and
        (is-eq (contract-of adapter) (get adapter request))
        (is-eq (contract-of token-in) (get token-in request))
        (is-eq (contract-of token-out) (get token-out request))
        (is-eq amount-in (get amount-in request))
        (is-eq min-out (get min-out request))
        (is-eq requested-at (get requested-at request))
      )
      ERR-REQUEST-MISMATCH
    )
    (asserts! (is-eq (get agent (get-vault owner)) (some agent))
      ERR-REQUEST-AGENT-CHANGED
    )
    (map-delete pending-swaps owner)
    (let ((done (try! (run-swap owner agent adapter token-in token-out amount-in min-out true))))
      (print (merge done {
        event: "approve-swap",
        requested-at: (get requested-at request),
      }))
      (ok (get amount-out done))
    )
  )
)

;; The owner rejects their pending request, expired or not. Nothing else
;; changes.
(define-public (reject-swap)
  (let (
      (owner contract-caller)
      (request (unwrap! (map-get? pending-swaps owner) ERR-NO-PENDING-SWAP))
    )
    (map-delete pending-swaps owner)
    (print (merge request {
      event: "reject-swap",
      owner: owner,
    }))
    (ok true)
  )
)

;; The agent that made `owner`'s pending request withdraws it, expired or
;; not. The caller must be the request's agent, whether or not it is still the
;; vault's agent, so a removed agent can still clear what it left behind.
(define-public (cancel-swap-request (owner principal))
  (let ((request (unwrap! (map-get? pending-swaps owner) ERR-NO-PENDING-SWAP)))
    (asserts! (is-eq (get agent request) contract-caller) ERR-NOT-REQUESTER)
    (map-delete pending-swaps owner)
    (print (merge request {
      event: "cancel-swap-request",
      owner: owner,
    }))
    (ok true)
  )
)
