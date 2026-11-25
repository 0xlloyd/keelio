import type { VaultConfig } from "@keelio/sdk";
import { DEFAULT_THRESHOLDS, type Thresholds } from "./alerts.js";

// The runner's configuration for a real network. Everything the monitor
// needs to know about a deployment is named here; nothing has a default that
// points at a network, because no vault is deployed.

export interface MonitorConfig {
  /** The Stacks API root. */
  apiUrl: string;
  /** The simulated caller for read-only calls. It signs nothing. */
  sender: string;
  /** Full contract ids, `ADDR.name`, as `readVault` takes them. */
  read: VaultConfig;
  thresholds: Thresholds;
  /** Milliseconds between polls. */
  intervalMs: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const CONTRACT_ID = /^S[0-9A-Z]{20,45}\.[a-zA-Z]([a-zA-Z0-9]|[-_]){0,39}$/;
const ADDRESS = /^S[0-9A-Z]{20,45}$/;
const UINT = /^(0|[1-9][0-9]*)$/;

const KEYS = [
  "apiUrl",
  "sender",
  "vault",
  "tokens",
  "adapters",
  "oracle",
  "sbtcToken",
  "priceScale",
  "thresholds",
  "intervalSeconds",
];

function contractId(value: unknown, what: string): string {
  if (typeof value !== "string" || !CONTRACT_ID.test(value)) {
    throw new ConfigError(`${what} must be a contract id ADDR.name`);
  }
  return value;
}

function contractIds(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ConfigError(`${what} must be a list of contract ids`);
  }
  return value.map((id, i) => contractId(id, `${what}[${i}]`));
}

/** A base-unit count written as a decimal string, so no float carries it. */
function uint(value: unknown, what: string): bigint {
  if (typeof value !== "string" || !UINT.test(value)) {
    throw new ConfigError(`${what} must be a decimal string of digits`);
  }
  return BigInt(value);
}

/**
 * Checks a parsed config file. Throws a `ConfigError` naming the first field
 * that is missing or wrong, and refuses a field it does not know.
 */
export function parseConfig(value: unknown): MonitorConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError("the config must be a JSON object");
  }
  const c = value as Record<string, unknown>;
  for (const key of Object.keys(c)) {
    if (!KEYS.includes(key)) throw new ConfigError(`unknown field ${key}`);
  }

  if (typeof c.apiUrl !== "string") {
    throw new ConfigError("apiUrl must be a URL");
  }
  let url: URL;
  try {
    url = new URL(c.apiUrl);
  } catch {
    throw new ConfigError("apiUrl must be a URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigError("apiUrl must use http: or https:");
  }
  if (
    typeof c.sender !== "string" ||
    !(ADDRESS.test(c.sender) || CONTRACT_ID.test(c.sender))
  ) {
    throw new ConfigError("sender must be a Stacks address or contract id");
  }

  const tokens = contractIds(c.tokens, "tokens");
  const sbtcToken = contractId(c.sbtcToken, "sbtcToken");
  if (!tokens.includes(sbtcToken)) {
    throw new ConfigError("sbtcToken must be one of tokens");
  }
  const priceScale = uint(c.priceScale, "priceScale");
  if (priceScale === 0n) throw new ConfigError("priceScale must not be 0");

  const thresholds = { ...DEFAULT_THRESHOLDS };
  if (c.thresholds !== undefined) {
    if (typeof c.thresholds !== "object" || c.thresholds === null) {
      throw new ConfigError("thresholds must be an object");
    }
    for (const [key, v] of Object.entries(c.thresholds)) {
      if (!Object.hasOwn(DEFAULT_THRESHOLDS, key)) {
        throw new ConfigError(`unknown field thresholds.${key}`);
      }
      thresholds[key as keyof Thresholds] = uint(v, `thresholds.${key}`);
    }
  }
  for (const key of ["dayCapWarnBps", "oracleAgeWarnBps"] as const) {
    if (thresholds[key] > 10_000n) {
      throw new ConfigError(`thresholds.${key} must be at most 10000`);
    }
  }

  const seconds = c.intervalSeconds ?? 30;
  if (
    typeof seconds !== "number" ||
    !Number.isInteger(seconds) ||
    seconds < 1 ||
    seconds > 86_400
  ) {
    throw new ConfigError("intervalSeconds must be a whole number, 1 to 86400");
  }

  return {
    apiUrl: c.apiUrl,
    sender: c.sender,
    read: {
      vault: contractId(c.vault, "vault"),
      tokens,
      adapters: contractIds(c.adapters, "adapters"),
      oracle: contractId(c.oracle, "oracle"),
      sbtcToken,
      priceScale,
    },
    thresholds,
    intervalMs: seconds * 1000,
  };
}
