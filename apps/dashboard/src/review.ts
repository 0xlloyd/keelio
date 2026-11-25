// The review step's content: one built call in words, before it is sent.
// It reads only the `VaultCall` the SDK built, so what the owner reviews is
// what is submitted.
import {
  Cl,
  type ClarityValue,
  type PostCondition,
} from "@stacks/transactions";
import type { VaultCall } from "../../../packages/sdk/src/build-tx.js";
import type { ChainConfig } from "./chain.js";
import {
  amountOf,
  blocksWords,
  bpsWords,
  capitalise,
  expiryWords,
  label,
  msWords,
  principalText,
  thresholdWords,
  tokenOf,
} from "./format.js";

/** Each keelio-vault function's argument names, in order. */
const ARGUMENTS: Readonly<Record<string, readonly string[]>> = {
  deposit: ["token", "amount"],
  withdraw: ["token", "amount"],
  "set-agent": ["agent"],
  "remove-agent": [],
  pause: [],
  unpause: [],
  "set-policy": ["cooldown-blocks", "expires-at"],
  "set-token-caps": ["token", "max-per-trade", "max-per-day"],
  "set-price-bounds": ["max-slippage-bps", "max-price-age"],
  "set-approval-threshold": ["token", "threshold"],
  "allow-token": ["token", "allowed"],
  "allow-adapter": ["adapter", "allowed"],
  "execute-swap": [
    "owner",
    "adapter",
    "token-in",
    "token-out",
    "amount-in",
    "min-out",
  ],
  "request-swap": [
    "owner",
    "adapter",
    "token-in",
    "token-out",
    "amount-in",
    "min-out",
  ],
  "approve-swap": [
    "adapter",
    "token-in",
    "token-out",
    "amount-in",
    "min-out",
    "requested-at",
  ],
  "reject-swap": [],
  "cancel-swap-request": ["owner"],
};

/** Which argument names the token an amount argument is counted in. */
const AMOUNT_TOKEN: Readonly<Record<string, string>> = {
  amount: "token",
  "max-per-trade": "token",
  "max-per-day": "token",
  "amount-in": "token-in",
  "min-out": "token-out",
};

export interface ArgumentReview {
  name: string;
  /** The Clarity value as sent, for example `u10000000`. */
  value: string;
  /** The same value in words. */
  meaning: string;
}

export interface PostConditionReview {
  /** The condition as a sentence. */
  text: string;
  /** The condition exactly as the SDK built it, as JSON. */
  raw: string;
}

export interface CallReview {
  /** The contract id the call goes to. */
  contract: string;
  functionName: string;
  args: ArgumentReview[];
  /** One entry per post-condition, in the SDK's order. */
  postConditions: PostConditionReview[];
  /** What the mode means for this call. */
  mode: string;
}

const COMPARATOR: Readonly<Record<string, string>> = {
  eq: "exactly",
  gt: "more than",
  gte: "at least",
  lt: "less than",
  lte: "at most",
};

/** A post-condition as JSON, with any bigint amount as its digits. */
export function rawPostCondition(pc: PostCondition): string {
  return JSON.stringify(pc, (_, v: unknown) =>
    typeof v === "bigint" ? v.toString() : v,
  );
}

/**
 * One post-condition as a sentence, for example "The vault sends exactly
 * 10000000 sats of mock sBTC (0.10000000 sBTC)." A kind the dashboard does
 * not know is printed as its JSON, never dropped.
 */
export function describePostCondition(
  pc: PostCondition,
  config: ChainConfig,
): string {
  const word = "condition" in pc ? COMPARATOR[pc.condition] : undefined;
  if (pc.type !== "ft-postcondition" || word === undefined) {
    return `Unrecognised post-condition: ${rawPostCondition(pc)}`;
  }
  const token = pc.asset.split("::")[0]!;
  const name = label(config, pc.address);
  // "the vault" starts the sentence as "The vault"; a contract name is kept.
  const who = name.startsWith("the ") ? capitalise(name) : name;
  return `${who} sends ${word} ${amountOf(config, token, BigInt(pc.amount))}.`;
}

function describeMode(call: VaultCall): string {
  if (call.postConditionMode !== "deny") {
    return `Mode: ${String(call.postConditionMode)}.`;
  }
  return call.postConditions.length === 0
    ? "Deny mode with no post-conditions: this call may not move any token. If it tried to, the whole transaction would be rolled back."
    : "Deny mode: any token transfer these lines do not cover rolls the whole transaction back.";
}

function meaning(
  name: string,
  value: ClarityValue,
  named: ReadonlyMap<string, ClarityValue>,
  config: ChainConfig,
  burnHeight: bigint,
): string {
  if (
    name === "threshold" &&
    (value.type === "some" || value.type === "none")
  ) {
    const tokenArg = named.get("token");
    const token =
      tokenArg === undefined ? null : tokenOf(config, principalText(tokenArg));
    const threshold =
      value.type === "some" && value.value.type === "uint"
        ? BigInt(value.value.value)
        : null;
    if (value.type === "none" || threshold !== null) {
      return token === null
        ? threshold === null
          ? "none"
          : threshold.toString()
        : thresholdWords(token, threshold);
    }
  }
  switch (value.type) {
    case "address":
    case "contract": {
      const principal = principalText(value);
      const short = label(config, principal);
      return short === principal ? "a principal" : short;
    }
    case "true":
      return name === "allowed" ? "yes, allow" : "true";
    case "false":
      return name === "allowed" ? "no, revoke" : "false";
    case "uint": {
      const n = BigInt(value.value);
      const tokenArg = AMOUNT_TOKEN[name];
      const token = tokenArg === undefined ? undefined : named.get(tokenArg);
      if (token !== undefined) {
        return amountOf(config, principalText(token), n);
      }
      if (name === "cooldown-blocks") return blocksWords(n);
      if (name === "expires-at") return expiryWords(n, burnHeight);
      if (name === "requested-at") {
        return `the request the agent made at burn height ${n}, and no other`;
      }
      if (name === "max-slippage-bps") {
        return n === 0n
          ? "0 bps: the agent may not trade"
          : `${bpsWords(n)} below the oracle price, at most`;
      }
      if (name === "max-price-age") {
        return n === 0n ? "0 ms: the agent may not trade" : msWords(n);
      }
      return n.toString();
    }
    default:
      return Cl.prettyPrint(value);
  }
}

/**
 * The call as the review step shows it. `burnHeight` is the current burn
 * height, so an expiry reads as a distance from now.
 */
export function reviewCall(
  call: VaultCall,
  config: ChainConfig,
  burnHeight: bigint,
): CallReview {
  const names = ARGUMENTS[call.functionName] ?? [];
  const named = new Map<string, ClarityValue>();
  call.functionArgs.forEach((value, i) => {
    named.set(names[i] ?? `argument ${i + 1}`, value);
  });
  return {
    contract: `${call.contractAddress}.${call.contractName}`,
    functionName: call.functionName,
    args: [...named].map(([name, value]) => ({
      name,
      value: Cl.prettyPrint(value),
      meaning: meaning(name, value, named, config, burnHeight),
    })),
    postConditions: call.postConditions.map((pc) => ({
      text: describePostCondition(pc, config),
      raw: rawPostCondition(pc),
    })),
    mode: describeMode(call),
  };
}
