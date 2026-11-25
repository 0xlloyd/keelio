// The Bitflow world on the remote-data simnet, shared by
// tests/bitflow-adapter.test.ts, tests/demo-bitflow.test.ts and
// scripts/demo-bitflow.ts: the mainnet principals bitflow-adapter names, and
// the copy of keelio-vault a Bitflow deployment would make.
//
// Everything here runs in the local simnet of tests/bitflow-remote/Clarinet.toml,
// which reads mainnet contract state through Hiro's public API (read only).
// Nothing is signed or broadcast and no key exists for any mainnet principal.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { initSimnet } from "@stacks/clarinet-sdk";
import { Cl, type ClarityValue } from "@stacks/transactions";
import { vaultClarityVersion } from "../tests/vault-clarity-version.js";

type Simnet = Awaited<ReturnType<typeof initSimnet>>;

/** The remote-data simnet's manifest, relative to the repo root. */
export const BITFLOW_MANIFEST = "tests/bitflow-remote/Clarinet.toml";

export const ROUTER =
  "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-swap-router-v-1-2";
export const POOL =
  "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-sbtc-usdcx-v-1-bps-10";
export const SBTC = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
export const USDCX = "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx";
export const SBTC_FT = "sbtc-token";
export const USDCX_FT = "usdcx-token";
/** A mainnet sBTC holder. The simnet sends a local transfer as it; no key for it exists here. */
export const DONOR = "SPMN217717VVAC8VABB76PXX016FVHGDD87HVC6K";

/** The contract name the vault copy is deployed under. */
export const BITFLOW_VAULT_NAME = "keelio-vault-bitflow";

const vaultPath = new URL("../contracts/keelio-vault.clar", import.meta.url);

// Five of the seven lines of the vault's deploy configuration block, and what a Bitflow deployment
// puts there. ORACLE and PRICE-SCALE stay as they are: the copy reads .mock-oracle, and USDCx has
// 6 decimals like mock-usd.
export const DEPLOY_CONFIG: readonly (readonly [string, string])[] = [
  [
    "(define-constant ALLOWED-TOKEN .mock-sbtc)",
    `(define-constant ALLOWED-TOKEN '${SBTC})`,
  ],
  [
    '(define-constant ALLOWED-TOKEN-FT "mock-sbtc")',
    `(define-constant ALLOWED-TOKEN-FT "${SBTC_FT}")`,
  ],
  [
    "(define-constant QUOTE-TOKEN .mock-usd)",
    `(define-constant QUOTE-TOKEN '${USDCX})`,
  ],
  [
    '(define-constant QUOTE-TOKEN-FT "mock-usd")',
    `(define-constant QUOTE-TOKEN-FT "${USDCX_FT}")`,
  ],
  [
    "(define-constant ALLOWED-ADAPTER .mock-dex)",
    "(define-constant ALLOWED-ADAPTER .bitflow-adapter)",
  ],
];

/** The source of contracts/keelio-vault.clar as it is on disk. */
export function vaultSource(): string {
  return readFileSync(vaultPath, "utf8");
}

/**
 * `source` (default: contracts/keelio-vault.clar) with the five DEPLOY_CONFIG
 * lines rewritten. Throws if a line to rewrite is not there.
 */
export function bitflowVaultSource(source: string = vaultSource()): string {
  let copy = source;
  for (const [from, to] of DEPLOY_CONFIG) {
    if (!copy.includes(from))
      throw new Error(`keelio-vault.clar has no line ${from}`);
    copy = copy.replace(from, to);
  }
  return copy;
}

/**
 * Deploys the vault copy on the simnet as the deployer, at keelio-vault's own
 * Clarity version. Returns the deploy result; the caller checks it.
 */
export function deployBitflowVault(
  simnet: Simnet,
  source: string = bitflowVaultSource(),
): ClarityValue {
  return simnet.deployContract(
    BITFLOW_VAULT_NAME,
    source,
    { clarityVersion: vaultClarityVersion() as 1 | 2 | 3 | 4 },
    simnet.deployer,
  ).result;
}

/** A simnet-local sBTC transfer of `amount` sats to `recipient`, sent as DONOR. */
export function fundSbtc(
  simnet: Simnet,
  recipient: string,
  amount: bigint,
): ClarityValue {
  return simnet.callPublicFn(
    SBTC,
    "transfer",
    [Cl.uint(amount), Cl.principal(DONOR), Cl.principal(recipient), Cl.none()],
    DONOR,
  ).result;
}

/** `initial_height` of the remote-data manifest: the mainnet height every run reads. */
export function pinnedHeight(): bigint {
  const manifest = readFileSync(
    fileURLToPath(new URL(`../${BITFLOW_MANIFEST}`, import.meta.url)),
    "utf8",
  );
  const match = /^\s*initial_height\s*=\s*(\d+)/m.exec(manifest);
  if (!match) throw new Error(`${BITFLOW_MANIFEST} has no initial_height`);
  return BigInt(match[1]!);
}
