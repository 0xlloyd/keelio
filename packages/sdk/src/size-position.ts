/** Asset base units per whole asset (sBTC sats). */
export const ASSET_SCALE = 10n ** 8n;

/** Highest risk per trade the sizer accepts, in basis points (2%). */
export const MAX_RISK_BPS = 200n;

export type SizingErrorCode =
  "ENTRY_EQUALS_STOP" | "NON_POSITIVE_INPUT" | "RISK_ABOVE_CEILING";

export class SizingError extends Error {
  readonly code: SizingErrorCode;

  constructor(code: SizingErrorCode, message: string) {
    super(message);
    this.name = "SizingError";
    this.code = code;
  }
}

export interface SizePositionInput {
  /** Capital in quote units (for example USD cents). */
  capital: bigint;
  /** Risk per trade in basis points of capital. */
  riskBps: bigint;
  /** Entry price in quote units per whole asset. */
  entry: bigint;
  /** Stop price in quote units per whole asset. */
  stop: bigint;
  /** Lot size in asset base units. */
  lotSize: bigint;
}

export interface SizedPosition {
  /** Position size in asset base units, a multiple of `lotSize`. */
  quantity: bigint;
  /** Loss at the stop in quote units, rounded up. */
  riskAmount: bigint;
}

/** Sizes a position so that a stop-out loses at most `riskBps` of capital. */
export function sizePosition(input: SizePositionInput): SizedPosition {
  const { capital, riskBps, entry, stop, lotSize } = input;

  if (
    capital <= 0n ||
    riskBps <= 0n ||
    entry <= 0n ||
    stop <= 0n ||
    lotSize <= 0n
  ) {
    throw new SizingError(
      "NON_POSITIVE_INPUT",
      "capital, riskBps, entry, stop and lotSize must be above zero",
    );
  }
  if (riskBps > MAX_RISK_BPS) {
    throw new SizingError(
      "RISK_ABOVE_CEILING",
      `riskBps must be at most ${MAX_RISK_BPS}`,
    );
  }
  if (entry === stop) {
    throw new SizingError("ENTRY_EQUALS_STOP", "entry and stop must differ");
  }

  const distance = entry > stop ? entry - stop : stop - entry;
  const raw = (capital * riskBps * ASSET_SCALE) / (10_000n * distance);
  const quantity = raw - (raw % lotSize);
  if (quantity === 0n) {
    return { quantity: 0n, riskAmount: 0n };
  }
  const riskAmount = (quantity * distance + ASSET_SCALE - 1n) / ASSET_SCALE;
  return { quantity, riskAmount };
}
