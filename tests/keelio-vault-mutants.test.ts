import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BASE_SEED,
  MUTANTS,
  SEQUENCES,
  mutate,
  runSequence,
  type VaultCopy,
} from "./vault-property.js";

// Mutation test for the keelio-vault property run. Each mutant is a copy of the
// shipped vault with one safety rule removed; the property run over the same
// seeds must fail on it with the check that guards that rule. The control is
// an unmodified copy deployed the same way, and must pass every sequence.
// Each sequence has its own simnet, so every copy deploys as one name.

const source = readFileSync(
  new URL("../contracts/keelio-vault.clar", import.meta.url),
  "utf8",
);

const NAME = "keelio-vault-mutant";
const seeds = Array.from({ length: SEQUENCES }, (_, i) => BASE_SEED + i);

/** The first property failure over all seeds, or undefined if all pass. */
async function firstFailure(vault: VaultCopy): Promise<Error | undefined> {
  for (const seed of seeds) {
    try {
      await runSequence(seed, vault);
    } catch (e) {
      if (e instanceof Error) return e;
      throw e;
    }
  }
  return undefined;
}

describe("keelio-vault mutants", () => {
  it.each(MUTANTS)(
    "the property run fails on the $name mutant with $check",
    async ({ name, check }) => {
      const failure = await firstFailure({
        name: NAME,
        source: mutate(source, name),
      });
      if (!failure)
        throw new Error(`mutant ${name} survived ${SEQUENCES} sequences`);
      const message = failure.message;
      console.log(
        `mutant ${name}: ${message.split("\n").slice(0, 2).join(" | ")}`,
      );
      // The exact check prefix, so a crash wrapped as a property failure, or
      // a different check, never counts as caught.
      expect(message.startsWith(`keelio-vault property failed: ${check}`)).toBe(
        true,
      );
      expect(message).toContain("seed: ");
      expect(message).toMatch(/^1\. /m);
    },
    120_000,
  );

  it("an unmodified copy passes all 200 sequences", async () => {
    let done = 0;
    for (const seed of seeds) {
      await runSequence(seed, { name: NAME, source });
      done += 1;
    }
    expect(done).toBe(200);
  }, 120_000);

  it("the property run fails when get-balance disagrees with the balances map", async () => {
    // Check 1 reads the map directly; the end-of-sequence cross-check is
    // what keeps the public read covered. The copy keeps the vault's own
    // reads on the map (renamed) and adds a public get-balance one too high.
    const define = "(define-read-only (get-balance\n";
    const uses = "(get-balance owner ";
    expect(source.split(define).length).toBe(2);
    expect(source.split(uses).length).toBe(7);
    const offByOne =
      source
        .replace(define, "(define-read-only (ledger-balance\n")
        .replaceAll(uses, "(ledger-balance owner ") +
      "\n(define-read-only (get-balance (owner principal) (token principal))\n  (+ (ledger-balance owner token) u1))\n";
    const failure = await firstFailure({ name: NAME, source: offByOne });
    const match = failure?.message.match(
      /^keelio-vault property failed: check 1: get-balance (\d+) != balances map (\d+)\n/,
    );
    expect(match).not.toBeNull();
    expect(BigInt(match![1]!)).toBe(BigInt(match![2]!) + 1n);
  }, 120_000);

  it("mutate throws when a target is missing", () => {
    const changed = source.replace(
      "(asserts! (not (get paused vault)) ERR-VAULT-PAUSED)",
      "(asserts! (not (get paused vault)) ERR-VAULT-IS-PAUSED)",
    );
    expect(changed).not.toBe(source);
    expect(() => mutate(changed, "pause")).toThrow(
      'mutant pause: expected exactly one "(asserts! (not (get paused vault)) ERR-VAULT-PAUSED)" in contracts/keelio-vault.clar, found 0',
    );
  });

  it("each mutant removes exactly its target lines", () => {
    for (const { name, targets } of MUTANTS) {
      const mutant = mutate(source, name);
      expect(source.split("\n").length - mutant.split("\n").length).toBe(
        targets.length,
      );
      for (const target of targets) expect(mutant).not.toContain(target);
    }
  });
});
