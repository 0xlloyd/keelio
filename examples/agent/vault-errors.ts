// The codes `keelio-vault` can return to an agent's calls, with the names of
// their constants in the contract: `execute-swap`'s, and those of the owner
// approval band (`request-swap`, `approve-swap`, `cancel-swap-request`).
// Copied from docs/errors.md; tests/example-agent.test.ts fails if the two
// disagree.

export const EXECUTE_SWAP_ERRORS: Readonly<Record<number, string>> = {
  100: "ERR-ZERO-AMOUNT",
  101: "ERR-INSUFFICIENT-BALANCE",
  104: "ERR-ALLOWANCE-EXCEEDED",
  108: "ERR-NOT-AGENT",
  109: "ERR-VAULT-PAUSED",
  110: "ERR-POLICY-EXPIRED",
  111: "ERR-SWAP-TOKEN-NOT-ALLOWED",
  112: "ERR-SAME-TOKEN",
  113: "ERR-SWAP-ADAPTER-NOT-ALLOWED",
  114: "ERR-TRADE-CAP-EXCEEDED",
  115: "ERR-DAY-CAP-EXCEEDED",
  116: "ERR-COOLDOWN-ACTIVE",
  117: "ERR-ADAPTER-FAILED",
  118: "ERR-BELOW-MIN-OUT",
  119: "ERR-PRICE-BOUNDS-UNSET",
  121: "ERR-ORACLE-FAILED",
  122: "ERR-PRICE-ZERO",
  123: "ERR-PRICE-STALE",
  124: "ERR-PRICE-OVERFLOW",
  125: "ERR-BELOW-ORACLE-FLOOR",
  126: "ERR-APPROVAL-REQUIRED",
  127: "ERR-APPROVAL-NOT-NEEDED",
  128: "ERR-REQUEST-PENDING",
  129: "ERR-NO-PENDING-SWAP",
  130: "ERR-REQUEST-EXPIRED",
  131: "ERR-REQUEST-MISMATCH",
  132: "ERR-REQUEST-AGENT-CHANGED",
  133: "ERR-NOT-REQUESTER",
};

/** The contract's constant name for one of those error codes. */
export function vaultErrorName(code: number): string {
  return Object.hasOwn(EXECUTE_SWAP_ERRORS, code)
    ? EXECUTE_SWAP_ERRORS[code]!
    : `unlisted code u${code}`;
}
