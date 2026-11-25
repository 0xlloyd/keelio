import { describe, expect, it } from "vitest";
import {
  ASSET_SCALE,
  SizingError,
  sizePosition,
  type SizingErrorCode,
} from "./index.js";

const base = {
  capital: 100_000n,
  riskBps: 100n,
  entry: 9_469_100n,
  stop: 9_363_700n,
  lotSize: 1_000n,
};

function codeOf(
  input: Parameters<typeof sizePosition>[0],
): SizingErrorCode | undefined {
  try {
    sizePosition(input);
  } catch (e) {
    if (e instanceof SizingError) return e.code;
    throw e;
  }
  return undefined;
}

describe("sizePosition", () => {
  it("sizes the worked example", () => {
    const { quantity, riskAmount } = sizePosition(base);
    expect(quantity).toBe(948_000n);
    expect(riskAmount).toBe(1_000n);
    expect(quantity % 1_000n).toBe(0n);
    expect(quantity * 105_400n * 10_000n <= 100_000n * 100n * ASSET_SCALE).toBe(
      true,
    );
  });

  it("gives the same quantity for a short with the same distance", () => {
    const long = sizePosition(base);
    const short = sizePosition({ ...base, stop: 9_574_500n });
    expect(short).toEqual(long);
  });

  it("rounds down to the lot", () => {
    expect(sizePosition({ ...base, lotSize: 1n }).quantity).toBe(948_766n);
    expect(sizePosition({ ...base, lotSize: 1_000n }).quantity).toBe(948_000n);
  });

  it("returns zero when the lot is larger than the raw quantity", () => {
    expect(sizePosition({ ...base, lotSize: 10_000_000n })).toEqual({
      quantity: 0n,
      riskAmount: 0n,
    });
  });

  it("refuses entry equal to stop", () => {
    expect(codeOf({ ...base, stop: base.entry })).toBe("ENTRY_EQUALS_STOP");
  });

  it.each(["capital", "riskBps", "entry", "stop", "lotSize"] as const)(
    "refuses zero and negative %s",
    (field) => {
      expect(codeOf({ ...base, [field]: 0n })).toBe("NON_POSITIVE_INPUT");
      expect(codeOf({ ...base, [field]: -1n })).toBe("NON_POSITIVE_INPUT");
    },
  );

  it("checks non-positive inputs before the ceiling and entry equals stop", () => {
    expect(codeOf({ ...base, riskBps: 0n, stop: base.entry })).toBe(
      "NON_POSITIVE_INPUT",
    );
    expect(codeOf({ ...base, riskBps: 201n, stop: base.entry })).toBe(
      "RISK_ABOVE_CEILING",
    );
  });

  it("refuses risk above the ceiling and accepts the ceiling", () => {
    expect(codeOf({ ...base, riskBps: 201n })).toBe("RISK_ABOVE_CEILING");
    expect(codeOf({ ...base, riskBps: 200n })).toBeUndefined();
  });
});
