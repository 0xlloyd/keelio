// `pnpm run check-deploy`: checks keelio-vault's deploy configuration before a
// deployment. Each `with-ft` allowance names a token constant and an asset name
// constant; the asset name must be a `define-fungible-token` in that token's
// source, or every withdrawal of the token fails closed and its deposits are
// stranded. It then checks the oracle configuration: that ORACLE names a
// contract whose `get-value` has the oracle trait's signature, and that
// PRICE-SCALE agrees with the two tokens' `get-decimals` (see
// `checkOracleConfig`). Everything is read from an in-process simnet only: no
// network call, no key. A contract that isn't on the simnet fails the check.
import { pathToFileURL } from "node:url";
import { initSimnet } from "@stacks/clarinet-sdk";
import { ClarityType } from "@stacks/transactions";

/** Reads a contract's source by id; the simnet satisfies this. */
export type SourceReader = {
  getContractSource(id: string): string | undefined;
};

export type TokenConfig = {
  /** The token constant, for example `ALLOWED-TOKEN`. */
  constant: string;
  /** The token contract, as `<address>.<name>`. */
  principal: string;
  /** The asset name constant, for example `ALLOWED-TOKEN-FT`. */
  nameConstant: string;
  /** The asset name the vault passes to `with-ft`. */
  assetName: string;
};

export type DeployCheck =
  { ok: true; tokens: TokenConfig[] } | { ok: false; errors: string[] };

/** Removes `;` comments to the end of each line, leaving `"…"` strings intact. */
export function stripComments(source: string): string {
  let out = "";
  let inString = false;
  let inComment = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (inComment) {
      if (ch === "\n") {
        inComment = false;
        out += ch;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < source.length) {
        out += source[++i];
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === ";") {
      inComment = true;
    } else {
      if (ch === '"') inString = true;
      out += ch;
    }
  }
  return out;
}

/**
 * Replaces everything between the quotes of each `"…"` string with spaces,
 * keeping the quotes, the newlines and the length. `\"` doesn't end a string.
 */
export function blankStrings(code: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]!;
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < code.length) {
      out += " ";
      const next = code[++i]!;
      out += next === "\n" ? "\n" : " ";
    } else if (ch === '"') {
      inString = false;
      out += ch;
    } else {
      out += ch === "\n" ? "\n" : " ";
    }
  }
  return out;
}

/** The names of every `define-fungible-token` in `source`, outside comments and strings. */
export function fungibleTokenNames(source: string): string[] {
  const code = blankStrings(stripComments(source));
  return [...code.matchAll(/\(\s*define-fungible-token\s+([^\s()";]+)/g)].map(
    (match) => match[1]!,
  );
}

type Atom = { start: number; end: number };

/** Finds one atom (symbol, principal or string) at `from`, or null. */
function readAtom(code: string, from: number): Atom | null {
  let i = from;
  while (i < code.length && /\s/.test(code[i]!)) i++;
  if (code[i] === '"') {
    let j = i + 1;
    while (j < code.length && code[j] !== '"') j += code[j] === "\\" ? 2 : 1;
    return j < code.length ? { start: i, end: j + 1 } : null;
  }
  const match = /^[^\s()"]+/.exec(code.slice(i));
  return match ? { start: i, end: i + match[0].length } : null;
}

/** Every `(define-constant NAME VALUE)` value, grouped by name. */
function constants(code: string, blank: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const match of blank.matchAll(/\(\s*define-constant\s+([^\s()";]+)/g)) {
    const value = readAtom(blank, match.index + match[0].length);
    const values = found.get(match[1]!) ?? [];
    values.push(value ? code.slice(value.start, value.end) : "(expression)");
    found.set(match[1]!, values);
  }
  return found;
}

const isSymbol = (atom: string) =>
  /^[a-zA-Z][a-zA-Z0-9_!?+<>=/*-]*$/.test(atom);
const isPrincipal = (atom: string) =>
  atom.startsWith(".") || atom.startsWith("'");

/** `.name` → `<deployer>.name`; `'SP….name` → `SP….name`. */
function resolvePrincipal(value: string, deployer: string): string {
  return value.startsWith(".") ? `${deployer}${value}` : value.slice(1);
}

function readSource(reader: SourceReader, id: string): string | undefined {
  try {
    return reader.getContractSource(id);
  } catch {
    return undefined;
  }
}

/**
 * Checks that every `with-ft` in the vault at `vaultId` names a token constant
 * and an asset name constant, and that the asset name is a
 * `define-fungible-token` in that token's source. Collects every error.
 */
export function checkDeployConfig(
  reader: SourceReader,
  vaultId: string,
): DeployCheck {
  const vaultSource = readSource(reader, vaultId);
  if (vaultSource === undefined) {
    return { ok: false, errors: [`keelio-vault source not found: ${vaultId}`] };
  }
  const deployer = vaultId.split(".")[0]!;
  const code = stripComments(vaultSource);
  const blank = blankStrings(code);
  const defined = constants(code, blank);
  const errors: string[] = [];

  // Pair each token constant with the name constants it is used with, in
  // source order.
  const pairs = new Map<string, string[]>();
  const literals = new Map<string, string[]>();
  const withFt = [...blank.matchAll(/\(\s*with-ft(?=[\s()])/g)];
  if (withFt.length === 0) {
    errors.push(`${vaultId}: no with-ft allowance found`);
  }
  for (const match of withFt) {
    const at = match.index + match[0].length;
    const tokenAtom = readAtom(blank, at);
    const nameAtom = tokenAtom === null ? null : readAtom(blank, tokenAtom.end);
    if (tokenAtom === null || nameAtom === null) {
      errors.push(
        `${vaultId}: a with-ft allowance has an argument that is not a constant`,
      );
      continue;
    }
    const token = code.slice(tokenAtom.start, tokenAtom.end);
    const name = code.slice(nameAtom.start, nameAtom.end);
    if (!isSymbol(token)) {
      errors.push(
        `${vaultId}: with-ft token ${token} is a literal; use a define-constant`,
      );
      continue;
    }
    const names = pairs.get(token) ?? [];
    pairs.set(token, names);
    if (!isSymbol(name)) {
      literals.set(token, [...(literals.get(token) ?? []), name]);
      continue;
    }
    if (!names.includes(name)) names.push(name);
  }

  const tokens: TokenConfig[] = [];
  for (const [constant, nameConstants] of pairs) {
    const values = defined.get(constant) ?? [];
    const value = values[0];
    if (values.length !== 1 || value === undefined || !isPrincipal(value)) {
      errors.push(
        `${constant}: must be defined exactly once as (define-constant ${constant} <contract principal>)`,
      );
      continue;
    }
    const principal = resolvePrincipal(value, deployer);
    const prefix = `${constant} (${principal}): `;
    for (const name of literals.get(constant) ?? []) {
      errors.push(
        `${prefix}with-ft asset name ${name} is a literal; use a define-constant`,
      );
    }
    if (nameConstants.length === 0) continue;
    if (nameConstants.length !== 1) {
      errors.push(
        `${prefix}paired with more than one asset name constant: ${nameConstants.join(", ")}`,
      );
      continue;
    }
    const nameConstant = nameConstants[0]!;
    const nameValues = defined.get(nameConstant) ?? [];
    const nameValue = nameValues[0];
    if (
      nameValues.length !== 1 ||
      nameValue === undefined ||
      !nameValue.startsWith('"')
    ) {
      errors.push(
        `${prefix}${nameConstant} must be defined exactly once as (define-constant ${nameConstant} "<name>")`,
      );
      continue;
    }
    const assetName = nameValue.slice(1, -1);
    const tokenSource = readSource(reader, principal);
    if (tokenSource === undefined) {
      errors.push(`${prefix}token source not found on the simnet`);
      continue;
    }
    const names = fungibleTokenNames(tokenSource);
    if (!names.includes(assetName)) {
      errors.push(
        `${prefix}asset name "${assetName}" (${nameConstant}) is not a define-fungible-token in that contract; it defines: ${names.length === 0 ? "(none)" : names.join(", ")}`,
      );
      continue;
    }
    tokens.push({ constant, principal, nameConstant, assetName });
  }

  return errors.length === 0 ? { ok: true, tokens } : { ok: false, errors };
}

/** A function as the Clarity analysis reports it (the contract's ABI). */
export type FunctionSignature = {
  /** `public`, `read_only` or `private`. */
  access: string;
  args: { name: string; type: unknown }[];
  outputs: { type: unknown };
};

/** What the oracle check reads; `simnetReader` gives one over a simnet. */
export type ConfigReader = SourceReader & {
  /** What the token's `get-decimals` answers, or undefined if it isn't `(ok uint)`. */
  getDecimals(id: string): bigint | undefined;
  /** The analysed signature of `name` in the contract, or undefined. */
  getFunction(id: string, name: string): FunctionSignature | undefined;
};

type Simnet = Awaited<ReturnType<typeof initSimnet>>;

/**
 * Reads sources, analysed signatures and `get-decimals` from a simnet.
 * `get-decimals` is a read-only call inside the simnet: nothing is signed.
 */
export function simnetReader(simnet: Simnet): ConfigReader {
  return {
    getContractSource: (id) => simnet.getContractSource(id),
    getDecimals: (id) => {
      try {
        const { result } = simnet.callReadOnlyFn(
          id,
          "get-decimals",
          [],
          simnet.deployer,
        );
        if (
          result.type !== ClarityType.ResponseOk ||
          result.value.type !== ClarityType.UInt
        ) {
          return undefined;
        }
        return BigInt(result.value.value);
      } catch {
        return undefined;
      }
    },
    getFunction: (id, name) =>
      simnet
        .getContractsInterfaces()
        .get(id)
        ?.functions.find((fn) => fn.name === name),
  };
}

export type OracleCheck =
  | {
      ok: true;
      /** The oracle contract, as `<address>.<name>`. */
      oracle: string;
      priceScale: bigint;
      /** Assumed, not read: see `notChecked`. */
      oracleDecimals: bigint;
      sbtc: { constant: string; decimals: bigint };
      quote: { constant: string; decimals: bigint };
      /** What the check could not verify, in plain words. */
      notChecked: string[];
    }
  | { ok: false; errors: string[] };

/** An ABI type in Clarity's notation, with tuple fields in name order. */
function showType(type: unknown): string {
  if (typeof type === "string") {
    return type === "uint128" ? "uint" : type === "int128" ? "int" : type;
  }
  if (typeof type === "object" && type !== null) {
    const t = type as Record<string, unknown>;
    const length = (value: unknown) =>
      String((value as { length?: unknown }).length);
    if ("string-ascii" in t)
      return `(string-ascii ${length(t["string-ascii"])})`;
    if ("string-utf8" in t) return `(string-utf8 ${length(t["string-utf8"])})`;
    if ("buffer" in t) return `(buff ${length(t["buffer"])})`;
    if ("optional" in t) return `(optional ${showType(t["optional"])})`;
    if ("response" in t) {
      const r = t["response"] as { ok: unknown; error: unknown };
      return `(response ${showType(r.ok)} ${showType(r.error)})`;
    }
    if ("list" in t) {
      const l = t["list"] as { type: unknown; length: unknown };
      return `(list ${String(l.length)} ${showType(l.type)})`;
    }
    if (Array.isArray(t["tuple"])) {
      const fields = (t["tuple"] as { name: string; type: unknown }[])
        .map((field) => `${field.name}: ${showType(field.type)}`)
        .sort();
      return `{ ${fields.join(", ")} }`;
    }
  }
  return JSON.stringify(type);
}

// `get-value` in contracts/traits/oracle-trait.clar. A test holds this to the
// trait's source.
const ORACLE_ARGS = ["(string-ascii 32)"];
const ORACLE_OK = "{ timestamp: uint, value: uint }";
const ORACLE_SIGNATURE = `(get-value (${ORACLE_ARGS.join(" ")}) (response ${ORACLE_OK} uint))`;
// A function that never errs has no error type ("none"), and Clarity admits
// it where the trait says uint. An oracle in DIA's shape may be written so.
const ORACLE_OUTPUTS = [
  `(response ${ORACLE_OK} uint)`,
  `(response ${ORACLE_OK} none)`,
];

// The decimals of the oracle's price. `get-value` returns only a value and a
// timestamp, so no call can read this; it is the 8 that oracle-trait.clar and
// the vault's own comments state for DIA.
const ORACLE_DECIMALS = 8n;
// From the vault: `(* PRICE-SCALE BPS)` is an unchecked product.
const BPS = 10_000n;
const MAX_UINT = 2n ** 128n - 1n;

/**
 * Checks the vault's oracle configuration at `vaultId`. Collects every error.
 *
 * ORACLE must be one contract constant, on the simnet, with a public or
 * read-only `get-value` of exactly the oracle trait's signature. The signature
 * comes from the Clarity analysis, not from the oracle's text, so nothing in a
 * comment or a string can stand in for the function.
 *
 * PRICE-SCALE must be 10^(p + s - q), where p is the decimals of the oracle's
 * price (8), s is ALLOWED-TOKEN's `get-decimals` (the sBTC token) and q is
 * QUOTE-TOKEN's. That follows from `oracle-floor` in the vault. Write P for the
 * oracle's value, so one BTC is P / 10^p USD; one BTC is 10^s base units of
 * sBTC and one USD is 10^q base units of the quote token.
 *
 * - Selling `a` base units of sBTC: that is a / 10^s BTC, worth
 *   (a / 10^s) * (P / 10^p) USD, or a * P * 10^q / 10^(s + p) quote base
 *   units. The vault computes a * P / PRICE-SCALE (times keep / BPS), so
 *   PRICE-SCALE = 10^(p + s - q).
 * - Buying sBTC with `a` quote base units: that is a / 10^q USD, worth
 *   (a / 10^q) / (P / 10^p) BTC, or a * 10^(p + s) / (P * 10^q) sats. The
 *   vault computes a * PRICE-SCALE / P, so again PRICE-SCALE = 10^(p + s - q).
 *
 * PRICE-SCALE is a uint, so p + s - q can't be negative, and the vault
 * multiplies PRICE-SCALE by BPS unchecked, so that product must fit a uint.
 *
 * Not checked, and reported as such: p itself, and that the oracle publishes
 * the vault's key as USD per BTC with a millisecond timestamp.
 */
export function checkOracleConfig(
  reader: ConfigReader,
  vaultId: string,
): OracleCheck {
  const vaultSource = readSource(reader, vaultId);
  if (vaultSource === undefined) {
    return { ok: false, errors: [`keelio-vault source not found: ${vaultId}`] };
  }
  const deployer = vaultId.split(".")[0]!;
  const code = stripComments(vaultSource);
  const defined = constants(code, blankStrings(code));
  const errors: string[] = [];

  /** The constant's one value if `accepts` it, else undefined. */
  const one = (name: string, accepts: (value: string) => boolean) => {
    const values = defined.get(name) ?? [];
    const value = values[0];
    return values.length === 1 && value !== undefined && accepts(value)
      ? value
      : undefined;
  };
  const principalOf = (name: string) => {
    const value = one(name, isPrincipal);
    return value === undefined ? undefined : resolvePrincipal(value, deployer);
  };
  const onePrincipal = (name: string) =>
    `${name} must be defined exactly once as (define-constant ${name} <contract principal>)`;

  const oracle = principalOf("ORACLE");
  if (oracle === undefined) {
    errors.push(`ORACLE: ${onePrincipal("ORACLE").slice("ORACLE ".length)}`);
  } else if (readSource(reader, oracle) === undefined) {
    errors.push(`ORACLE (${oracle}): contract not found on the simnet`);
  } else {
    const needs = `oracle-trait needs a public or read-only ${ORACLE_SIGNATURE}`;
    let fn: FunctionSignature | undefined;
    try {
      fn = reader.getFunction(oracle, "get-value");
    } catch {
      fn = undefined;
    }
    if (fn === undefined) {
      errors.push(`ORACLE (${oracle}): has no get-value function; ${needs}`);
    } else {
      const args = fn.args.map((arg) => showType(arg.type));
      const output = showType(fn.outputs.type);
      const callable = fn.access === "public" || fn.access === "read_only";
      if (
        !callable ||
        args.join(" ") !== ORACLE_ARGS.join(" ") ||
        !ORACLE_OUTPUTS.includes(output)
      ) {
        errors.push(
          `ORACLE (${oracle}): get-value is ${fn.access.replace("_", "-")} (get-value (${args.join(" ")}) ${output}); ${needs}`,
        );
      }
    }
  }

  const scaleValue = one("PRICE-SCALE", (value) => /^u[0-9]+$/.test(value));
  if (scaleValue === undefined) {
    errors.push(
      "PRICE-SCALE: must be defined exactly once as (define-constant PRICE-SCALE u<number>)",
    );
  }
  const [sbtc, quote] = ["ALLOWED-TOKEN", "QUOTE-TOKEN"].map((constant) => {
    const principal = principalOf(constant);
    if (principal === undefined) {
      errors.push(
        `PRICE-SCALE: not checked, because ${onePrincipal(constant)}`,
      );
      return undefined;
    }
    let decimals: bigint | undefined;
    try {
      decimals = reader.getDecimals(principal);
    } catch {
      decimals = undefined;
    }
    if (decimals === undefined) {
      errors.push(
        `PRICE-SCALE: not checked, because get-decimals of ${constant} (${principal}) did not answer (ok uint) on the simnet`,
      );
      return undefined;
    }
    return { constant, principal, decimals };
  });

  if (scaleValue !== undefined && sbtc !== undefined && quote !== undefined) {
    const priceScale = BigInt(scaleValue.slice(1));
    const exponent = ORACLE_DECIMALS + sbtc.decimals - quote.decimals;
    const sum = `10^(${ORACLE_DECIMALS} + ${sbtc.decimals} - ${quote.decimals})`;
    const sbtcName = `${sbtc.constant} (${sbtc.principal})`;
    const quoteName = `${quote.constant} (${quote.principal})`;
    if (exponent < 0n) {
      errors.push(
        `PRICE-SCALE: no uint fits: it must be ${sum} = 10^${exponent}, a fraction. ${quoteName} has more decimals than the oracle's price (${ORACLE_DECIMALS}) and ${sbtcName} together, which the vault's floor arithmetic cannot express.`,
      );
    } else if (exponent > 38n || 10n ** exponent * BPS > MAX_UINT) {
      errors.push(
        `PRICE-SCALE: it must be ${sum} = 10^${exponent}, and the vault's PRICE-SCALE * BPS would then overflow a uint and abort every sale of ${sbtcName}.`,
      );
    } else if (priceScale !== 10n ** exponent) {
      errors.push(
        `PRICE-SCALE: is u${priceScale} but must be u${10n ** exponent} = ${sum}, that is 10^(oracle price decimals + ${sbtc.constant} decimals - ${quote.constant} decimals): the oracle's price is taken to have ${ORACLE_DECIMALS} decimals, ${sbtcName} get-decimals is ${sbtc.decimals} and ${quoteName} get-decimals is ${quote.decimals}. A wrong value moves every oracle floor by that factor.`,
      );
    } else if (errors.length === 0 && oracle !== undefined) {
      const key = one("ORACLE-KEY", (value) => value.startsWith('"'));
      return {
        ok: true,
        oracle,
        priceScale,
        oracleDecimals: ORACLE_DECIMALS,
        sbtc: { constant: sbtc.constant, decimals: sbtc.decimals },
        quote: { constant: quote.constant, decimals: quote.decimals },
        notChecked: [
          `the oracle's price decimals: get-value returns no decimals, so PRICE-SCALE was checked taking them as ${ORACLE_DECIMALS}, which oracle-trait.clar states for DIA. Confirm it for ${oracle}.`,
          `that ${oracle} publishes ${key ?? "the vault's ORACLE-KEY"} as USD per BTC with a timestamp in milliseconds.`,
        ],
      };
    }
  }
  return { ok: false, errors };
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  // The simnet echoes contract output with console.log; keep stdout for the
  // result lines.
  console.log = (...args: unknown[]) => console.error(...args);
  try {
    const simnet = await initSimnet();
    const deployer = simnet.getAccounts().get("deployer");
    if (deployer === undefined) throw new Error("simnet has no deployer");
    const vaultId = `${deployer}.keelio-vault`;
    const check = checkDeployConfig(simnet, vaultId);
    const oracle = checkOracleConfig(simnetReader(simnet), vaultId);
    if (check.ok) {
      for (const t of check.tokens) {
        process.stdout.write(
          `ok  ${t.constant} ${t.principal}  ${t.nameConstant} "${t.assetName}"\n`,
        );
      }
    }
    if (oracle.ok) {
      const { sbtc, quote, oracleDecimals: p } = oracle;
      process.stdout.write(
        `ok  ORACLE ${oracle.oracle}  get-value matches oracle-trait\n` +
          `ok  PRICE-SCALE u${oracle.priceScale} = 10^(${p} + ${sbtc.decimals} - ${quote.decimals})  oracle price decimals ${p} (assumed), ${sbtc.constant} decimals ${sbtc.decimals}, ${quote.constant} decimals ${quote.decimals}\n`,
      );
      for (const line of oracle.notChecked) {
        process.stdout.write(`not checked  ${line}\n`);
      }
    }
    for (const failed of [check, oracle]) {
      if (failed.ok) continue;
      for (const error of failed.errors) process.stderr.write(`${error}\n`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
