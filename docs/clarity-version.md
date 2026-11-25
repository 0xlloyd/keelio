# Clarity version: stay on 4 or move to 6

Whether `keelio-vault` should stay on Clarity 4 (epoch 3.3) or move to Clarity 6 (epoch 4.0), which
mainnet has run since Bitcoin block 960,230. Checked on 2026-11-15. Every result below comes from a
command run on that date, or from a source link read that day. Anything neither shows is marked
**not confirmed**.

The `as-contract?` syntax is in [`clarity-4.md` §2](clarity-4.md#2-syntax) and mainnet activation is
in [`clarity-4.md` §3](clarity-4.md#3-is-clarity-4-live-on-mainnet). This doc doesn't repeat them.

All probes ran in a scratch copy of the repo (`/tmp/keel-016`, with `node_modules` linked from the
worktree) with throwaway test files that are not committed. Nothing was installed or upgraded:

```text
$ pnpm list @stacks/clarinet-sdk
devDependencies:
└── @stacks/clarinet-sdk@4.0.0

$ ls node_modules/.pnpm | grep clarinet-sdk-wasm
@stacks+clarinet-sdk-wasm@4.0.0
```

## Q1. Does SDK 4.0.0 run `keelio-vault` at Clarity 6, epoch 4.0?

Yes. The vault source deploys unchanged and the whole suite passes. One other contract moves with
it.

Before any change, the suite in the scratch copy:

```text
$ pnpm exec vitest run
 Test Files  15 passed (15)
      Tests  229 passed (229)
```

1. `keelio-vault` set to `clarity_version = 6`, `epoch = 4.0`, nothing else changed. `initSimnet()`
   failed in every file that starts a simnet:

   ```text
   $ pnpm exec vitest run
    FAIL  tests/demo.test.ts [ tests/demo.test.ts ]
   Unknown Error: Contract 'STT7X786SV7KBMCK5ZY9C7TZR81TCJ0CJJHJK6VD.vault-caller' is deployed at epoch 3.3, but dependency 'STT7X786SV7KBMCK5ZY9C7TZR81TCJ0CJJHJK6VD.keelio-vault' requires epoch 4.0.
    The dependency contract was deployed at a later epoch than this contract.
   …
    Test Files  14 failed | 1 passed (15)
   ```

   This is the same rule `clarity-4.md` §1 hit at 3.3: a contract that calls the vault statically
   must be deployed at the vault's epoch or later.

2. `vault-caller` moved to `epoch = 4.0`, still at `clarity_version = 3`. Every other contract
   stays at 3 / 3.1, including `mock-dex`, which still uses the old `as-contract` (Clarity 3 code
   keeps its own rules at any epoch):

   ```text
   $ pnpm exec vitest run
    Test Files  15 passed (15)
         Tests  229 passed (229)
   ```

3. The three test files that deploy string-replaced copies of the vault at runtime
   (`tests/keelio-vault-allowance.test.ts`, `tests/keelio-vault-swap.test.ts`,
   `tests/keelio-vault-threats.test.ts`) moved from `clarityVersion: 4` to `6`, so the allowance
   proof runs on the version that ships. The adapters they deploy stay at 3:

   ```text
   $ pnpm exec vitest run
    Test Files  15 passed (15)
         Tests  229 passed (229)

   $ pnpm exec vitest run tests/keelio-vault-allowance.test.ts tests/keelio-vault-swap.test.ts tests/keelio-vault-threats.test.ts --reporter=verbose
    ✓ keelio-vault withdraw allowance > refuses a greedy allowed token that moves more than amount
    ✓ keelio-vault withdraw allowance > control: the same token drains a vault with no allowance
    ✓ keelio-vault execute-swap allowance > refuses an adapter that takes more than amount-in, or any token-out
    ✓ keelio-vault execute-swap allowance > control: the same adapter takes more with no allowance
    …
    Test Files  3 passed (3)
         Tests  47 passed (47)
   ```

4. What the simnet actually deployed, printed by a probe test after `initSimnet()`:

   ```text
   PROBE currentEpoch 4.0
   PROBE defaultClarityForEpoch Clarity 6
   PROBE interface keelio-vault: epoch Epoch40 clarity_version Clarity6
   PROBE interface vault-caller: epoch Epoch40 clarity_version Clarity3
   PROBE interface mock-dex: epoch Epoch31 clarity_version Clarity3
   PROBE interface mock-sbtc: epoch Epoch31 clarity_version Clarity3
   PROBE interface sip-010-trait: epoch Epoch31 clarity_version Clarity3
   ```

   Runtime deploys land at epoch 4.0, and the version passed to `deployContract` is honoured:
   `with-staking` deploys at 6 and is rejected at 4 (see Q2), so the copies really are Clarity 6.

What moved, in `Clarinet.toml`:

| Contract        | Before  | After   | Why                       |
| --------------- | ------- | ------- | ------------------------- |
| `keelio-vault`  | 4 / 3.3 | 6 / 4.0 | The decision              |
| `vault-caller`  | 3 / 3.3 | 3 / 4.0 | The epoch error in step 1 |
| everything else | 3 / 3.1 | 3 / 3.1 | Nothing forced a change   |

Sources:

- Clarinet v4.0.0 release notes (published 2026-10-30, read 2026-11-15). They list simnet changes
  but don't mention Clarity 6: <https://github.com/stx-labs/clarinet/releases/tag/v4.0.0>
- Clarinet v3.23.0 release notes (published 2026-07-30, read 2026-11-15): "Use epoch 4.0 and Clarity
  6 defaults" and "Add new snapshot starting at epoch 4.0". So Clarity 6 support predates 4.0.0:
  <https://github.com/stx-labs/clarinet/releases/tag/v3.23.0>
- Clarinet JS SDK reference for `deployContract` and `currentEpoch` (as cited in `clarity-4.md`
  §1): <https://docs.stacks.co/reference/clarinet-js-sdk/sdk-reference>. `getContractsInterfaces`,
  `getDefaultClarityVersionForCurrentEpoch` and the post-condition options were read from the
  installed package's type definitions (`@stacks/clarinet-sdk-wasm@4.0.0/clarinet_sdk.d.ts`).

## Q2. What changes for the vault between Clarity 4 and Clarity 6

Nothing the vault uses. The `clarity-4.md` §1 probe table, rerun at both versions in one simnet
(vault at 6 / 4.0). Each `p-*` contract held 1,000 `mock-sbtc` and 1,000 `mock-usd` and had the
same `move` function as in `clarity-4.md` §1:

```text
PROBE C4 p-ok honest mock-sbtc 10: (ok true) bal (ok u990)
PROBE C4 p-ok evil-token 1: (err u0) bal (ok u990)
PROBE C4 p-wrongname honest 10: (err u128) bal (ok u1000)
PROBE C4 p-ok honest 5000 (more than held): (err u1) bal (ok u990)
PROBE C4 p-unsafe evil-token 1: (ok true) bal (ok u0)
PROBE C4 p-zero (with-ft mock-sbtc u0) mock-usd 10: (ok true) usd bal (ok u990)
PROBE C4 p-zero (with-ft mock-sbtc u0) mock-sbtc 10: (err u0) sbtc bal (ok u1000)
PROBE deploy p-old-4 @Clarity4 error: Contract deployment runtime error: STT7X786SV7KBMCK5ZY9C7TZR81TCJ0CJJHJK6VD.p-old-4 -> use of unresolved function 'as-contract'
PROBE deploy p-cc-4 @Clarity4: (ok true)
PROBE deploy p-stacking-4 @Clarity4: (ok true)
PROBE deploy p-staking-4 @Clarity4 error: Contract deployment runtime error: STT7X786SV7KBMCK5ZY9C7TZR81TCJ0CJJHJK6VD.p-staking-4 -> use of unresolved function 'with-staking'
PROBE deploy p-pox-4 @Clarity4 error: Contract deployment runtime error: STT7X786SV7KBMCK5ZY9C7TZR81TCJ0CJJHJK6VD.p-pox-4 -> use of unresolved function 'with-pox'
PROBE C6 p-ok honest mock-sbtc 10: (ok true) bal (ok u990)
PROBE C6 p-ok evil-token 1: (err u0) bal (ok u990)
PROBE C6 p-wrongname honest 10: (err u128) bal (ok u1000)
PROBE C6 p-ok honest 5000 (more than held): (err u1) bal (ok u990)
PROBE C6 p-unsafe evil-token 1: (ok true) bal (ok u0)
PROBE C6 p-zero (with-ft mock-sbtc u0) mock-usd 10: (ok true) usd bal (ok u990)
PROBE C6 p-zero (with-ft mock-sbtc u0) mock-sbtc 10: (err u0) sbtc bal (ok u1000)
PROBE deploy p-old-6 @Clarity6 error: Contract deployment runtime error: STT7X786SV7KBMCK5ZY9C7TZR81TCJ0CJJHJK6VD.p-old-6 -> use of unresolved function 'as-contract'
PROBE deploy p-cc-6 @Clarity6: (ok true)
PROBE deploy p-stacking-6 @Clarity6 error: Contract deployment runtime error: STT7X786SV7KBMCK5ZY9C7TZR81TCJ0CJJHJK6VD.p-stacking-6 -> use of unresolved function 'with-stacking'
PROBE deploy p-staking-6 @Clarity6: (ok true)
PROBE deploy p-pox-6 @Clarity6: (ok true)
```

| Probe                      | Allowance                                                                   | Clarity 4                     | Clarity 6    |
| -------------------------- | --------------------------------------------------------------------------- | ----------------------------- | ------------ |
| `p-ok`, `mock-sbtc` 10     | `(with-ft .mock-sbtc "mock-sbtc" amount)`                                   | `(ok true)`, 10 moved         | same         |
| `p-ok`, `evil-token` 1     | same                                                                        | `(err u0)`, nothing moved     | same         |
| `p-wrongname`, `mock-sbtc` | `(with-ft .mock-sbtc "sbtc" amount)`                                        | `(err u128)`, nothing moved   | same         |
| `p-ok`, `mock-sbtc` 5,000  | same as `p-ok`                                                              | `(err u1)`, the token's error | same         |
| `p-unsafe`, `evil-token` 1 | `(with-all-assets-unsafe)`                                                  | `(ok true)`, all drained      | same         |
| `p-zero`, `mock-usd` 10    | `(with-ft .mock-sbtc "mock-sbtc" u0) (with-ft .mock-usd "mock-usd" amount)` | `(ok true)`, 10 moved         | same         |
| `p-zero`, `mock-sbtc` 10   | same                                                                        | `(err u0)`, nothing moved     | same         |
| `p-old`                    | old `(as-contract tx-sender)`                                               | rejected                      | rejected     |
| `p-cc`                     | `current-contract`                                                          | deploys                       | deploys      |
| `p-stacking`               | `(with-stacking u0)`                                                        | deploys                       | **rejected** |
| `p-staking`, `p-pox`       | `(with-staking u0)`, `(with-pox)`                                           | **rejected**                  | deploys      |

What that means for the vault, item by item:

- **`as-contract?` and its allowances, `with-ft`**: identical results at 4 and 6, including the raw
  `u0` and `u128` codes, so the vault's `unwrap!` still maps every allowance failure to
  `ERR-ALLOWANCE-EXCEEDED` (`u104`). A `with-ft` amount of `u0` still blocks any outflow of that
  token, which `withdraw` and `execute-swap` rely on for the token that isn't moving.
- **`current-contract`**: unchanged.
- **`with-stacking`** is replaced by `with-staking` and `with-pox` at Clarity 6. The vault uses
  none of them. `clarity-4.md` §2's `with-stacking` row says the same and stays as it is.
- **Deprecated forms the vault uses**: none. The function reference marks `as-contract` deprecated
  in Clarity 4, `at-block` deprecated in Clarity 5 and `with-stacking` deprecated in Clarity 6. The
  vault uses none of them (`grep -n "at-block\|as-contract \|with-stacking" contracts/keelio-vault.clar`
  prints nothing). `burn-block-height` has no deprecation note.
- **`burn-block-height`**, which drives the day window, cooldown and expiry, still returns the
  Bitcoin height at Clarity 6. The probe in Q3 reads the same value at 3, 4 and 6 before and after
  `mineEmptyBurnBlocks(144)`, and the window tests pass with the vault at 6:

  ```text
  $ pnpm exec vitest run tests/keelio-vault-swap.test.ts tests/keelio-vault-threats.test.ts --reporter=verbose
   ✓ keelio-vault execute-swap > u110: refuses after the policy expires
   ✓ keelio-vault execute-swap > u115: refuses an amount-in that would pass max-per-day
   ✓ keelio-vault execute-swap > u116: refuses during the cooldown
   ✓ keelio-vault execute-swap > trades at expires-at and refuses one block later
   ✓ keelio-vault execute-swap > cooldown 3: refuses at H+2 and trades at H+3
   ✓ keelio-vault execute-swap > the day window rolls: refused at H+143, trades at H+144
   ✓ keelio-vault execute-swap > a trade at each of 144 heights, then a second in the last block, fits the window
   ✓ T3: a bad price inside the caps > T3: min-out 0 loses at most max-per-day per rolling 144-block window
  ```

  The epoch 4.0 page lists no change to `burn-block-height`. Its "burn" changes are about where
  miner BTC goes under PoX-5 ("Miner BTC no longer reaches a burn address"), not the burn chain's
  height. Whether mainnet block timing differs after 4.0 is **not confirmed**: the simnet can't
  show it and the docs we read don't say.

- **`concat`** became variadic in Clarity 6. The vault doesn't call `concat`.
- **Post-condition modes.** Epoch 3.4 added an `originator` mode beside `deny` and `allow`
  (SIP-040). Epoch 4.0 added staking and PoX post-condition types (SIP-045) but no new mode. These
  are transaction-level, so they work the same for a Clarity 4 or Clarity 6 vault. SDK 4.0.0 takes
  post-conditions on `simnet.callPublicFn` (its `PostConditionOptions`), so this was run on the
  simnet, with the vault at 6 / 4.0:

  ```text
  PROBE deposit 100 deny, alice sends =100: (ok u100) alice (ok u920)
  PROBE deposit 100 deny, alice sends =99 error: Call contract function error: keelio-vault::deposit('STT7X786SV7KBMCK5ZY9C7TZR81TCJ0CJJHJK6VD.mock-sbtc, u100) -> Post-condition check failure on fungible asset STT7X786SV7KBMCK5ZY9C7TZR81TCJ0CJJHJK6VD.mock-sbtc::mock-sbtc owned by ST1JB16RJ35T8RYJ6RD85FKDNXMB9ZSRGHMMQD9Q8: 99 SentEq 100
  PROBE deposit 100 originator, no conditions error: Call contract function error: keelio-vault::deposit('STT7X786SV7KBMCK5ZY9C7TZR81TCJ0CJJHJK6VD.mock-sbtc, u100) -> Post-condition check failure: Fungible asset STT7X786SV7KBMCK5ZY9C7TZR81TCJ0CJJHJK6VD.mock-sbtc::mock-sbtc was moved by ST1JB16RJ35T8RYJ6RD85FKDNXMB9ZSRGHMMQD9Q8 but not checked
  PROBE deposit 100 originator, alice sends <=100: (ok u200) alice (ok u820)
  PROBE withdraw 50 deny, no conditions error: Call contract function error: keelio-vault::withdraw('STT7X786SV7KBMCK5ZY9C7TZR81TCJ0CJJHJK6VD.mock-sbtc, u50) -> Post-condition check failure: Fungible asset STT7X786SV7KBMCK5ZY9C7TZR81TCJ0CJJHJK6VD.mock-sbtc::mock-sbtc was moved by STT7X786SV7KBMCK5ZY9C7TZR81TCJ0CJJHJK6VD.keelio-vault but not checked
  PROBE withdraw 50 originator, no conditions: (ok u150) alice (ok u870)
  PROBE withdraw 50 deny, vault sends =50: (ok u100) alice (ok u920)
  ```

  In `originator` mode a withdrawal needs no condition (only the vault sends), and a deposit needs
  one on the owner's own outflow. In `deny` mode a withdrawal must also name the vault's outflow.
  The SDK's transaction builders don't set a mode today; choosing one is a later SDK change, not
  part of this job. The simnet doesn't show what a wallet displays: **not confirmed**.

Sources (all read 2026-11-15):

- Stacks docs, Epoch 4.0 consensus changes: "Epoch 4.0 activated on mainnet at Bitcoin block
  960,230, on 30 July 2026", "The `with-stacking` allowance used by `restrict-assets?` and
  `as-contract?` is replaced by two allowances in Clarity 6. `with-stacking` remains valid in
  Clarity 4 and 5 contracts", and "Two post-condition types are new. Staking … PoX …":
  <https://docs.stacks.co/reference/epoch-4-0-consensus-changes>
- Clarity function reference: `as-contract` "Deprecated in Clarity 4", `at-block` "Deprecated in
  Clarity 5", `with-stacking` "Deprecated in Clarity 6", `with-staking` and `with-pox` "Introduced
  in: Clarity 6", and `concat` variadic "Beginning in Clarity 6":
  <https://docs.stacks.co/reference/clarity/functions>
- Clarity keyword reference: `burn-block-height` "Introduced in: Clarity 1 … Returns the current
  block height of the underlying burn blockchain", with no deprecation note; `current-contract`
  "Introduced in: Clarity 4": <https://docs.stacks.co/reference/clarity/keywords>
- Stacks docs, Post-conditions: originator mode "Available starting with Stacks epoch 3.4
  (SIP-040)", staking and PoX conditions "available starting with Stacks epoch 4.0":
  <https://docs.stacks.co/post-conditions/overview>

## Q3. Is `stacks-block-time` available?

In Clarity 4 and Clarity 6, yes. In Clarity 3, no. Each probe contract was deployed at runtime with
`simnet.deployContract(name, source, { clarityVersion }, deployer)`:

```clarity
(define-read-only (now) stacks-block-time)   ;; time-3, time-4, time-6
(define-read-only (now) burn-block-height)   ;; burn-3, burn-4, burn-6
```

```text
PROBE deploy time-3 @Clarity3 error: Contract deployment runtime error: STT7X786SV7KBMCK5ZY9C7TZR81TCJ0CJJHJK6VD.time-3 -> use of unresolved variable 'stacks-block-time'
PROBE deploy burn-3 @Clarity3: (ok true)
PROBE deploy time-4 @Clarity4: (ok true)
PROBE deploy burn-4 @Clarity4: (ok true)
PROBE deploy time-6 @Clarity6: (ok true)
PROBE deploy burn-6 @Clarity6: (ok true)
PROBE before simnet.blockHeight 59 simnet.burnBlockHeight 3
PROBE before burn-3 now: u3
PROBE before time-4 now: u1794778449
PROBE before burn-4 now: u3
PROBE before time-6 now: u1794778449
PROBE before burn-6 now: u3
PROBE after mineEmptyBurnBlocks(144) simnet.blockHeight 203 simnet.burnBlockHeight 147
PROBE after mineEmptyBurnBlocks(144) burn-3 now: u147
PROBE after mineEmptyBurnBlocks(144) time-4 now: u1794864299
PROBE after mineEmptyBurnBlocks(144) burn-4 now: u147
PROBE after mineEmptyBurnBlocks(144) time-6 now: u1794864299
PROBE after mineEmptyBurnBlocks(144) burn-6 now: u147
```

| Keyword             | Clarity 3                               | Clarity 4     | Clarity 6     |
| ------------------- | --------------------------------------- | ------------- | ------------- |
| `stacks-block-time` | rejected: `use of unresolved variable`  | `u1794778449` | `u1794778449` |
| `burn-block-height` | `u3`, then `u147` after 144 burn blocks | same          | same          |

`stacks-block-time` is a Unix timestamp in seconds. On the simnet it advanced by 85,850 s over 144
empty burn blocks (about 596 s per block). That is the simnet's clock, not a mainnet block time.
The oracle work can use it from Clarity 4 up. A Clarity 3 caller can't read it directly. Both
`stacks-block-time` and `burn-block-height` give the same value at 4 and 6.

Source: Clarity keyword reference, `stacks-block-time` "Introduced in: Clarity 4 … Returns the Unix
timestamp (in seconds) of the current Stacks block" (read 2026-11-15):
<https://docs.stacks.co/reference/clarity/keywords>

## Q4. Decision

**Decision:** move to Clarity 6. All four conditions of the decision rule hold: (a) met: SDK 4.0.0,
unchanged, deploys `keelio-vault` at `clarity_version = 6`, `epoch = 4.0` from `Clarinet.toml`
(`interface keelio-vault: epoch Epoch40 clarity_version Clarity6`); (b) met: the full suite passes
(229 of 229, the same count as before), including the greedy and unsafe copies, now deployed at 6,
with `u104` proving each refusal; (c) met: the vault's code needs no edit, only two comments that
named Clarity 4 now name Clarity 6; (d) met: `burn-block-height` is neither removed nor renamed in
Clarity 6, returns the same Bitcoin height as at 3 and 4, and the day window, cooldown and expiry
tests pass.

**Reason:** the move costs three lines in `Clarinet.toml` and the version literal of three test
copies, with no change to any check, error code or allowance. Staying would leave the vault on the
older version with nothing to show for it.

**How a grant reviewer reads it:** the vault targets the language version mainnet runs now, and
the claim is checked: the same allowance refusals that `clarity-4.md` proved at Clarity 4 were rerun
at Clarity 6 with the same results, and every test runs against the Clarity 6 vault. The oracle
milestone can use `stacks-block-time` for a maximum price age without another version move.

What moving does not change:

- Mainnet would still accept a Clarity 4 vault (`clarity-4.md` §3), so this was a choice, not a
  forced upgrade.
- The mocks and traits stay at Clarity 3. Only `vault-caller` moves epoch, because it calls the
  vault.
- The real-deploy FT names in [`clarity-4.md`'s Deploy note](clarity-4.md#deploy-note) apply
  unchanged.
