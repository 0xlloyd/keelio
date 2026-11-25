# Keelio

Read `docs/frame.md` first: it says what Keelio is and holds the rules for this repo.

- **Set up:** `pnpm install`. There is no dev server and no build step yet: the tests run the contracts in an in-process simnet.
- **Check everything:** `pnpm run check` (format, lint, types, tests). Run one test file with
  `pnpm exec vitest run tests/<file>`.
- **Simnet only:** never deploy, sign or broadcast to testnet or mainnet. Never add a real key.
- **Contracts:** Clarity 6 (epoch 4.0) for `keelio-vault`; the other contracts are Clarity 3 or 4, as `Clarinet.toml` sets. Each contract is registered in `Clarinet.toml`. Tests use
  `initSimnet()` from `@stacks/clarinet-sdk`; see `tests/mock-sbtc.test.ts` for the pattern.
- **Amounts:** base units, `uint` on-chain and `bigint` in TypeScript. No floating point.
- **Errors:** one named constant per `(err uN)`, listed in `docs/errors.md`.
- **Format before committing:** `pnpm run format`.
