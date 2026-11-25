import type { ClarityValue } from "@stacks/transactions";

// The error `stacksApiClient` throws, in its own file so that `readVault`,
// which only needs to recognise it, does not pull the API client into a
// bundle that never talks to a node.

export type StacksApiErrorCode =
  | "INVALID_OPTION"
  | "INVALID_PRINCIPAL"
  | "HTTP_ERROR"
  | "MALFORMED_RESPONSE"
  | "CALL_FAILED"
  | "CLARITY_ERROR";

export class StacksApiError extends Error {
  readonly code: StacksApiErrorCode;
  /** The HTTP status for an `HTTP_ERROR` the node answered, else `null`. */
  readonly status: number | null;
  /** The node's `cause` for `CALL_FAILED`, cut to 200 characters. */
  readonly detail: string | null;
  /** The decoded `(err …)` for `CLARITY_ERROR`. */
  readonly value: ClarityValue | null;

  constructor(
    code: StacksApiErrorCode,
    message: string,
    extra: {
      status?: number;
      detail?: string | null;
      value?: ClarityValue;
      cause?: unknown;
    } = {},
  ) {
    super(message, "cause" in extra ? { cause: extra.cause } : undefined);
    this.name = "StacksApiError";
    this.code = code;
    this.status = extra.status ?? null;
    this.detail = extra.detail ?? null;
    this.value = extra.value ?? null;
  }
}
