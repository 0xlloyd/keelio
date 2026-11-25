import {
  checkIntent,
  type Intent,
  type VaultState,
} from "../../packages/sdk/src/index.js";

/**
 * Asks the SDK whether the vault would accept a swap before the agent pays a
 * fee to send it. The contract runs the same checks and has the final say.
 */
export function canSwap(state: VaultState, intent: Intent): string {
  const check = checkIntent(state, intent);
  if (check.ok) return "ok";
  return `${check.rule} (u${check.errorCode}): ${check.message}`;
}
