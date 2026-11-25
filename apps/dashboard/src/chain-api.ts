// The Stacks API reads the testnet session needs beyond the SDK's read-only
// calls: the chain tip, an address's token balances, one transaction and a
// contract's events. It only reads. The response shapes are the ones recorded
// in tests/fixtures/stacks-api/extended.json; a reply is untrusted, so every
// field that is used is checked and every failure is a `ChainApiError`.
import { Cl, type ClarityValue } from "@stacks/transactions";
import {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  withDeadline,
} from "../../../packages/sdk/src/stacks-api.js";

/** The part of `fetch` the session uses. The global `fetch` satisfies it. */
export type ApiFetch = (
  url: string,
  init: {
    method: "GET" | "POST";
    headers?: Record<string, string>;
    body?: string;
    redirect: "error";
    /** Aborted when the request passes the timeout. */
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type ChainApiErrorCode = "HTTP_ERROR" | "MALFORMED_RESPONSE";

export class ChainApiError extends Error {
  readonly code: ChainApiErrorCode;

  constructor(code: ChainApiErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ChainApiError";
    this.code = code;
  }
}

/** One post-condition as the API prints it, flattened to one string. */
export type PostConditionText = string;

/** A transaction the API knows, in the mempool or in a block. */
export interface ApiTx {
  txId: string;
  /** `"pending"`, `"success"`, `"abort_by_response"`, … as the API says it. */
  status: string;
  /** `false` when the block it was in is no longer on the chain. */
  canonical: boolean;
  /** `"deny"` or `"allow"`, as the API says it. */
  postConditionMode: string;
  postConditions: PostConditionText[];
  /** Set for a contract call. */
  call: { contractId: string; functionName: string; argsHex: string[] } | null;
  /** Set once the transaction is in a block. */
  mined: {
    blockHeight: bigint;
    burnHeight: bigint;
    txIndex: bigint;
    result: ClarityValue;
    /** The node's words for a failed post-condition, else `null`. */
    vmError: string | null;
  } | null;
}

/** One print event of a contract, as the events endpoint lists it. */
export interface ApiPrintEvent {
  txId: string;
  eventIndex: bigint;
  value: ClarityValue;
}

export interface ChainApi {
  /** The node's `network_id`: 1 is mainnet. */
  networkId(): Promise<number>;
  /** The latest block's burn height and `stacks-block-time` in ms. */
  tip(): Promise<{ burnHeight: bigint; nowMs: bigint }>;
  /** Fungible balances by `ADDR.contract::asset`. A token never held is absent. */
  balances(address: string): Promise<Readonly<Record<string, bigint>>>;
  /** One transaction, or `null` while the API does not know its id. */
  tx(txId: string): Promise<ApiTx | null>;
  /**
   * One page of a contract's print events, newest first, and the page size
   * the API applied.
   */
  printEvents(
    contractId: string,
    offset: number,
  ): Promise<{ limit: number; events: ApiPrintEvent[]; count: number }>;
}

/** How long one read may take: the SDK client's default, 10 seconds. */
export const DEFAULT_API_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;

const HEX = /^0x([0-9a-fA-F]{2})+$/;
const TX_ID = /^0x[0-9a-f]{64}$/;
const DIGITS = /^[0-9]+$/;
const EVENTS_PAGE = 50;

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformed(path: string, why: string, cause?: unknown): ChainApiError {
  return new ChainApiError(
    "MALFORMED_RESPONSE",
    `malformed response from ${path}: ${why}`,
    cause,
  );
}

function reader(path: string) {
  const record = (value: unknown, name: string): Json => {
    if (!isRecord(value)) throw malformed(path, `${name} is not an object`);
    return value;
  };
  const text = (value: unknown, name: string): string => {
    if (typeof value !== "string") {
      throw malformed(path, `${name} is not a string`);
    }
    return value;
  };
  /** A whole number of 0 or more, from a JSON number. */
  const count = (value: unknown, name: string): bigint => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      throw malformed(path, `${name} is not a whole number`);
    return BigInt(value);
  };
  const list = (value: unknown, name: string): unknown[] => {
    if (!Array.isArray(value)) throw malformed(path, `${name} is not a list`);
    return value;
  };
  /** A `{ hex }` Clarity value, refused unless it round-trips. */
  const clarity = (value: unknown, name: string): ClarityValue => {
    const hex = record(value, name).hex;
    if (typeof hex !== "string" || !HEX.test(hex)) {
      throw malformed(path, `${name}.hex is not 0x-prefixed hex`);
    }
    let decoded: ClarityValue;
    let again: string;
    try {
      decoded = Cl.deserialize(hex);
      again = Cl.serialize(decoded);
    } catch (e) {
      throw malformed(path, `${name}.hex is not a Clarity value`, e);
    }
    if (again !== hex.slice(2).toLowerCase()) {
      throw malformed(path, `${name}.hex has missing or trailing bytes`);
    }
    return decoded;
  };
  return { record, text, count, list, clarity };
}

/**
 * One API post-condition as `principal|code|amount|asset`. The session builds
 * the same string from the SDK's post-condition and compares the two.
 */
function postConditionText(
  value: unknown,
  path: string,
  i: number,
): PostConditionText {
  const r = reader(path);
  const name = `post_conditions[${i}]`;
  const pc = r.record(value, name);
  const principal = r.record(pc.principal, `${name}.principal`);
  const who =
    principal.type_id === "principal_contract"
      ? `${r.text(principal.address, `${name}.principal.address`)}.${r.text(principal.contract_name, `${name}.principal.contract_name`)}`
      : principal.type_id === "principal_standard"
        ? r.text(principal.address, `${name}.principal.address`)
        : r.text(principal.type_id, `${name}.principal.type_id`);
  const type = r.text(pc.type, `${name}.type`);
  const code = r.text(pc.condition_code, `${name}.condition_code`);
  if (type !== "fungible") {
    // Keelio builds only fungible conditions; any other kind is kept as an
    // opaque string, so it can never equal one of them.
    return `${who}|${code}|${type}|${JSON.stringify(pc)}`;
  }
  const asset = r.record(pc.asset, `${name}.asset`);
  const assetId = `${r.text(asset.contract_address, `${name}.asset.contract_address`)}.${r.text(asset.contract_name, `${name}.asset.contract_name`)}::${r.text(asset.asset_name, `${name}.asset.asset_name`)}`;
  const amount = r.text(pc.amount, `${name}.amount`);
  return `${who}|${code}|${amount}|${assetId}`;
}

function parseTx(body: unknown, path: string): ApiTx {
  const r = reader(path);
  const tx = r.record(body, "body");
  const txId = r.text(tx.tx_id, "tx_id");
  const status = r.text(tx.tx_status, "tx_status");
  const postConditions = r
    .list(tx.post_conditions, "post_conditions")
    .map((pc, i) => postConditionText(pc, path, i));
  let call: ApiTx["call"] = null;
  if (tx.tx_type === "contract_call") {
    const c = r.record(tx.contract_call, "contract_call");
    call = {
      contractId: r.text(c.contract_id, "contract_call.contract_id"),
      functionName: r.text(c.function_name, "contract_call.function_name"),
      argsHex: r
        .list(c.function_args ?? [], "contract_call.function_args")
        .map((arg, i) =>
          r
            .text(
              r.record(arg, `function_args[${i}]`).hex,
              `function_args[${i}].hex`,
            )
            .toLowerCase(),
        ),
    };
  }
  let mined: ApiTx["mined"] = null;
  if (status !== "pending" && "block_height" in tx) {
    const vmError = tx.vm_error;
    if (vmError !== null && vmError !== undefined) r.text(vmError, "vm_error");
    mined = {
      blockHeight: r.count(tx.block_height, "block_height"),
      burnHeight: r.count(tx.burn_block_height, "burn_block_height"),
      txIndex: r.count(tx.tx_index, "tx_index"),
      result: r.clarity(tx.tx_result, "tx_result"),
      vmError: typeof vmError === "string" ? vmError : null,
    };
  }
  return {
    txId,
    status,
    // A mempool transaction has no `canonical` field.
    canonical: tx.canonical !== false,
    postConditionMode: r.text(tx.post_condition_mode, "post_condition_mode"),
    postConditions,
    call,
    mined,
  };
}

/**
 * A `ChainApi` over a Stacks API root. `baseUrl` has no trailing slash. Each
 * read, request and body together, fails with `HTTP_ERROR` after `timeoutMs`
 * and aborts its request, so a node that stops answering cannot hang the page.
 */
export function chainApi(
  baseUrl: string,
  fetch: ApiFetch,
  timeoutMs: number = DEFAULT_API_TIMEOUT_MS,
): ChainApi {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new RangeError(
      `timeoutMs must be a whole number of milliseconds from 1 to ${MAX_TIMEOUT_MS}`,
    );
  }

  /** The JSON body, or `null` for a 404 when `missingOk`. */
  const get = (path: string, missingOk = false): Promise<unknown> =>
    withDeadline(
      timeoutMs,
      () =>
        new ChainApiError(
          "HTTP_ERROR",
          `request to ${path} timed out after ${timeoutMs} ms`,
        ),
      async (signal) => {
        let response: Awaited<ReturnType<ApiFetch>>;
        try {
          response = await fetch(baseUrl + path, {
            method: "GET",
            redirect: "error",
            signal,
          });
        } catch (e) {
          throw new ChainApiError("HTTP_ERROR", `request to ${path} failed`, e);
        }
        if (missingOk && response.status === 404) return null;
        if (!response.ok) {
          throw new ChainApiError(
            "HTTP_ERROR",
            `HTTP ${response.status} from ${path}`,
          );
        }
        try {
          return await response.json();
        } catch (e) {
          throw malformed(path, "body is not JSON", e);
        }
      },
    );

  return {
    async networkId() {
      const path = "/v2/info";
      const r = reader(path);
      const info = r.record(await get(path), "body");
      return Number(r.count(info.network_id, "network_id"));
    },

    async tip() {
      const path = "/extended/v2/blocks/latest";
      const r = reader(path);
      const block = r.record(await get(path), "body");
      return {
        burnHeight: r.count(block.burn_block_height, "burn_block_height"),
        nowMs: r.count(block.block_time, "block_time") * 1000n,
      };
    },

    async balances(address) {
      const path = `/extended/v1/address/${encodeURIComponent(address)}/balances`;
      const r = reader(path);
      const body = r.record(await get(path), "body");
      const tokens = r.record(body.fungible_tokens, "fungible_tokens");
      const balances: Record<string, bigint> = {};
      for (const [asset, entry] of Object.entries(tokens)) {
        const balance = r.record(entry, `fungible_tokens[${asset}]`).balance;
        if (typeof balance !== "string" || !DIGITS.test(balance)) {
          throw malformed(path, `the balance of ${asset} is not digits`);
        }
        balances[asset] = BigInt(balance);
      }
      return balances;
    },

    async tx(txId) {
      if (!TX_ID.test(txId)) {
        throw new TypeError("txId must be 0x and 64 lower-case hex digits");
      }
      const path = `/extended/v1/tx/${txId}`;
      const body = await get(path, true);
      return body === null ? null : parseTx(body, path);
    },

    async printEvents(contractId, offset) {
      const path = `/extended/v1/contract/${encodeURIComponent(contractId)}/events?limit=${EVENTS_PAGE}&offset=${offset}`;
      const r = reader(path);
      const body = r.record(await get(path), "body");
      const limit = Number(r.count(body.limit, "limit"));
      if (limit < 1) throw malformed(path, "limit is 0");
      const results = r.list(body.results, "results");
      const events: ApiPrintEvent[] = [];
      results.forEach((entry, i) => {
        const name = `results[${i}]`;
        const event = r.record(entry, name);
        if (event.event_type !== "smart_contract_log") return;
        const log = r.record(event.contract_log, `${name}.contract_log`);
        if (log.topic !== "print" || log.contract_id !== contractId) return;
        const txId = r.text(event.tx_id, `${name}.tx_id`);
        if (!TX_ID.test(txId))
          throw malformed(path, `${name}.tx_id is not one`);
        events.push({
          txId,
          eventIndex: r.count(event.event_index, `${name}.event_index`),
          value: r.clarity(log.value, `${name}.contract_log.value`),
        });
      });
      return { limit, events, count: results.length };
    },
  };
}
