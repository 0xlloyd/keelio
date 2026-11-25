import { describe, expect, it } from "vitest";
import {
  BASE_SEED,
  SEQUENCES,
  parseSeedEnv,
  runSequence,
} from "./vault-property.js";

// Property test for keelio-vault: random call sequences from a seeded generator,
// each on a fresh simnet, with the safety claims checked after every call.
// The engine is in tests/vault-property.ts; tests/keelio-vault-mutants.test.ts
// shows each check fails on a vault copy with its rule removed.
//
// Replay one sequence: KEELIO_SEED=<seed> pnpm exec vitest run tests/keelio-vault-property.test.ts
// A failure prints the seed and the numbered call list. Sequence `i` uses seed
// BASE_SEED + i. Without KEELIO_SEED the file runs SEQUENCES sequences.

// execute-swap refusals each check relies on: u108 not agent (check 5), u109
// paused (check 7), u114 trade cap (check 3), u115 day cap (check 4), u125
// below the oracle floor (check 6).
const REFUSALS = [108, 109, 114, 115, 125] as const;

// Check 8 runs the SDK's readVault and checkIntent before every swap and
// requires the contract's answer: the same refusal code, or ok for a success
// and for the refusals decided only after the adapter call (u117 here). It
// must have compared successes and each of these refusals. The oracle's own
// refusals (u121 to u124) are in tests/sdk-check-intent.test.ts.
const PARITY = [
  "ok",
  "u100",
  "u101",
  "u108",
  "u109",
  "u110",
  "u111",
  "u112",
  "u113",
  "u114",
  "u115",
  "u116",
  "u117",
  "u119",
  "u125",
] as const;

describe("keelio-vault property test", () => {
  it("holds the safety claims over random call sequences", async () => {
    const only = parseSeedEnv(process.env.KEELIO_SEED);
    const seeds =
      only === undefined
        ? Array.from({ length: SEQUENCES }, (_, i) => BASE_SEED + i)
        : [only];
    let done = 0;
    let checkedFloor = 0;
    const refused: Record<number, number> = {};
    const parity: Record<string, number> = {};
    for (const seed of seeds) {
      const stats = await runSequence(seed);
      checkedFloor += stats.checkedFloor;
      for (const [label, n] of Object.entries(stats.parity))
        parity[label] = (parity[label] ?? 0) + n;
      for (const [code, n] of Object.entries(stats.refused))
        refused[Number(code)] = (refused[Number(code)] ?? 0) + n;
      done += 1;
    }
    const counts = REFUSALS.map((c) => `u${c} ${refused[c] ?? 0}`).join(", ");
    console.log(
      `keelio-vault property: ${done} sequences passed, ${checkedFloor} swaps at or above the oracle floor, ${refused[125] ?? 0} refused below it; swaps refused: ${counts}`,
    );
    const parityCounts = Object.entries(parity)
      .sort(([x], [y]) => x.localeCompare(y))
      .map(([label, n]) => `${label} ${n}`)
      .join(", ");
    console.log(`checkIntent agreed with execute-swap on: ${parityCounts}`);
    expect(done).toBe(seeds.length);
    if (only === undefined) {
      expect(done).toBeGreaterThanOrEqual(200);
      for (const code of REFUSALS)
        expect(refused[code] ?? 0, `u${code} refusals`).toBeGreaterThan(0);
      expect(checkedFloor).toBeGreaterThan(0);
      // Check 8 compared successes and every refusal the run reaches.
      for (const label of PARITY)
        expect(parity[label] ?? 0, `check 8 on ${label}`).toBeGreaterThan(0);
    }
  }, 300_000);
});

describe("KEELIO_SEED", () => {
  it.each([
    "",
    "abc",
    "NaN",
    "-1",
    "1.5",
    "+5",
    "1e3",
    " 7",
    "7 ",
    "4294967296",
    "99999999999999999999",
  ])("refuses %j", (value) => {
    expect(() => parseSeedEnv(value)).toThrow(
      `KEELIO_SEED must be a whole number from 0 to 4294967295, got "${value}"`,
    );
  });

  it.each([
    ["0", 0],
    ["20260000", 20_260_000],
    ["4294967295", 4_294_967_295],
    [undefined, undefined],
  ])("accepts %j", (value, seed) => {
    expect(parseSeedEnv(value)).toBe(seed);
  });
});
