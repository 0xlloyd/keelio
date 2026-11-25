import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { initSimnet } from "@stacks/clarinet-sdk";
import { Cl } from "@stacks/transactions";
import { describe, expect, it } from "vitest";
import {
  blankStrings,
  checkDeployConfig,
  checkOracleConfig,
  fungibleTokenNames,
  simnetReader,
  stripComments,
  type ConfigReader,
  type FunctionSignature,
  type SourceReader,
} from "../scripts/check-deploy-config.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const simnet = await initSimnet();
const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const alice = accounts.get("wallet_1")!;

const source = readFileSync(
  new URL("../contracts/keelio-vault.clar", import.meta.url),
  "utf8",
);

function replaceOnce(text: string, from: string, to: string): string {
  const changed = text.replace(from, to);
  expect(changed).not.toBe(text);
  return changed;
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** A reader over a fixed map of contract id to source. */
function stub(sources: Record<string, string>): SourceReader {
  return { getContractSource: (id) => sources[id] };
}

const SP = "SP000000000000000000002Q6VF78";

/** A minimal vault with one `with-ft` on a token at `SP.token`. */
function stubVault(nameArg: string, nameValue = '"tok"'): string {
  return [
    `(define-constant TOKEN '${SP}.token)`,
    `(define-constant TOKEN-FT ${nameValue})`,
    `(define-public (f (amount uint))`,
    `  (as-contract? ((with-ft TOKEN ${nameArg} amount)) (ok true)))`,
  ].join("\n");
}

function checkNamed(tokenSource: string | undefined, assetName: string) {
  const reader = stub({
    [`${SP}.vault`]: stubVault("TOKEN-FT", `"${assetName}"`),
    ...(tokenSource === undefined ? {} : { [`${SP}.token`]: tokenSource }),
  });
  return checkDeployConfig(reader, `${SP}.vault`);
}

describe("checkDeployConfig on the simnet", () => {
  it("passes the committed vault and lists both tokens", () => {
    expect(checkDeployConfig(simnet, `${deployer}.keelio-vault`)).toStrictEqual(
      {
        ok: true,
        tokens: [
          {
            constant: "ALLOWED-TOKEN",
            principal: `${deployer}.mock-sbtc`,
            nameConstant: "ALLOWED-TOKEN-FT",
            assetName: "mock-sbtc",
          },
          {
            constant: "QUOTE-TOKEN",
            principal: `${deployer}.mock-usd`,
            nameConstant: "QUOTE-TOKEN-FT",
            assetName: "mock-usd",
          },
        ],
      },
    );
  });

  it("refuses a copy with a wrong asset name, naming the token, and that copy strands withdrawals", () => {
    const wrong = replaceOnce(
      source,
      '(define-constant QUOTE-TOKEN-FT "mock-usd")',
      '(define-constant QUOTE-TOKEN-FT "usd")',
    );
    const { result: deployed } = simnet.deployContract(
      "vault-wrong-name",
      wrong,
      { clarityVersion: 4 },
      deployer,
    );
    expect(deployed).toStrictEqual(Cl.ok(Cl.bool(true)));

    const check = checkDeployConfig(simnet, `${deployer}.vault-wrong-name`);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.errors).toHaveLength(1);
    expect(check.errors[0]).toMatch(
      new RegExp(`^QUOTE-TOKEN \\(${deployer}\\.mock-usd\\): `),
    );
    expect(check.errors[0]).toContain('"usd"');
    for (const error of check.errors) {
      expect(error).not.toContain("ALLOWED-TOKEN");
    }

    // The mismatch the check prevents is real: the deposit lands and can't leave.
    const usd = Cl.contractPrincipal(deployer, "mock-usd");
    expect(
      simnet.callPublicFn(
        "mock-usd",
        "mint",
        [Cl.uint(100), Cl.principal(alice)],
        alice,
      ).result,
    ).toStrictEqual(Cl.ok(Cl.bool(true)));
    expect(
      simnet.callPublicFn(
        "vault-wrong-name",
        "deposit",
        [usd, Cl.uint(100)],
        alice,
      ).result,
    ).toStrictEqual(Cl.ok(Cl.uint(100)));
    expect(
      simnet.callPublicFn(
        "vault-wrong-name",
        "withdraw",
        [usd, Cl.uint(100)],
        alice,
      ).result,
    ).toStrictEqual(Cl.error(Cl.uint(104)));
  });
});

describe("the committed vault source", () => {
  it("declares each asset name once, in its -FT constant", () => {
    const code = stripComments(source);
    for (const [name, constant] of [
      ["mock-sbtc", "ALLOWED-TOKEN-FT"],
      ["mock-usd", "QUOTE-TOKEN-FT"],
    ] as const) {
      expect(count(code, `"${name}"`)).toBe(1);
      expect(count(source, `"${name}"`)).toBe(1);
      expect(code).toContain(`(define-constant ${constant} "${name}")`);
    }
    const withFt = [...code.matchAll(/\(\s*with-ft\s+(\S+)\s+(\S+)/g)];
    expect(withFt).toHaveLength(4);
    for (const match of withFt) {
      expect(match[2]).not.toContain('"');
    }
  });

  it("keeps the seven configuration constants in one block before the first map", () => {
    const block = [
      "(define-constant ALLOWED-TOKEN .mock-sbtc)",
      '(define-constant ALLOWED-TOKEN-FT "mock-sbtc")',
      "(define-constant QUOTE-TOKEN .mock-usd)",
      '(define-constant QUOTE-TOKEN-FT "mock-usd")',
      "(define-constant ALLOWED-ADAPTER .mock-dex)",
      "(define-constant ORACLE .mock-oracle)",
      "(define-constant PRICE-SCALE u10000000000)",
    ];
    const lines = source.split("\n");
    const start = lines.indexOf(block[0]!);
    expect(start).toBeGreaterThanOrEqual(0);
    const code = lines
      .slice(start)
      .filter((line) => line.trim() !== "" && !line.trim().startsWith(";"));
    expect(code.slice(0, block.length)).toStrictEqual(block);
    expect(start).toBeLessThan(
      lines.findIndex((line) => line.startsWith("(define-map")),
    );
  });
});

describe("stripComments and fungibleTokenNames", () => {
  it("strips comments but keeps a ; inside a string", () => {
    expect(stripComments('(a "x;y") ; note\n;; whole line\n(b)')).toBe(
      '(a "x;y") \n\n(b)',
    );
  });

  it("collects whole names outside comments", () => {
    expect(
      fungibleTokenNames(
        "(define-fungible-token sbtc-token)\n(define-fungible-token sbtc-token-locked)\n;; (define-fungible-token hidden)",
      ),
    ).toStrictEqual(["sbtc-token", "sbtc-token-locked"]);
  });

  it("ignores a define-fungible-token inside a string", () => {
    expect(
      fungibleTokenNames(
        '(print "(define-fungible-token x)") (define-fungible-token y)',
      ),
    ).toStrictEqual(["y"]);
  });

  it("blankStrings keeps quotes and length, and honours an escaped quote", () => {
    const input = '(a "x\\"(define-fungible-token z)" b)';
    const out = blankStrings(input);
    expect(out).toHaveLength(input.length);
    const first = input.indexOf('"');
    const last = input.lastIndexOf('"');
    expect(out.slice(0, first + 1)).toBe(input.slice(0, first + 1));
    expect(out.slice(first + 1, last)).toBe(" ".repeat(last - first - 1));
    expect(out.slice(last)).toBe('" b)');
    expect(blankStrings('"a\\nb"\n"c"')).toBe('"    "\n" "');

    expect(
      fungibleTokenNames(`${input} (define-fungible-token w)`),
    ).toStrictEqual(["w"]);
  });
});

describe("checkDeployConfig with a stub reader", () => {
  it("matches whole asset names only", () => {
    expect(
      checkNamed("(define-fungible-token sbtc-token-locked)", "sbtc-token").ok,
    ).toBe(false);
    expect(checkNamed("(define-fungible-token mock-sbtc)", "mock").ok).toBe(
      false,
    );
    expect(
      checkNamed(
        "(define-fungible-token sbtc-token)\n(define-fungible-token sbtc-token-locked)",
        "sbtc-token",
      ),
    ).toStrictEqual({
      ok: true,
      tokens: [
        {
          constant: "TOKEN",
          principal: `${SP}.token`,
          nameConstant: "TOKEN-FT",
          assetName: "sbtc-token",
        },
      ],
    });
  });

  it("ignores a define-fungible-token inside a comment", () => {
    const check = checkNamed(";; (define-fungible-token tok)", "tok");
    expect(check).toStrictEqual({
      ok: false,
      errors: [
        `TOKEN (${SP}.token): asset name "tok" (TOKEN-FT) is not a define-fungible-token in that contract; it defines: (none)`,
      ],
    });
  });

  it("fails, naming the token, when the quote token's source can't be read", () => {
    const vaultId = `${deployer}.keelio-vault`;
    const sbtcId = `${deployer}.mock-sbtc`;
    const reader = stub({
      [vaultId]: source,
      [sbtcId]: simnet.getContractSource(sbtcId)!,
    });
    const check = checkDeployConfig(reader, vaultId);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.errors).toHaveLength(1);
    expect(check.errors[0]).toMatch(
      new RegExp(`^QUOTE-TOKEN \\(${deployer}\\.mock-usd\\): `),
    );
  });

  it("fails when reading a token throws", () => {
    const reader: SourceReader = {
      getContractSource: (id) => {
        if (id === `${SP}.vault`) return stubVault("TOKEN-FT");
        throw new Error("boom");
      },
    };
    const check = checkDeployConfig(reader, `${SP}.vault`);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.errors[0]).toMatch(new RegExp(`^TOKEN \\(${SP}\\.token\\): `));
  });

  it("refuses a string literal or a wildcard as the asset name", () => {
    const token = { [`${SP}.token`]: "(define-fungible-token tok)" };
    for (const arg of ['"tok"', '"*"']) {
      const check = checkDeployConfig(
        stub({ [`${SP}.vault`]: stubVault(arg), ...token }),
        `${SP}.vault`,
      );
      expect(check.ok, arg).toBe(false);
    }
  });

  it("fails a token defined only inside a string", () => {
    const check = checkNamed('(print "(define-fungible-token real)")', "real");
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.errors[0]).toContain("is not a define-fungible-token");
    expect(check.errors[0]).toContain("it defines: (none)");
  });

  it("starts the literal asset name error with the token prefix", () => {
    const check = checkDeployConfig(
      stub({
        [`${SP}.vault`]: stubVault('"tok"'),
        [`${SP}.token`]: "(define-fungible-token tok)",
      }),
      `${SP}.vault`,
    );
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.errors[0]).toMatch(
      /^TOKEN \(SP000000000000000000002Q6VF78\.token\): .*literal/,
    );
  });

  it("does not count a with-ft or define-constant inside a string", () => {
    const vault = [
      `(define-constant TOKEN '${SP}.token)`,
      `(print "(define-constant TOKEN-FT \\"tok\\")")`,
      `(print "(with-ft TOKEN TOKEN-FT amount)")`,
    ].join("\n");
    expect(
      checkDeployConfig(stub({ [`${SP}.vault`]: vault }), `${SP}.vault`),
    ).toStrictEqual({
      ok: false,
      errors: [`${SP}.vault: no with-ft allowance found`],
    });
  });

  it("refuses a literal principal as the token", () => {
    const vault = stubVault("TOKEN-FT").replace(
      "(with-ft TOKEN ",
      `(with-ft '${SP}.token `,
    );
    const check = checkDeployConfig(
      stub({
        [`${SP}.vault`]: vault,
        [`${SP}.token`]: "(define-fungible-token tok)",
      }),
      `${SP}.vault`,
    );
    expect(check.ok).toBe(false);
  });

  it("refuses a token paired with two different name constants", () => {
    const vault = [
      stubVault("TOKEN-FT"),
      `(define-constant OTHER-FT "tok")`,
      `(define-public (g (amount uint))`,
      `  (as-contract? ((with-ft TOKEN OTHER-FT amount)) (ok true)))`,
    ].join("\n");
    const check = checkDeployConfig(
      stub({
        [`${SP}.vault`]: vault,
        [`${SP}.token`]: "(define-fungible-token tok)",
      }),
      `${SP}.vault`,
    );
    expect(check.ok).toBe(false);
  });

  it("refuses a constant defined twice", () => {
    const vault = `${stubVault("TOKEN-FT")}\n(define-constant TOKEN-FT "tok")`;
    const check = checkDeployConfig(
      stub({
        [`${SP}.vault`]: vault,
        [`${SP}.token`]: "(define-fungible-token tok)",
      }),
      `${SP}.vault`,
    );
    expect(check.ok).toBe(false);
  });

  it("refuses a vault with no with-ft at all", () => {
    const check = checkDeployConfig(
      stub({ [`${SP}.vault`]: "(define-public (f) (ok true))" }),
      `${SP}.vault`,
    );
    expect(check.ok).toBe(false);
  });

  it("refuses an unreadable vault", () => {
    expect(checkDeployConfig(stub({}), `${SP}.vault`)).toStrictEqual({
      ok: false,
      errors: [`keelio-vault source not found: ${SP}.vault`],
    });
  });
});

// The oracle half of the check: ORACLE and PRICE-SCALE.

const live = simnetReader(simnet);
const ORACLE_LINE = "(define-constant ORACLE .mock-oracle)";
const SCALE_LINE = "(define-constant PRICE-SCALE u10000000000)";
const TRAIT_SIGNATURE =
  "(get-value ((string-ascii 32)) (response { timestamp: uint, value: uint } uint))";

/** The live simnet, plus `vaultSource` as a vault that was never deployed. */
function withVault(vaultSource: string) {
  const id = `${deployer}.vault-under-check`;
  const reader: ConfigReader = {
    ...live,
    getContractSource: (other) =>
      other === id ? vaultSource : live.getContractSource(other),
  };
  return checkOracleConfig(reader, id);
}

function errorsOf(check: ReturnType<typeof checkOracleConfig>): string[] {
  expect(check.ok).toBe(false);
  return check.ok ? [] : check.errors;
}

// Not the vault: a small oracle stand-in needs nothing newer.
const oracleClarity = 3;

/** Deploys `body` as `name` on the simnet and checks the vault with ORACLE set to it. */
function checkWithOracle(name: string, body: string) {
  const { result } = simnet.deployContract(
    name,
    body,
    { clarityVersion: oracleClarity },
    deployer,
  );
  expect(result, name).toStrictEqual(Cl.ok(Cl.bool(true)));
  return withVault(
    replaceOnce(source, ORACLE_LINE, `(define-constant ORACLE .${name})`),
  );
}

describe("checkOracleConfig on the simnet", () => {
  it("passes the committed vault and says what it did not check", () => {
    const check = checkOracleConfig(live, `${deployer}.keelio-vault`);
    expect(check).toStrictEqual({
      ok: true,
      oracle: `${deployer}.mock-oracle`,
      priceScale: 10_000_000_000n,
      oracleDecimals: 8n,
      sbtc: { constant: "ALLOWED-TOKEN", decimals: 8n },
      quote: { constant: "QUOTE-TOKEN", decimals: 6n },
      notChecked: [expect.any(String), expect.any(String)],
    });
    if (!check.ok) return;
    expect(check.notChecked[0]).toContain("price decimals");
    expect(check.notChecked[0]).toContain("8");
    expect(check.notChecked[1]).toContain('"BTC/USD"');
  });

  it("hard-codes the signature that oracle-trait.clar declares", () => {
    const trait = stripComments(
      live.getContractSource(`${deployer}.oracle-trait`)!,
    ).replace(/\s+/g, " ");
    expect(trait).toContain(
      "(get-value ((string-ascii 32)) (response { value: uint, timestamp: uint } uint))",
    );
  });

  it("refuses a PRICE-SCALE that leaves out the tokens' decimals, stating the relation", () => {
    const errors = errorsOf(
      withVault(
        replaceOnce(
          source,
          SCALE_LINE,
          "(define-constant PRICE-SCALE u100000000)",
        ),
      ),
    );
    expect(errors).toStrictEqual([
      `PRICE-SCALE: is u100000000 but must be u10000000000 = 10^(8 + 8 - 6), that is 10^(oracle price decimals + ALLOWED-TOKEN decimals - QUOTE-TOKEN decimals): the oracle's price is taken to have 8 decimals, ALLOWED-TOKEN (${deployer}.mock-sbtc) get-decimals is 8 and QUOTE-TOKEN (${deployer}.mock-usd) get-decimals is 6. A wrong value moves every oracle floor by that factor.`,
    ]);
  });

  it("refuses the committed PRICE-SCALE when the quote token has other decimals", () => {
    // evil-token answers get-decimals with 8, so the scale must be 10^8.
    const errors = errorsOf(
      withVault(
        replaceOnce(
          source,
          "(define-constant QUOTE-TOKEN .mock-usd)",
          "(define-constant QUOTE-TOKEN .evil-token)",
        ),
      ),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(
      "is u10000000000 but must be u100000000 = 10^(8 + 8 - 8)",
    );
    expect(errors[0]).toContain(`QUOTE-TOKEN (${deployer}.evil-token)`);
  });

  it("refuses a token that has no get-decimals", () => {
    const errors = errorsOf(
      withVault(
        replaceOnce(
          source,
          "(define-constant QUOTE-TOKEN .mock-usd)",
          "(define-constant QUOTE-TOKEN .mock-dex)",
        ),
      ),
    );
    expect(errors).toStrictEqual([
      `PRICE-SCALE: not checked, because get-decimals of QUOTE-TOKEN (${deployer}.mock-dex) did not answer (ok uint) on the simnet`,
    ]);
  });

  it("is not fooled by a right PRICE-SCALE inside a string or a comment", () => {
    const decoys = `(print "${SCALE_LINE}")\n;; ${SCALE_LINE}\n`;
    const errors = errorsOf(
      withVault(
        replaceOnce(
          source,
          SCALE_LINE,
          `${decoys}(define-constant PRICE-SCALE u1)`,
        ),
      ),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("PRICE-SCALE: is u1 but must be u10000000000");

    const missing = errorsOf(
      withVault(replaceOnce(source, SCALE_LINE, decoys)),
    );
    expect(missing).toStrictEqual([
      "PRICE-SCALE: must be defined exactly once as (define-constant PRICE-SCALE u<number>)",
    ]);
  });

  it("refuses a PRICE-SCALE that is an expression or is defined twice", () => {
    for (const lines of [
      "(define-constant PRICE-SCALE (pow u10 u10))",
      `${SCALE_LINE}\n${SCALE_LINE}`,
      "(define-constant PRICE-SCALE 10000000000)",
    ]) {
      expect(
        errorsOf(withVault(replaceOnce(source, SCALE_LINE, lines))),
        lines,
      ).toStrictEqual([
        "PRICE-SCALE: must be defined exactly once as (define-constant PRICE-SCALE u<number>)",
      ]);
    }
  });

  it("passes an oracle in DIA's shape that never errs, and a public get-value", () => {
    const quiet = checkWithOracle(
      "oracle-never-errs",
      "(define-read-only (get-value (key (string-ascii 32))) (ok { value: u1, timestamp: u2 }))",
    );
    expect(quiet.ok).toBe(true);
    if (quiet.ok) expect(quiet.oracle).toBe(`${deployer}.oracle-never-errs`);
    expect(
      checkWithOracle(
        "oracle-public",
        "(define-public (get-value (key (string-ascii 32))) (if true (ok { timestamp: u2, value: u1 }) (err u1)))",
      ).ok,
    ).toBe(true);
  });

  it("refuses an oracle whose get-value exists only in a string and a comment", () => {
    const errors = errorsOf(
      checkWithOracle(
        "oracle-in-text-only",
        [
          ";; (define-read-only (get-value (key (string-ascii 32))) (ok { value: u1, timestamp: u2 }))",
          '(define-read-only (about) (ok "(define-read-only (get-value (key (string-ascii 32))) (ok { value: u1, timestamp: u2 }))"))',
        ].join("\n"),
      ),
    );
    expect(errors).toStrictEqual([
      `ORACLE (${deployer}.oracle-in-text-only): has no get-value function; oracle-trait needs a public or read-only ${TRAIT_SIGNATURE}`,
    ]);
  });

  it("refuses each wrong get-value signature, showing the one it found", () => {
    const wrong: [string, string, string][] = [
      [
        "oracle-short-key",
        "(define-read-only (get-value (key (string-ascii 16))) (if true (ok { value: u1, timestamp: u2 }) (err u1)))",
        "(get-value ((string-ascii 16)) (response { timestamp: uint, value: uint } uint))",
      ],
      [
        "oracle-two-args",
        "(define-read-only (get-value (key (string-ascii 32)) (n uint)) (if true (ok { value: n, timestamp: u2 }) (err u1)))",
        "(get-value ((string-ascii 32) uint) (response { timestamp: uint, value: uint } uint))",
      ],
      [
        "oracle-bare-price",
        "(define-read-only (get-value (key (string-ascii 32))) (if true (ok u1) (err u1)))",
        "(get-value ((string-ascii 32)) (response uint uint))",
      ],
      [
        "oracle-no-timestamp",
        "(define-read-only (get-value (key (string-ascii 32))) (if true (ok { value: u1 }) (err u1)))",
        "(get-value ((string-ascii 32)) (response { value: uint } uint))",
      ],
      [
        "oracle-int-price",
        "(define-read-only (get-value (key (string-ascii 32))) (if true (ok { value: 1, timestamp: u2 }) (err u1)))",
        "(get-value ((string-ascii 32)) (response { timestamp: uint, value: int } uint))",
      ],
      [
        "oracle-bool-error",
        "(define-read-only (get-value (key (string-ascii 32))) (if true (ok { value: u1, timestamp: u2 }) (err false)))",
        "(get-value ((string-ascii 32)) (response { timestamp: uint, value: uint } bool))",
      ],
      [
        "oracle-no-response",
        "(define-read-only (get-value (key (string-ascii 32))) { value: u1, timestamp: u2 })",
        "(get-value ((string-ascii 32)) { timestamp: uint, value: uint })",
      ],
    ];
    for (const [name, body, found] of wrong) {
      expect(errorsOf(checkWithOracle(name, body)), name).toStrictEqual([
        `ORACLE (${deployer}.${name}): get-value is read-only ${found}; oracle-trait needs a public or read-only ${TRAIT_SIGNATURE}`,
      ]);
    }
  });

  it("refuses a private get-value", () => {
    const errors = errorsOf(
      checkWithOracle(
        "oracle-private",
        [
          "(define-private (get-value (key (string-ascii 32))) (if true (ok { value: u1, timestamp: u2 }) (err u1)))",
          '(define-read-only (peek) (get-value "BTC/USD"))',
        ].join("\n"),
      ),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("get-value is private (get-value");
  });

  it("refuses an ORACLE that is not on the simnet, or is not one contract constant", () => {
    expect(
      errorsOf(
        withVault(
          replaceOnce(source, ORACLE_LINE, "(define-constant ORACLE .absent)"),
        ),
      ),
    ).toStrictEqual([
      `ORACLE (${deployer}.absent): contract not found on the simnet`,
    ]);
    for (const lines of [
      `(print "${ORACLE_LINE}")\n;; ${ORACLE_LINE}`,
      `${ORACLE_LINE}\n${ORACLE_LINE}`,
      '(define-constant ORACLE "mock-oracle")',
    ]) {
      expect(
        errorsOf(withVault(replaceOnce(source, ORACLE_LINE, lines))),
        lines,
      ).toStrictEqual([
        "ORACLE: must be defined exactly once as (define-constant ORACLE <contract principal>)",
      ]);
    }
  });
});

describe("checkOracleConfig with a stub reader", () => {
  const getValue: FunctionSignature = {
    access: "read_only",
    args: [{ name: "key", type: { "string-ascii": { length: 32 } } }],
    outputs: {
      type: {
        response: {
          ok: {
            tuple: [
              { name: "value", type: "uint128" },
              { name: "timestamp", type: "uint128" },
            ],
          },
          error: "uint128",
        },
      },
    },
  };

  function checkScale(
    scale: string,
    sbtcDecimals: bigint | undefined,
    quoteDecimals: bigint | undefined,
  ) {
    const vault = [
      `(define-constant ALLOWED-TOKEN '${SP}.sbtc)`,
      `(define-constant QUOTE-TOKEN '${SP}.usd)`,
      `(define-constant ORACLE '${SP}.oracle)`,
      `(define-constant PRICE-SCALE ${scale})`,
    ].join("\n");
    const decimals: Record<string, bigint | undefined> = {
      [`${SP}.sbtc`]: sbtcDecimals,
      [`${SP}.usd`]: quoteDecimals,
    };
    const reader: ConfigReader = {
      getContractSource: (id) =>
        ({ [`${SP}.vault`]: vault, [`${SP}.oracle`]: "(oracle)" })[id],
      getDecimals: (id) => decimals[id],
      getFunction: (id, name) =>
        id === `${SP}.oracle` && name === "get-value" ? getValue : undefined,
    };
    return checkOracleConfig(reader, `${SP}.vault`);
  }

  it("accepts exactly 10^(8 + sBTC decimals - quote decimals)", () => {
    expect(checkScale("u10000000000", 8n, 6n).ok).toBe(true);
    expect(checkScale("u1", 8n, 16n).ok).toBe(true);
    expect(checkScale("u100000000", 8n, 8n).ok).toBe(true);
    expect(checkScale("u100000000", 8n, 6n).ok).toBe(false);
    expect(checkScale("u10000000001", 8n, 6n).ok).toBe(false);
    expect(checkScale("u0", 8n, 6n).ok).toBe(false);
  });

  it("refuses a quote token with more decimals than a uint scale can express", () => {
    expect(errorsOf(checkScale("u1", 8n, 18n))).toStrictEqual([
      `PRICE-SCALE: no uint fits: it must be 10^(8 + 8 - 18) = 10^-2, a fraction. QUOTE-TOKEN (${SP}.usd) has more decimals than the oracle's price (8) and ALLOWED-TOKEN (${SP}.sbtc) together, which the vault's floor arithmetic cannot express.`,
    ]);
  });

  it("refuses a scale so large that PRICE-SCALE * BPS overflows a uint", () => {
    expect(checkScale(`u1${"0".repeat(34)}`, 32n, 6n).ok).toBe(true);
    const errors = errorsOf(checkScale(`u1${"0".repeat(35)}`, 33n, 6n));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("10^(8 + 33 - 6) = 10^35");
    expect(errors[0]).toContain("PRICE-SCALE * BPS");
  });

  it("refuses when either token's decimals can't be read", () => {
    expect(errorsOf(checkScale("u10000000000", undefined, 6n))).toStrictEqual([
      `PRICE-SCALE: not checked, because get-decimals of ALLOWED-TOKEN (${SP}.sbtc) did not answer (ok uint) on the simnet`,
    ]);
    expect(
      errorsOf(checkScale("u10000000000", undefined, undefined)),
    ).toHaveLength(2);
  });

  it("refuses a vault with no token constants, and an unreadable vault", () => {
    const reader: ConfigReader = {
      getContractSource: (id) =>
        id === `${SP}.vault`
          ? `(define-constant ORACLE '${SP}.oracle)\n(define-constant PRICE-SCALE u1)`
          : id === `${SP}.oracle`
            ? "(oracle)"
            : undefined,
      getDecimals: () => 8n,
      getFunction: () => getValue,
    };
    expect(errorsOf(checkOracleConfig(reader, `${SP}.vault`))).toStrictEqual([
      "PRICE-SCALE: not checked, because ALLOWED-TOKEN must be defined exactly once as (define-constant ALLOWED-TOKEN <contract principal>)",
      "PRICE-SCALE: not checked, because QUOTE-TOKEN must be defined exactly once as (define-constant QUOTE-TOKEN <contract principal>)",
    ]);
    expect(
      checkOracleConfig(
        { ...reader, getContractSource: () => undefined },
        `${SP}.vault`,
      ),
    ).toStrictEqual({
      ok: false,
      errors: [`keelio-vault source not found: ${SP}.vault`],
    });
  });
});

describe("pnpm run check-deploy", () => {
  it("prints an ok line per token, the oracle and the scale, then what it did not check", async () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts["check-deploy"]).toBe(
      "node --import ./scripts/resolve-ts.mjs scripts/check-deploy-config.ts",
    );

    const run = await runScript([
      "--import",
      "./scripts/resolve-ts.mjs",
      "scripts/check-deploy-config.ts",
    ]);
    expect(run.status, run.stderr).toBe(0);
    const ok = run.stdout.split("\n").filter((line) => line.startsWith("ok "));
    expect(ok).toHaveLength(4);
    expect(ok[0]).toContain('ALLOWED-TOKEN-FT "mock-sbtc"');
    expect(ok[1]).toContain('QUOTE-TOKEN-FT "mock-usd"');
    expect(ok[2]).toBe(
      `ok  ORACLE ${deployer}.mock-oracle  get-value matches oracle-trait`,
    );
    expect(ok[3]).toBe(
      "ok  PRICE-SCALE u10000000000 = 10^(8 + 8 - 6)  oracle price decimals 8 (assumed), ALLOWED-TOKEN decimals 8, QUOTE-TOKEN decimals 6",
    );
    const notChecked = run.stdout
      .split("\n")
      .filter((line) => line.startsWith("not checked  "));
    expect(notChecked).toHaveLength(2);
    expect(notChecked[0]).toContain("price decimals");
  }, 60_000);
});

/** Runs node with `args` from the repo root without blocking the test worker. */
function runScript(
  args: string[],
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}
