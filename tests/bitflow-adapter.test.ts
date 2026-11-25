// bitflow-adapter against Bitflow's own mainnet contracts, run in the remote-data simnet.
//
// Like tests/bitflow-probe.test.ts, this reads mainnet state through Hiro's public API and changes
// nothing outside the local simnet. sBTC comes from a local transfer sent as a mainnet holder
// (DONOR); the simnet does not check signatures, and no key for it exists here.
//
// The vault is a copy of contracts/keelio-vault.clar that differs only in five of the seven lines of
// its deploy configuration block, the edit docs/clarity-4.md (Deploy note) says a deployment makes.
// ORACLE and PRICE-SCALE stay as they are: the copy reads .mock-oracle, and USDCx has 6 decimals
// like mock-usd.
//
// It needs the network, so it runs only under `pnpm run test:online`. `pnpm run check` reports it
// as skipped and stays offline. tests/bitflow-remote/Clarinet.toml pins the mainnet height, so every run reads the
// same pool state. The tests still assert relations, never fixed output amounts, so they also hold
// when the pin is raised.
import { readFileSync } from "node:fs";
import { initSimnet } from "@stacks/clarinet-sdk";
import {
  Cl,
  type ClarityValue,
  type ResponseOkCV,
  type TupleCV,
  type UIntCV,
} from "@stacks/transactions";
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildExecuteSwap,
  type TxConfig,
  type VaultCall,
} from "../packages/sdk/src/index.js";
import {
  BITFLOW_MANIFEST,
  BITFLOW_VAULT_NAME,
  bitflowVaultSource,
  DEPLOY_CONFIG,
  fundSbtc,
  POOL,
  ROUTER,
  SBTC,
  SBTC_FT,
  USDCX,
  USDCX_FT,
  vaultSource as readVaultSource,
} from "../scripts/bitflow-world.js";
import {
  fungibleTokenNames,
  stripComments,
} from "../scripts/check-deploy-config.js";
import { armOracle, floorOf } from "./oracle-fixture.js";
import { vaultClarityVersion } from "./vault-clarity-version.js";

// Off by default so the gate never depends on the network. `pnpm run test:online` sets it.
const online = process.env.KEELIO_ONLINE === "1";

// The mainnet principals, DONOR and DEPLOY_CONFIG (the five deploy-configuration lines a Bitflow
// deployment rewrites) are in scripts/bitflow-world.ts, shared with the Bitflow demo.
const SBTC_ASSET = `${SBTC}::${SBTC_FT}`;
const USDCX_ASSET = `${USDCX}::${USDCX_FT}`;
// A third SIP-010 token, outside the adapter's pair.
const STX_WRAPPER = "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2";

const FUNDING = 10_000_000n;
const DEPOSIT = 100_000n;
const SWAP_IN = 10_000n;
// Caps are in each token's own base units; these are high enough for every swap here.
const MAX_PER_TRADE = 1_000_000_000_000n;
const MAX_PER_DAY = 1_000_000_000_000_000n;
const UNREACHABLE_MIN_OUT = 10_000_000_000_000n;
// The vault's oracle: $100,000 a BTC, and a floor of 10% of that reference (9000 bps), so the live
// pool clears it in both directions. The age limit is never reached here.
const ORACLE_PRICE = 10_000_000_000_000n;
const SLIPPAGE_BPS = 9_000n;
/** The vault's oracle floor for a swap: the least min-out it accepts. */
const floor = (tokenIn: string, amountIn: bigint) =>
  floorOf(amountIn, ORACLE_PRICE, SLIPPAGE_BPS, tokenIn === SBTC);

const adapterPath = new URL(
  "../contracts/adapters/bitflow-adapter.clar",
  import.meta.url,
);
// Forwards `swap` to the adapter with itself as recipient. It is `contract-caller` to the adapter
// while the wallet that calls it stays `tx-sender`.
const ADAPTER_CALLER = `
(use-trait sip-010 .sip-010-trait.sip-010-trait)
(define-public (forward (token-in <sip-010>) (token-out <sip-010>) (amount-in uint) (min-out uint))
  (contract-call? .bitflow-adapter swap token-in token-out amount-in min-out current-contract))`;

interface FtTransfer {
  asset_identifier: string;
  sender: string;
  recipient: string;
  amount: string;
}

type Simnet = Awaited<ReturnType<typeof initSimnet>>;
type CallResult = ReturnType<Simnet["callPublicFn"]>;

function ftTransfers(events: CallResult["events"]): FtTransfer[] {
  return events
    .filter((e) => e.event === "ft_transfer_event")
    .map((e) => e.data as FtTransfer);
}

/**
 * Copied from tests/sdk-build-tx.test.ts (importing it would run that file's simnet), and changed
 * to report every failure and every uncovered key instead of stopping at the first. The simnet does
 * not enforce post-conditions, so this sums the FT amounts each principal sent per asset and checks
 * each post-condition against its sum (no transfer counts as 0). `uncovered` lists the
 * (sender, asset) keys that moved without a post-condition, which Deny mode would refuse.
 */
function checkPostConditions(
  call: VaultCall,
  events: CallResult["events"],
): { failed: string[]; uncovered: string[] } {
  const sent = new Map<string, bigint>();
  for (const t of ftTransfers(events)) {
    const key = `${t.sender}|${t.asset_identifier}`;
    sent.set(key, (sent.get(key) ?? 0n) + BigInt(t.amount));
  }
  const covered = new Set<string>();
  const failed: string[] = [];
  for (const pc of call.postConditions) {
    if (pc.type !== "ft-postcondition") {
      failed.push(`unsupported ${pc.type}`);
      continue;
    }
    const key = `${pc.address}|${pc.asset}`;
    covered.add(key);
    const actual = sent.get(key) ?? 0n;
    const want = BigInt(pc.amount);
    const holds = {
      eq: actual === want,
      gt: actual > want,
      gte: actual >= want,
      lt: actual < want,
      lte: actual <= want,
    }[pc.condition];
    if (!holds)
      failed.push(`${key} sent ${actual}, needs ${pc.condition} ${want}`);
  }
  const uncovered = [...sent.keys()].filter((key) => !covered.has(key));
  return { failed, uncovered };
}

const sum = (transfers: FtTransfer[]): bigint =>
  transfers.reduce((total, t) => total + BigInt(t.amount), 0n);

const uint = (cv: ClarityValue): bigint => BigInt((cv as UIntCV).value);

function okUint(call: CallResult): bigint {
  expect(call.result.type, Cl.prettyPrint(call.result)).toBe("ok");
  return uint((call.result as ResponseOkCV).value);
}

describe.runIf(online)(
  "bitflow-adapter (mainnet state, simnet execution)",
  { timeout: 120_000 },
  () => {
    let simnet: Simnet;
    let deployer: string;
    let owner: string;
    let agent: string;
    let adapter: string;
    let vault: string;
    let caller: string;

    const balance = (token: string, who: string): bigint => {
      const r = simnet.callReadOnlyFn(
        token,
        "get-balance",
        [Cl.principal(who)],
        deployer,
      ).result;
      return uint((r as ResponseOkCV).value);
    };
    const ledger = (token: string): bigint =>
      uint(
        simnet.callReadOnlyFn(
          vault,
          "get-balance",
          [Cl.principal(owner), Cl.principal(token)],
          deployer,
        ).result,
      );
    const vaultCall = (sender: string, fn: string, args: ClarityValue[]) =>
      simnet.callPublicFn(vault, fn, args, sender);
    const ok = (call: CallResult) =>
      expect(call.result).toStrictEqual(Cl.ok(Cl.bool(true)));

    const executeSwap = (
      tokenIn: string,
      tokenOut: string,
      amountIn: bigint,
      minOut: bigint,
    ) =>
      vaultCall(agent, "execute-swap", [
        Cl.principal(owner),
        Cl.principal(adapter),
        Cl.principal(tokenIn),
        Cl.principal(tokenOut),
        Cl.uint(amountIn),
        Cl.uint(minOut),
      ]);
    const directSwap = (
      sender: string,
      tokenIn: string,
      tokenOut: string,
      amountIn: bigint,
      minOut: bigint,
    ) =>
      simnet.callPublicFn(
        adapter,
        "swap",
        [
          Cl.principal(tokenIn),
          Cl.principal(tokenOut),
          Cl.uint(amountIn),
          Cl.uint(minOut),
          Cl.principal(sender),
        ],
        sender,
      );

    /** AC 2: asserted after every successful swap, not only at the end. */
    const expectAdapterEmpty = () => {
      expect(balance(SBTC, adapter)).toBe(0n);
      expect(balance(USDCX, adapter)).toBe(0n);
    };

    /** Every balance a refused call must leave alone. */
    const snapshot = () => ({
      ledgers: [ledger(SBTC), ledger(USDCX)],
      owner: [balance(SBTC, owner), balance(USDCX, owner)],
      agent: [balance(SBTC, agent), balance(USDCX, agent)],
      vault: [balance(SBTC, vault), balance(USDCX, vault)],
      adapter: [balance(SBTC, adapter), balance(USDCX, adapter)],
    });

    const deposit = (token: string, amount: bigint) =>
      vaultCall(owner, "deposit", [Cl.principal(token), Cl.uint(amount)]);
    const withdraw = (token: string, amount: bigint) =>
      vaultCall(owner, "withdraw", [Cl.principal(token), Cl.uint(amount)]);

    beforeAll(() => {
      const vaultSource = readVaultSource();
      // Throws if any of the five lines is missing from the vault.
      const copySource = bitflowVaultSource(vaultSource);
      expect(copySource).not.toBe(vaultSource);
      // Only these five configuration lines differ.
      const changed = vaultSource
        .split("\n")
        .filter((line, i) => line !== copySource.split("\n")[i]);
      expect(changed).toStrictEqual(DEPLOY_CONFIG.map(([from]) => from));

      return initSimnet(BITFLOW_MANIFEST).then((s) => {
        simnet = s;
        deployer = simnet.deployer;
        const accounts = simnet.getAccounts();
        owner = accounts.get("wallet_1")!;
        agent = accounts.get("wallet_2")!;
        adapter = `${deployer}.bitflow-adapter`;
        vault = `${deployer}.${BITFLOW_VAULT_NAME}`;
        caller = `${deployer}.adapter-caller`;

        for (const [name, code, version] of [
          [
            BITFLOW_VAULT_NAME,
            copySource,
            vaultClarityVersion() as 1 | 2 | 3 | 4,
          ],
          ["adapter-caller", ADAPTER_CALLER, 4],
        ] as const) {
          const { result } = simnet.deployContract(
            name,
            code,
            { clarityVersion: version },
            deployer,
          );
          expect(result, name).toStrictEqual(Cl.ok(Cl.bool(true)));
        }

        // Fund the owner: a local transfer in the simnet, sent as a mainnet holder.
        expect(fundSbtc(simnet, owner, FUNDING)).toStrictEqual(
          Cl.ok(Cl.bool(true)),
        );

        // The remote simnet starts at the mainnet tip, so the expiry is read now.
        const expiresAt = BigInt(simnet.burnBlockHeight) + 1_000n;
        for (const token of [SBTC, USDCX]) {
          ok(
            vaultCall(owner, "allow-token", [
              Cl.principal(token),
              Cl.bool(true),
            ]),
          );
          ok(
            vaultCall(owner, "set-token-caps", [
              Cl.principal(token),
              Cl.uint(MAX_PER_TRADE),
              Cl.uint(MAX_PER_DAY),
            ]),
          );
        }
        ok(vaultCall(owner, "set-policy", [Cl.uint(0), Cl.uint(expiresAt)]));
        ok(
          vaultCall(owner, "allow-adapter", [
            Cl.principal(adapter),
            Cl.bool(true),
          ]),
        );
        ok(vaultCall(owner, "set-agent", [Cl.principal(agent)]));
        armOracle(
          simnet,
          owner,
          {
            price: ORACLE_PRICE,
            slippageBps: SLIPPAGE_BPS,
            maxAgeMs: 10n ** 15n,
          },
          vault,
        );
        expectAdapterEmpty();
      });
    }, 180_000);

    describe("constants and source", () => {
      const source = readFileSync(adapterPath, "utf8");
      const code = stripComments(source);

      function constant(name: string): string {
        const m = new RegExp(
          `\\(define-constant ${name} ('?[^\\s()]+|"[^"]*")\\)`,
        ).exec(code);
        expect(m, name).toBeTruthy();
        return m![1]!.replace(/^'/, "").replace(/^"(.*)"$/, "$1");
      }

      // Each `contract-call?` with the contract it targets and its arguments up to the next `)`.
      const calls = [
        ...code.matchAll(/\(contract-call\?\s+([^\s()]+)\s+([^\s()]+)([^)]*)/g),
      ].map((m) => ({
        target: m[1]!,
        fn: m[2]!,
        args: m[3]!.trim().split(/\s+/),
      }));

      it("the asset names are the tokens' define-fungible-token names", () => {
        expect(constant("SBTC-FT")).toBe(SBTC_FT);
        expect(constant("USDCX-FT")).toBe(USDCX_FT);
        expect(fungibleTokenNames(simnet.getContractSource(SBTC)!)).toContain(
          constant("SBTC-FT"),
        );
        expect(fungibleTokenNames(simnet.getContractSource(USDCX)!)).toContain(
          constant("USDCX-FT"),
        );
      });

      it("every contract-call? names the constants' principals as literals", () => {
        expect(constant("ROUTER")).toBe(ROUTER);
        expect(constant("POOL")).toBe(POOL);
        expect(constant("SBTC")).toBe(SBTC);
        expect(constant("USDCX")).toBe(USDCX);

        const routerCalls = calls.filter((c) => c.fn.includes("simple-multi"));
        expect(routerCalls.map((c) => c.fn).sort()).toStrictEqual([
          "swap-x-for-y-simple-multi",
          "swap-y-for-x-simple-multi",
        ]);
        for (const c of routerCalls) {
          expect(c.target).toBe(`'${ROUTER}`);
          expect(c.args.slice(0, 3)).toStrictEqual([
            `'${POOL}`,
            `'${SBTC}`,
            `'${USDCX}`,
          ]);
          expect(c.args.slice(3)).toStrictEqual([
            "amount-in",
            "min-out",
            "none",
          ]);
        }
        const tokenCalls = calls.filter((c) => !c.fn.includes("simple-multi"));
        expect(tokenCalls.map((c) => c.target).sort()).toStrictEqual(
          [
            ...Array<string>(3).fill(`'${SBTC}`),
            ...Array<string>(3).fill(`'${USDCX}`),
          ].sort(),
        );
        // No principal literal anywhere other than the four constants' values.
        const literals = new Set(code.match(/'S[0-9A-Z]+\.[a-z0-9-]+/g));
        expect([...literals].sort()).toStrictEqual(
          [ROUTER, POOL, SBTC, USDCX].map((p) => `'${p}`).sort(),
        );
      });

      it("has no data var, no map and exactly one public function", () => {
        expect(code).not.toMatch(/define-data-var/);
        expect(code).not.toMatch(/define-map/);
        expect(code.match(/\(define-public /g)).toHaveLength(1);
        expect(code).toMatch(/\(define-public \(swap\s/);
      });

      it("T2e (bitflow): the adapter calls only the router and its two tokens, never the vault", () => {
        expect(calls.length).toBeGreaterThan(0);
        expect(new Set(calls.map((c) => c.target))).toStrictEqual(
          new Set([`'${ROUTER}`, `'${SBTC}`, `'${USDCX}`]),
        );
        // No relative contract (such as .keelio-vault) and no trait-typed call.
        expect(code).not.toMatch(/contract-call\?\s+[^'\s]/);
        expect(code).not.toMatch(/keelio-vault/);
      });
    });

    describe("direct refusals", () => {
      it("refuses any pair but sBTC/USDCx with u200, before calling anything", () => {
        const before = snapshot();
        for (const [tokenIn, tokenOut] of [
          [SBTC, SBTC],
          [USDCX, USDCX],
          [SBTC, STX_WRAPPER],
          [STX_WRAPPER, USDCX],
        ] as const) {
          const call = directSwap(owner, tokenIn, tokenOut, SWAP_IN, 1n);
          expect(call.result, `${tokenIn} ${tokenOut}`).toStrictEqual(
            Cl.error(Cl.uint(200)),
          );
          expect(call.events).toStrictEqual([]);
        }
        expect(snapshot()).toStrictEqual(before);
      });

      it("refuses amount-in 0 with u201 and min-out 0 with u202", () => {
        const before = snapshot();
        const zeroIn = directSwap(owner, SBTC, USDCX, 0n, 1n);
        expect(zeroIn.result).toStrictEqual(Cl.error(Cl.uint(201)));
        expect(zeroIn.events).toStrictEqual([]);
        const zeroOut = directSwap(owner, SBTC, USDCX, SWAP_IN, 0n);
        expect(zeroOut.result).toStrictEqual(Cl.error(Cl.uint(202)));
        expect(zeroOut.events).toStrictEqual([]);
        expect(snapshot()).toStrictEqual(before);
      });

      it("debits contract-caller, not tx-sender: a forwarding contract gets u207", () => {
        const before = snapshot();
        const call = simnet.callPublicFn(
          caller,
          "forward",
          [
            Cl.principal(SBTC),
            Cl.principal(USDCX),
            Cl.uint(SWAP_IN),
            Cl.uint(1),
          ],
          owner,
        );
        expect(call.result).toStrictEqual(Cl.error(Cl.uint(207)));
        expect(ftTransfers(call.events)).toStrictEqual([]);
        expect(balance(SBTC, owner)).toBe(before.owner[0]);
        expect(snapshot()).toStrictEqual(before);
      });
    });

    describe("through the vault", () => {
      it("round trip: deposit, swap both ways, withdraw both ledgers", () => {
        expect([ledger(SBTC), ledger(USDCX)]).toStrictEqual([0n, 0n]);
        const walletBefore = [balance(SBTC, owner), balance(USDCX, owner)];
        expect(deposit(SBTC, DEPOSIT).result).toStrictEqual(
          Cl.ok(Cl.uint(DEPOSIT)),
        );

        // sBTC -> USDCx
        let vaultOut = balance(USDCX, vault);
        const toUsd = executeSwap(SBTC, USDCX, SWAP_IN, floor(SBTC, SWAP_IN));
        const usdReceived = okUint(toUsd);
        expect(usdReceived).toBeGreaterThan(0n);
        expect(balance(USDCX, vault) - vaultOut).toBe(usdReceived);
        expect([ledger(SBTC), ledger(USDCX)]).toStrictEqual([
          DEPOSIT - SWAP_IN,
          usdReceived,
        ]);
        expectAdapterEmpty();

        // USDCx -> sBTC, half of what came in
        const usdIn = usdReceived / 2n;
        vaultOut = balance(SBTC, vault);
        const toSbtc = executeSwap(USDCX, SBTC, usdIn, floor(USDCX, usdIn));
        const satsReceived = okUint(toSbtc);
        expect(satsReceived).toBeGreaterThan(0n);
        expect(balance(SBTC, vault) - vaultOut).toBe(satsReceived);
        const sbtcLedger = DEPOSIT - SWAP_IN + satsReceived;
        const usdLedger = usdReceived - usdIn;
        expect([ledger(SBTC), ledger(USDCX)]).toStrictEqual([
          sbtcLedger,
          usdLedger,
        ]);
        expectAdapterEmpty();

        console.log(
          `round trip: ${SWAP_IN} sats in -> ${usdReceived} USDCx out; ${usdIn} USDCx in -> ${satsReceived} sats out`,
        );
        console.log(
          "sBTC -> USDCx ft_transfer_events",
          ftTransfers(toUsd.events),
        );
        console.log(
          "USDCx -> sBTC ft_transfer_events",
          ftTransfers(toSbtc.events),
        );

        expect(withdraw(SBTC, sbtcLedger).result).toStrictEqual(
          Cl.ok(Cl.uint(0)),
        );
        expect(withdraw(USDCX, usdLedger).result).toStrictEqual(
          Cl.ok(Cl.uint(0)),
        );
        expect([ledger(SBTC), ledger(USDCX)]).toStrictEqual([0n, 0n]);
        expect([balance(SBTC, owner), balance(USDCX, owner)]).toStrictEqual([
          walletBefore[0]! - DEPOSIT + sbtcLedger,
          walletBefore[1]! + usdLedger,
        ]);
      });

      it("T2a (bitflow): the vault credits the rise in its own balance, which equals what the adapter returns", () => {
        expect(deposit(SBTC, DEPOSIT).result.type).toBe("ok");
        const ledgerBefore = ledger(USDCX);
        const vaultBefore = balance(USDCX, vault);
        const call = executeSwap(SBTC, USDCX, SWAP_IN, floor(SBTC, SWAP_IN));
        const received = okUint(call);
        // The adapter paid the vault exactly what it returned, in one transfer.
        expect(
          ftTransfers(call.events).filter((t) => t.recipient === vault),
        ).toStrictEqual([
          {
            asset_identifier: USDCX_ASSET,
            sender: adapter,
            recipient: vault,
            amount: String(received),
          },
        ]);
        expect(balance(USDCX, vault) - vaultBefore).toBe(received);
        expect(ledger(USDCX) - ledgerBefore).toBe(received);
        expectAdapterEmpty();
      });

      it("T2b (bitflow): the vault refuses min-out 0 with u125 before the adapter is called", () => {
        const before = snapshot();
        expect(before.ledgers[0]).toBeGreaterThanOrEqual(SWAP_IN);
        const call = executeSwap(SBTC, USDCX, SWAP_IN, 0n);
        expect(call.result).toStrictEqual(Cl.error(Cl.uint(125)));
        expect(call.events).toStrictEqual([]);
        expect(snapshot()).toStrictEqual(before);
      });

      it("T2c (bitflow): the vault sends exactly amount-in of token-in to the adapter and none of token-out", () => {
        for (const [tokenIn, tokenOut, asset] of [
          [SBTC, USDCX, SBTC_ASSET],
          [USDCX, SBTC, USDCX_ASSET],
        ] as const) {
          const amountIn = tokenIn === SBTC ? SWAP_IN : ledger(USDCX) / 2n;
          const call = executeSwap(
            tokenIn,
            tokenOut,
            amountIn,
            floor(tokenIn, amountIn),
          );
          expect(okUint(call)).toBeGreaterThan(0n);
          expect(
            ftTransfers(call.events).filter((t) => t.sender === vault),
          ).toStrictEqual([
            {
              asset_identifier: asset,
              sender: vault,
              recipient: adapter,
              amount: String(amountIn),
            },
          ]);
          expectAdapterEmpty();
        }
      });

      it("T2d (bitflow): the adapter's input goes only to the Bitflow pool", () => {
        for (const [tokenIn, tokenOut, assetIn, assetOut] of [
          [SBTC, USDCX, SBTC_ASSET, USDCX_ASSET],
          [USDCX, SBTC, USDCX_ASSET, SBTC_ASSET],
        ] as const) {
          const amountIn = tokenIn === SBTC ? SWAP_IN : ledger(USDCX) / 2n;
          const call = executeSwap(
            tokenIn,
            tokenOut,
            amountIn,
            floor(tokenIn, amountIn),
          );
          const received = okUint(call);
          const fromAdapter = ftTransfers(call.events).filter(
            (t) => t.sender === adapter,
          );
          // The router makes one transfer per bin it walks, each to the pool.
          const input = fromAdapter.filter(
            (t) => t.asset_identifier === assetIn,
          );
          expect(input.length).toBeGreaterThan(0);
          expect(new Set(input.map((t) => t.recipient))).toStrictEqual(
            new Set([POOL]),
          );
          expect(sum(input)).toBe(amountIn);
          // The only other transfer from the adapter is the payout to the vault.
          expect(
            fromAdapter.filter((t) => t.asset_identifier !== assetIn),
          ).toStrictEqual([
            {
              asset_identifier: assetOut,
              sender: adapter,
              recipient: vault,
              amount: String(received),
            },
          ]);
          expectAdapterEmpty();
        }
      });

      it("T2f (bitflow): a Bitflow error comes back as the adapter's u203, and as u117 from the vault", () => {
        const before = snapshot();
        const direct = directSwap(
          owner,
          SBTC,
          USDCX,
          SWAP_IN,
          UNREACHABLE_MIN_OUT,
        );
        expect(direct.result).toStrictEqual(Cl.error(Cl.uint(203)));
        expect(direct.events).toStrictEqual([]);
        const viaVault = executeSwap(SBTC, USDCX, SWAP_IN, UNREACHABLE_MIN_OUT);
        expect(viaVault.result).toStrictEqual(Cl.error(Cl.uint(117)));
        expect(viaVault.events).toStrictEqual([]);
        expect(snapshot()).toStrictEqual(before);
      });

      it("SDK: buildExecuteSwap covers every (sender, asset) a swap moves, in both directions", () => {
        const config: TxConfig = {
          vault,
          assetNames: { [SBTC]: SBTC_FT, [USDCX]: USDCX_FT },
          adapters: { [adapter]: { pool: POOL } },
        };
        for (const [tokenIn, tokenOut] of [
          [SBTC, USDCX],
          [USDCX, SBTC],
        ] as const) {
          const amountIn = tokenIn === SBTC ? SWAP_IN : ledger(USDCX) / 2n;
          expect(amountIn).toBeGreaterThan(0n);
          const built = buildExecuteSwap(config, {
            owner,
            adapter,
            tokenIn,
            tokenOut,
            amountIn,
            minOut: floor(tokenIn, amountIn),
          });
          expect(built.postConditionMode).toBe("deny");
          // Vault and adapter send tokenIn; pool and adapter send tokenOut.
          expect(built.postConditions).toHaveLength(4);
          const call = simnet.callPublicFn(
            `${built.contractAddress}.${built.contractName}`,
            built.functionName,
            built.functionArgs,
            agent,
          );
          expect(okUint(call)).toBeGreaterThan(0n);
          expectAdapterEmpty();
          const { failed, uncovered } = checkPostConditions(built, call.events);
          expect(failed).toStrictEqual([]);
          // The run shows no Bitflow fee transfer; a new one would show up here.
          expect(uncovered).toStrictEqual([]);
        }
      });
    });

    describe("direct swaps", () => {
      it("swaps both ways for a wallet and keeps nothing", () => {
        for (const [tokenIn, tokenOut] of [
          [SBTC, USDCX],
          [USDCX, SBTC],
        ] as const) {
          const amountIn =
            tokenIn === SBTC ? SWAP_IN : balance(USDCX, owner) / 2n;
          expect(amountIn).toBeGreaterThan(0n);
          const inBefore = balance(tokenIn, owner);
          const outBefore = balance(tokenOut, owner);
          const received = okUint(
            directSwap(owner, tokenIn, tokenOut, amountIn, 1n),
          );
          expect(received).toBeGreaterThan(0n);
          expect(balance(tokenIn, owner)).toBe(inBefore - amountIn);
          expect(balance(tokenOut, owner)).toBe(outBefore + received);
          expectAdapterEmpty();
        }
      });

      it("swaps across bins: more sBTC than the active bin can fill", () => {
        const binOf = () => {
          const r = simnet.callReadOnlyFn(
            POOL,
            "get-active-bin-id",
            [],
            deployer,
          ).result as ResponseOkCV;
          return BigInt((r.value as { value: bigint }).value);
        };
        const binBalances = (id: bigint) => {
          const r = simnet.callReadOnlyFn(
            POOL,
            "get-bin-balances",
            [Cl.uint(id + 500n)],
            deployer,
          ).result as ResponseOkCV;
          const t = r.value as TupleCV;
          return {
            x: uint(t.value["x-balance"]!),
            y: uint(t.value["y-balance"]!),
          };
        };
        // The rate in the active bin, from a small swap that stays in it.
        const probe = okUint(directSwap(owner, SBTC, USDCX, SWAP_IN, 1n));
        expectAdapterEmpty();
        const activeBin = binOf();
        // Selling sBTC (x) takes USDCx (y) out of the active bin. Sell half again as many sats as
        // its whole USDCx side is worth, so the swap must move on to the next bins.
        const { x: sbtcSide, y: usdcxSide } = binBalances(activeBin);
        // How this compares with the bin's sBTC side says nothing: an active bin can hold mostly
        // sBTC and little USDCx.
        const amountIn = (((usdcxSide * SWAP_IN) / probe) * 3n) / 2n;
        expect(amountIn).toBeGreaterThan(0n);
        expect(amountIn).toBeLessThanOrEqual(balance(SBTC, owner));

        const inBefore = balance(SBTC, owner);
        const call = directSwap(owner, SBTC, USDCX, amountIn, 1n);
        const received = okUint(call);
        const binAfter = binOf();
        console.log(
          `cross-bin: active bin ${activeBin} held ${sbtcSide} sats and ${usdcxSide} USDCx; swapped ${amountIn} sats -> ${received} USDCx; active bin now ${binAfter}`,
        );
        expect(received).toBeGreaterThan(usdcxSide);
        expect(balance(SBTC, owner)).toBe(inBefore - amountIn);
        // The router spent all of amount-in (in = amount-in): every bin's input went to the pool,
        // one transfer per bin, and they add up to amount-in.
        const input = ftTransfers(call.events).filter(
          (t) => t.sender === adapter && t.asset_identifier === SBTC_ASSET,
        );
        expect(input.length).toBeGreaterThan(1);
        expect(new Set(input.map((t) => t.recipient))).toStrictEqual(
          new Set([POOL]),
        );
        expect(sum(input)).toBe(amountIn);
        // The swap emptied the bin's USDCx side and moved the active bin down.
        expect(binAfter).toBeLessThan(activeBin);
        expectAdapterEmpty();
      });

      it("last: pays out only what the swap produced, never a donation sitting in the adapter", () => {
        // Someone sends USDCx to the adapter directly.
        const donation = balance(USDCX, owner) / 4n;
        expect(donation).toBeGreaterThan(0n);
        expect(
          simnet.callPublicFn(
            USDCX,
            "transfer",
            [
              Cl.uint(donation),
              Cl.principal(owner),
              Cl.principal(adapter),
              Cl.none(),
            ],
            owner,
          ).result,
        ).toStrictEqual(Cl.ok(Cl.bool(true)));
        const call = directSwap(owner, SBTC, USDCX, SWAP_IN, 1n);
        const received = okUint(call);
        const fromPool = ftTransfers(call.events).filter(
          (t) => t.sender === POOL,
        );
        expect(fromPool).toHaveLength(1);
        expect(BigInt(fromPool[0]!.amount)).toBe(received);
        // The donation stays, stranded; the swap's own tokens all left.
        expect(balance(USDCX, adapter)).toBe(donation);
        expect(balance(SBTC, adapter)).toBe(0n);
      });
    });
  },
);
