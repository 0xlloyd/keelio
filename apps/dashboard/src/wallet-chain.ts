// `ChainSession` for testnet: the vault is read through a Stacks API, and
// each call the SDK built is handed, unsigned and unchanged, to the owner's
// wallet. Nothing here signs, broadcasts or holds a key: the wallet does
// that, and this file then follows the transaction the wallet reports.
//
// It has no DOM and takes its wallet, `fetch` and clock as arguments, so the
// tests run it in Node with fakes. It has never been run against a real
// wallet or a deployed vault.
import { Cl, type ClarityValue } from "@stacks/transactions";
import type { VaultCall } from "../../../packages/sdk/src/build-tx.js";
import { readVault } from "../../../packages/sdk/src/read-vault.js";
import { stacksApiClient } from "../../../packages/sdk/src/stacks-api.js";
import type {
  ChainRead,
  ChainSession,
  JournalRecord,
  Receipt,
  SubmitProgress,
} from "./chain.js";
import {
  chainApi,
  type ApiFetch,
  type ApiTx,
  type PostConditionText,
} from "./chain-api.js";
import {
  assertTestnet,
  chainConfigOf,
  isMainnetPrincipal,
  isTestnetAddress,
  MAINNET_NETWORK_ID,
  MainnetRefusedError,
  type TestnetConfig,
} from "./testnet-config.js";

/**
 * The owner's wallet, as much of it as the session needs. The real one is
 * connect-wallet.ts over @stacks/connect; tests pass a fake.
 */
export interface Wallet {
  /** Asks the wallet for the owner's Stacks address on `network`. */
  connect(network: "testnet"): Promise<string>;
  /**
   * Hands the wallet one unsigned call: its function, arguments,
   * post-conditions and Deny mode exactly as the SDK built them. The wallet
   * shows it to the owner, signs and broadcasts it, and this resolves to the
   * transaction id. It rejects if the owner declines.
   */
  requestContractCall(
    call: VaultCall,
    context: { network: "testnet"; owner: string },
  ): Promise<string>;
}

export interface WalletChainOptions {
  config: TestnetConfig;
  wallet: Wallet;
  /** Injected; the session never reads `globalThis.fetch`. */
  fetch: ApiFetch;
  /** Waits between two looks at a transaction. Injected so tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait between two looks. */
  pollMs?: number;
  /** How long to follow a transaction before giving up with its id. */
  timeoutMs?: number;
}

export type WalletChainErrorCode =
  | "WALLET_REJECTED"
  | "BAD_ADDRESS"
  | "BAD_TX_ID"
  | "CALL_CHANGED"
  | "TX_TIMEOUT"
  | "TX_FAILED"
  | "JOURNAL_TOO_LONG";

export class WalletChainError extends Error {
  readonly code: WalletChainErrorCode;
  /** The transaction the wallet broadcast, when there is one. */
  readonly txId: string | null;

  constructor(
    code: WalletChainErrorCode,
    message: string,
    extra: { txId?: string; cause?: unknown } = {},
  ) {
    super(message, "cause" in extra ? { cause: extra.cause } : undefined);
    this.name = "WalletChainError";
    this.code = code;
    this.txId = extra.txId ?? null;
  }
}

export const DEFAULT_POLL_MS = 5_000;
export const DEFAULT_TIMEOUT_MS = 10 * 60_000;
/** The journal stops with an error past this many pages of events. */
const MAX_EVENT_PAGES = 200;

const TX_ID = /^(0x)?[0-9a-fA-F]{64}$/;

/** The API's name for each comparator the SDK builds. */
const CONDITION_CODE: Readonly<Record<string, string>> = {
  eq: "sent_equal_to",
  gte: "sent_greater_than_or_equal_to",
  lte: "sent_less_than_or_equal_to",
};

/**
 * The SDK's post-condition as the string chain-api.ts makes of the API's.
 * A kind or comparator the SDK never builds becomes a string no API
 * condition equals, so it is reported as a difference, not passed over.
 */
function expectedPostCondition(
  pc: VaultCall["postConditions"][number],
): PostConditionText {
  const code = CONDITION_CODE[pc.condition];
  if (pc.type !== "ft-postcondition" || code === undefined) {
    return `not comparable: ${JSON.stringify(pc)}`;
  }
  return `${pc.address}|${code}|${pc.amount.toString()}|${pc.asset}`;
}

/**
 * How the transaction the wallet broadcast differs from the call the owner
 * reviewed, or `null` when contract, function, arguments, post-conditions
 * and mode are all the same.
 */
export function callDifference(call: VaultCall, tx: ApiTx): string | null {
  const contractId = `${call.contractAddress}.${call.contractName}`;
  if (tx.call === null) return "it is not a contract call";
  if (tx.call.contractId !== contractId) {
    return `it calls ${tx.call.contractId}, not ${contractId}`;
  }
  if (tx.call.functionName !== call.functionName) {
    return `it calls ${tx.call.functionName}, not ${call.functionName}`;
  }
  const args = call.functionArgs.map((arg) => "0x" + Cl.serialize(arg));
  if (
    args.length !== tx.call.argsHex.length ||
    args.some((arg, i) => arg !== tx.call!.argsHex[i])
  ) {
    return "its arguments are not the reviewed ones";
  }
  if (tx.postConditionMode !== call.postConditionMode) {
    return `its post-condition mode is ${tx.postConditionMode}, not ${call.postConditionMode}`;
  }
  const expected = call.postConditions.map(expectedPostCondition);
  if (
    expected.length !== tx.postConditions.length ||
    expected.some((pc, i) => pc !== tx.postConditions[i])
  ) {
    return `it carries ${tx.postConditions.length} post-condition(s) that are not the ${expected.length} reviewed`;
  }
  return null;
}

function principalOf(value: ClarityValue): string | null {
  return value.type === "address" || value.type === "contract"
    ? Cl.prettyPrint(value).replace(/^'/, "")
    : null;
}

interface PlacedRecord {
  record: JournalRecord;
  /** Block height, index in the block, index in the transaction. */
  place: [bigint, bigint, bigint];
}

/**
 * Starts a testnet session: refuses mainnet, asks the wallet for the owner's
 * address and returns the owner's `ChainSession`.
 *
 * Mainnet is refused three times: a config that names it (before any request
 * is made), a node whose `network_id` is mainnet's, and a wallet that answers
 * with a mainnet address.
 */
export async function startWalletChain(
  options: WalletChainOptions,
): Promise<ChainSession> {
  const { config, wallet, fetch } = options;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  assertTestnet(config);
  const baseUrl = config.apiUrl.replace(/\/$/, "");
  const api = chainApi(baseUrl, fetch);
  if ((await api.networkId()) === MAINNET_NETWORK_ID) {
    throw new MainnetRefusedError(
      `the node at ${config.apiUrl} reports mainnet's network id`,
    );
  }

  let owner: string;
  try {
    owner = await wallet.connect(config.network);
  } catch (error) {
    throw new WalletChainError(
      "WALLET_REJECTED",
      `The wallet did not connect: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (typeof owner === "string" && isMainnetPrincipal(owner)) {
    throw new MainnetRefusedError(
      `the wallet answered with the mainnet address ${owner}; switch the wallet to testnet`,
    );
  }
  if (typeof owner !== "string" || !isTestnetAddress(owner)) {
    throw new WalletChainError(
      "BAD_ADDRESS",
      `The wallet did not give a testnet Stacks address: ${String(owner)}`,
    );
  }

  const chain = chainConfigOf(config, owner);
  const client = stacksApiClient({ baseUrl, sender: owner, fetch });

  const read = async (): Promise<ChainRead> => {
    const vault = await readVault(client, chain.read, owner);
    const tip = await api.tip();
    const held = await api.balances(owner);
    const walletBalances: Record<string, bigint> = {};
    for (const token of config.tokens) {
      const asset = `${token.id}::${token.assetName}`;
      // The API lists only tokens the address has held.
      walletBalances[token.id] = Object.hasOwn(held, asset) ? held[asset]! : 0n;
    }
    return {
      vault,
      burnHeight: tip.burnHeight,
      nowMs: tip.nowMs,
      wallet: walletBalances,
    };
  };

  const receiptOf = (tx: ApiTx, txId: string): Receipt => {
    const mined = tx.mined;
    if (mined === null) throw new Error("receiptOf needs a mined transaction");
    const { result, vmError } = mined;
    if (tx.status === "success" && result.type === "ok") {
      return { status: "ok", result };
    }
    if (tx.status === "abort_by_response" && result.type === "err") {
      return { status: "refused", result };
    }
    if (tx.status === "abort_by_post_condition") {
      const reason = vmError ?? "Post-condition check failure";
      // The contract refused, nothing moved, so "sends exactly N" failed too.
      return result.type === "err"
        ? { status: "refused", result, postCondition: reason }
        : { status: "aborted", reason };
    }
    throw new WalletChainError(
      "TX_FAILED",
      `Transaction ${txId} ended with the status ${tx.status}, which this page does not know. Look it up by its id.`,
      { txId },
    );
  };

  const submit = async (
    call: VaultCall,
    onProgress?: (progress: SubmitProgress) => void,
  ): Promise<Receipt> => {
    onProgress?.({ stage: "wallet" });
    let answer: string;
    try {
      // The SDK's object goes to the wallet as it is: nothing is rebuilt.
      answer = await wallet.requestContractCall(call, {
        network: config.network,
        owner,
      });
    } catch (error) {
      throw new WalletChainError(
        "WALLET_REJECTED",
        `Not sent. The wallet did not sign the call: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (typeof answer !== "string" || !TX_ID.test(answer)) {
      throw new WalletChainError(
        "BAD_TX_ID",
        `The wallet did not return a transaction id, so the call cannot be followed. It answered: ${String(answer).slice(0, 80)}`,
      );
    }
    const txId = "0x" + answer.replace(/^0x/, "").toLowerCase();

    let checked = false;
    for (let waitedMs = 0; ; waitedMs += pollMs) {
      const tx = await api.tx(txId);
      if (tx !== null && !checked) {
        const difference = callDifference(call, tx);
        if (difference !== null) {
          throw new WalletChainError(
            "CALL_CHANGED",
            `Transaction ${txId} is not the call you reviewed: ${difference}. The wallet changed the call, so do not rely on its post-conditions. Look the transaction up by its id.`,
            { txId },
          );
        }
        checked = true;
      }
      if (tx !== null && tx.mined !== null && tx.canonical) {
        return receiptOf(tx, txId);
      }
      if (tx !== null && tx.status !== "pending" && tx.mined === null) {
        // Not pending and not in a block: the mempool let go of it.
        throw new WalletChainError(
          "TX_FAILED",
          `Transaction ${txId} left the mempool with the status ${tx.status} and is in no block. Nothing changed.`,
          { txId },
        );
      }
      if (waitedMs >= timeoutMs) {
        throw new WalletChainError(
          "TX_TIMEOUT",
          `Transaction ${txId} was broadcast but is not in a block after ${Math.round(timeoutMs / 1000)} seconds. It may still be mined: look it up by its id, then read the vault again.`,
          { txId },
        );
      }
      onProgress?.({ stage: "pending", txId, waitedMs });
      await sleep(pollMs);
    }
  };

  // Events already placed, by `txId:eventIndex`. `null` marks one that is not
  // this owner's or whose transaction did not succeed.
  const known = new Map<string, PlacedRecord | null>();
  const txPlaces = new Map<
    string,
    { block: bigint; index: bigint; burn: bigint } | null
  >();

  const placeOfTx = async (txId: string) => {
    const cached = txPlaces.get(txId);
    if (cached !== undefined) return cached;
    const tx = await api.tx(txId);
    const place =
      tx !== null &&
      tx.mined !== null &&
      tx.canonical &&
      tx.status === "success"
        ? {
            block: tx.mined.blockHeight,
            index: tx.mined.txIndex,
            burn: tx.mined.burnHeight,
          }
        : null;
    txPlaces.set(txId, place);
    return place;
  };

  // Set once a read has reached the oldest event. Until then a known event
  // does not mean the older pages were read: an earlier read may have failed
  // part-way, and stopping at it would leave the journal short for good.
  let reachedOldest = false;

  /**
   * Reads the vault contract's print events, newest first, until a page
   * holds one already known, then returns this owner's, oldest first.
   */
  const journal = async (): Promise<readonly JournalRecord[]> => {
    let offset = 0;
    for (let page = 0; ; page++) {
      if (page >= MAX_EVENT_PAGES) {
        throw new WalletChainError(
          "JOURNAL_TOO_LONG",
          `The vault contract has more events than this page reads (${offset}).`,
        );
      }
      const { limit, events, count } = await api.printEvents(
        config.vault,
        offset,
      );
      let caughtUp = false;
      for (const event of events) {
        const key = `${event.txId}:${event.eventIndex}`;
        if (known.has(key)) {
          caughtUp = true;
          continue;
        }
        const who =
          event.value.type === "tuple" && event.value.value.owner !== undefined
            ? principalOf(event.value.value.owner)
            : null;
        if (who !== owner) {
          known.set(key, null);
          continue;
        }
        const place = await placeOfTx(event.txId);
        known.set(
          key,
          place === null
            ? null
            : {
                record: { burnHeight: place.burn, value: event.value },
                place: [place.block, place.index, event.eventIndex],
              },
        );
      }
      if (count < limit) {
        reachedOldest = true;
        break;
      }
      if (caughtUp && reachedOldest) break;
      offset += count;
    }
    const placed = [...known.values()].filter((entry) => entry !== null);
    placed.sort((a, b) => {
      for (let i = 0; i < 3; i++) {
        if (a.place[i]! !== b.place[i]!) {
          return a.place[i]! < b.place[i]! ? -1 : 1;
        }
      }
      return 0;
    });
    return placed.map((entry) => entry.record);
  };

  return {
    kind: "testnet",
    owner,
    config: chain,
    read,
    submit,
    journal,
    // `journal` keeps this owner's events and drops everyone else's.
    journalScope: "owner",
  };
}
