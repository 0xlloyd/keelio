import { Cl, isClarityName, type ClarityValue } from "@stacks/transactions";
import { isNodeContractId, principalProblem } from "./principal.js";
import type { ReadOnlyClient } from "./read-vault.js";
import { StacksApiError, type StacksApiErrorCode } from "./stacks-api-error.js";

// A `ReadOnlyClient` backed by a Stacks node's read-only call endpoint. It
// only reads: nothing here signs or broadcasts a transaction or takes a key.
// The node's reply is untrusted, so every path from it is shape-checked and
// every failure is a `StacksApiError`.

/** The part of `fetch` the client uses. The global `fetch` satisfies it. */
export type FetchLike = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    redirect: "error";
    /** Aborted when the request passes `timeoutMs`. */
    signal: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface StacksApiClientOptions {
  /** The node or API root, for example `https://api.testnet.hiro.so`. */
  baseUrl: string;
  /** The simulated caller the read-only endpoint requires. No default. */
  sender: string;
  /** Injected; the client never reads `globalThis.fetch`. */
  fetch: FetchLike;
  /**
   * How long one read may take, request and body together, before it fails
   * with `HTTP_ERROR` and the request is aborted. A whole number of ms from 1
   * to `MAX_TIMEOUT_MS`; `DEFAULT_TIMEOUT_MS` when left out.
   */
  timeoutMs?: number;
}

/** The `timeoutMs` a client uses when none is given. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * The longest `timeoutMs`: `setTimeout` fires at once for a longer delay, so
 * every read would time out.
 */
export const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export { StacksApiError, type StacksApiErrorCode };

const CALL_READ_PATH = "/v2/contracts/call-read";
const MAX_DETAIL = 200;
const HEX = /^0x([0-9a-fA-F]{2})+$/;

/** Splits `ADDR.name` at its first `.`, or returns `null` if it is not one. */
function splitContractId(value: unknown): [string, string] | null {
  if (typeof value !== "string" || !isNodeContractId(value)) return null;
  const dot = value.indexOf(".");
  return [value.slice(0, dot), value.slice(dot + 1)];
}

function isPrincipal(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return value.includes(".")
    ? isNodeContractId(value)
    : principalProblem(value, false) === null;
}

function checkBaseUrl(value: unknown): string {
  const fail = (why: string): never => {
    throw new StacksApiError("INVALID_OPTION", `baseUrl ${why}`);
  };
  if (typeof value !== "string") return fail("must be a string");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail("is not a URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    fail("must use http: or https:");
  }
  // A query or fragment would swallow the path appended after it.
  if (url.search !== "" || url.hash !== "") {
    fail("must not have a query or fragment");
  }
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function malformed(why: string, cause?: unknown): StacksApiError {
  return new StacksApiError(
    "MALFORMED_RESPONSE",
    `malformed call-read response: ${why}`,
    cause === undefined ? {} : { cause },
  );
}

/** Decodes a call-read `result`, refusing anything that does not round-trip. */
function decode(result: unknown): ClarityValue {
  if (typeof result !== "string" || !HEX.test(result)) {
    throw malformed("result is not 0x-prefixed hex");
  }
  let value: ClarityValue;
  try {
    value = Cl.deserialize(result);
  } catch (e) {
    throw malformed("result is not a Clarity value", e);
  }
  // The decoder reads past the end of short input and ignores trailing bytes,
  // so only a value that serialises back to the same bytes is accepted.
  let again: string;
  try {
    again = Cl.serialize(value);
  } catch (e) {
    throw malformed("result is not a Clarity value", e);
  }
  if (again !== result.slice(2).toLowerCase()) {
    throw malformed("result has missing or trailing bytes");
  }
  return value;
}

/**
 * Runs `run` under one deadline. After `timeoutMs` the signal handed to `run`
 * is aborted and the promise rejects with `timedOut()`, even if `run` ignores
 * the signal and never settles. Shared by every Stacks API reader in the
 * repo, so none of them can hang on a node that stops answering.
 */
export async function withDeadline<T>(
  timeoutMs: number,
  timedOut: () => Error,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(timedOut());
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** A `ReadOnlyClient` that calls a Stacks node's read-only endpoint. */
export function stacksApiClient(
  options: StacksApiClientOptions,
): ReadOnlyClient {
  const baseUrl = checkBaseUrl(options.baseUrl);
  const { sender, fetch } = options;
  if (!isPrincipal(sender)) {
    throw new StacksApiError(
      "INVALID_PRINCIPAL",
      "sender must be a Stacks address or contract id ADDR.name",
    );
  }
  if (typeof fetch !== "function") {
    throw new StacksApiError("INVALID_OPTION", "fetch must be a function");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new StacksApiError(
      "INVALID_OPTION",
      `timeoutMs must be a whole number of milliseconds from 1 to ${MAX_TIMEOUT_MS}`,
    );
  }

  /**
   * Sends one call-read request and returns its parsed JSON body. Request
   * and body share one deadline: the signal stops a real fetch, and the race
   * stops a fetch that ignores it.
   */
  const post = (path: string, body: string): Promise<unknown> =>
    withDeadline(
      timeoutMs,
      () =>
        new StacksApiError(
          "HTTP_ERROR",
          `request to ${path} timed out after ${timeoutMs} ms`,
        ),
      async (signal) => {
        let response: Awaited<ReturnType<FetchLike>>;
        try {
          response = await fetch(baseUrl + path, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
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
        try {
          return await response.json();
        } catch (e) {
          throw malformed("body is not JSON", e);
        }
      },
    );

  return {
    async callReadOnly(contract, fn, args) {
      const target = splitContractId(contract);
      if (target === null) {
        throw new StacksApiError(
          "INVALID_PRINCIPAL",
          "contract must be a contract id ADDR.name",
        );
      }
      if (typeof fn !== "string" || !isClarityName(fn)) {
        throw new StacksApiError(
          "INVALID_OPTION",
          "fn must be a Clarity function name",
        );
      }
      const path = [CALL_READ_PATH, ...target, fn]
        .map((part, i) => (i === 0 ? part : encodeURIComponent(part)))
        .join("/");
      let body: string;
      try {
        body = JSON.stringify({
          sender,
          arguments: args.map((a) => "0x" + Cl.serialize(a)),
        });
      } catch (e) {
        throw new StacksApiError(
          "INVALID_OPTION",
          "args must be Clarity values",
          { cause: e },
        );
      }

      const reply = await post(path, body);
      if (
        typeof reply !== "object" ||
        reply === null ||
        Array.isArray(reply) ||
        !("okay" in reply) ||
        typeof reply.okay !== "boolean"
      ) {
        throw malformed("body has no boolean okay");
      }
      if (!reply.okay) {
        const cause = "cause" in reply ? reply.cause : undefined;
        throw new StacksApiError(
          "CALL_FAILED",
          `the node refused the read-only call to ${path}`,
          {
            detail:
              typeof cause === "string" ? cause.slice(0, MAX_DETAIL) : null,
          },
        );
      }

      const value = decode("result" in reply ? reply.result : undefined);
      if (value.type === "err") {
        throw new StacksApiError(
          "CLARITY_ERROR",
          `the read-only call to ${path} returned (err …)`,
          { value },
        );
      }
      return value;
    },
  };
}
