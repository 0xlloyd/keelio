# Bitflow: how to test the first live adapter, and which pool

Findings of the spike for issue #45. Everything below was read or run on 2026-11-15 (Stacks tip
9,495,9xx). Mainnet was only read, through Hiro's public API (`GET`, and `POST .../call-read`, which
is the read-only call). Nothing was signed, deployed or broadcast, and no key was added.

Short version: the simnet can run against mainnet state with `remote_data`; a contract principal can
swap through both the XYK and the DLMM paths; the STX wrapper does not reject it; `min-dy` 0 is
refused by XYK and accepted by DLMM; Bitflow has no testnet XYK or DLMM. Use the sBTC/USDCx DLMM pool.

Contract ids used below:

| Name              | Contract id                                                                             |
| ----------------- | --------------------------------------------------------------------------------------- |
| XYK core          | `SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-core-v-1-2`                              |
| XYK sBTC/STX pool | `SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-sbtc-stx-v-1-1` (pool id 21)        |
| STX wrapper       | `SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2`                             |
| DLMM core         | `SP1PFR4V08H1RAZXREBGFFQ59WB739XM8VVGTFSEA.dlmm-core-v-1-1`                             |
| DLMM routers      | `SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-swap-router-v-1-1` and `-v-1-2`         |
| DLMM sBTC/USDCx   | `SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-sbtc-usdcx-v-1-bps-10` (pool id 1) |
| sBTC              | `SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token`                                  |
| USDCx             | `SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx`                                       |

Sources were fetched with `GET https://api.hiro.so/v2/contracts/source/<address>/<name>` and the
signatures with `GET .../v2/contracts/interface/<address>/<name>`. Line numbers refer to the source
text that endpoint returns.

## 1. Can the simnet read mainnet state, and do the sources deploy as they are?

**Remote data works.** `@stacks/clarinet-sdk` 4.0.0 accepts a `[repl.remote_data]` table. The probe
uses a second project, `tests/bitflow-remote/Clarinet.toml`, so the shared `Clarinet.toml` and the
other tests stay offline:

```toml
[repl.remote_data]
enabled = true
api_url = "https://api.hiro.so"
use_mainnet_wallets = true
```

A read-only call from the simnet to a mainnet contract returns live state (the first call fetches
the contract and its dependencies, so a run takes 8 to 40 seconds):

```
$ pnpm exec vitest run tests/bitflow-probe.test.ts
 Test Files  1 passed (1)
      Tests  1 passed (1)
```

and, in an exploration run, `simnet.callReadOnlyFn("SM1793…9HCCR.xyk-pool-sbtc-stx-v-1-1",
"get-pool", …)` returned the pool tuple of section 3 (simnet height 9495952, the mainnet tip).

Three things the run showed that are not in the Clarinet docs:

- **`use_mainnet_wallets = true` is required.** Without it the simnet accounts are `ST…` addresses.
  Bitflow's `is-standard` checks then fail on one side of every swap. Observed output, same probe,
  `ST` wallets: DLMM `(err u2001)` (the router's `ERR_NO_RESULT_DATA`, which hides the first inner
  error), XYK `(err u3003)` (`ERR_INVALID_PRINCIPAL`, `xyk-pool-sbtc-stx-v-1-1` line 241 and 242).
  With `SP…` wallets the same calls succeed (section 4).
- **`mintSTX` fails in remote mode** (`RuntimeError: unreachable`). Use `simnet.transferSTX` from the
  deployer.
- **The sBTC test balance comes from impersonation.** The simnet does not check signatures, so a
  test can send `sbtc-token transfer` _as_ a mainnet holder (`SPMN2177…HVC6K`, 808 sBTC on the day).
  That is a local state change in the simnet. No key is involved and nothing leaves the machine.
  `mock-sbtc` cannot be used here, because Bitflow's pools only accept the real token.

**The sources do not deploy as they are.** The router is not self-contained. Deploying
`dlmm-swap-router-v-1-1` alone into a simnet without remote data:

```
error: use of unresolved contract 'STT7X786SV7KBMCK5ZY9C7TZR81TCJ0CJJHJK6VD.dlmm-pool-trait-v-1-1'
--> contracts/router.clar:5:1
(use-trait dlmm-pool-trait .dlmm-pool-trait-v-1-1.dlmm-pool-trait)
```

The router also hard-codes `SP1PFR4V08H1RAZXREBGFFQ59WB739XM8VVGTFSEA.dlmm-core-v-1-1` (v-1-1
lines 178 to 179, v-1-2 lines 186 to 187), and the pool, tokens and traits come from three more
addresses. A vendored copy would need the whole tree (traits, core, pool, `sbtc-token`, `usdcx`,
wrapper) redeployed at the right addresses. Remote data avoids that, so nothing is copied into
`contracts/vendor/`.

**Offline.** The probe and adapter tests run only under `pnpm run test:online`, which sets
`KEELIO_ONLINE=1`. `pnpm run check` shows them as skipped, so the gate never depends on the network.
The remote project pins `initial_height`, so every online run reads the same mainnet state. Remote data is not available offline: the
simnet needs the API for every contract it has not seen.

## 2. Swap entry points and return values

Signatures are from `GET /v2/contracts/interface/...`; the bodies are from the sources.

### `xyk-core-v-1-2` (986 lines)

```clarity
(swap-x-for-y (pool-trait <xyk-pool-trait>) (x-token-trait <sip-010-trait>)
              (y-token-trait <sip-010-trait>) (x-amount uint) (min-dy uint))
  -> (response uint uint)            ;; line 558
(swap-y-for-x (pool-trait <xyk-pool-trait>) (x-token-trait <sip-010-trait>)
              (y-token-trait <sip-010-trait>) (y-amount uint) (min-dx uint))
  -> (response uint uint)            ;; line 637
```

- `ok`: the amount of the output token the caller received (`dy` for x-for-y, `dx` for y-for-x).
- `err`: `u1001` to `u1024` (`ERR_*` at lines 6 to 29). The ones a swap can return: `u1002`
  `ERR_INVALID_AMOUNT`, `u1008` `ERR_NO_POOL_DATA`, `u1010` `ERR_POOL_DISABLED`, `u1012`
  `ERR_INVALID_POOL`, `u1017`/`u1018` wrong token trait, `u1019` `ERR_MINIMUM_X_AMOUNT`, `u1020`
  `ERR_MINIMUM_Y_AMOUNT`. Errors from the token or pool contracts pass through unchanged
  (`try!`), for example `u4`, `u5` (wrapper) and `u3003` (pool).
- **Debited and credited:** `caller` is `tx-sender` (line 584). The input token is transferred
  from `caller` to the pool: `dx + provider fee` (line 600), then the protocol fee from `caller` to
  `fee-address` (lines 606 to 609). The output token goes from the pool to `caller` (line 603,
  `pool-transfer`). `pool-transfer` only accepts `contract-caller` equal to the core (pool source
  line 238).
- Fees on the sBTC/STX pool: protocol 10 bps and provider 40 bps on each side (section 3).

### `dlmm-swap-router-v-1-1` (352 lines) and `-v-1-2` (360 lines)

The functions that swap one pair in one pool (the ones an adapter needs):

```clarity
;; v-1-1
(swap-x-for-y-simple-multi (pool-trait <dlmm-pool-trait>) (x-token-trait <sip-010-trait>)
    (y-token-trait <sip-010-trait>) (x-amount uint) (min-dy uint))
  -> (response {in: uint, out: uint} uint)
(swap-y-for-x-simple-multi … (y-amount uint) (min-dx uint)) -> (response {in: uint, out: uint} uint)
;; the same with (max-steps uint) before the end: swap-x-for-y-simple-range-multi, …y-for-x…
;; v-1-2: identical, plus a final (deadline-time (optional uint)) argument on every swap function
```

Other swap functions, same `(response … uint)` shape: `swap-multi`, `swap-simple-multi`,
`swap-x-for-y-same-multi`, `swap-y-for-x-same-multi` (several bins or pools; they take
`max-unfavorable-bins` or per-swap `min-received`).

- `ok {in, out}`: `in` is the input actually spent (`x-amount` minus what was left unswapped),
  `out` the total output. `swap-simple-multi` returns a list of these.
- `err`: router codes `u2001` to `u2011` (v-1-1 lines 9 to 19) and, in v-1-2 only, `u2012`
  `ERR_DEADLINE_PASSED` (line 20, checked at lines 145 and 163 against `stacks-block-time`). The
  slippage check is `ERR_MINIMUM_RECEIVED` `u2003` (v-1-1 lines 139 and 156; v-1-2 lines 146 and
  164). Errors inside the core pass through the fold as the router's `u2001` (see section 1).
- **Debited and credited:** the router is not a custodian. Each step calls
  `SP1PFR4V08H1RAZXREBGFFQ59WB739XM8VVGTFSEA.dlmm-core-v-1-1 swap-x-for-y` (or `swap-y-for-x`) in
  the same transaction, and the core uses `caller tx-sender` (core line 1283). The input token goes
  from `tx-sender` to the pool (core line 1359), the output from the pool to `tx-sender` (core line
  1364). The router passes `tx-sender` through unchanged, so the account debited and credited is
  the one that started the call or the one inside an `as-contract` block.
- v-1-2 needs Clarity 4 (`stacks-block-time`), so the simnet project that runs it uses epoch 3.3.

## 3. Current and liquid pools

Read with `POST /v2/contracts/call-read/<address>/<contract>/<function>` on 2026-11-15.

**XYK sBTC/STX is pool 21, current and enabled.**
`xyk-core-v-1-2 get-last-pool-id` returned `u44`; `get-pool-by-id u21` returned
`xyk-pool-sbtc-stx-v-1-1` (`sBTC-STX-LP`). Its `get-pool`:

```
x-token  SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token      x-balance 49974180
y-token  SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2  y-balance 121068168496
pool-status true   total-shares 2207200991   x/y protocol fee 10   x/y provider fee 40
```

That is 0.4997418 sBTC against 121,068.168496 STX. A swap of 10,000 sats returned 24,145,253 µSTX
in the probe run.

**DLMM sBTC/USDCx is pool 1, current and enabled.** `dlmm-core-v-1-1 get-last-pool-id` returned
`u19`. Three sBTC/USDCx pools exist: ids 1, 2 and 17.

| Pool id | Contract                          | Active bin (signed) | Active-bin balances           |
| ------- | --------------------------------- | ------------------- | ----------------------------- |
| 1       | `dlmm-pool-sbtc-usdcx-v-1-bps-10` | -22                 | 637,712 sats, 35.096007 USDCx |
| 2       | `dlmm-pool-sbtc-usdcx-v-1-bps-1`  | 499                 | 17 sats, 0.000119 USDCx       |
| 17      | `dlmm-pool-sbtc-usdcx-v-2-bps-10` | 0                   | 20,024 sats, 0.000006 USDCx   |

(`get-bin-balances` takes the unsigned bin id, the signed id plus 500.) Summing
`get-bin-balances` over all 1001 unsigned bin ids gave 368,803,308 sats (3.688 sBTC) and
15,506.359401 USDCx for pool 1, and 20,024 sats and 0.000006 USDCx for pool 17. Pool 1 has fee 25 +
25 bps and bin step 10 bps; its `get-pool` shows `initial-price` 66194479380. A swap of 10,000 sats
returned 6,443,104 (6.443104 USDCx) in the probe run. Pools 2 and 17 are dust. Pool 1 is the only
liquid sBTC/USDCx pool.

There is also a DLMM STX/sBTC pool (ids 6, 15 and 16); it is out of scope here.

## 4. Can a contract principal swap through each path?

**Yes, through both, and the STX wrapper does not reject it.** The probe contract
`contracts/probes/bitflow-probe.clar` calls each router inside `as-contract`, so `tx-sender` is the
probe contract. `tests/bitflow-probe.test.ts` funds it, swaps, and asserts the balances. Run on
2026-11-15 (exploration run, same calls as the test):

```
dlmm-v11-sbtc-for-usdcx (10000, min 0)  (ok (tuple (in u10000) (out u6443104)))
dlmm-v12-sbtc-for-usdcx (10000, min 1)  (ok (tuple (in u10000) (out u6443104)))
xyk-sbtc-for-stx        (10000, min 1)  (ok u24145253)
probe sbtc before 100000, after 4 swaps 60000;  probe usdcx after 19329312
```

The test also swaps STX for sBTC (`xyk-stx-for-sbtc`), where the wrapper debits the contract's STX,
and asserts that the contract's sBTC balance rose.

Why the wrapper accepts it. `token-stx-v-1-2` `transfer` (lines 93 to 105) requires
`tx-sender` equal to `sender`, then `(is-standard sender)` and `(is-standard recipient)`. `is-standard`
tests the network version byte of the address, so a contract principal on a mainnet address passes
(`SP….name`). The rejection that was reported is real in the simnet only when the accounts are
`ST…` (section 1): then every `SM…`/`SP…` mainnet principal fails `is-standard` and the pool answers
`u3003`. It is a version-byte check, not a "no contracts" rule.

Caveat for the adapter: the caller must be the principal that holds the tokens. If the adapter is
called by the vault, the vault must move the input tokens to the adapter (as the frame says) and the
adapter must make the Bitflow call from an `as-contract` block of its own; then Bitflow debits and
credits the adapter, and the adapter sends the output back to the vault. This probe does not cover
that chain.

## 5. Is `min-dy` 0 refused?

- **XYK: refused**, with `(err u1002)` `ERR_INVALID_AMOUNT`. `xyk-core-v-1-2` line 596,
  `(asserts! (> min-dy u0) ERR_INVALID_AMOUNT)`, and line 675 for `min-dx`. Run:
  `xyk-sbtc-for-stx (10000, min 0)` returned `(err u1002)`. The test asserts it.
- **DLMM: not refused** at either router. `swap-x-for-y-simple-multi` only checks
  `(>= y-amount min-dy)` (v-1-1 line 139, v-1-2 line 146), which holds for 0, and the core takes no
  minimum at all. Run: `dlmm-v11-sbtc-for-usdcx (10000, min 0)` returned
  `(ok (tuple (in u10000) (out u6443104)))`. The test asserts the balance rose. The vault's
  `min-out` check is then the only floor on that path.

## 6. Does Bitflow have a testnet deployment?

**Not for the contracts we need.** Read only; no testnet node or API was called. The check was
Bitflow's docs, `https://docs.bitflow.finance/llms-full.txt` (fetched 2026-11-15), page
"Deployed Contracts / Stacks":

```
## Testnet Contracts
  … deployed to STRP7MYBHSMFH5EGN3HGX6KNQ7QBHVTBPF1669DW
### StableSwap Contracts   stableswap-xbtc-sbtc-v-0-1-1, stableswap-usda-susdt
### XYK Contracts          Currently, there are no available contracts. Check back soon.
### Router Contracts       Currently, there are no available contracts. Check back soon.
```

The docs list only old StableSwap and Earn contracts on testnet (an `xBTC`/`sBTC` pair from before
sBTC launched). The XYK and router sections are empty. The DLMM routers also hard-code the mainnet
`SP1PFR4V…dlmm-core-v-1-1`, so a testnet copy would be a different deployment. The docs page may
lag the chain; it was not checked against a testnet node, by design. Testing a live adapter on
testnet is therefore not an option today, and the simnet with remote data is the way.

## 7. Recommendation

**Use the sBTC/USDCx DLMM pool,
`SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-sbtc-usdcx-v-1-bps-10`, through
`dlmm-swap-router-v-1-2` `swap-x-for-y-simple-multi` and `swap-y-for-x-simple-multi`.**

- **Depth.** 3.69 sBTC and 15,506 USDCx across the bins, against 0.50 sBTC in the XYK pool. It is
  the only liquid sBTC/stablecoin pool.
- **The other leg is a dollar token.** An agent swapping sBTC for USDCx and back is the intended
  use. The XYK pool pairs sBTC with STX, which adds a second volatile asset.
- **No wrapper.** The XYK output goes through `token-stx-v-1-2`, whose `is-standard` check is
  fragile with respect to the network of the caller, as section 1 showed.
- **Deadline.** v-1-2 takes `deadline-time`, so a stale transaction can fail instead of filling at
  an old price. Pass `(some …)`; it was checked (`u2012`).
- **Cost:** DLMM accepts `min-dy` 0 (section 5), so the adapter must not pass 0 through from the
  vault by default. The vault's `min-out` must be above zero, which `execute-swap` already needs
  for the check to mean anything. The XYK pool would refuse it, which is a point in its favour.
- The router returns `{in, out}`, so the adapter can report `out` to the vault without reading
  balances.

How to test it: `tests/bitflow-probe.test.ts` is the pattern (second project with `remote_data` and
`use_mainnet_wallets`, impersonated sBTC funding, probe contract inside `as-contract`). The adapter
test should reuse it and add the vault. It needs the network, so keep it apart from the offline
tests.

**Verified by `tests/bitflow-adapter.test.ts`** (run 2026-11-15, against `contracts/adapters/bitflow-adapter.clar`):

- **The vault-to-adapter chain.** A copy of `keelio-vault` that differs only in its five deploy
  configuration lines swaps through the adapter in both directions. Round trip: 10,000 sats in,
  6,449,547 USDCx (base units) out; 3,224,773 USDCx in, 4,950 sats out. Each swap's transfers are
  vault to adapter (`amount-in`), adapter to pool (`amount-in`), pool to adapter (the output), and
  adapter to vault (the same output). The adapter holds neither token afterwards.
- **A swap across bins.** Active bin -21 held 64,992 sats and 385.974951 USDCx. Selling 897,678 sats
  emptied its USDCx side and moved on to bin -22: two adapter-to-pool sBTC transfers that add up to
  `amount-in`, 578.768814 USDCx out, active bin now -22. The router spent all of `amount-in`, so it
  did not return a partial fill.
- **Asset names.** USDCx's `define-fungible-token` is `usdcx-token` (sBTC's is `sbtc-token`).
- **Fees.** No fee recipient appeared in the transfers: the pool's `swap-x-for-y` event shows the
  protocol and provider fees (`x-amount-fees-protocol`, `x-amount-fees-provider`, 25 + 25 bps of a
  10,000-sat swap) taken inside the pool, and no transfer goes from the adapter to anyone but the
  pool.
- **Deadline.** The adapter passes `none`, not `(some …)` as recommended above. A deadline the
  adapter computed from `stacks-block-time` would sit in the same transaction and always pass. A real
  deadline needs the agent to sign one, and the adapter trait has no argument for it.

Still not verified: swaps that walk many bins, beyond the two seen above.
