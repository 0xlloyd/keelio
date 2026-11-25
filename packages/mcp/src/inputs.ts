import { principalProblem, type VaultCall } from "@keelio/sdk";
import { Cl, type ClarityValue } from "@stacks/transactions";
import { z } from "zod";

// The registered schemas carry JSON types only. The rules (principal format,
// decimal amounts, the limit range) run in the handlers, so every bad input
// returns the same `{ error: { code, field, message } }` shape.

const principal = (what: string) => z.string().describe(what);
const amount = (what: string) =>
  z.string().describe(`${what}, a decimal string of base units`);

export const vaultShape = {
  owner: principal("The vault owner's principal"),
};

export const tradeShape = {
  owner: principal("The vault owner's principal"),
  agent: principal(
    "The principal that will send the swap; must be the vault's agent",
  ),
  adapter: principal("The swap adapter contract id, ADDR.name"),
  tokenIn: principal("The token sold, a contract id ADDR.name"),
  tokenOut: principal("The token bought, a contract id ADDR.name"),
  amountIn: amount("Amount of tokenIn to sell"),
  minOut: amount("Least amount of tokenOut the vault must receive"),
};

export const swapShape = tradeShape;

export const requestShape = {
  ...tradeShape,
  agent: principal(
    "The principal that will send the request; must be the vault's agent",
  ),
};

export const cancelShape = {
  owner: principal("The vault owner's principal"),
  agent: principal(
    "The principal that will send the call; must be the agent that made the request",
  ),
};

export const agentShape = {
  agent: principal("The agent principal to look up in the journal"),
};

export const accountabilityShape = {
  owner: principal("The vault owner's principal"),
  limit: z
    .number()
    .int()
    .optional()
    .describe(
      "How many trades to return, the most recent ones: 1 to 500, default 50",
    ),
};

export const sizeShape = {
  capital: amount("Capital in quote units"),
  riskBps: amount("Risk per trade in basis points of capital (100 = 1%)"),
  entry: amount("Entry price in quote units per whole asset"),
  stop: amount("Stop price in quote units per whole asset"),
  lotSize: amount(
    "Lot size in asset base units; the quantity is in the same units",
  ),
};

export const journalShape = {
  owner: principal("The vault owner's principal"),
  limit: z
    .number()
    .int()
    .optional()
    .describe("How many events to return, newest first: 1 to 500, default 50"),
};

export type ToolInputErrorCode =
  | "INVALID_PRINCIPAL"
  | "INVALID_AMOUNT"
  | "INVALID_INPUT"
  | "UNKNOWN_ADAPTER"
  | "UNKNOWN_ASSET";

export class ToolInputError extends Error {
  readonly code: ToolInputErrorCode;
  readonly field: string;

  constructor(code: ToolInputErrorCode, field: string, message: string) {
    super(message);
    this.name = "ToolInputError";
    this.code = code;
    this.field = field;
  }
}

const MAX_UINT = 2n ** 128n - 1n;
const DECIMAL = /^[0-9]+$/;
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 500;

/**
 * Returns `value`, in its canonical spelling, if it is a standard address or
 * a contract id `ADDR.name`, by the SDK's `principalProblem`, the rule its
 * builders apply. `contractOnly` refuses a standard address.
 */
export function parsePrincipal(
  field: string,
  value: unknown,
  contractOnly: boolean,
): string {
  if (typeof value !== "string") {
    throw new ToolInputError(
      "INVALID_INPUT",
      field,
      `${field} must be a string`,
    );
  }
  const fail = (why: string): never => {
    throw new ToolInputError("INVALID_PRINCIPAL", field, `${field} ${why}`);
  };
  const problem = principalProblem(value, contractOnly);
  if (problem !== null) fail(problem);
  // Every principal later goes through Cl.principal; refuse here anything it
  // would throw on, so it never surfaces as a chain error.
  let cv: ClarityValue;
  try {
    cv = Cl.principal(value);
  } catch {
    return fail("is not a valid principal");
  }
  // c32 reads O as 0 and I or L as 1, so one principal has many spellings.
  // The contract compares principals, but checkIntent, the journal filter and
  // the config lookups compare strings: return the one canonical spelling.
  return Cl.prettyPrint(cv).replace(/^'/, "");
}

/** Parses a decimal string of base units into a bigint in `[0, 2^128 - 1]`. */
export function parseAmount(field: string, value: unknown): bigint {
  if (typeof value !== "string") {
    throw new ToolInputError(
      "INVALID_INPUT",
      field,
      `${field} must be a decimal string`,
    );
  }
  if (!DECIMAL.test(value)) {
    throw new ToolInputError(
      "INVALID_AMOUNT",
      field,
      `${field} must be a decimal string of digits only`,
    );
  }
  const n = BigInt(value);
  if (n > MAX_UINT) {
    throw new ToolInputError(
      "INVALID_AMOUNT",
      field,
      `${field} must be at most 2^128 - 1`,
    );
  }
  return n;
}

/** Parses the journal's event count: an integer from 1 to 500, default 50. */
export function parseLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_LIMIT
  ) {
    throw new ToolInputError(
      "INVALID_INPUT",
      "limit",
      `limit must be an integer from 1 to ${MAX_LIMIT}`,
    );
  }
  return value;
}

/** A post-condition with its bigint amount, if any, as a decimal string. */
export type JsonPostCondition = Record<string, unknown>;

export interface JsonVaultCall {
  contractAddress: string;
  contractName: string;
  functionName: string;
  /** Hex consensus encoding of each argument; decode with `Cl.deserialize`. */
  functionArgs: string[];
  /** `Cl.prettyPrint` of each argument, for people only. */
  functionArgsRepr: string[];
  postConditions: JsonPostCondition[];
  postConditionMode: "deny";
}

/** Turns a `VaultCall` into JSON-safe values: hex arguments, string amounts. */
export function encodeVaultCall(call: VaultCall): JsonVaultCall {
  return {
    contractAddress: call.contractAddress,
    contractName: call.contractName,
    functionName: call.functionName,
    functionArgs: call.functionArgs.map((a) => Cl.serialize(a)),
    functionArgsRepr: call.functionArgs.map((a) => Cl.prettyPrint(a)),
    postConditions: call.postConditions.map((pc) =>
      "amount" in pc ? { ...pc, amount: pc.amount.toString() } : { ...pc },
    ),
    postConditionMode: call.postConditionMode,
  };
}

export type JsonValue = string | boolean | null;

function decodeField(name: string, value: ClarityValue): JsonValue {
  switch (value.type) {
    case "uint":
    case "int":
      return BigInt(value.value).toString();
    case "address":
    case "contract":
      return Cl.prettyPrint(value).replace(/^'/, "");
    case "true":
      return true;
    case "false":
      return false;
    case "none":
      return null;
    case "some":
      return decodeField(name, value.value);
    case "ascii":
    case "utf8":
      return value.value;
    default:
      throw new Error(
        `journal field ${name} has unsupported type ${value.type}`,
      );
  }
}

/** Decodes one journal print tuple, keeping the kebab-case field names. */
export function decodeEvent(
  value: ClarityValue,
): { event: string } & Record<string, JsonValue> {
  if (value.type !== "tuple") {
    throw new Error(`journal event must be a tuple, got ${value.type}`);
  }
  const fields: Record<string, JsonValue> = {};
  for (const [name, v] of Object.entries(value.value)) {
    fields[name] = decodeField(name, v);
  }
  const event = fields.event;
  if (typeof event !== "string") {
    throw new Error("journal event has no string event field");
  }
  return { event, ...fields };
}
