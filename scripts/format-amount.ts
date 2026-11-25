// Formats token base units as a decimal string with integer maths only, so
// no amount ever passes through a float.

/** `amount` base units with `decimals` places, for example 10_000_000n, 8 → "0.10000000". */
export function formatUnits(amount: bigint, decimals: number): string {
  if (!Number.isSafeInteger(decimals) || decimals < 0) {
    throw new RangeError("decimals must be a non-negative safe integer");
  }
  if (amount < 0n) throw new RangeError("amount must not be negative");
  if (decimals === 0) return amount.toString();
  const scale = 10n ** BigInt(decimals);
  const whole = amount / scale;
  const fraction = (amount % scale).toString().padStart(decimals, "0");
  return `${whole}.${fraction}`;
}

/** sBTC base units (sats) with 8 decimals. */
export function formatBtc(amount: bigint): string {
  return formatUnits(amount, 8);
}
