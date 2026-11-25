// Probe for docs/bitflow.md: one swap on each Bitflow path, from a contract principal.
//
// This runs in a second simnet project (tests/bitflow-remote) that reads mainnet contract state
// through Hiro's public API. It only reads. Nothing is signed or broadcast. The "donor" below is
// a mainnet sBTC holder used as the sender of one local transfer in the simnet, which does not
// check signatures; no key for it exists here.
//
// It needs the network, so it runs only under `pnpm run test:online`. `pnpm run check` reports it
// as skipped and stays offline.
import { initSimnet } from "@stacks/clarinet-sdk";
import {
  Cl,
  type ClarityValue,
  type ResponseOkCV,
  type TupleCV,
  type UIntCV,
} from "@stacks/transactions";
import { describe, expect, it } from "vitest";

// Off by default so the gate never depends on the network. `pnpm run test:online` sets it.
const online = process.env.KEELIO_ONLINE === "1";

const SBTC = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const USDCX = "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx";
const DONOR = "SPMN217717VVAC8VABB76PXX016FVHGDD87HVC6K";

describe.runIf(online)(
  "bitflow probe (mainnet state, simnet execution)",
  () => {
    it("swaps from a contract principal through the DLMM routers and both XYK directions", async () => {
      const simnet = await initSimnet("tests/bitflow-remote/Clarinet.toml");
      const deployer = simnet.deployer;
      const probe = `${deployer}.bitflow-probe`;

      const balance = (token: string): bigint => {
        const r = simnet.callReadOnlyFn(
          token,
          "get-balance",
          [Cl.principal(probe)],
          deployer,
        ).result as { value: { value: bigint } };
        return r.value.value;
      };
      const stx = (): bigint =>
        simnet.getAssetsMap().get("STX")?.get(probe) ?? 0n;
      const call = (fn: string, args: ClarityValue[]) =>
        simnet.callPublicFn(probe, fn, args, deployer).result;
      const okValue = (cv: ClarityValue): ClarityValue => {
        expect(cv.type).toBe("ok");
        return (cv as ResponseOkCV).value;
      };
      const uint = (cv: ClarityValue): bigint => BigInt((cv as UIntCV).value);
      const field = (cv: ClarityValue, key: string): bigint =>
        uint((cv as TupleCV).value[key]!);

      // Fund the probe: a local transfer in the simnet, sent as a mainnet holder.
      const funded = simnet.callPublicFn(
        SBTC,
        "transfer",
        [
          Cl.uint(1_000_000),
          Cl.principal(DONOR),
          Cl.principal(probe),
          Cl.none(),
        ],
        DONOR,
      );
      expect(funded.result).toStrictEqual(Cl.ok(Cl.bool(true)));
      simnet.transferSTX(100_000_000n, probe, deployer);

      // The deployer is a mainnet-version address (use_mainnet_wallets), so is-standard accepts it
      // and the contract principal under it.
      expect(probe.startsWith("SP")).toBe(true);

      // DLMM v-1-1: min-out 0 is accepted, and the contract's USDCx balance rises by `out`.
      let sbtcBefore = balance(SBTC);
      let usdcxBefore = balance(USDCX);
      const d1 = okValue(
        call("dlmm-v11-sbtc-for-usdcx", [Cl.uint(10_000), Cl.uint(0)]),
      );
      const d1Out = field(d1, "out");
      expect(d1Out).toBeGreaterThan(0n);
      expect(balance(USDCX)).toBe(usdcxBefore + d1Out);
      expect(balance(SBTC)).toBe(sbtcBefore - field(d1, "in"));

      // DLMM v-1-2: same swap, no deadline.
      usdcxBefore = balance(USDCX);
      const d2 = okValue(
        call("dlmm-v12-sbtc-for-usdcx", [
          Cl.uint(10_000),
          Cl.uint(1),
          Cl.none(),
        ]),
      );
      expect(balance(USDCX)).toBe(usdcxBefore + field(d2, "out"));

      // DLMM v-1-2: a deadline in the past is refused with ERR_DEADLINE_PASSED (u2012).
      expect(
        call("dlmm-v12-sbtc-for-usdcx", [
          Cl.uint(10_000),
          Cl.uint(1),
          Cl.some(Cl.uint(1)),
        ]),
      ).toStrictEqual(Cl.error(Cl.uint(2012)));

      // DLMM v-1-1: an unreachable min-out is refused with ERR_MINIMUM_RECEIVED (u2003).
      expect(
        call("dlmm-v11-sbtc-for-usdcx", [
          Cl.uint(10_000),
          Cl.uint(10_000_000_000),
        ]),
      ).toStrictEqual(Cl.error(Cl.uint(2003)));

      // XYK: min-dy 0 is refused with ERR_INVALID_AMOUNT (u1002).
      expect(
        call("xyk-sbtc-for-stx", [Cl.uint(10_000), Cl.uint(0)]),
      ).toStrictEqual(Cl.error(Cl.uint(1002)));

      // XYK sBTC -> STX: the contract receives STX through the STX wrapper token.
      sbtcBefore = balance(SBTC);
      let stxBefore = stx();
      const x1 = okValue(
        call("xyk-sbtc-for-stx", [Cl.uint(10_000), Cl.uint(1)]),
      );
      expect(stx()).toBe(stxBefore + uint(x1));
      expect(balance(SBTC)).toBe(sbtcBefore - 10_000n);

      // XYK STX -> sBTC: the STX wrapper debits the contract; its sBTC balance rises.
      sbtcBefore = balance(SBTC);
      stxBefore = stx();
      const x2 = okValue(
        call("xyk-stx-for-sbtc", [Cl.uint(5_000_000), Cl.uint(1)]),
      );
      expect(balance(SBTC)).toBe(sbtcBefore + uint(x2));
      expect(balance(SBTC)).toBeGreaterThan(sbtcBefore);
      expect(stx()).toBe(stxBefore - 5_000_000n);
    }, 180_000);
  },
);
