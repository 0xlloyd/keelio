// The testnet mode's config: what the owner fills in after deploying a vault
// (apps/dashboard/testnet.config.example.json), checked field by field, and
// the network guard. No DOM and no network, so tests run it in Node.
import { isClarityName, validateStacksAddress } from "@stacks/transactions";
import { isNodeContractId } from "../../../packages/sdk/src/principal.js";
import type { ChainConfig, TokenInfo } from "./chain.js";

/** Said wherever a mainnet address, network name or API is refused. */
export const MAINNET_REFUSAL =
  "Mainnet is outside this version of the Keelio dashboard. It runs on testnet only.";

export class MainnetRefusedError extends Error {
  constructor(what: string) {
    super(`${MAINNET_REFUSAL} Refused: ${what}.`);
    this.name = "MainnetRefusedError";
  }
}

export interface TestnetToken extends TokenInfo {
  /** The token's `define-fungible-token` name, for post-conditions. */
  assetName: string;
}

export interface TestnetAdapter {
  id: string;
  name: string;
  /** The pool the adapter trades against, or `null` if it pays out itself. */
  pool: string | null;
}

export interface TestnetConfig {
  network: "testnet";
  /** The Stacks API root, for example a testnet API. */
  apiUrl: string;
  /** The deployed vault's contract id. */
  vault: string;
  tokens: readonly TestnetToken[];
  /** Must equal the vault's `ALLOWED-TOKEN`. */
  sbtcToken: string;
  adapters: readonly TestnetAdapter[];
  /** Must equal the vault's `ORACLE`. */
  oracle: string;
  /** Must equal the vault's `PRICE-SCALE`. */
  priceScale: bigint;
}

export type ParsedConfig =
  | { ok: true; config: TestnetConfig }
  | {
      ok: false;
      /** `true` when any problem is a mainnet value. */
      mainnet: boolean;
      /** One full sentence per missing or wrong field. */
      problems: string[];
    };

/** Mainnet's `network_id` in a node's `/v2/info`. */
export const MAINNET_NETWORK_ID = 1;

const DIGITS = /^[0-9]+$/;
/** What every unfilled value of testnet.config.example.json contains. */
const PLACEHOLDER = "REPLACE_WITH";

/** `true` for a mainnet address or contract id: prefix SP or SM. */
export function isMainnetPrincipal(principal: string): boolean {
  return /^S[PM]/.test(principal);
}

/**
 * `true` for a testnet standard address: valid, and prefix ST or SN. A
 * mainnet address is valid too, so the prefix is what tells them apart.
 */
export function isTestnetAddress(address: string): boolean {
  return /^S[TN]/.test(address) && validateStacksAddress(address);
}

/**
 * Why `apiUrl` cannot be used, or `null`. A URL that names mainnet is
 * refused here; a mainnet node behind any other URL is refused when the
 * session starts, from the node's own `network_id`.
 */
export function apiUrlProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "apiUrl is not a URL.";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return "apiUrl must use http: or https:.";
  }
  if (url.search !== "" || url.hash !== "") {
    return "apiUrl must not have a query or fragment.";
  }
  const host = url.hostname.toLowerCase();
  if (host === "api.hiro.so" || host.includes("mainnet")) {
    return `${MAINNET_REFUSAL} apiUrl ${value} is a mainnet API.`;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Checks the owner's config. Every missing or wrong field is named, so the
 * page can say what to fill in. Nothing is guessed or defaulted.
 */
export function parseTestnetConfig(raw: unknown): ParsedConfig {
  const problems: string[] = [];
  let mainnet = false;
  const refuse = (what: string): void => {
    mainnet = true;
    problems.push(`${MAINNET_REFUSAL} ${what}`);
  };
  if (!isRecord(raw)) {
    return {
      ok: false,
      mainnet: false,
      problems: ["The config must be a JSON object."],
    };
  }

  /** A testnet contract id, or `null` after recording the problem. */
  const contractId = (value: unknown, name: string): string | null => {
    if (typeof value !== "string" || value === "") {
      problems.push(`${name} is missing: give a contract id, ADDRESS.name.`);
      return null;
    }
    if (value.includes(PLACEHOLDER)) {
      problems.push(`${name} is still the example's placeholder.`);
      return null;
    }
    if (!isNodeContractId(value)) {
      problems.push(`${name} is not a contract id (ADDRESS.name): ${value}`);
      return null;
    }
    if (isMainnetPrincipal(value)) {
      refuse(`${name} ${value} is a mainnet contract.`);
      return null;
    }
    return value;
  };
  const text = (value: unknown, name: string): string | null => {
    if (typeof value !== "string" || value.trim() === "") {
      problems.push(`${name} is missing.`);
      return null;
    }
    if (value.includes(PLACEHOLDER)) {
      problems.push(`${name} is still the example's placeholder.`);
      return null;
    }
    return value;
  };

  if (raw.network === "mainnet") {
    refuse('network is "mainnet".');
  } else if (raw.network !== "testnet") {
    problems.push('network must be "testnet".');
  }

  let apiUrl: string | null = null;
  if (typeof raw.apiUrl !== "string" || raw.apiUrl === "") {
    problems.push("apiUrl is missing: give the testnet Stacks API root.");
  } else {
    const problem = apiUrlProblem(raw.apiUrl);
    if (problem === null) apiUrl = raw.apiUrl;
    else if (problem.startsWith(MAINNET_REFUSAL)) {
      mainnet = true;
      problems.push(problem);
    } else problems.push(problem);
  }

  const vault = contractId(raw.vault, "vault");
  const oracle = contractId(raw.oracle, "oracle");

  const tokens: TestnetToken[] = [];
  if (!Array.isArray(raw.tokens) || raw.tokens.length === 0) {
    problems.push("tokens is missing: list the vault's tokens.");
  } else {
    raw.tokens.forEach((entry: unknown, i) => {
      const at = `tokens[${i}]`;
      if (!isRecord(entry)) {
        problems.push(`${at} must be an object.`);
        return;
      }
      const id = contractId(entry.id, `${at}.id`);
      const assetName = text(entry.assetName, `${at}.assetName`);
      const name = text(entry.name, `${at}.name`);
      const symbol = text(entry.symbol, `${at}.symbol`);
      const unit = text(entry.unit, `${at}.unit`);
      const decimals = entry.decimals;
      const decimalsOk =
        typeof decimals === "number" &&
        Number.isInteger(decimals) &&
        decimals >= 0 &&
        decimals <= 38;
      if (!decimalsOk) {
        problems.push(`${at}.decimals must be a whole number from 0 to 38.`);
      }
      if (assetName !== null && !isClarityName(assetName)) {
        problems.push(`${at}.assetName is not a Clarity name: ${assetName}`);
        return;
      }
      if (
        id !== null &&
        assetName !== null &&
        name !== null &&
        symbol !== null &&
        unit !== null &&
        decimalsOk
      ) {
        tokens.push({ id, assetName, name, symbol, unit, decimals });
      }
    });
  }

  const sbtcToken = contractId(raw.sbtcToken, "sbtcToken");
  if (
    sbtcToken !== null &&
    Array.isArray(raw.tokens) &&
    !tokens.some((t) => t.id === sbtcToken)
  ) {
    problems.push("sbtcToken must be the id of one of tokens.");
  }

  const adapters: TestnetAdapter[] = [];
  if (!Array.isArray(raw.adapters) || raw.adapters.length === 0) {
    problems.push("adapters is missing: list the vault's swap adapter.");
  } else {
    raw.adapters.forEach((entry: unknown, i) => {
      const at = `adapters[${i}]`;
      if (!isRecord(entry)) {
        problems.push(`${at} must be an object.`);
        return;
      }
      const id = contractId(entry.id, `${at}.id`);
      const name = text(entry.name, `${at}.name`);
      let pool: string | null = null;
      let poolOk = true;
      if (!("pool" in entry)) {
        poolOk = false;
        problems.push(
          `${at}.pool is missing: give the pool's contract id, or null if the adapter pays out itself.`,
        );
      } else if (entry.pool !== null) {
        pool = contractId(entry.pool, `${at}.pool`);
        poolOk = pool !== null;
      }
      if (id !== null && name !== null && poolOk) {
        adapters.push({ id, name, pool });
      }
    });
  }

  // A string of digits, so the scale never passes through a float.
  let priceScale: bigint | null = null;
  if (typeof raw.priceScale !== "string" || !DIGITS.test(raw.priceScale)) {
    problems.push(
      'priceScale is missing: give the vault\'s PRICE-SCALE as a string of digits, for example "10000000000".',
    );
  } else {
    priceScale = BigInt(raw.priceScale);
    if (priceScale === 0n) {
      priceScale = null;
      problems.push("priceScale must be 1 or more.");
    }
  }

  if (
    problems.length > 0 ||
    apiUrl === null ||
    vault === null ||
    oracle === null ||
    sbtcToken === null ||
    priceScale === null
  ) {
    return { ok: false, mainnet, problems };
  }
  return {
    ok: true,
    config: {
      network: "testnet",
      apiUrl,
      vault,
      tokens,
      sbtcToken,
      adapters,
      oracle,
      priceScale,
    },
  };
}

/**
 * Throws `MainnetRefusedError` if any part of a config names mainnet. Run
 * again when a session starts, because a `TestnetConfig` can be built by
 * hand without `parseTestnetConfig`.
 */
export function assertTestnet(config: TestnetConfig): void {
  if ((config.network as string) !== "testnet") {
    throw new MainnetRefusedError(`network is "${String(config.network)}"`);
  }
  const url = apiUrlProblem(config.apiUrl);
  if (url !== null) {
    if (url.startsWith(MAINNET_REFUSAL)) {
      throw new MainnetRefusedError(`apiUrl ${config.apiUrl} is a mainnet API`);
    }
    throw new Error(url);
  }
  const ids: [string, string][] = [
    ["vault", config.vault],
    ["oracle", config.oracle],
    ["sbtcToken", config.sbtcToken],
    ...config.tokens.map((t): [string, string] => ["token", t.id]),
    ...config.adapters.flatMap((a): [string, string][] =>
      a.pool === null
        ? [["adapter", a.id]]
        : [
            ["adapter", a.id],
            ["pool", a.pool],
          ],
    ),
  ];
  for (const [name, id] of ids) {
    if (isMainnetPrincipal(id)) {
      throw new MainnetRefusedError(`${name} ${id} is a mainnet contract`);
    }
  }
}

/** The `ChainConfig` the forms, the review step and the panels use. */
export function chainConfigOf(
  config: TestnetConfig,
  owner: string,
): ChainConfig {
  const assetNames: Record<string, string> = {};
  for (const token of config.tokens) assetNames[token.id] = token.assetName;
  const routes: Record<string, { pool: string | null }> = {};
  const labels: Record<string, string> = {
    [owner]: "the owner",
    [config.vault]: "the vault",
  };
  for (const adapter of config.adapters) {
    routes[adapter.id] = { pool: adapter.pool };
    labels[adapter.id] = adapter.name;
  }
  for (const token of config.tokens) labels[token.id] = token.name;
  return {
    tx: { vault: config.vault, assetNames, adapters: routes },
    read: {
      vault: config.vault,
      tokens: config.tokens.map((t) => t.id),
      adapters: config.adapters.map((a) => a.id),
      oracle: config.oracle,
      sbtcToken: config.sbtcToken,
      priceScale: config.priceScale,
    },
    tokens: config.tokens.map(({ id, name, symbol, decimals, unit }) => ({
      id,
      name,
      symbol,
      decimals,
      unit,
    })),
    adapters: config.adapters.map(({ id, name }) => ({ id, name })),
    labels,
  };
}
