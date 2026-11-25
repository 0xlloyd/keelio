// The owner's forms as data, their validation, and the one place a form
// becomes a contract call: always through the SDK's transaction builders.
// No DOM here, so tests run it in Node.
import {
  buildAllowAdapter,
  buildAllowToken,
  buildDeposit,
  buildPause,
  buildRemoveAgent,
  buildSetAgent,
  buildSetApprovalThreshold,
  buildSetPolicy,
  buildSetPriceBounds,
  buildSetTokenCaps,
  buildUnpause,
  buildWithdraw,
  MAX_POST_CONDITION_AMOUNT,
  TxBuildError,
  type VaultCall,
} from "../../../packages/sdk/src/build-tx.js";
import type { ChainConfig } from "./chain.js";
import {
  blocksWords,
  bpsWords,
  expiryWords,
  human,
  msWords,
  thresholdWords,
  tokenOf,
} from "./format.js";

export const MAX_UINT = 2n ** 128n - 1n;

/**
 * A whole number in `[min, max]`, or `null`. Digits only after trimming and
 * parsed with `BigInt`, so nothing passes through a float: no sign, decimal
 * point, exponent or inner space.
 */
export function parseUint(
  text: string,
  min: bigint,
  max: bigint,
): bigint | null {
  const trimmed = text.trim();
  if (!/^[0-9]+$/.test(trimmed)) return null;
  const value = BigInt(trimmed);
  return value < min || value > max ? null : value;
}

export type FieldKind =
  /** Base units of the token chosen in the form's `token` field. */
  | "amount"
  /** As `amount`, and empty text means none: the value is cleared. */
  | "optionalAmount"
  | "blocks"
  | "height"
  | "bps"
  | "ms"
  | "principal"
  | "token"
  | "adapter"
  | "allowed";

export interface FlowField {
  name: string;
  label: string;
  kind: FieldKind;
  /** For the number kinds. Defaults: 0 and 2^128 - 1. */
  min?: bigint;
  max?: bigint;
}

export type FlowId =
  | "deposit"
  | "withdraw"
  | "set-agent"
  | "remove-agent"
  | "pause"
  | "unpause"
  | "set-policy"
  | "set-token-caps"
  | "set-price-bounds"
  | "set-approval-threshold"
  | "allow-token"
  | "allow-adapter";

export interface Flow {
  /** The keelio-vault function this form calls. */
  id: FlowId;
  group: "Funds" | "Agent and kill switch" | "Policy";
  title: string;
  about: string;
  fields: readonly FlowField[];
}

const token: FlowField = { name: "token", label: "Token", kind: "token" };
const transferAmount: FlowField = {
  name: "amount",
  label: "Amount, in base units",
  kind: "amount",
  min: 1n,
  // A post-condition amount must fit a u64, so the builder refuses more.
  max: MAX_POST_CONDITION_AMOUNT,
};

export const FLOWS: readonly Flow[] = [
  {
    id: "deposit",
    group: "Funds",
    title: "Deposit",
    about: "Move tokens from your account into your vault.",
    fields: [token, transferAmount],
  },
  {
    id: "withdraw",
    group: "Funds",
    title: "Withdraw",
    about:
      "Take tokens back to your account. Only the owner can withdraw, and it works while the vault is paused.",
    fields: [token, transferAmount],
  },
  {
    id: "set-agent",
    group: "Agent and kill switch",
    title: "Name the agent",
    about:
      "The one account that may trade for this vault. It replaces any earlier agent and can never withdraw.",
    fields: [{ name: "agent", label: "Agent address", kind: "principal" }],
  },
  {
    id: "remove-agent",
    group: "Agent and kill switch",
    title: "Remove the agent",
    about: "After this, no one can trade for this vault.",
    fields: [],
  },
  {
    id: "pause",
    group: "Agent and kill switch",
    title: "Pause",
    about:
      "The kill switch: stops the agent at once. Deposits and withdrawals still work.",
    fields: [],
  },
  {
    id: "unpause",
    group: "Agent and kill switch",
    title: "Unpause",
    about: "Lets the agent trade again, inside the policy.",
    fields: [],
  },
  {
    id: "set-policy",
    group: "Policy",
    title: "Cooldown and expiry",
    about:
      "Shared by both tokens. The expiry is the last burn height the agent may trade at.",
    fields: [
      {
        name: "cooldownBlocks",
        label: "Cooldown between trades, in burn blocks",
        kind: "blocks",
      },
      {
        name: "expiresAt",
        label: "Expires at burn height",
        kind: "height",
      },
    ],
  },
  {
    id: "set-token-caps",
    group: "Policy",
    title: "Caps for one token",
    about:
      "How much of this token the agent may sell in one trade and over a day (144 burn blocks). The day cap must not be below the trade cap. Caps of 0 mean the agent may not sell it.",
    fields: [
      token,
      {
        name: "maxPerTrade",
        label: "Max per trade, in base units",
        kind: "amount",
      },
      {
        name: "maxPerDay",
        label: "Max per day, in base units",
        kind: "amount",
      },
    ],
  },
  {
    id: "set-price-bounds",
    group: "Policy",
    title: "Price bounds",
    about:
      "How far below the oracle's BTC/USD price a trade may settle, and how old that price may be. 0 in either field means the agent may not trade.",
    fields: [
      {
        name: "maxSlippageBps",
        label: "Max slippage, in basis points",
        kind: "bps",
        // The contract refuses 10000 or more with u120.
        max: 9999n,
      },
      {
        name: "maxPriceAge",
        label: "Max price age, in milliseconds",
        kind: "ms",
      },
    ],
  },
  {
    id: "set-approval-threshold",
    group: "Policy",
    title: "Approval threshold",
    about:
      "A trade selling more than this much of the token, and inside the per-trade cap, does not run from the agent alone: the agent records a request, and it runs only if you approve it within 6 burn blocks. Leave the amount empty for none: the agent then trades alone up to the per-trade cap. 0 means every trade selling this token needs your approval.",
    fields: [
      token,
      {
        name: "threshold",
        label: "Ask me above, in base units (empty for none)",
        kind: "optionalAmount",
      },
    ],
  },
  {
    id: "allow-token",
    group: "Policy",
    title: "Allow or revoke a token",
    about:
      "The agent may swap only between tokens on your list. The vault's own set is fixed; your list can only narrow it.",
    fields: [token, { name: "allowed", label: "Setting", kind: "allowed" }],
  },
  {
    id: "allow-adapter",
    group: "Policy",
    title: "Allow or revoke the swap adapter",
    about: "The agent may swap only through an adapter on your list.",
    fields: [
      { name: "adapter", label: "Adapter", kind: "adapter" },
      { name: "allowed", label: "Setting", kind: "allowed" },
    ],
  },
];

export function flowById(id: FlowId): Flow {
  const flow = FLOWS.find((f) => f.id === id);
  if (flow === undefined) throw new Error(`no flow ${id}`);
  return flow;
}

const NUMBER_KINDS: ReadonlySet<FieldKind> = new Set([
  "amount",
  "blocks",
  "height",
  "bps",
  "ms",
]);

function boundLabel(n: bigint): string {
  if (n === MAX_UINT) return "2^128 - 1";
  if (n === MAX_POST_CONDITION_AMOUNT) return "2^64 - 1";
  return n.toString();
}

/** What to tell the owner when a number field does not parse. */
export function numberError(field: FlowField): string {
  const min = field.min ?? 0n;
  const max = field.max ?? MAX_UINT;
  return `Enter a whole number from ${min} to ${boundLabel(max)}, digits only: no sign, decimal point or spaces.`;
}

export type FormValues = Readonly<Record<string, string>>;

export type Prepared =
  | { ok: true; call: VaultCall }
  | {
      ok: false;
      /** One message per invalid field, by field name. */
      fieldErrors: Record<string, string>;
      /** A refusal by the SDK's builder that belongs to no single field. */
      formError: string | null;
    };

export interface FlowEnv {
  owner: string;
  config: ChainConfig;
}

/**
 * Validates a form's text values and builds its call with the SDK. An
 * invalid value never becomes a call, so it never reaches the chain.
 */
export function prepareCall(
  env: FlowEnv,
  id: FlowId,
  values: FormValues,
): Prepared {
  const { owner, config } = env;
  const flow = flowById(id);
  const fieldErrors: Record<string, string> = {};
  const numbers: Record<string, bigint> = {};
  const texts: Record<string, string> = {};

  for (const field of flow.fields) {
    const text = (values[field.name] ?? "").trim();
    texts[field.name] = text;
    if (NUMBER_KINDS.has(field.kind)) {
      const n = parseUint(text, field.min ?? 0n, field.max ?? MAX_UINT);
      if (n === null) fieldErrors[field.name] = numberError(field);
      else numbers[field.name] = n;
    } else if (field.kind === "optionalAmount") {
      if (text !== "") {
        const n = parseUint(text, field.min ?? 0n, field.max ?? MAX_UINT);
        if (n === null) {
          fieldErrors[field.name] =
            `${numberError(field)} Leave it empty for none.`;
        } else numbers[field.name] = n;
      }
    } else if (field.kind === "token") {
      if (!config.tokens.some((t) => t.id === text)) {
        fieldErrors[field.name] = "Choose one of the vault's tokens.";
      }
    } else if (field.kind === "adapter") {
      if (!config.adapters.some((a) => a.id === text)) {
        fieldErrors[field.name] = "Choose the vault's adapter.";
      }
    } else if (field.kind === "allowed") {
      if (text !== "allow" && text !== "revoke") {
        fieldErrors[field.name] = "Choose allow or revoke.";
      }
    } else if (text === "") {
      fieldErrors[field.name] = "Enter a Stacks address.";
    }
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, fieldErrors, formError: null };
  }

  const n = (name: string): bigint => numbers[name]!;
  const t = (name: string): string => texts[name]!;
  const tx = config.tx;
  try {
    switch (id) {
      case "deposit":
        return {
          ok: true,
          call: buildDeposit(tx, {
            owner,
            token: t("token"),
            amount: n("amount"),
          }),
        };
      case "withdraw":
        return {
          ok: true,
          call: buildWithdraw(tx, { token: t("token"), amount: n("amount") }),
        };
      case "set-agent":
        return { ok: true, call: buildSetAgent(tx, { agent: t("agent") }) };
      case "remove-agent":
        return { ok: true, call: buildRemoveAgent(tx) };
      case "pause":
        return { ok: true, call: buildPause(tx) };
      case "unpause":
        return { ok: true, call: buildUnpause(tx) };
      case "set-policy":
        return {
          ok: true,
          call: buildSetPolicy(tx, {
            cooldownBlocks: n("cooldownBlocks"),
            expiresAt: n("expiresAt"),
          }),
        };
      case "set-token-caps":
        return {
          ok: true,
          call: buildSetTokenCaps(tx, {
            token: t("token"),
            maxPerTrade: n("maxPerTrade"),
            maxPerDay: n("maxPerDay"),
          }),
        };
      case "set-price-bounds":
        return {
          ok: true,
          call: buildSetPriceBounds(tx, {
            maxSlippageBps: n("maxSlippageBps"),
            maxPriceAge: n("maxPriceAge"),
          }),
        };
      case "set-approval-threshold":
        return {
          ok: true,
          call: buildSetApprovalThreshold(tx, {
            token: t("token"),
            // Empty text never reached `numbers`: it clears the threshold.
            threshold: numbers.threshold ?? null,
          }),
        };
      case "allow-token":
        return {
          ok: true,
          call: buildAllowToken(tx, {
            token: t("token"),
            allowed: t("allowed") === "allow",
          }),
        };
      case "allow-adapter":
        return {
          ok: true,
          call: buildAllowAdapter(tx, {
            adapter: t("adapter"),
            allowed: t("allowed") === "allow",
          }),
        };
    }
  } catch (error) {
    if (!(error instanceof TxBuildError)) throw error;
    if (id === "set-agent" && error.code === "INVALID_PRINCIPAL") {
      return {
        ok: false,
        fieldErrors: {
          agent:
            "Enter a valid Stacks address (ST… or SP…) or contract id (address.name).",
        },
        formError: null,
      };
    }
    return {
      ok: false,
      fieldErrors: {},
      formError: `The SDK refused to build this call (${error.code}): ${error.message}.`,
    };
  }
}

/**
 * The line under a field that says what its current text means, for example
 * "= 0.50000000 sBTC". Empty when the text is not a valid value.
 */
export function fieldHint(
  field: FlowField,
  values: FormValues,
  config: ChainConfig,
  burnHeight: bigint,
): string {
  if (field.kind === "optionalAmount") {
    const text = (values[field.name] ?? "").trim();
    const info = tokenOf(config, values.token ?? "");
    if (info === null) return "";
    if (text === "") return `= ${thresholdWords(info, null)}`;
    const amount = parseUint(text, field.min ?? 0n, field.max ?? MAX_UINT);
    return amount === null ? "" : `= ${thresholdWords(info, amount)}`;
  }
  if (!NUMBER_KINDS.has(field.kind)) return "";
  const n = parseUint(
    values[field.name] ?? "",
    field.min ?? 0n,
    field.max ?? MAX_UINT,
  );
  if (n === null) return "";
  switch (field.kind) {
    case "amount": {
      const info = tokenOf(config, values.token ?? "");
      return info === null ? "" : `= ${human(info, n)}`;
    }
    case "blocks":
      return `= ${blocksWords(n)}`;
    case "height":
      return `= ${expiryWords(n, burnHeight)}`;
    case "bps":
      return n === 0n ? "= 0: the agent may not trade" : `= ${bpsWords(n)}`;
    case "ms":
      return n === 0n ? "= 0: the agent may not trade" : `= ${msWords(n)}`;
    default:
      return "";
  }
}
