# Clarity 4 allowances

What we found when we checked whether `keelio-vault` can use Clarity 4's `as-contract?` allowances.
Checked on 2026-11-15. Every result below comes from a command run on that date. None of it is
from memory.

The vault has since moved to Clarity 6 (epoch 4.0): see `docs/clarity-version.md` for the decision.
The allowance behaviour in §1 and §2 was re-checked at Clarity 6 with the same results (see
[the Q2 table](clarity-version.md#q2-what-changes-for-the-vault-between-clarity-4-and-clarity-6)).

## 1. Does the simnet run Clarity 4?

Yes, with the SDK already in the lockfile. Nothing was upgraded.

```text
$ pnpm list @stacks/clarinet-sdk
devDependencies:
└── @stacks/clarinet-sdk@4.0.0

$ ls node_modules/.pnpm | grep clarinet-sdk-wasm
@stacks+clarinet-sdk-wasm@4.0.0
```

The working settings in `Clarinet.toml`:

```toml
[contracts.keelio-vault]
path = "contracts/keelio-vault.clar"
clarity_version = 4
epoch = 3.3
```

What we ran, in a scratch copy of the repo with a throwaway test that is not committed:

1. `keelio-vault` moved to `clarity_version = 4`, `epoch = 3.3`, nothing else changed. `initSimnet()`
   failed:

   ```text
   Contract 'STT7X786SV7KBMCK5ZY9C7TZR81TCJ0CJJHJK6VD.vault-caller' is deployed at epoch 3.1, but
   dependency 'STT7X786SV7KBMCK5ZY9C7TZR81TCJ0CJJHJK6VD.keelio-vault' requires epoch 3.3.
    The dependency contract was deployed at a later epoch than this contract.
   ```

   A Clarity 3 contract can sit beside a Clarity 4 one, but a contract that calls a 3.3 contract
   must itself be at epoch 3.3. `vault-caller` moves to `epoch = 3.3` and stays at
   `clarity_version = 3`. Every other contract stays at 3 / 3.1.

2. With `vault-caller` at 3.3, `initSimnet()` failed on the vault's own code:

   ```text
   error: use of unresolved function 'as-contract'
   ```

   Clarity 4 removes `as-contract`. In `deposit`, `(as-contract tx-sender)` becomes
   `current-contract`. In `withdraw`, the transfer moves to `as-contract?`.

3. With both changes made, the probe printed:

   ```text
   PROBE currentEpoch 3.3
   PROBE p-ok honest mock-sbtc 10: (ok true) bal (ok u990)
   PROBE p-ok evil-token 1: (err u0) bal (ok u990)
   PROBE p-wrongname honest 10: (err u128) bal (ok u1000)
   PROBE p-ok honest 5000 (more than held): (err u1) bal (ok u990)
   PROBE p-unsafe evil-token 1: (ok true) bal (ok u0)
   PROBE p-unchecked error: Contract deployment runtime error: …p-unchecked -> intermediary responses in consecutive statements must be checked
   PROBE p-old error: Contract deployment runtime error: …p-old -> use of unresolved function 'as-contract'
   ```

   Each `p-*` contract was deployed at runtime with
   `simnet.deployContract(name, source, { clarityVersion: 4 }, deployer)`, held 1,000 `mock-sbtc`,
   and had one function:

   ```clarity
   (define-public (move (token <sip>) (amount uint) (to principal))
     (as-contract? (<allowance>)
       (try! (contract-call? token transfer amount tx-sender to none))))
   ```

   | Probe         | Allowance                                 | Token called       | Result                                                                                               |
   | ------------- | ----------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------- |
   | `p-ok`        | `(with-ft .mock-sbtc "mock-sbtc" amount)` | `mock-sbtc`        | `(ok true)`, 10 moved                                                                                |
   | `p-ok`        | same                                      | `evil-token`       | `(err u0)`: allowance 0 violated, nothing moved                                                      |
   | `p-wrongname` | `(with-ft .mock-sbtc "sbtc" amount)`      | `mock-sbtc`        | `(err u128)`: `"sbtc"` is the symbol, not the FT name, so no allowance covered the move              |
   | `p-ok`        | as above                                  | `mock-sbtc`, 5,000 | `(err u1)`: the token's own error. The inner `try!` exits the enclosing function, not `as-contract?` |
   | `p-unsafe`    | `(with-all-assets-unsafe)`                | `evil-token`       | `(ok true)`, the whole balance drained                                                               |

   The full suite with the vault change passed: `Test Files 7 passed (7)`, `Tests 38 passed (38)`
   (36 existing tests plus the two probe files).

Sources read:

- Clarinet v3.9.0 release notes, "This release has full support for Epoch 3.3 and Clarity 4":
  <https://github.com/stx-labs/clarinet/releases/tag/v3.9.0>
- Clarinet v4.0.0 release (the SDK version in our lockfile, published 2026-10-30):
  <https://github.com/stx-labs/clarinet/releases/tag/v4.0.0>
- Clarinet JS SDK reference, `deployContract` and `currentEpoch`:
  <https://docs.stacks.co/reference/clarinet-js-sdk/sdk-reference>

## 2. Syntax

From the Clarity function reference at <https://docs.stacks.co/reference/clarity/functions> and
the keyword reference at <https://docs.stacks.co/reference/clarity/keywords>.

```clarity
(as-contract? (allowance*) body1 body2 ... body-last)   ;; => (response <type of body-last> uint)
```

`as-contract?` runs the body with `tx-sender` and `contract-caller` set to the contract, then checks
the contract's asset outflows against the allowances in order. It allows up to 128 allowances.

- `(ok x)`: every outflow fit an allowance. `x` is the value of the last body expression.
- `(err uN)`: allowance `N` (0-based) was exceeded. The body's effects are reverted.
- `(err u128)`: an asset moved that no allowance names. The body's effects are reverted.

The allowances:

| Allowance                                    | Permits                                                                                                              |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `(with-stx amount)`                          | Up to `amount` uSTX out                                                                                              |
| `(with-ft contract-id token-name amount)`    | Up to `amount` of one FT. `"*"` as the name covers every FT in `contract-id`                                         |
| `(with-nft contract-id asset-name (list …))` | Only the listed NFT identifiers. `"*"` as the name covers every NFT in `contract-id`                                 |
| `(with-stacking amount)`                     | Stacking or delegating up to `amount` uSTX (Clarity 4 and 5; Clarity 6 splits it into `with-staking` and `with-pox`) |
| `(with-all-assets-unsafe)`                   | Everything. Only in `as-contract?`, never with another allowance. It switches the protection off                     |

`(restrict-assets? asset-owner (allowance*) body…)` applies the same checks to `asset-owner`'s
outflows without changing `tx-sender`. It does not accept `with-all-assets-unsafe`. (The reference
gives its error type as `int`; we didn't test `restrict-assets?`.)

`current-contract` is a Clarity 4 keyword that evaluates to the contract's own principal. It
replaces `(as-contract tx-sender)`.

Traps we hit in the probes:

- **The token name is the `define-fungible-token` name, not the symbol.** `mock-sbtc` declares
  `(define-fungible-token mock-sbtc)` and its symbol is `"sBTC"`. Only `"mock-sbtc"` matches. A wrong
  name fails closed with `(err u128)`.
- **The body must check its responses.** A body that ends in an unchecked `contract-call?` fails
  analysis with `intermediary responses in consecutive statements must be checked`. Wrap the call
  in `try!` or `unwrap!`.
- **A `try!` in the body exits the enclosing function**, so a token's own error (for example
  `mock-sbtc`'s `(err u1)` for an insufficient balance) reaches the caller unchanged. Only allowance
  failures come back out of `as-contract?` as `(err uN)`.
- The raw `(err u0)` / `(err u128)` must not leak out of the vault, because `docs/errors.md` keeps
  each code stable. `keelio-vault` maps them to `ERR-ALLOWANCE-EXCEEDED` with `unwrap!`.

What it looks like in `keelio-vault.withdraw`:

```clarity
(unwrap!
  (as-contract? ((with-ft ALLOWED-TOKEN "mock-sbtc" amount))
    (try! (contract-call? token transfer amount tx-sender owner none))
  )
  ERR-ALLOWANCE-EXCEEDED
)
```

The allowance limits the amount and the asset. It does not limit the recipient: a token could
still send exactly `amount` to someone other than `owner`. The fixed token list is the defence
against that.

## 3. Is Clarity 4 live on mainnet?

Yes. Clarity 4 arrived with epoch 3.3, which activated on mainnet at Bitcoin block 923,222. Mainnet
has since moved on to epoch 4.0 (Clarity 6), and later epochs keep accepting Clarity 4 contracts.

- stacks-core release 3.3.0.0.0, published 2025-11-03: "implements the 3.3 Stacks consensus rules
  which activates at Bitcoin block `923,222`", estimated for 11 November 2025:
  <https://github.com/stacks-network/stacks-core/releases/tag/3.3.0.0.0>
- Stacks docs, Epoch 4.0 consensus changes: "Epoch 4.0 activated on mainnet at Bitcoin block
  960,230, on 30 July 2026", and "`with-stacking` remains valid in Clarity 4 and 5 contracts":
  <https://docs.stacks.co/reference/epoch-4-0-consensus-changes>
- The mainnet node itself, queried on 2026-11-15 at 12:43 UTC:

  ```text
  $ curl -s https://api.hiro.so/v2/info
  network_id 1, burn_block_height 975961, server_version 'stacks-node 4.0.7 (764b77b, release build, linux [x86_64])'
  $ curl -s https://api.hiro.so/v2/pox   (epochs)
  Epoch33 start_height 923222 end_height 943333
  Epoch34 start_height 943333 end_height 960230
  Epoch40 start_height 960230 end_height 9223372036854775807
  ```

Keelio stays on the simnet whatever mainnet supports (see `docs/frame.md`).

## Deploy note

A deployment edits only the configuration block at the top of `contracts/keelio-vault.clar`: seven
constants, each token's contract followed by its `define-fungible-token` name, then the adapter, the
price oracle and the price scale.

```clarity
(define-constant ALLOWED-TOKEN .mock-sbtc)
(define-constant ALLOWED-TOKEN-FT "mock-sbtc")
(define-constant QUOTE-TOKEN .mock-usd)
(define-constant QUOTE-TOKEN-FT "mock-usd")
(define-constant ALLOWED-ADAPTER .mock-dex)
(define-constant ORACLE .mock-oracle)
(define-constant PRICE-SCALE u10000000000)
```

- `ORACLE` is the contract `execute-swap` reads the BTC/USD price from, through
  `get-value "BTC/USD"` (`contracts/traits/oracle-trait.clar`). On mainnet that is DIA's
  `dia-oracle`, whose price has 8 decimals and whose timestamp is in milliseconds.
- `PRICE-SCALE` is `10^(8 + sBTC decimals - quote token decimals)`: `u10000000000` for sBTC (8) and
  a 6-decimal quote token such as mock-usd or USDCx. A wrong value moves every oracle floor by a
  power of ten. `pnpm run check-deploy` checks both constants, as described below.

`withdraw` and `execute-swap` read `ALLOWED-TOKEN-FT` and `QUOTE-TOKEN-FT` in their `with-ft`
allowances, so nothing else in the contract names an asset. Each `-FT` value is the name in the
token's `define-fungible-token`, not its SIP-010 symbol. A real deployment points `ALLOWED-TOKEN` at
`SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token` and sets `ALLOWED-TOKEN-FT` to
`"sbtc-token"`, not `"sbtc-token-locked"`:

```text
$ curl -s 'https://api.hiro.so/v2/contracts/source/SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4/sbtc-token?proof=0'
(define-fungible-token sbtc-token)
(define-fungible-token sbtc-token-locked)
```

If a name doesn't match, every withdrawal of that token fails with `ERR-ALLOWANCE-EXCEEDED`
(`u104`), and so does every swap out of it. The mismatch fails closed, so no funds leave, but
deposits of that token can then never be withdrawn: the vault has no admin and can't be changed
after deployment.

Before deploying, run `pnpm run check-deploy`. It reads everything from the simnet and collects
every failure:

- **Asset names.** It reads the vault's source and each configured token's source, and fails, naming
  the token, if an asset name is not a whole `define-fungible-token` name in that token.
- **`ORACLE`.** The constant must name a contract with a public or read-only
  `(get-value ((string-ascii 32)) (response { value: uint, timestamp: uint } uint))`, the one
  function of `oracle-trait`. The signature comes from the Clarity analysis of the oracle, so a
  `get-value` in a comment or a string does not count. A `get-value` that never errs passes.
- **`PRICE-SCALE`.** It calls each token's `get-decimals` and requires
  `PRICE-SCALE = 10^(p + s - q)`, where `p` is the decimals of the oracle's price, `s` is
  `ALLOWED-TOKEN`'s decimals and `q` is `QUOTE-TOKEN`'s. It also fails if `p + s - q` is negative,
  which a `uint` can't express, or so large that the vault's `PRICE-SCALE * BPS` would overflow.

The relation comes from the floor. With `P` the oracle's value, `a` base units of sBTC are
`a / 10^s` BTC, worth `(a / 10^s) × (P / 10^p)` USD, which is `a × P × 10^q / 10^(s + p)` quote base
units. The vault computes `a × P / PRICE-SCALE`, so `PRICE-SCALE = 10^(p + s - q)`. Buying gives the
same: `a` quote base units are worth `a × 10^(p + s) / (P × 10^q)` sats, and the vault computes
`a × PRICE-SCALE / P`.

```text
$ pnpm run check-deploy
ok  ALLOWED-TOKEN STT7X786SV7KBMCK5ZY9C7TZR81TCJ0CJJHJK6VD.mock-sbtc  ALLOWED-TOKEN-FT "mock-sbtc"
ok  QUOTE-TOKEN STT7X786SV7KBMCK5ZY9C7TZR81TCJ0CJJHJK6VD.mock-usd  QUOTE-TOKEN-FT "mock-usd"
ok  ORACLE STT7X786SV7KBMCK5ZY9C7TZR81TCJ0CJJHJK6VD.mock-oracle  get-value matches oracle-trait
ok  PRICE-SCALE u10000000000 = 10^(8 + 8 - 6)  oracle price decimals 8 (assumed), ALLOWED-TOKEN decimals 8, QUOTE-TOKEN decimals 6
not checked  the oracle's price decimals: get-value returns no decimals, so PRICE-SCALE was checked taking them as 8, which oracle-trait.clar states for DIA. Confirm it for STT7X786SV7KBMCK5ZY9C7TZR81TCJ0CJJHJK6VD.mock-oracle.
not checked  that STT7X786SV7KBMCK5ZY9C7TZR81TCJ0CJJHJK6VD.mock-oracle publishes "BTC/USD" as USD per BTC with a timestamp in milliseconds.
```

The two `not checked` lines are the limits of the check. `get-value` returns a value and a
timestamp and nothing else, so no call can read `p`: the check takes 8, and an oracle with other
decimals passes it with a wrong `PRICE-SCALE`. Nor can it tell what the oracle publishes under
`"BTC/USD"`. Confirm both by hand for the oracle you deploy against.

The check reads only what is on the simnet, so a token or oracle contract that isn't on the simnet
fails the check. That fails closed too. Then test a withdrawal before taking real deposits.
