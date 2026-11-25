import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { initSimnet } from "@stacks/clarinet-sdk";
import { Cl, type ClarityValue } from "@stacks/transactions";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TIMEOUT_MS,
  readVault,
  simnetClient,
  stacksApiClient,
  StacksApiError,
  type FetchLike,
  type StacksApiClientOptions,
  type StacksApiErrorCode,
  type VaultConfig,
} from "../packages/sdk/src/index.js";

const simnet = await initSimnet();
const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const alice = accounts.get("wallet_1")!;
const bob = accounts.get("wallet_2")!;

const vaultId = `${deployer}.keelio-vault`;
const sbtc = `${deployer}.mock-sbtc`;
const usd = `${deployer}.mock-usd`;
const dex = `${deployer}.mock-dex`;

const BASE = "https://node.example";
const PRICE_SCALE = 10_000_000_000n;
const PRICE = 9_000_000_000_000n;
const PRICE_AT = 1_700_000_000_000n;
const SDK_SRC = join(import.meta.dirname, "../packages/sdk/src");
const fixtures = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "fixtures/stacks-api/call-read.json"),
    "utf8",
  ),
) as Record<string, unknown>;

// The real global fetch must satisfy FetchLike with no cast.
const realFetchFits: FetchLike = fetch;
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

type Init = Parameters<FetchLike>[1];
type Reply = Awaited<ReturnType<FetchLike>>;

/** A fake fetch that records each request and answers with `reply`. */
function fakeFetch(reply: () => Promise<Reply>) {
  const calls: { url: string; init: Init }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return reply();
  };
  return { fetch, calls };
}

function answer(body: unknown, ok = true, status = 200) {
  return fakeFetch(async () => ({ ok, status, json: async () => body }));
}

function fixture(name: string) {
  const body = fixtures[name];
  if (body === undefined) throw new Error(`no fixture ${name}`);
  return answer(body);
}

function client(fetch: FetchLike, over: Partial<StacksApiClientOptions> = {}) {
  return stacksApiClient({
    baseUrl: `${BASE}/`,
    sender: deployer,
    fetch,
    ...over,
  });
}

function getBalance(fetch: FetchLike) {
  return client(fetch).callReadOnly(vaultId, "get-balance", [
    Cl.principal(alice),
    Cl.principal(sbtc),
  ]);
}

function check(err: unknown, code: StacksApiErrorCode): StacksApiError {
  expect(err).toBeInstanceOf(StacksApiError);
  expect(err).not.toBeInstanceOf(TypeError);
  const e = err as StacksApiError;
  expect(e.name).toBe("StacksApiError");
  expect(e.code).toBe(code);
  return e;
}

async function rejects(
  p: ClarityValue | Promise<ClarityValue>,
  code: StacksApiErrorCode,
): Promise<StacksApiError> {
  const err = await Promise.resolve(p).then(
    (v) => expect.fail(`resolved with ${JSON.stringify(v)}`),
    (e: unknown) => e,
  );
  return check(err, code);
}

function throws(build: () => unknown, code: StacksApiErrorCode) {
  let err: unknown;
  try {
    build();
  } catch (e) {
    err = e;
  }
  if (err === undefined) expect.fail(`expected ${code}, nothing thrown`);
  return check(err, code);
}

describe("callReadOnly request", () => {
  it("sends one POST to the call-read endpoint with hex arguments", async () => {
    const { fetch, calls } = fixture("uintOk");
    await getBalance(fetch);

    expect(calls).toHaveLength(1);
    const [{ url, init }] = calls as [(typeof calls)[0]];
    expect(url).toBe(
      `https://node.example/v2/contracts/call-read/${deployer}/keelio-vault/get-balance`,
    );
    expect(url.slice("https://".length)).not.toContain("//");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.headers).toStrictEqual({ "content-type": "application/json" });
    expect(JSON.parse(init.body)).toStrictEqual({
      sender: deployer,
      arguments: [
        "0x" + Cl.serialize(Cl.principal(alice)),
        "0x" + Cl.serialize(Cl.principal(sbtc)),
      ],
    });
  });

  it("sends amounts as Clarity hex, never as JSON numbers", async () => {
    const { fetch, calls } = fixture("uintOk");
    await client(fetch).callReadOnly(vaultId, "get-balance", [
      Cl.uint(2n ** 128n - 1n),
    ]);
    const body = JSON.parse(calls[0]!.init.body) as { arguments: unknown[] };
    expect(body.arguments).toStrictEqual([
      "0x01ffffffffffffffffffffffffffffffff",
    ]);
  });

  it("trims exactly one trailing slash from baseUrl", async () => {
    const { fetch, calls } = fixture("uintOk");
    await client(fetch, { baseUrl: BASE }).callReadOnly(vaultId, "f", []);
    await client(fetch, { baseUrl: `${BASE}/api/` }).callReadOnly(
      vaultId,
      "f",
      [],
    );
    expect(calls.map((c) => c.url)).toStrictEqual([
      `${BASE}/v2/contracts/call-read/${deployer}/keelio-vault/f`,
      `${BASE}/api/v2/contracts/call-read/${deployer}/keelio-vault/f`,
    ]);
  });

  it("encodes each path segment with encodeURIComponent", async () => {
    const { fetch, calls } = fixture("uintOk");
    // `?` and `/` are legal in a Clarity function name.
    await client(fetch).callReadOnly(vaultId, "has?/x", []);
    const path = new URL(calls[0]!.url).pathname;
    expect(path.split("/")).toStrictEqual([
      "",
      "v2",
      "contracts",
      "call-read",
      deployer,
      "keelio-vault",
      "has%3F%2Fx",
    ]);
  });

  it.each([`${deployer}.keelio/vault`, `${deployer}.keelio?x=1`])(
    "rejects contract id %s as INVALID_PRINCIPAL without a fetch",
    async (contract) => {
      const { fetch, calls } = fixture("uintOk");
      await rejects(
        client(fetch).callReadOnly(contract, "get-balance", []),
        "INVALID_PRINCIPAL",
      );
      expect(calls).toHaveLength(0);
    },
  );
});

describe("callReadOnly response", () => {
  it("decodes a uint result", async () => {
    const { fetch } = fixture("uintOk");
    expect(await getBalance(fetch)).toStrictEqual(Cl.uint(1_000_000n));
  });

  it("decodes a get-vault tuple", async () => {
    const { fetch } = fixture("tupleOk");
    const value = await client(fetch).callReadOnly(vaultId, "get-vault", [
      Cl.principal(alice),
    ]);
    expect(value).toStrictEqual(
      Cl.tuple({
        agent: Cl.some(
          Cl.standardPrincipal("ST263C0A64Y6EFS3X4VJTMDDQRVZKR1MTFRDHV82Z"),
        ),
        paused: Cl.bool(false),
      }),
    );
  });
});

describe("callReadOnly failures", () => {
  const cases: [
    string,
    () => ReturnType<typeof fakeFetch>,
    StacksApiErrorCode,
  ][] = [
    [
      "fetch rejects",
      () =>
        fakeFetch(() => Promise.reject(new TypeError("fetch failed: ECONN"))),
      "HTTP_ERROR",
    ],
    ["status 500", () => answer({ okay: true }, false, 500), "HTTP_ERROR"],
    [
      "json() rejects",
      () =>
        fakeFetch(async () => ({
          ok: true,
          status: 200,
          json: () => Promise.reject(new SyntaxError("Unexpected token")),
        })),
      "MALFORMED_RESPONSE",
    ],
    ["noOkay", () => fixture("noOkay"), "MALFORMED_RESPONSE"],
    ["badHex", () => fixture("badHex"), "MALFORMED_RESPONSE"],
    ["truncated", () => fixture("truncated"), "MALFORMED_RESPONSE"],
    ["null body", () => answer(null), "MALFORMED_RESPONSE"],
    ['"x" body', () => answer("x"), "MALFORMED_RESPONSE"],
    ["callFailed", () => fixture("callFailed"), "CALL_FAILED"],
    ["errValue", () => fixture("errValue"), "CLARITY_ERROR"],
  ];

  it.each(cases)("%s makes one request and throws", async (_, make, code) => {
    const { fetch, calls } = make();
    await rejects(getBalance(fetch), code);
    expect(calls).toHaveLength(1);
  });

  it("keeps a fetch rejection as the cause with a null status", async () => {
    const boom = new TypeError("fetch failed");
    const { fetch } = fakeFetch(() => Promise.reject(boom));
    const err = await rejects(getBalance(fetch), "HTTP_ERROR");
    expect(err.status).toBeNull();
    expect(err.cause).toBe(boom);
  });

  it("reports the status and path of a failed response, not its body", async () => {
    const { fetch } = answer({ okay: true, secret: "BODY-TEXT" }, false, 500);
    const err = await rejects(getBalance(fetch), "HTTP_ERROR");
    expect(err.status).toBe(500);
    expect(err.message).toContain("500");
    expect(err.message).toContain(
      `/v2/contracts/call-read/${deployer}/keelio-vault/get-balance`,
    );
    expect(err.message).not.toContain("BODY-TEXT");
    expect(err.message).not.toContain("node.example");
  });

  it("keeps okay:false cause on detail, not in the message", async () => {
    const { fetch } = fixture("callFailed");
    const err = await rejects(getBalance(fetch), "CALL_FAILED");
    expect(err.detail).toBe(
      `Unchecked(NoSuchContract("${deployer}.keelio-vault"))`,
    );
    expect(err.message).not.toContain("NoSuchContract");
  });

  it("cuts a long cause to 200 characters and ignores a non-string one", async () => {
    const long = await rejects(
      getBalance(answer({ okay: false, cause: "a".repeat(500) }).fetch),
      "CALL_FAILED",
    );
    expect(long.detail).toBe("a".repeat(200));
    const odd = await rejects(
      getBalance(answer({ okay: false, cause: { x: 1 } }).fetch),
      "CALL_FAILED",
    );
    expect(odd.detail).toBeNull();
  });

  it("puts a decoded (err …) on value", async () => {
    const { fetch } = fixture("errValue");
    const err = await rejects(getBalance(fetch), "CLARITY_ERROR");
    expect(err.value).toStrictEqual(Cl.error(Cl.uint(1)));
  });

  it.each([
    ["an array body", []],
    ["okay as a string", { okay: "true", result: "0x03" }],
    ["a number result", { okay: true, result: 3 }],
    ["no 0x prefix", { okay: true, result: "03" }],
    ["an odd hex length", { okay: true, result: "0x030" }],
    ["an empty result", { okay: true, result: "0x" }],
    ["trailing bytes", { okay: true, result: "0x0300" }],
    ["an unknown type byte", { okay: true, result: "0xff" }],
  ])("treats %s as MALFORMED_RESPONSE", async (_, body) => {
    await rejects(getBalance(answer(body).fetch), "MALFORMED_RESPONSE");
  });

  it("rejects a bare contract name as INVALID_PRINCIPAL without a fetch", async () => {
    const { fetch, calls } = fixture("uintOk");
    await rejects(
      client(fetch).callReadOnly("keelio-vault", "get-balance", []),
      "INVALID_PRINCIPAL",
    );
    expect(calls).toHaveLength(0);
  });

  it.each([
    "bad.keelio-vault",
    `${deployer}.`,
    `${deployer}.${"a".repeat(41)}`,
    `${deployer}.1vault`,
  ])("rejects contract id %s without a fetch", async (contract) => {
    const { fetch, calls } = fixture("uintOk");
    await rejects(
      client(fetch).callReadOnly(contract, "get-balance", []),
      "INVALID_PRINCIPAL",
    );
    expect(calls).toHaveLength(0);
  });

  it.each(["get balance", "", "1fn"])(
    "rejects function name %j as INVALID_OPTION without a fetch",
    async (fn) => {
      const { fetch, calls } = fixture("uintOk");
      await rejects(
        client(fetch).callReadOnly(vaultId, fn, []),
        "INVALID_OPTION",
      );
      expect(calls).toHaveLength(0);
    },
  );
});

describe("callReadOnly timeout", () => {
  /** A fetch whose answer never arrives, recording the signal it was given. */
  function hanging(stage: "fetch" | "json") {
    const signals: AbortSignal[] = [];
    const fetch: FetchLike = (_url, init) => {
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

  it.each(["fetch", "json"] as const)(
    "gives up on a node that never answers (%s) with HTTP_ERROR",
    async (stage) => {
      const { fetch, signals } = hanging(stage);
      const err = await rejects(
        client(fetch, { timeoutMs: 20 }).callReadOnly(
          vaultId,
          "get-balance",
          [],
        ),
        "HTTP_ERROR",
      );
      expect(err.status).toBeNull();
      expect(err.message).toBe(
        `request to /v2/contracts/call-read/${deployer}/keelio-vault/get-balance timed out after 20 ms`,
      );
      expect(err.message).not.toContain("node.example");
      // The request is aborted too, so a real fetch stops reading.
      expect(signals).toHaveLength(1);
      expect(signals[0]!.aborted).toBe(true);
    },
  );

  it("passes a signal that is not aborted on a prompt answer", async () => {
    const { fetch, calls } = fixture("uintOk");
    await getBalance(fetch);
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]!.init.signal.aborted).toBe(false);
  });

  // 2 ** 31 ms: setTimeout would fire at once, so every read would fail.
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31, "10"])(
    "refuses timeoutMs %j with INVALID_OPTION",
    (timeoutMs) => {
      const { fetch, calls } = fixture("uintOk");
      throws(
        () => client(fetch, { timeoutMs: timeoutMs as number }),
        "INVALID_OPTION",
      );
      expect(calls).toHaveLength(0);
    },
  );

  it("defaults timeoutMs to 10 seconds", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(10_000);
  });
});

describe("stacksApiClient options", () => {
  it.each([
    "ftp://x",
    "not a url",
    "",
    "https://node.example/?q=1",
    "https://node.example/#x",
  ])("refuses baseUrl %j with INVALID_OPTION", (baseUrl) => {
    const { fetch, calls } = fixture("uintOk");
    throws(() => client(fetch, { baseUrl }), "INVALID_OPTION");
    expect(calls).toHaveLength(0);
  });

  it.each(["", "SPnotreal", `${deployer}.`, `nope.keelio-vault`])(
    "refuses sender %j with INVALID_PRINCIPAL",
    (sender) => {
      const { fetch, calls } = fixture("uintOk");
      throws(() => client(fetch, { sender }), "INVALID_PRINCIPAL");
      expect(calls).toHaveLength(0);
    },
  );

  it("accepts a contract id as sender", async () => {
    const { fetch, calls } = fixture("uintOk");
    await client(fetch, { sender: vaultId }).callReadOnly(vaultId, "f", []);
    expect(JSON.parse(calls[0]!.init.body)).toMatchObject({ sender: vaultId });
  });

  it("refuses a fetch that is not a function", () => {
    throws(() => client(undefined as unknown as FetchLike), "INVALID_OPTION");
  });
});

/**
 * A node stand-in that speaks the call-read wire format and answers from the
 * simnet. It opens no socket.
 */
const simnetFetch: FetchLike = async (url, init) => {
  const match = /^\/v2\/contracts\/call-read\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(
    new URL(url).pathname,
  );
  if (match === null) throw new Error(`unexpected path ${url}`);
  const [addr, name, fn] = match.slice(1).map(decodeURIComponent) as [
    string,
    string,
    string,
  ];
  const body = JSON.parse(init.body) as { sender: string; arguments: string[] };
  const args = body.arguments.map((hex) => Cl.deserialize(hex));
  const { result } = simnet.callReadOnlyFn(
    `${addr}.${name}`,
    fn,
    args,
    body.sender,
  );
  return {
    ok: true,
    status: 200,
    json: async () => ({ okay: true, result: "0x" + Cl.serialize(result) }),
  };
};

/** Every leaf of a plain value tree. */
function leaves(value: unknown): unknown[] {
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap(leaves);
  }
  return [value];
}

describe("readVault through stacksApiClient", () => {
  const DEPOSIT = 1_000_000n;
  const MAX_PER_TRADE = 100_000n;
  const MAX_PER_DAY = 500_000n;
  const COOLDOWN = 3n;
  const EXPIRES_AT = 1_000_000n;

  beforeAll(() => {
    const ok = (call: { result: ClarityValue }) =>
      expect(call.result.type).toBe("ok");
    ok(
      simnet.callPublicFn(
        "mock-sbtc",
        "mint",
        [Cl.uint(DEPOSIT), Cl.principal(alice)],
        deployer,
      ),
    );
    const owner = (fn: string, args: ClarityValue[]) =>
      ok(simnet.callPublicFn("keelio-vault", fn, args, alice));
    owner("deposit", [Cl.principal(sbtc), Cl.uint(DEPOSIT)]);
    owner("set-agent", [Cl.principal(bob)]);
    owner("set-token-caps", [
      Cl.principal(sbtc),
      Cl.uint(MAX_PER_TRADE),
      Cl.uint(MAX_PER_DAY),
    ]);
    owner("set-policy", [Cl.uint(COOLDOWN), Cl.uint(EXPIRES_AT)]);
    owner("allow-token", [Cl.principal(sbtc), Cl.bool(true)]);
    owner("allow-adapter", [Cl.principal(dex), Cl.bool(true)]);
    owner("set-price-bounds", [Cl.uint(100n), Cl.uint(60_000n)]);
    ok(
      simnet.callPublicFn(
        "mock-oracle",
        "set-value",
        [Cl.stringAscii("BTC/USD"), Cl.uint(PRICE), Cl.uint(PRICE_AT)],
        deployer,
      ),
    );
  });

  const tokens = [sbtc, usd];
  const adapters = [dex];
  const terms = { sbtcToken: sbtc, priceScale: PRICE_SCALE };
  const viaSimnet: VaultConfig = {
    vault: "keelio-vault",
    tokens,
    adapters,
    oracle: "mock-oracle",
    ...terms,
  };
  const viaApi: VaultConfig = {
    vault: vaultId,
    tokens,
    adapters,
    oracle: `${deployer}.mock-oracle`,
    ...terms,
  };
  const api = (fetch: FetchLike = simnetFetch) =>
    stacksApiClient({ baseUrl: BASE, sender: deployer, fetch });
  const readBoth = async () => ({
    fromApi: await readVault(api(), viaApi, alice),
    fromSimnet: await readVault(
      simnetClient(simnet, deployer),
      viaSimnet,
      alice,
    ),
  });
  const setFailing = (on: boolean) =>
    expect(
      simnet.callPublicFn("mock-oracle", "set-failing", [Cl.bool(on)], deployer)
        .result,
    ).toStrictEqual(Cl.ok(Cl.bool(true)));

  it("returns the same VaultRead as simnetClient", async () => {
    const { fromApi, fromSimnet } = await readBoth();

    expect(fromApi).toStrictEqual(fromSimnet);
    // The set-up reached the chain, so the comparison is not of two defaults.
    expect(fromApi.vault.agent).toBe(bob);
    expect(fromApi.balances[sbtc]).toBe(DEPOSIT);
    expect(fromApi.policy.caps[sbtc]).toStrictEqual({
      maxPerTrade: MAX_PER_TRADE,
      maxPerDay: MAX_PER_DAY,
    });
    expect(fromApi.policy.allowedTokens).toStrictEqual([sbtc]);
    expect(fromApi.policy.allowedAdapters).toStrictEqual([dex]);
    expect(fromApi.priceBounds).toStrictEqual({
      maxSlippageBps: 100n,
      maxPriceAge: 60_000n,
    });
    expect(fromApi.oracle).toStrictEqual({
      sbtcToken: sbtc,
      priceScale: PRICE_SCALE,
      price: { value: PRICE, timestamp: PRICE_AT },
    });
    for (const leaf of leaves(fromApi)) {
      expect(typeof leaf).not.toBe("number");
    }
    const amounts = [
      ...Object.values(fromApi.balances),
      ...Object.values(fromApi.policy.caps).flatMap((c) => [
        c.maxPerTrade,
        c.maxPerDay,
      ]),
      ...Object.values(fromApi.usage.dayTotals),
      fromApi.policy.cooldownBlocks,
      fromApi.policy.expiresAt,
    ];
    expect(amounts.length).toBeGreaterThan(0);
    for (const amount of amounts) expect(typeof amount).toBe("bigint");
  });

  it("reads a failing oracle as price null through both clients", async () => {
    setFailing(true);
    try {
      const { fromApi, fromSimnet } = await readBoth();
      expect(fromApi).toStrictEqual(fromSimnet);
      expect(fromApi.oracle.price).toBeNull();
      // The rest of the read is still there.
      expect(fromApi.priceBounds.maxSlippageBps).toBe(100n);
    } finally {
      setFailing(false);
    }
  });

  it("throws an oracle HTTP_ERROR rather than read it as a failing oracle", async () => {
    const oracleDown: FetchLike = async (url, init) =>
      url.endsWith("/mock-oracle/get-value")
        ? { ok: false, status: 503, json: async () => ({}) }
        : simnetFetch(url, init);
    const err = await readVault(api(oracleDown), viaApi, alice).then(
      () => expect.fail("readVault resolved"),
      (e: unknown) => e,
    );
    expect(check(err, "HTTP_ERROR").status).toBe(503);
  });
});

describe("read-only guard", () => {
  const sources = (
    readdirSync(SDK_SRC, { recursive: true, encoding: "utf8" }) as string[]
  )
    .filter((f) => f.endsWith(".ts"))
    .map((f) => ({ file: f, text: readFileSync(join(SDK_SRC, f), "utf8") }));
  const clientSource = readFileSync(join(SDK_SRC, "stacks-api.ts"), "utf8");

  it("scans the SDK sources, build-tx.ts included", () => {
    const files = sources.map((s) => s.file);
    expect(files).toContain("stacks-api.ts");
    expect(files).toContain("build-tx.ts");
  });

  it("finds no broadcast endpoint or call in packages/sdk/src", () => {
    const broadcast =
      /\/v2\/transactions|\/extended\/v1\/tx|broadcastTransaction|\bbroadcast\(/;
    const hits = sources
      .filter((s) => broadcast.test(s.text))
      .map((s) => s.file);
    expect(hits).toStrictEqual([]);
  });

  it("finds no key, signing or transaction-submit name in stacks-api.ts", () => {
    expect(clientSource).not.toMatch(
      /privateKey|mnemonic|signTransaction|makeContractCall\b|makeSTXTokenTransfer|TransactionSigner|\/v2\/transactions/,
    );
  });

  it("still allows the read-only call-read POST", () => {
    expect(clientSource).toContain("/v2/contracts/call-read");
  });
});
