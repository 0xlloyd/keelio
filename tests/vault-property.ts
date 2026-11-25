import { initSimnet, type Simnet } from "@stacks/clarinet-sdk";
import { Cl, cvToString, type ClarityValue } from "@stacks/transactions";
import {
  checkIntent,
  readVault,
  RULES,
  simnetClient,
} from "../packages/sdk/src/index.js";
import { ORACLE_KEY, PRICE_SCALE, floorOf } from "./oracle-fixture.js";
import { vaultClarityVersion } from "./vault-clarity-version.js";

// The keelio-vault property run, shared by tests/keelio-vault-property.test.ts and
// tests/keelio-vault-mutants.test.ts. Not a test file.
//
// Each sequence is a random list of calls from a seeded generator, run on a
// fresh simnet, with the safety claims checked after every call. A failure
// throws `keelio-vault property failed: <why>` with the seed and the numbered
// call list. Sequence `i` uses seed BASE_SEED + i.

export const BASE_SEED = 20_260_000;
export const SEQUENCES = 200;
const DAY_BLOCKS = 144n;
const MAX_UINT = 340282366920938463463374607431768211455n;
// The owner's max-price-age: no sequence mines far enough to reach it.
const MAX_AGE_MS = 10n ** 15n;

/**
 * What one sequence saw. `refused` counts `execute-swap` refusals by error
 * code; `checkedFloor` counts the successful swaps check 6 ran on. The test
 * asserts the counts it relies on are above 0, so no check is vacuous.
 */
export type SequenceStats = {
  checkedFloor: number;
  refused: Record<number, number>;
  /** Swaps check 8 compared with `checkIntent`, by the contract's result. */
  parity: Record<string, number>;
};

/** A vault contract to run against instead of the deployed `keelio-vault`. */
export type VaultCopy = { name: string; source: string };

const SEED_MAX = 4_294_967_295;

/**
 * Reads `KEELIO_SEED`. Unset gives `undefined` (run every sequence). Anything
 * but ASCII digits up to 2^32 - 1 is refused: `mulberry32` takes
 * `seed >>> 0`, so a larger seed would quietly alias a smaller one.
 */
export function parseSeedEnv(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[0-9]+$/.test(value) || Number(value) > SEED_MAX)
    throw new Error(
      `KEELIO_SEED must be a whole number from 0 to ${SEED_MAX}, got "${value}"`,
    );
  return Number(value);
}

// Small deterministic generator (mulberry32). No new dependency.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;
const int = (r: Rng, lo: number, hi: number) =>
  lo + Math.floor(r() * (hi - lo + 1));
const pick = <T>(r: Rng, xs: readonly T[]): T => xs[int(r, 0, xs.length - 1)]!;
const chance = (r: Rng, p: number) => r() < p;

type Role = "owner" | "agent" | "stranger1" | "stranger2";
type Call = {
  who: Role | "chain";
  fn: string;
  args: ClarityValue[];
  note?: string;
};

type Ctx = {
  // Read results, cleared after every state change.
  cache: Map<string, bigint>;
  simnet: Simnet;
  deployer: string;
  actors: Record<Role, string>;
  sbtc: string;
  usd: string;
  dex: string;
  // The vault contract under test: `keelio-vault` or a deployed copy.
  vaultName: string;
  vault: string;
};

function readUint(value: ClarityValue, wrappedInOk: boolean): bigint {
  const inner = wrappedInOk && value.type === "ok" ? value.value : value;
  if (inner.type !== "uint")
    throw new Error(`expected uint, got ${inner.type}`);
  return BigInt(inner.value);
}

const ROLES: Role[] = ["owner", "agent", "stranger1", "stranger2"];

function cached(c: Ctx, k: string, read: () => bigint): bigint {
  let v = c.cache.get(k);
  if (v === undefined) {
    v = read();
    c.cache.set(k, v);
  }
  return v;
}

function wallet(c: Ctx, token: string, who: string): bigint {
  return cached(c, `w|${token}|${who}`, () => walletRead(c, token, who));
}

function walletRead(c: Ctx, token: string, who: string): bigint {
  return readUint(
    c.simnet.callReadOnlyFn(
      token.split(".")[1]!,
      "get-balance",
      [Cl.principal(who)],
      c.deployer,
    ).result,
    true,
  );
}

function ledger(c: Ctx, who: string, token: string): bigint {
  return cached(c, `l|${who}|${token}`, () => ledgerRead(c, who, token));
}

// Reads the vault's `balances` map directly: about 14 times faster than the
// `get-balance` read-only. `checkLedgerReads` compares the two at the end of
// each sequence, so the public read stays covered.
function ledgerRead(c: Ctx, who: string, token: string): bigint {
  const entry = c.simnet.getMapEntry(
    c.vaultName,
    "balances",
    Cl.tuple({ owner: Cl.principal(who), token: Cl.principal(token) }),
  );
  if (entry.type === "none") return 0n;
  if (entry.type === "some") return readUint(entry.value, false);
  throw new Error(
    `balances map entry: expected an optional, got ${entry.type}`,
  );
}

function publicLedgerRead(c: Ctx, who: string, token: string): bigint {
  return readUint(
    c.simnet.callReadOnlyFn(
      c.vaultName,
      "get-balance",
      [Cl.principal(who), Cl.principal(token)],
      c.deployer,
    ).result,
    false,
  );
}

function mint(c: Ctx, token: string, amount: bigint, to: string) {
  const { result } = c.simnet.callPublicFn(
    token.split(".")[1]!,
    "mint",
    [Cl.uint(amount), Cl.principal(to)],
    c.deployer,
  );
  if (result.type !== "ok")
    throw new Error(`mint failed: ${cvToString(result)}`);
}

async function freshContext(vault?: VaultCopy): Promise<Ctx> {
  const simnet = await initSimnet();
  const accounts = simnet.getAccounts();
  const deployer = accounts.get("deployer")!;
  if (vault) {
    // Not a `keelio-vault property failed` message, so a copy that does not
    // deploy can never count as a caught mutant.
    const { result } = simnet.deployContract(
      vault.name,
      vault.source,
      { clarityVersion: vaultClarityVersion() },
      deployer,
    );
    if (cvToString(result) !== cvToString(Cl.ok(Cl.bool(true))))
      throw new Error(
        `vault copy ${vault.name} failed to deploy: ${cvToString(result)}`,
      );
  }
  const vaultName = vault?.name ?? "keelio-vault";
  const c: Ctx = {
    cache: new Map(),
    simnet,
    deployer,
    actors: {
      owner: accounts.get("wallet_1")!,
      agent: accounts.get("wallet_2")!,
      stranger1: accounts.get("wallet_3")!,
      stranger2: accounts.get("wallet_4")!,
    },
    sbtc: `${deployer}.mock-sbtc`,
    usd: `${deployer}.mock-usd`,
    dex: `${deployer}.mock-dex`,
    vaultName,
    vault: `${deployer}.${vaultName}`,
  };
  for (const who of ROLES.map((r) => c.actors[r])) {
    mint(c, c.sbtc, 10_000_000n, who);
    mint(c, c.usd, 10_000_000_000n, who);
  }
  mint(c, c.sbtc, 10n ** 30n, c.dex);
  mint(c, c.usd, 10n ** 30n, c.dex);
  return c;
}

// Amounts: zero, small, around a cap, or large.
function amount(r: Rng, cap: bigint): bigint {
  const k = r();
  if (k < 0.08) return 0n;
  if (k < 0.4) return BigInt(int(r, 1, 100));
  if (k < 0.7) {
    const d = BigInt(int(r, -1, 1));
    const v = cap + d;
    return v < 0n ? 0n : v;
  }
  if (k < 0.9) return BigInt(int(r, 100, 100_000));
  return BigInt(int(r, 1_000_000, 50_000_000));
}

// What the test believes about the vault, built only from results it saw.
// Caps and swaps are kept per input token, as the vault keeps them; cooldown
// and expiry are the owner's. A token never set reads 0n caps.
type Caps = { perTrade: bigint; perDay: bigint };
type Model = {
  // The oracle price and the owner's price bounds, from successful calls.
  price: bigint;
  slippageBps: bigint;
  maxPriceAge: bigint;
  caps: Map<string, Caps>;
  cooldown: bigint;
  expiry: bigint;
  swaps: Map<string, { height: bigint; amount: bigint }[]>;
  agent: Role | null;
  // The owner's paused flag, from the owner's successful pause and unpause.
  paused: boolean;
};

const capsOf = (model: Model, token: string): Caps =>
  model.caps.get(token) ?? { perTrade: 0n, perDay: 0n };

/** The model's total of `token`'s swaps in the day window ending at `now`. */
const windowTotal = (model: Model, token: string, now: bigint): bigint =>
  (model.swaps.get(token) ?? [])
    .filter((s) => s.height > now - DAY_BLOCKS && s.height <= now)
    .reduce((sum, s) => sum + s.amount, 0n);

function describeCall(c: Ctx, call: Call): string {
  const names = new Map<string, string>([
    [c.actors.owner, "owner"],
    [c.actors.agent, "agent"],
    [c.actors.stranger1, "stranger1"],
    [c.actors.stranger2, "stranger2"],
    [c.sbtc, "sbtc"],
    [c.usd, "usd"],
    [c.dex, "dex"],
  ]);
  const args = call.args.map((a) => {
    const s = cvToString(a);
    return names.get(s.replace(/^'/, "")) ?? s;
  });
  return `${call.who} ${call.fn}(${args.join(", ")})${call.note ? " " + call.note : ""}`;
}

/**
 * Runs sequence `seed` against `keelio-vault`, or against `vault` deployed into
 * the sequence's own simnet. Throws `keelio-vault property failed: …` when a
 * check fails.
 */
export async function runSequence(
  seed: number,
  vault?: VaultCopy,
): Promise<SequenceStats> {
  const stats: SequenceStats = { checkedFloor: 0, refused: {}, parity: {} };
  const r = mulberry32(seed);
  const c = await freshContext(vault);
  const { simnet } = c;
  const a = c.actors;
  const log: string[] = [];
  const model: Model = {
    price: 0n,
    slippageBps: 0n,
    maxPriceAge: 0n,
    caps: new Map(),
    cooldown: 0n,
    expiry: 0n,
    swaps: new Map(),
    agent: null,
    paused: false,
  };
  const evil = `${c.deployer}.evil-token`;

  const rate = pick(r, [
    [900n, 1n],
    [1n, 900n],
    [1n, 1n],
    [3n, 2n],
  ] as const);
  const rated = simnet.callPublicFn(
    "mock-dex",
    "set-rate",
    [Cl.uint(rate[0]), Cl.uint(rate[1])],
    c.deployer,
  );
  if (rated.result.type !== "ok") throw new Error("set-rate failed");
  log.push(`setup: dex rate ${rate[0]}/${rate[1]}`);

  // The oracle price that matches the rate for a sale of sBTC, floored.
  const fair = (rate[0] * 10_000_000_000n) / rate[1];
  const setPrice = (price: bigint): string => {
    const set = simnet.callPublicFn(
      "mock-oracle",
      "set-value-aged",
      [Cl.stringAscii(ORACLE_KEY), Cl.uint(price), Cl.uint(0n)],
      c.deployer,
    );
    if (set.result.type !== "ok") throw new Error("set-value-aged failed");
    model.price = price;
    return `oracle price ${price}`;
  };
  log.push(`setup: ${setPrice(fair)}`);

  const startWallets = new Map<string, bigint>();
  const key = (who: string, token: string) => `${who}|${token}`;
  for (const role of ROLES)
    for (const t of [c.sbtc, c.usd])
      startWallets.set(key(a[role], t), wallet(c, t, a[role]));
  let prevWallets = new Map(startWallets);

  const caps = [1n, 10n, 100n, 1_000n, 10_000n, 100_000n];
  const now = () => BigInt(simnet.burnBlockHeight);
  // Amounts that walk `token`'s day window up to its cap and past it: the
  // full per-trade cap while more room is left than that, then the exact room
  // or one over it, and 1 once the window is full. Empty when the token has
  // no per-trade cap.
  const roomAmounts = (token: string): bigint[] => {
    const { perTrade, perDay } = capsOf(model, token);
    const room = perDay - windowTotal(model, token, now());
    if (perTrade < 1n) return [];
    if (room < 1n) return [1n];
    if (room > perTrade) return [perTrade];
    return [room, room + 1n].filter((v) => v <= perTrade);
  };
  const swapCall = (who: Role): Call => {
    // About a third of swaps aim at the day cap of a token with caps set;
    // their min-out clears the floor, so the caps are what decide them.
    const aimable = [c.sbtc, c.usd].filter((t) => roomAmounts(t).length > 0);
    const aim = chance(r, 0.35) && aimable.length > 0;
    const dir = aim ? pick(r, aimable) === c.sbtc : chance(r, 0.5);
    const tokenIn = dir ? c.sbtc : c.usd;
    const tokenOut = dir ? c.usd : c.sbtc;
    const sameToken = chance(r, 0.03);
    const amountIn = aim
      ? pick(r, roomAmounts(tokenIn))
      : amount(r, capsOf(model, tokenIn).perTrade);
    // The floor as the model sees it, which the bounds may not have set.
    const floor =
      model.slippageBps < 10_000n
        ? floorOf(amountIn, model.price, model.slippageBps, dir)
        : 0n;
    const minOut = aim
      ? floor
      : pick(r, [
          0n,
          floor > 0n ? floor - 1n : 0n,
          floor,
          (amountIn * rate[0]) / rate[1],
        ]);
    return {
      who,
      fn: "execute-swap",
      args: [
        Cl.principal(a.owner),
        Cl.principal(c.dex),
        Cl.principal(tokenIn),
        Cl.principal(sameToken ? tokenIn : tokenOut),
        Cl.uint(amountIn),
        Cl.uint(minOut),
      ],
    };
  };
  const capsCall = (
    token = chance(r, 0.05) ? evil : pick(r, [c.sbtc, c.usd]),
  ): Call => {
    const perTrade = pick(r, caps);
    const invalid = chance(r, 0.1);
    // A small multiple half the time, so a few swaps can reach the day cap.
    const days = chance(r, 0.5)
      ? pick(r, [1n, 1n, 2n, 3n])
      : BigInt(int(r, 1, 20));
    const perDay = invalid
      ? perTrade - 1n
      : perTrade * days + (chance(r, 0.3) ? 1n : 0n);
    return {
      who: "owner",
      fn: "set-token-caps",
      args: [
        Cl.principal(token),
        Cl.uint(perTrade),
        Cl.uint(perDay < 0n ? 0n : perDay),
      ],
    };
  };
  const policyCall = (): Call => {
    const cooldown = chance(r, 0.7) ? 0n : BigInt(int(r, 1, 30));
    const now = BigInt(simnet.burnBlockHeight);
    const expiry = chance(r, 0.1)
      ? now - 1n
      : chance(r, 0.1)
        ? MAX_UINT
        : now + BigInt(int(r, 0, 500));
    return {
      who: "owner",
      fn: "set-policy",
      args: [Cl.uint(cooldown), Cl.uint(expiry)],
    };
  };
  const boundsCall = (
    bps = pick(r, [0n, 1n, 100n, 500n, 9_999n, 10_000n]),
    age = chance(r, 0.1) ? 0n : MAX_AGE_MS,
  ): Call => ({
    who: "owner",
    fn: "set-price-bounds",
    args: [Cl.uint(bps), Cl.uint(age)],
  });
  const depositCall = (who: Role, token = pick(r, [c.sbtc, c.usd])): Call => ({
    who,
    fn: "deposit",
    args: [Cl.principal(token), Cl.uint(amount(r, 1_000_000n))],
  });

  // Early setup, each step dropped now and then so refusals still show up.
  const preludeAll: Call[] = [
    boundsCall(pick(r, [1n, 100n, 500n, 9_999n]), MAX_AGE_MS),
    capsCall(c.sbtc),
    capsCall(c.usd),
    policyCall(),
    {
      who: "owner",
      fn: "allow-token",
      args: [Cl.principal(c.sbtc), Cl.bool(true)],
    },
    {
      who: "owner",
      fn: "allow-token",
      args: [Cl.principal(c.usd), Cl.bool(true)],
    },
    {
      who: "owner",
      fn: "allow-adapter",
      args: [Cl.principal(c.dex), Cl.bool(true)],
    },
    { who: "owner", fn: "set-agent", args: [Cl.principal(a.agent)] },
    {
      who: "owner",
      fn: "deposit",
      args: [Cl.principal(c.sbtc), Cl.uint(BigInt(int(r, 1_000, 2_000_000)))],
    },
    {
      who: "owner",
      fn: "deposit",
      args: [Cl.principal(c.usd), Cl.uint(BigInt(int(r, 1_000, 2_000_000)))],
    },
  ];
  const prelude = preludeAll.filter(() => !chance(r, 0.05));

  const nextCall = (): Call | "advance" => {
    // About 5%: new price bounds, or the deployer moves the oracle price.
    if (chance(r, 0.05))
      return chance(r, 0.5)
        ? boundsCall()
        : {
            who: "chain",
            fn: "set-oracle-price",
            args: [Cl.uint((fair * pick(r, [1n, 2n, 4n])) / 2n)],
          };
    const k = r();
    if (k < 0.12) return "advance";
    if (k < 0.5)
      return swapCall(
        pick(r, ["agent", "agent", "agent", "stranger1", "stranger2"] as const),
      );
    if (k < 0.555) return capsCall();
    if (k < 0.58) return policyCall();
    if (k < 0.66) return depositCall("owner");
    if (k < 0.74)
      return {
        who: "owner",
        fn: "withdraw",
        args: [
          Cl.principal(pick(r, [c.sbtc, c.usd])),
          Cl.uint(amount(r, 500_000n)),
        ],
      };
    if (k < 0.78)
      return {
        who: "owner",
        fn: "allow-token",
        args: [Cl.principal(pick(r, [c.sbtc, c.usd])), Cl.bool(chance(r, 0.8))],
      };
    if (k < 0.81)
      return {
        who: "owner",
        fn: "allow-adapter",
        args: [Cl.principal(c.dex), Cl.bool(chance(r, 0.8))],
      };
    if (k < 0.85)
      return {
        who: "owner",
        fn: "set-agent",
        args: [Cl.principal(chance(r, 0.85) ? a.agent : a.stranger1)],
      };
    if (k < 0.87) return { who: "owner", fn: "remove-agent", args: [] };
    if (k < 0.9)
      return {
        who: "owner",
        fn: chance(r, 0.5) ? "pause" : "unpause",
        args: [],
      };
    if (k < 0.93)
      return {
        who: pick(r, ["agent", "stranger1", "stranger2"] as const),
        fn: "withdraw",
        args: [
          Cl.principal(pick(r, [c.sbtc, c.usd])),
          Cl.uint(amount(r, 1_000n)),
        ],
      };
    if (k < 0.96)
      return depositCall(pick(r, ["agent", "stranger1", "stranger2"] as const));
    return {
      who: pick(r, ["stranger1", "stranger2"] as const),
      fn: "set-agent",
      args: [Cl.principal(pick(r, [a.owner, a.agent]))],
    };
  };

  // Each call after the prelude is drawn just before it runs, so it sees the
  // caps, bounds and day window the earlier calls left.
  const total = Math.max(int(r, 10, 40), prelude.length);

  const fail = (index: number, why: string): never => {
    throw new Error(
      `keelio-vault property failed: ${why}\nseed: ${seed} (replay: KEELIO_SEED=${seed})\ncalls:\n${log.join("\n")}\n(failed at call ${index})`,
    );
  };

  try {
    for (let i = 0; i < total; i++) {
      const step = prelude[i] ?? nextCall();
      const index = i + 1;

      if (step === "advance") {
        const n = chance(r, 0.5) ? int(r, 0, 10) : int(r, 0, 200);
        simnet.mineEmptyBurnBlocks(n);
        c.cache.clear();
        log.push(
          `${index}. chain mineEmptyBurnBlocks(${n}) -> height ${simnet.burnBlockHeight}`,
        );
        continue;
      }

      if (step.who === "chain") {
        log.push(`${index}. chain ${setPrice(readUint(step.args[0]!, false))}`);
        c.cache.clear();
        continue;
      }

      const owner = a.owner;
      const who = a[step.who as Role];
      const now = BigInt(simnet.burnBlockHeight);
      const ownerLedgerBefore = [c.sbtc, c.usd].map((t) => ledger(c, owner, t));
      const ownerWalletBefore = [c.sbtc, c.usd].map((t) => wallet(c, t, owner));
      const ownLedgerBefore = new Map(
        [c.sbtc, c.usd].map((t) => [t, ledger(c, who, t)]),
      );

      // Check 8 (shipped vault only: a mutant disagrees by design): read the
      // vault with the SDK before the swap, so checkIntent sees what
      // execute-swap will see.
      const parityRead =
        vault === undefined && step.fn === "execute-swap"
          ? await readVault(
              simnetClient(simnet, c.deployer),
              {
                vault: c.vaultName,
                tokens: [c.sbtc, c.usd],
                adapters: [c.dex],
                oracle: "mock-oracle",
                sbtcToken: c.sbtc,
                priceScale: PRICE_SCALE,
              },
              owner,
            )
          : undefined;

      const res = simnet.callPublicFn(c.vaultName, step.fn, step.args, who);
      c.cache.clear();
      const ok = res.result.type === "ok";
      log.push(
        `${index}. ${describeCall(c, step)} @${now} -> ${cvToString(res.result)}`,
      );

      // Track what the test believes the vault now holds.
      if (step.fn === "set-token-caps") {
        const token = cvToString(step.args[0]!);
        const [t, d] = step.args.slice(1).map((x) => readUint(x, false)) as [
          bigint,
          bigint,
        ];
        const accepted = token === c.sbtc || token === c.usd;
        // The fixed-set check comes first, so u106 wins over u105.
        const expected = !accepted
          ? Cl.error(Cl.uint(106))
          : d < t
            ? Cl.error(Cl.uint(105))
            : Cl.ok(Cl.bool(true));
        if (cvToString(res.result) !== cvToString(expected))
          fail(index, "set-token-caps accepted or refused wrongly");
        if (ok) model.caps.set(token, { perTrade: t, perDay: d });
      }
      if (step.fn === "set-policy") {
        const [cd, e] = step.args.map((x) => readUint(x, false)) as [
          bigint,
          bigint,
        ];
        // set-policy has no refusal path.
        if (cvToString(res.result) !== cvToString(Cl.ok(Cl.bool(true))))
          fail(index, "set-policy refused");
        model.cooldown = cd;
        model.expiry = e;
      }
      if (step.fn === "set-price-bounds") {
        const [bps, age] = step.args.map((x) => readUint(x, false)) as [
          bigint,
          bigint,
        ];
        const expected =
          bps >= 10_000n ? Cl.error(Cl.uint(120)) : Cl.ok(Cl.bool(true));
        if (cvToString(res.result) !== cvToString(expected))
          fail(index, "set-price-bounds accepted or refused wrongly");
        if (ok) {
          model.slippageBps = bps;
          model.maxPriceAge = age;
        }
      }
      if (step.fn === "execute-swap" && res.result.type === "err") {
        const code = Number(readUint(res.result.value, false));
        stats.refused[code] = (stats.refused[code] ?? 0) + 1;
      }

      // Check 8: checkIntent gives the contract's answer for this swap: the
      // same refusal code, or ok for a success and for the refusals decided
      // only after the adapter call (u104, u117, u118).
      if (parityRead !== undefined) {
        const check = checkIntent(
          {
            ...parityRead,
            burnHeight: now,
            // The block the swap ran in; execute-swap reads stacks-block-time.
            nowMs: BigInt(simnet.getBlockTime()) * 1000n,
          },
          {
            caller: who,
            adapter: cvToString(step.args[1]!),
            tokenIn: cvToString(step.args[2]!),
            tokenOut: cvToString(step.args[3]!),
            amountIn: readUint(step.args[4]!, false),
            minOut: readUint(step.args[5]!, false),
          },
        );
        const code =
          res.result.type === "err"
            ? Number(readUint(res.result.value, false))
            : null;
        const predicted = RULES.some((rule) => rule.errorCode === code);
        const agrees =
          code === null || !predicted
            ? check.ok
            : !check.ok && check.errorCode === code;
        if (!agrees)
          fail(
            index,
            `check 8: execute-swap gave ${cvToString(res.result)} but checkIntent gave ${check.ok ? "ok" : `u${check.errorCode} ${check.rule}`}`,
          );
        const label = code === null ? "ok" : `u${code}`;
        stats.parity[label] = (stats.parity[label] ?? 0) + 1;
      }
      if (ok && step.who === "owner" && step.fn === "set-agent")
        model.agent =
          ROLES.find((role) => cvToString(step.args[0]!) === a[role]) ?? null;
      if (ok && step.who === "owner" && step.fn === "remove-agent")
        model.agent = null;
      if (ok && step.who === "owner" && step.fn === "pause")
        model.paused = true;
      if (ok && step.who === "owner" && step.fn === "unpause")
        model.paused = false;

      // Check 3 and 4: caps for each successful swap.
      if (step.fn === "execute-swap" && ok) {
        const tokenIn = cvToString(step.args[2]!);
        const tokenInIdx = tokenIn === c.sbtc ? 0 : 1;
        const spent =
          ownerLedgerBefore[tokenInIdx]! - ledger(c, owner, tokenIn);
        if (spent < 0n) fail(index, "swap raised the input ledger");
        const caps = capsOf(model, tokenIn);
        if (spent > caps.perTrade)
          fail(
            index,
            `check 3: spent ${spent} > ${tokenIn} max-per-trade ${caps.perTrade}`,
          );
        const swaps = model.swaps.get(tokenIn) ?? [];
        swaps.push({ height: now, amount: spent });
        model.swaps.set(tokenIn, swaps);
        // Only token-in's own swaps count towards its day cap.
        const windowTotal = swaps
          .filter((s) => s.height > now - DAY_BLOCKS && s.height <= now)
          .reduce((sum, s) => sum + s.amount, 0n);
        if (windowTotal > caps.perDay)
          fail(
            index,
            `check 4: ${tokenIn} window total ${windowTotal} > max-per-day ${caps.perDay}`,
          );
        const reported = cvToString(
          simnet.callReadOnlyFn(
            c.vaultName,
            "get-trade-state",
            [Cl.principal(owner), Cl.principal(tokenIn)],
            owner,
          ).result,
        );
        if (!reported.includes(`(day-total u${windowTotal})`))
          fail(
            index,
            `check 4: get-trade-state ${reported} != model total ${windowTotal}`,
          );
        // Check 7: no swap while the owner has the vault paused.
        if (model.paused)
          fail(index, "check 7: a swap succeeded while the vault was paused");
        // The owner may name stranger1 the agent; then its swaps are the
        // agent's. Any other actor's swap also fails the agent check below.
        if (
          (step.who === "stranger1" || step.who === "stranger2") &&
          model.agent !== step.who
        )
          fail(index, "check 5: a stranger's swap succeeded");

        // Check 6: the owner received at least the oracle floor, and only
        // with both price bounds set.
        if (model.slippageBps === 0n || model.maxPriceAge === 0n)
          fail(index, "check 6: a swap succeeded with a price bound unset");
        const tokenOut = cvToString(step.args[3]!);
        const received =
          ledger(c, owner, tokenOut) - ownerLedgerBefore[1 - tokenInIdx]!;
        const floor = floorOf(
          readUint(step.args[4]!, false),
          model.price,
          model.slippageBps,
          tokenIn === c.sbtc,
        );
        stats.checkedFloor += 1;
        if (received < floor)
          fail(
            index,
            `check 6: received ${received} of ${tokenOut} < oracle floor ${floor}`,
          );
        if (model.agent !== step.who)
          fail(
            index,
            "check 5: a swap succeeded for an actor that is not the agent",
          );
      }

      // Check 1: vault balance equals the sum of ledgers.
      for (const t of [c.sbtc, c.usd]) {
        let sum = 0n;
        for (const role of ROLES) sum += ledger(c, a[role], t);
        const held = wallet(c, t, c.vault);
        if (held !== sum)
          fail(
            index,
            `check 1: vault holds ${held} of ${t} but ledgers sum to ${sum}`,
          );
      }

      // Check 2: a non-owner never gains. Wallet plus ledger never exceeds the
      // starting wallet, and the wallet only rises by a successful withdraw of
      // at most that actor's own earlier ledger.
      const nowWallets = new Map<string, bigint>();
      for (const role of ["agent", "stranger1", "stranger2"] as const) {
        for (const t of [c.sbtc, c.usd]) {
          const w = wallet(c, t, a[role]);
          nowWallets.set(key(a[role], t), w);
          const start = startWallets.get(key(a[role], t))!;
          const prev = prevWallets.get(key(a[role], t))!;
          if (w > start)
            fail(index, `check 2: ${role} wallet ${w} > start ${start}`);
          if (w > prev) {
            const own = step.who === role && step.fn === "withdraw";
            const allowed = own ? ownLedgerBefore.get(t)! : 0n;
            if (!own || !ok || w - prev > allowed)
              fail(
                index,
                `check 2: ${role} wallet rose ${prev} -> ${w} without its own withdrawal`,
              );
          }
          if (w + ledger(c, a[role], t) > start)
            fail(index, `check 2: ${role} holds more than at the start`);
        }
      }
      prevWallets = nowWallets;

      // Check 5: a non-owner's call never takes the owner's funds out.
      if (step.who !== "owner") {
        const ownerWalletAfter = [c.sbtc, c.usd].map((t) =>
          wallet(c, t, owner),
        );
        if (ownerWalletAfter.some((w, k) => w !== ownerWalletBefore[k]))
          fail(index, "check 5: a non-owner call changed the owner's wallet");
        if (step.fn !== "execute-swap") {
          const after = [c.sbtc, c.usd].map((t) => ledger(c, owner, t));
          if (after.some((l, k) => l !== ownerLedgerBefore[k]))
            fail(index, "check 5: a non-owner call changed the owner's ledger");
        }
        if (step.fn === "withdraw" && ok) {
          const t = cvToString(step.args[0]!);
          const amt = readUint(step.args[1]!, false);
          if (amt > ownLedgerBefore.get(t)!)
            fail(
              index,
              "check 5: withdraw paid out more than the caller's own ledger",
            );
        }
      }
    }

    // Check 1 reads the balances map directly; the public get-balance must
    // agree with it for every role and token.
    for (const role of ROLES)
      for (const t of [c.sbtc, c.usd]) {
        const v = publicLedgerRead(c, a[role], t);
        const m = ledgerRead(c, a[role], t);
        if (v !== m)
          fail(total, `check 1: get-balance ${v} != balances map ${m}`);
      }
  } catch (e) {
    if (
      e instanceof Error &&
      e.message.startsWith("keelio-vault property failed")
    )
      throw e;
    throw new Error(
      `keelio-vault property failed: ${e instanceof Error ? e.message : String(e)}\nseed: ${seed} (replay: KEELIO_SEED=${seed})\ncalls:\n${log.join("\n")}`,
      { cause: e },
    );
  }
  return stats;
}

/**
 * Vault copies with one safety rule removed each, and the check that must
 * catch it. Each target is a whole source line, matched after trimming.
 */
export const MUTANTS = [
  {
    name: "day-cap",
    targets: [
      "(asserts! (<= day-total max-per-day) ERR-DAY-CAP-EXCEEDED)",
      "(asserts! (<= amount-in (- max-per-day day-total)) ERR-DAY-CAP-EXCEEDED)",
    ],
    check: "check 4:",
  },
  {
    name: "trade-cap",
    targets: [
      "(asserts! (<= amount-in (get max-per-trade policy)) ERR-TRADE-CAP-EXCEEDED)",
    ],
    check: "check 3:",
  },
  {
    name: "agent",
    targets: [
      "(asserts! (is-eq (get agent vault) (some agent)) ERR-NOT-AGENT)",
    ],
    check: "check 5:",
  },
  {
    name: "pause",
    targets: ["(asserts! (not (get paused vault)) ERR-VAULT-PAUSED)"],
    check: "check 7:",
  },
] as const;

export type MutantName = (typeof MUTANTS)[number]["name"];

/**
 * `source` with mutant `name`'s target lines removed. Throws unless each
 * target is in `source` exactly once, so a renamed line can never leave a
 * mutant that is a silent copy of the real vault.
 */
export function mutate(source: string, name: MutantName): string {
  const mutant = MUTANTS.find((m) => m.name === name);
  if (!mutant) throw new Error(`unknown mutant ${name}`);
  let lines = source.split("\n");
  for (const target of mutant.targets) {
    const found = lines.filter((line) => line.trim() === target).length;
    if (found !== 1)
      throw new Error(
        `mutant ${name}: expected exactly one "${target}" in contracts/keelio-vault.clar, found ${found}`,
      );
    lines = lines.filter((line) => line.trim() !== target);
  }
  return lines.join("\n");
}
