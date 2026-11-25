import type { JournalRecord } from "@keelio/mcp";
import {
  DEFAULT_TIMEOUT_MS,
  stacksApiClient,
  StacksApiError,
  withDeadline,
  type FetchLike,
} from "@keelio/sdk";
import { Cl, type ClarityValue } from "@stacks/transactions";
import type { MonitorChain, RefusedCall } from "./chain.js";

// A `MonitorChain` over the Stacks Blockchain API's read endpoints. It only
// reads: nothing here signs or broadcasts a transaction or takes a key.
//
// The reply shapes were taken from real replies of https://api.hiro.so,
// recorded in tests/fixtures/stacks-api/monitor.json. No Keelio vault is
// deployed, so this has never read one: see docs/monitoring.md.

/** The part of `fetch` the GET endpoints use. The global `fetch` fits. */
export type GetFetchLike = (
  url: string,
  init: {
    method: "GET";
    headers: Record<string, string>;
    redirect: "error";
    /** Aborted when the request passes `timeoutMs`. */
    signal: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface StacksApiChainOptions {
  /** The API root, for example `https://api.testnet.hiro.so`. */
  baseUrl: string;
  /** The simulated caller for read-only calls. Any valid principal. */
  sender: string;
  /** The vault's full contract id, `ADDR.name`. */
  vault: string;
  /** Injected; the chain never reads `globalThis.fetch`. */
  fetch: FetchLike & GetFetchLike;
  /** Entries per page, 1 to 50. Defaults to 50, the API's most. */
  pageSize?: number;
  /**
   * How long one request may take, request and body together, before the
   * poll fails with `HTTP_ERROR` and the request is aborted. Applies to the
   * GET endpoints and the read-only calls alike. A whole number of ms from 1
   * to the SDK's `MAX_TIMEOUT_MS`; its `DEFAULT_TIMEOUT_MS` when left out.
   */
  timeoutMs?: number;
}

const CONTRACT_ID = /^S[0-9A-Z]{20,45}\.[a-zA-Z]([a-zA-Z0-9]|[-_]){0,39}$/;
const TX_ID = /^0x[0-9a-f]{64}$/;
const HEX = /^0x([0-9a-fA-F]{2})+$/;
/** A stop for a reply that never ends: 5 million entries at 50 a page. */
const MAX_PAGES = 100_000;

type Json = Record<string, unknown>;

function malformed(path: string, why: string): StacksApiError {
  return new StacksApiError(
    "MALFORMED_RESPONSE",
    `malformed reply from ${path}: ${why}`,
  );
}

function object(value: unknown, path: string, what: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw malformed(path, `${what} is not an object`);
  }
  return value as Json;
}

function text(o: Json, key: string, path: string): string {
  const value = o[key];
  if (typeof value !== "string") throw malformed(path, `${key} is not text`);
  return value;
}

function int(o: Json, key: string, path: string): number {
  const value = o[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw malformed(path, `${key} is not a whole number`);
  }
  return value;
}

function clarity(value: unknown, path: string, what: string): ClarityValue {
  const hex = text(object(value, path, what), "hex", path);
  if (!HEX.test(hex)) throw malformed(path, `${what}.hex is not hex`);
  try {
    return Cl.deserialize(hex);
  } catch {
    throw malformed(path, `${what}.hex is not a Clarity value`);
  }
}

/** Where a transaction sits on the chain, for ordering and the journal. */
interface Placed {
  burnHeight: number;
  blockHeight: number;
  txIndex: number;
}

function placed(tx: Json, path: string): Placed {
  return {
    burnHeight: int(tx, "burn_block_height", path),
    blockHeight: int(tx, "block_height", path),
    txIndex: int(tx, "tx_index", path),
  };
}

function byChainOrder(a: Placed, b: Placed): number {
  return a.blockHeight - b.blockHeight || a.txIndex - b.txIndex;
}

/**
 * Reads a vault from a Stacks API. The journal comes from the contract's
 * print events, each placed by its transaction; the refusals from the failed
 * transactions whose contract call names the vault.
 *
 * Every poll reads both lists from the start, so the cost grows with the
 * vault's history. Entries are ordered by block height, then transaction
 * index, then event index.
 */
export function stacksApiChain(options: StacksApiChainOptions): MonitorChain {
  const { vault, fetch } = options;
  const pageSize = options.pageSize ?? 50;
  if (typeof vault !== "string" || !CONTRACT_ID.test(vault)) {
    throw new StacksApiError(
      "INVALID_PRINCIPAL",
      "vault must be a contract id ADDR.name",
    );
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) {
    throw new StacksApiError("INVALID_OPTION", "pageSize must be 1 to 50");
  }
  // Also checks baseUrl, sender, fetch and timeoutMs.
  const reader = stacksApiClient(options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseUrl = options.baseUrl.endsWith("/")
    ? options.baseUrl.slice(0, -1)
    : options.baseUrl;

  /** One GET under the deadline, so a silent node cannot stall a poll. */
  const get = (path: string): Promise<Json> =>
    withDeadline(
      timeoutMs,
      () =>
        new StacksApiError(
          "HTTP_ERROR",
          `request to ${path} timed out after ${timeoutMs} ms`,
        ),
      async (signal) => {
        let response: Awaited<ReturnType<GetFetchLike>>;
        try {
          response = await fetch(baseUrl + path, {
            method: "GET",
            headers: { accept: "application/json" },
            redirect: "error",
            signal,
          });
        } catch (e) {
          throw new StacksApiError("HTTP_ERROR", `request to ${path} failed`, {
            cause: e,
          });
        }
        if (!response.ok) {
          throw new StacksApiError(
            "HTTP_ERROR",
            `HTTP ${response.status} from ${path}`,
            { status: response.status },
          );
        }
        let reply: unknown;
        try {
          reply = await response.json();
        } catch {
          throw malformed(path, "body is not JSON");
        }
        return object(reply, path, "body");
      },
    );

  /** Every entry of a `limit`/`offset` list, in the API's order. */
  const pages = async (path: string): Promise<Json[]> => {
    const out: Json[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const at = `${path}?limit=${pageSize}&offset=${page * pageSize}`;
      const results = (await get(at)).results;
      if (!Array.isArray(results)) throw malformed(at, "results is not a list");
      for (const entry of results) out.push(object(entry, at, "an entry"));
      if (results.length < pageSize) return out;
    }
    throw malformed(path, `more than ${MAX_PAGES} pages`);
  };

  const latestBlock = async (): Promise<Json> => {
    const path = "/extended/v2/blocks?limit=1";
    const results = (await get(path)).results;
    if (!Array.isArray(results) || results.length !== 1) {
      throw malformed(path, "results is not one block");
    }
    return object(results[0], path, "the block");
  };

  // A confirmed transaction's place does not change, short of a reorg.
  const places = new Map<string, Placed | null>();
  /** The place of a canonical, successful transaction, else `null`. */
  const placeOf = async (txId: string): Promise<Placed | null> => {
    const known = places.get(txId);
    if (known !== undefined) return known;
    const path = `/extended/v1/tx/${txId}?event_limit=0`;
    const tx = await get(path);
    const place =
      tx.canonical === true && text(tx, "tx_status", path) === "success"
        ? placed(tx, path)
        : null;
    places.set(txId, place);
    return place;
  };

  return {
    vault,
    callReadOnly: reader.callReadOnly,
    async burnHeight() {
      return BigInt(int(await latestBlock(), "burn_block_height", "blocks"));
    },
    async blockTimeMs() {
      return BigInt(int(await latestBlock(), "block_time", "blocks")) * 1000n;
    },
    async vaultEvents() {
      const path = `/extended/v1/contract/${vault}/events`;
      const found: (Placed & { eventIndex: number; value: ClarityValue })[] =
        [];
      const seen = new Set<string>();
      for (const entry of await pages(path)) {
        if (entry.event_type !== "smart_contract_log") continue;
        const log = object(entry.contract_log, path, "contract_log");
        if (log.contract_id !== vault || log.topic !== "print") continue;
        const txId = text(entry, "tx_id", path);
        if (!TX_ID.test(txId)) throw malformed(path, "tx_id is not a tx id");
        const eventIndex = int(entry, "event_index", path);
        // The list is newest first and read by offset: an entry that arrives
        // between two pages pushes one already read onto the next page. A
        // repeat would be alerted twice and would move the cursor past an
        // entry the next poll then skips.
        const key = `${txId}:${eventIndex}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const place = await placeOf(txId);
        if (place === null) continue;
        found.push({
          ...place,
          eventIndex,
          value: clarity(log.value, path, "contract_log.value"),
        });
      }
      found.sort((a, b) => byChainOrder(a, b) || a.eventIndex - b.eventIndex);
      return found.map((e): JournalRecord => ({
        burnHeight: BigInt(e.burnHeight),
        value: e.value,
      }));
    },
    async vaultRefusals() {
      const path = `/extended/v1/address/${vault}/transactions`;
      const found: (Placed & { call: RefusedCall })[] = [];
      // As in `vaultEvents`: a page can repeat an entry of the one before.
      const seen = new Set<string>();
      for (const tx of await pages(path)) {
        if (tx.tx_type !== "contract_call" || tx.canonical !== true) continue;
        const status = text(tx, "tx_status", path);
        if (
          status !== "abort_by_response" &&
          status !== "abort_by_post_condition"
        ) {
          continue;
        }
        const call = object(tx.contract_call, path, "contract_call");
        if (call.contract_id !== vault) continue;
        const args = call.function_args;
        if (!Array.isArray(args)) {
          throw malformed(path, "function_args is not a list");
        }
        const txId = text(tx, "tx_id", path);
        if (seen.has(txId)) continue;
        seen.add(txId);
        const place = placed(tx, path);
        found.push({
          ...place,
          call: {
            burnHeight: BigInt(place.burnHeight),
            sender: text(tx, "sender_address", path),
            functionName: text(call, "function_name", path),
            args: args.map((a) => clarity(a, path, "an argument")),
            reason:
              status === "abort_by_response" ? "response" : "post-condition",
            result: clarity(tx.tx_result, path, "tx_result"),
            txId,
          },
        });
      }
      found.sort(byChainOrder);
      return found.map((f) => f.call);
    },
  };
}
