// The one interface between the dashboard and a chain. The forms, the review
// step and the panels use only `ChainSession`. simnet-chain.ts implements it
// on the in-page simnet. wallet-chain.ts implements it for testnet with the
// owner's wallet (submit) and a Stacks API client (read, journal). Neither
// signs or broadcasts: on testnet the owner's wallet does both.
import type { ClarityValue } from "@stacks/transactions";
import type {
  TxConfig,
  VaultCall,
} from "../../../packages/sdk/src/build-tx.js";
import type {
  VaultConfig,
  VaultRead,
} from "../../../packages/sdk/src/read-vault.js";

/** How to name and print one token. */
export interface TokenInfo {
  /** The token contract id. */
  id: string;
  /** For example "mock sBTC". */
  name: string;
  /** For example "sBTC". */
  symbol: string;
  decimals: number;
  /** What one base unit is called, plural: "sats" or "base units". */
  unit: string;
}

export interface AdapterInfo {
  id: string;
  name: string;
}

/** The vault's deploy constants and the names the pages print. */
export interface ChainConfig {
  /** For the SDK's transaction builders. */
  tx: TxConfig;
  /** For the SDK's `readVault`. */
  read: VaultConfig;
  tokens: readonly TokenInfo[];
  adapters: readonly AdapterInfo[];
  /** Principal to a short name, for example the vault id to "the vault". */
  labels: Readonly<Record<string, string>>;
}

/**
 * What happened to a submitted call.
 * - `ok`: the contract returned `(ok …)`.
 * - `refused`: the contract returned `(err …)` and changed nothing.
 * - `aborted`: a post-condition failed, so the transaction was rolled back.
 */
export type Receipt =
  | { status: "ok"; result: ClarityValue }
  | {
      status: "refused";
      result: ClarityValue;
      /**
       * Set when the chain reported the refusal as a failed post-condition
       * (nothing moved, so "sends exactly N" was not met), in its words.
       */
      postCondition?: string;
    }
  | { status: "aborted"; reason: string };

/** One print event of the vault contract (see docs/events.md). */
export interface JournalRecord {
  burnHeight: bigint;
  /** The print tuple. */
  value: ClarityValue;
}

export interface ChainRead {
  /** The SDK's `readVault` answer for the owner. */
  vault: VaultRead;
  burnHeight: bigint;
  /** `stacks-block-time * 1000` of the latest block. */
  nowMs: bigint;
  /** The owner's own balance of each token, outside the vault, by token id. */
  wallet: Readonly<Record<string, bigint>>;
}

/**
 * Where a submitted call is, on a chain that takes time to answer.
 * - `wallet`: the unsigned call is with the owner's wallet.
 * - `pending`: the wallet broadcast it as `txId`; it is not in a block yet.
 */
export type SubmitProgress =
  { stage: "wallet" } | { stage: "pending"; txId: string; waitedMs: number };

export interface ChainSession {
  /** Which chain this is. The page says so, and words its texts to match. */
  readonly kind: "simulation" | "testnet";
  /** The vault owner: the account every `submit` is sent from. */
  readonly owner: string;
  readonly config: ChainConfig;
  read(): Promise<ChainRead>;
  /**
   * Sends one call the SDK built, as the owner, with the call's own
   * post-conditions and mode. `onProgress` is told while the call waits.
   */
  submit(
    call: VaultCall,
    onProgress?: (progress: SubmitProgress) => void,
  ): Promise<Receipt>;
  /**
   * The journal, oldest first. It always holds every event of this owner.
   * `journalScope` says whether it also holds the other owners' events.
   */
  journal(): Promise<readonly JournalRecord[]>;
  /**
   * What `journal()` covers: `"contract"` for every owner's events of the
   * vault contract, `"owner"` for this owner's alone. The page says which
   * wherever it reports on a principal from the journal.
   */
  readonly journalScope: "contract" | "owner";
}
