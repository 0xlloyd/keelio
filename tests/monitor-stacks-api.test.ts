import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Cl } from "@stacks/transactions";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createMonitor,
  memoryStore,
  stacksApiChain,
  type GetFetchLike,
} from "../packages/monitor/src/index.js";
import { StacksApiError, type FetchLike } from "../packages/sdk/src/index.js";

// Replies recorded from https://api.hiro.so for a mainnet contract that is
// not a Keelio vault (see the fixture's `about`). They pin the reply shapes
// the chain reads; they cannot show it reading a vault's journal.
interface Page {
  limit: number;
  offset: number;
  results: Record<string, unknown>[];
}
const fixture = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "fixtures/stacks-api/monitor.json"),
    "utf8",
  ),
) as {
  contract: string;
  block: Page;
  transactions: Page & { total: number };
  events: Page;
  txs: Record<string, Record<string, unknown>>;
};

const BASE = "https://api.example";
const SENDER = "SP000000000000000000002Q6VF78";
const vault = fixture.contract;

// The real global fetch must satisfy both fetch types with no cast.
const realFetchFits: FetchLike & GetFetchLike = (url, init) => fetch(url, init);
void realFetchFits;

// No test may reach the network: any use of the global fetch throws.
const globalFetch = vi.fn(() => {
  throw new Error("network disabled in tests");
});
beforeAll(() => {
  vi.stubGlobal("fetch", globalFetch);
});
afterAll(() => {
  vi.unstubAllGlobals();
  expect(globalFetch).not.toHaveBeenCalled();
});

type Overrides = Record<string, unknown>;

/**
 * Serves the recorded replies. A list is served in pages cut from the
 * recorded `results` by the request's own `limit` and `offset`, inside the
 * recorded envelope. `overrides` replaces the body for a path prefix.
 */
function api(overrides: Overrides = {}) {
  const requests: string[] = [];
  const fetch = (async (url: string, init: { method: string }) => {
    expect(url.startsWith(BASE)).toBe(true);
    const path = url.slice(BASE.length);
    requests.push(`${init.method} ${path}`);
    const reply = (body: unknown, status = 200) => ({
      ok: status === 200,
      status,
      json: async () => body,
    });
    for (const [prefix, body] of Object.entries(overrides)) {
      if (path.startsWith(prefix)) return reply(body);
    }
    const [route, query = ""] = path.split("?");
    const params = new URLSearchParams(query);
    const page = (recorded: Page) => {
      const limit = Number(params.get("limit"));
      const offset = Number(params.get("offset"));
      return reply({
        ...recorded,
        limit,
        offset,
        results: recorded.results.slice(offset, offset + limit),
      });
    };
    if (route === "/extended/v2/blocks") return reply(fixture.block);
    if (route === `/extended/v1/contract/${vault}/events`) {
      return page(fixture.events);
    }
    if (route === `/extended/v1/address/${vault}/transactions`) {
      return page(fixture.transactions);
    }
    const tx = fixture.txs[route!.replace("/extended/v1/tx/", "")];
    if (tx !== undefined) return reply(tx);
    return reply({ error: "not found" }, 404);
  }) as FetchLike & GetFetchLike;
  return { fetch, requests };
}

function chainOver(overrides: Overrides = {}, pageSize?: number) {
  const { fetch, requests } = api(overrides);
  const chain = stacksApiChain({
    baseUrl: BASE,
    sender: SENDER,
    vault,
    fetch,
    ...(pageSize === undefined ? {} : { pageSize }),
  });
  return { chain, requests };
}

describe("stacksApiChain", () => {
  it("reads the burn height and block time of the latest block", async () => {
    const { chain, requests } = chainOver();
    const block = fixture.block.results[0]!;
    expect(await chain.burnHeight()).toBe(
      BigInt(block.burn_block_height as number),
    );
    expect(await chain.blockTimeMs()).toBe(
      BigInt(block.block_time as number) * 1000n,
    );
    expect(requests).toStrictEqual([
      "GET /extended/v2/blocks?limit=1",
      "GET /extended/v2/blocks?limit=1",
    ]);
  });

  it("reads the contract's prints oldest first, each at its transaction's burn height", async () => {
    const { chain, requests } = chainOver();
    const events = await chain.vaultEvents();
    // The API lists newest first.
    const recorded = [...fixture.events.results].reverse();
    expect(events).toHaveLength(5);
    expect(events).toStrictEqual(
      recorded.map((e) => {
        const log = e.contract_log as { value: { hex: string } };
        return {
          burnHeight: BigInt(
            fixture.txs[e.tx_id as string]!.burn_block_height as number,
          ),
          value: Cl.deserialize(log.value.hex),
        };
      }),
    );
    const heights = events.map((e) => e.burnHeight);
    expect(heights).toStrictEqual([...heights].sort((a, b) => Number(a - b)));
    expect(requests[0]).toBe(
      `GET /extended/v1/contract/${vault}/events?limit=50&offset=0`,
    );
    expect(requests.slice(1).sort()).toStrictEqual(
      Object.keys(fixture.txs)
        .map((id) => `GET /extended/v1/tx/${id}?event_limit=0`)
        .sort(),
    );
  });

  it("reads every page, and looks each transaction up once", async () => {
    const whole = await chainOver().chain.vaultEvents();
    const { chain, requests } = chainOver({}, 2);
    expect(await chain.vaultEvents()).toStrictEqual(whole);
    expect(requests.filter((r) => r.includes("/events?"))).toStrictEqual([
      `GET /extended/v1/contract/${vault}/events?limit=2&offset=0`,
      `GET /extended/v1/contract/${vault}/events?limit=2&offset=2`,
      `GET /extended/v1/contract/${vault}/events?limit=2&offset=4`,
    ]);
    const lookups = requests.filter((r) => r.includes("/tx/")).length;
    expect(lookups).toBe(5);
    await chain.vaultEvents();
    expect(requests.filter((r) => r.includes("/tx/"))).toHaveLength(lookups);
    // A full last page costs one more, empty, page.
    const five = chainOver({}, 5);
    expect(await five.chain.vaultEvents()).toStrictEqual(whole);
    expect(five.requests.filter((r) => r.includes("/events?"))).toHaveLength(2);
  });

  it("lists an entry once when a page repeats one of the page before", async () => {
    const whole = chainOver().chain;
    // An entry that arrives between two page reads moves every older one
    // down by one: each later page starts one entry early.
    const { fetch } = api();
    const chain = stacksApiChain({
      baseUrl: BASE,
      sender: SENDER,
      vault,
      pageSize: 2,
      fetch: ((url: string, init: never) => {
        const offset = /[?&]offset=(\d+)/.exec(url);
        const at = offset === null ? 0 : Number(offset[1]);
        return fetch(
          at > 0 ? url.replace(/offset=\d+/, "offset=" + (at - 1)) : url,
          init,
        );
      }) as FetchLike & GetFetchLike,
    });
    expect(await chain.vaultEvents()).toStrictEqual(await whole.vaultEvents());
    expect(await chain.vaultRefusals()).toStrictEqual(
      await whole.vaultRefusals(),
    );
  });

  it("lists the failed calls to the contract, oldest first, and no successful one", async () => {
    const { chain } = chainOver({}, 2);
    const refusals = await chain.vaultRefusals();
    const failed = fixture.transactions.results
      .filter((t) => t.tx_status !== "success")
      .reverse();
    expect(failed).toHaveLength(3);
    expect(
      fixture.transactions.results.some((t) => t.tx_status === "success"),
    ).toBe(true);
    expect(refusals.map((r) => r.txId)).toStrictEqual(
      failed.map((t) => t.tx_id),
    );
    // The oldest: a `transfer` refused with (err u1).
    expect(refusals[0]).toStrictEqual({
      burnHeight: 976128n,
      sender: "SP1EG89QEYKVTT52P8KRTV7BMB3NFAPPFT6XAG2GD",
      functionName: "transfer",
      args: [
        Cl.uint(780000),
        Cl.principal("SP1EG89QEYKVTT52P8KRTV7BMB3NFAPPFT6XAG2GD"),
        Cl.principal("SP443S3079EEJN4Q3J4DH2SBAAKA0X5J4HQ8XFRZ"),
        Cl.none(),
      ],
      reason: "response",
      result: Cl.error(Cl.uint(1)),
      txId: "0x38b848b4a0f2e4ef2ba189ac72da2f243996fc867c119772433b5a0958bdc1a9",
    });
    // A call with no arguments.
    expect(refusals[1]).toMatchObject({
      functionName: "pause",
      args: [],
      result: Cl.error(Cl.uint(400)),
    });
  });

  it("skips a call to another contract, a non-canonical one and a post-condition abort is kept", async () => {
    const [newest, second, third, ...rest] = fixture.transactions.results;
    const results = [
      {
        ...newest,
        tx_status: "abort_by_response",
        contract_call: {
          ...(newest!.contract_call as object),
          contract_id: `${SENDER}.other`,
        },
      },
      { ...second, tx_status: "abort_by_post_condition" },
      { ...third, canonical: false },
      ...rest,
    ];
    const { chain } = chainOver({
      [`/extended/v1/address/${vault}/transactions`]: { results },
    });
    const refusals = await chain.vaultRefusals();
    expect(refusals.map((r) => [r.txId, r.reason])).toStrictEqual([
      [rest[1]!.tx_id, "response"],
      [rest[0]!.tx_id, "response"],
      [second!.tx_id, "post-condition"],
    ]);
  });

  it("skips a print whose transaction is not canonical or did not succeed", async () => {
    const [id, other] = Object.keys(fixture.txs);
    const { chain } = chainOver({
      [`/extended/v1/tx/${id}`]: { ...fixture.txs[id!], canonical: false },
      [`/extended/v1/tx/${other}`]: {
        ...fixture.txs[other!],
        tx_status: "abort_by_response",
      },
    });
    expect(await chain.vaultEvents()).toHaveLength(3);
  });

  it("refuses a reply it cannot read", async () => {
    const events = `/extended/v1/contract/${vault}/events`;
    const txs = `/extended/v1/address/${vault}/transactions`;
    const entry = fixture.events.results[0]!;
    const failedTx = fixture.transactions.results.find(
      (t) => t.tx_status !== "success",
    )!;
    const cases: [Overrides, "vaultEvents" | "vaultRefusals" | "burnHeight"][] =
      [
        [{ [events]: [] }, "vaultEvents"],
        [{ [events]: { results: "none" } }, "vaultEvents"],
        [{ [events]: { results: [7] } }, "vaultEvents"],
        [
          { [events]: { results: [{ ...entry, tx_id: "0x12/../x" }] } },
          "vaultEvents",
        ],
        [
          {
            [events]: {
              results: [
                {
                  ...entry,
                  contract_log: {
                    ...(entry.contract_log as object),
                    value: { hex: "0xzz" },
                  },
                },
              ],
            },
          },
          "vaultEvents",
        ],
        [
          { "/extended/v1/tx/": { canonical: true, tx_status: "success" } },
          "vaultEvents",
        ],
        [
          { [txs]: { results: [{ ...failedTx, tx_result: null }] } },
          "vaultRefusals",
        ],
        [
          { [txs]: { results: [{ ...failedTx, burn_block_height: "9" }] } },
          "vaultRefusals",
        ],
        [{ "/extended/v2/blocks": { results: [] } }, "burnHeight"],
        [
          { "/extended/v2/blocks": { results: [{ burn_block_height: 1.5 }] } },
          "burnHeight",
        ],
      ];
    for (const [overrides, method] of cases) {
      const { chain } = chainOver(overrides);
      const error = await Promise.resolve()
        .then(() => chain[method]())
        .catch((e: unknown) => e);
      expect(error, JSON.stringify(overrides).slice(0, 80)).toBeInstanceOf(
        StacksApiError,
      );
      expect((error as StacksApiError).code).toBe("MALFORMED_RESPONSE");
    }
  });

  it("reports an HTTP failure and a thrown fetch as HTTP_ERROR", async () => {
    const options = { baseUrl: BASE, sender: SENDER, vault };
    const notFound = stacksApiChain({
      ...options,
      fetch: (async () => ({
        ok: false,
        status: 404,
        json: async () => ({}),
      })) as FetchLike & GetFetchLike,
    });
    await expect(notFound.vaultEvents()).rejects.toMatchObject({
      code: "HTTP_ERROR",
      status: 404,
    });
    const down = stacksApiChain({
      ...options,
      fetch: (async () => {
        throw new Error("offline");
      }) as FetchLike & GetFetchLike,
    });
    await expect(down.vaultRefusals()).rejects.toMatchObject({
      code: "HTTP_ERROR",
      status: null,
    });
  });

  it.each(["fetch", "json"] as const)(
    "gives up on a GET that never answers (%s) with HTTP_ERROR and aborts it",
    async (stage) => {
      const signals: AbortSignal[] = [];
      const chain = stacksApiChain({
        baseUrl: BASE,
        sender: SENDER,
        vault,
        timeoutMs: 20,
        fetch: ((_url: string, init: { signal: AbortSignal }) => {
          signals.push(init.signal);
          if (stage === "fetch") return new Promise(() => {});
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => new Promise(() => {}),
          });
        }) as FetchLike & GetFetchLike,
      });
      const err = await Promise.resolve(chain.burnHeight()).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(StacksApiError);
      expect(err).toMatchObject({
        code: "HTTP_ERROR",
        status: null,
        message: "request to /extended/v2/blocks?limit=1 timed out after 20 ms",
      });
      expect(signals).toHaveLength(1);
      expect(signals[0]!.aborted).toBe(true);
    },
  );

  it("passes every GET a signal that a prompt answer leaves alone", async () => {
    const signals: AbortSignal[] = [];
    const { fetch } = api();
    const chain = stacksApiChain({
      baseUrl: BASE,
      sender: SENDER,
      vault,
      fetch: ((url: string, init: Parameters<GetFetchLike>[1]) => {
        signals.push(init.signal);
        return fetch(url, init);
      }) as FetchLike & GetFetchLike,
    });
    await chain.burnHeight();
    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]!.aborted).toBe(false);
  });

  it("refuses a timeoutMs it cannot use", () => {
    const { fetch } = api();
    for (const timeoutMs of [0, -1, 1.5, Number.NaN]) {
      expect(() =>
        stacksApiChain({
          baseUrl: BASE,
          sender: SENDER,
          vault,
          fetch,
          timeoutMs,
        }),
      ).toThrow("timeoutMs");
    }
  });

  it("refuses a vault id or page size it cannot use", () => {
    const { fetch } = api();
    const options = { baseUrl: BASE, sender: SENDER, vault, fetch };
    for (const bad of [
      "keelio-vault",
      `${SENDER}.x/../y`,
      `${SENDER}.`,
      SENDER,
    ]) {
      expect(() => stacksApiChain({ ...options, vault: bad })).toThrow(
        StacksApiError,
      );
    }
    for (const pageSize of [0, 51, 1.5]) {
      expect(() => stacksApiChain({ ...options, pageSize })).toThrow(
        "pageSize",
      );
    }
    expect(() => stacksApiChain({ ...options, baseUrl: "ftp://x" })).toThrow(
      StacksApiError,
    );
  });

  it("feeds the monitor: the recorded failed calls become CALL_REFUSED, the foreign prints UNKNOWN_EVENT", async () => {
    // The recorded contract is a token, not a vault, so there is no vault to
    // read and nothing here shows a Keelio journal read from a network. The
    // two vault-wide reads of LEDGER_SHORTFALL are answered by hand.
    const [address, name] = vault.split(".");
    const callRead = `/v2/contracts/call-read/${address}/${name}`;
    const { chain, requests } = chainOver({
      [`${callRead}/get-ledger-total`]: {
        okay: true,
        result: `0x${Cl.serialize(Cl.uint(7))}`,
      },
      [`${callRead}/get-balance`]: {
        okay: true,
        result: `0x${Cl.serialize(Cl.ok(Cl.uint(7)))}`,
      },
    });
    const store = memoryStore();
    const monitor = createMonitor({
      chain,
      store,
      read: {
        vault,
        tokens: [vault],
        adapters: [],
        oracle: vault,
        sbtcToken: vault,
        priceScale: 1n,
      },
    });
    const alerts = await monitor.poll();
    expect(alerts.map((a) => a.code)).toStrictEqual([
      ...Array<string>(5).fill("UNKNOWN_EVENT"),
      ...Array<string>(3).fill("CALL_REFUSED"),
    ]);
    expect(alerts[5]).toMatchObject({
      id: "refusal:0",
      owner: "SP1EG89QEYKVTT52P8KRTV7BMB3NFAPPFT6XAG2GD",
      burnHeight: "976128",
      message:
        "transfer by SP1EG89QEYKVTT52P8KRTV7BMB3NFAPPFT6XAG2GD was refused with (err u1) unknown code",
      details: {
        txId: "0x38b848b4a0f2e4ef2ba189ac72da2f243996fc867c119772433b5a0958bdc1a9",
      },
    });
    expect((await monitor.state()).cursor).toStrictEqual({
      events: 5,
      refusals: 3,
    });
    expect(await monitor.poll()).toStrictEqual([]);
    expect(requests).toContain(`POST ${callRead}/get-ledger-total`);
    expect(requests).toContain(`POST ${callRead}/get-balance`);
  });
});
