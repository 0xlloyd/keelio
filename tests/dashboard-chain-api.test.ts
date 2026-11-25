// The dashboard's own Stacks API reads (apps/dashboard/src/chain-api.ts) give
// up on a node that stops answering, as the SDK's client does. Without a
// deadline, a silent node left testnet mode at "Reading the vault…" for good.
import { describe, expect, it } from "vitest";
import {
  chainApi,
  ChainApiError,
  DEFAULT_API_TIMEOUT_MS,
  type ApiFetch,
} from "../apps/dashboard/src/chain-api.js";

const BASE = "https://api.example";

/** A fetch whose answer never arrives, recording the signal it was given. */
function hanging(stage: "fetch" | "json") {
  const signals: (AbortSignal | undefined)[] = [];
  const fetch: ApiFetch = (_url, init) => {
    signals.push(init.signal);
    if (stage === "fetch") return new Promise(() => {});
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => new Promise(() => {}),
    });
  };
  return { fetch, signals };
}

describe("chainApi timeout", () => {
  it.each(["fetch", "json"] as const)(
    "gives up on a node that never answers (%s) with HTTP_ERROR and aborts the request",
    async (stage) => {
      const { fetch, signals } = hanging(stage);
      const err = await chainApi(BASE, fetch, 20)
        .tip()
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err).toBeInstanceOf(ChainApiError);
      expect(err).toMatchObject({
        code: "HTTP_ERROR",
        message: "request to /extended/v2/blocks/latest timed out after 20 ms",
      });
      expect((err as Error).message).not.toContain("api.example");
      expect(signals).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(true);
    },
  );

  it("passes a signal that a prompt answer leaves alone", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const fetch: ApiFetch = async (_url, init) => {
      signals.push(init.signal);
      return { ok: true, status: 200, json: async () => ({ network_id: 2 }) };
    };
    expect(await chainApi(BASE, fetch).networkId()).toBe(2);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]?.aborted).toBe(false);
  });

  // 2 ** 31 ms: setTimeout would fire at once, so every read would fail.
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31])(
    "refuses timeoutMs %j",
    (timeoutMs) => {
      const { fetch } = hanging("fetch");
      expect(() => chainApi(BASE, fetch, timeoutMs)).toThrow(RangeError);
    },
  );

  it("defaults to the SDK's 10 seconds", () => {
    expect(DEFAULT_API_TIMEOUT_MS).toBe(10_000);
  });
});
