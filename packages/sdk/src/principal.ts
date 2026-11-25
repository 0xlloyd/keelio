import { isClarityName, validateStacksAddress } from "@stacks/transactions";

// The one principal grammar the SDK's builders and API client, the MCP
// server's inputs and the dashboard's testnet config share: a Stacks address,
// or a contract id `ADDR.name` split at its first `.`.

const MAX_CONTRACT_NAME = 40;
// The node's contract-name rule. Stricter than `isClarityName`, which also
// allows `/`, `?` and other characters that would change a URL.
const NODE_CONTRACT_NAME = /^[a-zA-Z]([a-zA-Z0-9]|[-_])*$/;

function isContractName(name: string): boolean {
  return (
    name.length >= 1 && name.length <= MAX_CONTRACT_NAME && isClarityName(name)
  );
}

/**
 * Why `value` is not a principal, as the end of a sentence that starts with
 * its field name ("owner is not a valid Stacks address"), or `null` when it
 * is one. The contract name must be a Clarity name of 1 to 40 characters.
 * `contractOnly` refuses a standard address.
 */
export function principalProblem(
  value: string,
  contractOnly: boolean,
): string | null {
  const dot = value.indexOf(".");
  if (dot === -1) {
    if (contractOnly) return "must be a contract id ADDR.name";
    return validateStacksAddress(value)
      ? null
      : "is not a valid Stacks address";
  }
  if (!validateStacksAddress(value.slice(0, dot))) {
    return "has an invalid address part";
  }
  if (!isContractName(value.slice(dot + 1))) {
    return "has an invalid contract name";
  }
  return null;
}

/**
 * `true` for a contract id whose name also meets the node's stricter rule
 * (letters, digits, `-` and `_`), so it can go into an API path as it is.
 */
export function isNodeContractId(value: string): boolean {
  return (
    principalProblem(value, true) === null &&
    NODE_CONTRACT_NAME.test(value.slice(value.indexOf(".") + 1))
  );
}
