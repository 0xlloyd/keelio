import {
  Cl,
  deserializePostConditionWire,
  postConditionToHex,
  wireToPostCondition,
  type ClarityValue,
} from "@stacks/transactions";
import { describe, expect, it } from "vitest";
import * as sdk from "../packages/sdk/src/index.js";
import {
  MAX_POST_CONDITION_AMOUNT,
  TxBuildError,
  type TxConfig,
  type VaultCall,
} from "../packages/sdk/src/index.js";

// No simnet: these tests check that a built call survives a wallet's JSON
// path and @stacks/transactions' own serialisation, exactly.

/** The fixed devnet deployer address. */
const D = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM";
const vault = `${D}.keelio-vault`;
const sbtc = `${D}.mock-sbtc`;
const usd = `${D}.mock-usd`;
const dex = `${D}.mock-dex`;
const bitflow = `${D}.bitflow-adapter`;
const pool = `${D}.mock-usd-pool`;

const config: TxConfig = {
  vault,
  assetNames: { [sbtc]: "mock-sbtc", [usd]: "mock-usd" },
  adapters: { [dex]: { pool: null }, [bitflow]: { pool } },
};

/** Amounts every post-condition builder must carry exactly. */
const PC_AMOUNTS = [1n, 2n ** 53n + 1n, 2n ** 64n - 1n];
/** Amounts that reach only `functionArgs`, up to the full uint128 range. */
const ARG_AMOUNTS = [0n, ...PC_AMOUNTS, 2n ** 128n - 1n];

/** A request's burn height, past what a JSON number holds exactly. */
const REQUESTED_AT = 2n ** 53n + 1n;

interface Case {
  /** The exported builder this case calls. */
  builder: string;
  label: string;
  call: VaultCall;
  /** Written from the contract's signature, with bigint uint values. */
  args: ClarityValue[];
  /** Each post-condition's amount, in order. */
  pcAmounts: bigint[];
}

function swapCases(amount: bigint): Case[] {
  const swap = (
    label: string,
    adapter: string,
    tokenIn: string,
    tokenOut: string,
    minOut: bigint,
    pcAmounts: bigint[],
  ): Case => ({
    builder: "buildExecuteSwap",
    label: `${label} ${amount}`,
    call: sdk.buildExecuteSwap(config, {
      owner: D,
      adapter,
      tokenIn,
      tokenOut,
      amountIn: amount,
      minOut,
    }),
    args: [
      Cl.principal(D),
      Cl.principal(adapter),
      Cl.principal(tokenIn),
      Cl.principal(tokenOut),
      Cl.uint(amount),
      Cl.uint(minOut),
    ],
    pcAmounts,
  });
  // approve-swap is the same trade without the owner argument and with the
  // request's burn height after it, with the same post-conditions;
  // request-swap is execute-swap's arguments and no post-condition.
  const approve = (
    label: string,
    adapter: string,
    minOut: bigint,
    pcAmounts: bigint[],
  ): Case => ({
    builder: "buildApproveSwap",
    label: `approve ${label} ${amount}`,
    call: sdk.buildApproveSwap(config, {
      adapter,
      tokenIn: sbtc,
      tokenOut: usd,
      amountIn: amount,
      minOut,
      requestedAt: REQUESTED_AT,
    }),
    args: [
      Cl.principal(adapter),
      Cl.principal(sbtc),
      Cl.principal(usd),
      Cl.uint(amount),
      Cl.uint(minOut),
      Cl.uint(REQUESTED_AT),
    ],
    pcAmounts,
  });
  const request: Case = {
    builder: "buildRequestSwap",
    label: `request-swap ${amount}`,
    call: sdk.buildRequestSwap(config, {
      owner: D,
      adapter: bitflow,
      tokenIn: sbtc,
      tokenOut: usd,
      amountIn: amount,
      minOut: amount,
    }),
    args: [
      Cl.principal(D),
      Cl.principal(bitflow),
      Cl.principal(sbtc),
      Cl.principal(usd),
      Cl.uint(amount),
      Cl.uint(amount),
    ],
    pcAmounts: [],
  };
  return [
    approve("sBTC to USD", dex, amount, [amount, amount]),
    approve("minOut 0", dex, 0n, [amount, 0n]),
    approve("pool route", bitflow, amount, [amount, amount, amount, amount]),
    request,
    swap("sBTC to USD", dex, sbtc, usd, amount, [amount, amount]),
    swap("USD to sBTC", dex, usd, sbtc, amount, [amount, amount]),
    swap("minOut 0", dex, sbtc, usd, 0n, [amount, 0n]),
    swap("pool route", bitflow, sbtc, usd, amount, [
      amount,
      amount,
      amount,
      amount,
    ]),
  ];
}

const cases: Case[] = [
  ...PC_AMOUNTS.flatMap((amount): Case[] => [
    {
      builder: "buildDeposit",
      label: `deposit ${amount}`,
      call: sdk.buildDeposit(config, { owner: D, token: sbtc, amount }),
      args: [Cl.principal(sbtc), Cl.uint(amount)],
      pcAmounts: [amount],
    },
    {
      builder: "buildWithdraw",
      label: `withdraw ${amount}`,
      call: sdk.buildWithdraw(config, { token: usd, amount }),
      args: [Cl.principal(usd), Cl.uint(amount)],
      pcAmounts: [amount],
    },
    ...swapCases(amount),
  ]),
  ...ARG_AMOUNTS.flatMap((amount): Case[] => [
    {
      builder: "buildSetPolicy",
      label: `set-policy ${amount}`,
      call: sdk.buildSetPolicy(config, {
        cooldownBlocks: amount,
        expiresAt: amount,
      }),
      args: [Cl.uint(amount), Cl.uint(amount)],
      pcAmounts: [],
    },
    {
      builder: "buildSetTokenCaps",
      label: `set-token-caps ${amount}`,
      call: sdk.buildSetTokenCaps(config, {
        token: sbtc,
        maxPerTrade: amount,
        maxPerDay: amount,
      }),
      args: [Cl.principal(sbtc), Cl.uint(amount), Cl.uint(amount)],
      pcAmounts: [],
    },
    // maxSlippageBps must stay below 10000, so only the age takes the
    // large amounts.
    {
      builder: "buildSetPriceBounds",
      label: `set-price-bounds ${amount}`,
      call: sdk.buildSetPriceBounds(config, {
        maxSlippageBps: amount < 10_000n ? amount : 9_999n,
        maxPriceAge: amount,
      }),
      args: [Cl.uint(amount < 10_000n ? amount : 9_999n), Cl.uint(amount)],
      pcAmounts: [],
    },
  ]),
  ...ARG_AMOUNTS.map((amount): Case => ({
    builder: "buildSetApprovalThreshold",
    label: `set-approval-threshold ${amount}`,
    call: sdk.buildSetApprovalThreshold(config, {
      token: sbtc,
      threshold: amount,
    }),
    args: [Cl.principal(sbtc), Cl.some(Cl.uint(amount))],
    pcAmounts: [],
  })),
  {
    builder: "buildSetApprovalThreshold",
    label: "set-approval-threshold none",
    call: sdk.buildSetApprovalThreshold(config, {
      token: usd,
      threshold: null,
    }),
    args: [Cl.principal(usd), Cl.none()],
    pcAmounts: [],
  },
  {
    builder: "buildRejectSwap",
    label: "reject-swap",
    call: sdk.buildRejectSwap(config),
    args: [],
    pcAmounts: [],
  },
  {
    builder: "buildCancelSwapRequest",
    label: "cancel-swap-request",
    call: sdk.buildCancelSwapRequest(config, { owner: D }),
    args: [Cl.principal(D)],
    pcAmounts: [],
  },
  // buildLeave returns several calls: each one is a case. The sBTC balance
  // is past 2^64 - 1, so it is split in two withdrawals.
  ...sdk
    .buildLeave(config, {
      balances: { [sbtc]: 2n ** 64n + 6n, [usd]: 2n ** 53n + 1n },
    })
    .map((step, i): Case => ({
      builder: "buildLeave",
      label: `leave step ${i + 1}: ${step.kind}`,
      call: step.call,
      args:
        step.kind === "pause"
          ? []
          : [Cl.principal(step.token), Cl.uint(step.amount)],
      pcAmounts: step.kind === "pause" ? [] : [step.amount],
    })),
  {
    builder: "buildSetAgent",
    label: "set-agent",
    call: sdk.buildSetAgent(config, { agent: D }),
    args: [Cl.principal(D)],
    pcAmounts: [],
  },
  {
    builder: "buildRemoveAgent",
    label: "remove-agent",
    call: sdk.buildRemoveAgent(config),
    args: [],
    pcAmounts: [],
  },
  {
    builder: "buildPause",
    label: "pause",
    call: sdk.buildPause(config),
    args: [],
    pcAmounts: [],
  },
  {
    builder: "buildUnpause",
    label: "unpause",
    call: sdk.buildUnpause(config),
    args: [],
    pcAmounts: [],
  },
  {
    builder: "buildAllowToken",
    label: "allow-token",
    call: sdk.buildAllowToken(config, { token: usd, allowed: true }),
    args: [Cl.principal(usd), Cl.bool(true)],
    pcAmounts: [],
  },
  {
    builder: "buildAllowAdapter",
    label: "allow-adapter",
    call: sdk.buildAllowAdapter(config, { adapter: dex, allowed: false }),
    args: [Cl.principal(dex), Cl.bool(false)],
    pcAmounts: [],
  },
];

const roundTrip = (call: VaultCall): VaultCall =>
  JSON.parse(JSON.stringify(call)) as VaultCall;

/** Paths in `value` holding a bigint, a number or undefined. */
function unsafeLeaves(value: unknown, path = "call"): string[] {
  if (value === undefined || typeof value === "bigint") return [path];
  if (typeof value === "number") return [path];
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => unsafeLeaves(v, `${path}[${i}]`));
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([k, v]) =>
      unsafeLeaves(v, `${path}.${k}`),
    );
  }
  return [];
}

describe("built calls are JSON-safe", () => {
  it("the table covers every exported builder", () => {
    const exported = Object.keys(sdk)
      .filter((k) => k.startsWith("build"))
      .sort();
    const covered = [...new Set(cases.map((c) => c.builder))].sort();
    expect(covered).toStrictEqual(exported);
  });

  it("covers 2^53 + 1 and 2^64 - 1 in post-conditions, 2^128 - 1 in arguments", () => {
    const pcAmounts = new Set(cases.flatMap((c) => c.pcAmounts));
    expect(pcAmounts.has(2n ** 53n + 1n)).toBe(true);
    expect(pcAmounts.has(2n ** 64n - 1n)).toBe(true);
    const argAmounts = new Set(
      cases.flatMap((c) =>
        c.args.flatMap((a) => (a.type === "uint" ? [a.value] : [])),
      ),
    );
    expect(argAmounts.has(2n ** 128n - 1n)).toBe(true);
  });

  for (const c of cases) {
    describe(c.label, () => {
      it("JSON.parse(JSON.stringify(call)) deep-equals the call", () => {
        expect(unsafeLeaves(c.call)).toStrictEqual([]);
        expect(roundTrip(c.call)).toStrictEqual(c.call);
      });

      it("each argument serialises to the Clarity value of its input", () => {
        const args = roundTrip(c.call).functionArgs;
        expect(args).toHaveLength(c.args.length);
        args.forEach((arg, i) => {
          const want = c.args[i]!;
          const hex = Cl.serialize(arg);
          expect(hex).toBe(Cl.serialize(want));
          const decoded = Cl.deserialize(hex);
          expect(decoded).toStrictEqual(want);
          if (want.type === "uint" && decoded.type === "uint") {
            expect(decoded.value).toBe(want.value);
            expect(typeof decoded.value).toBe("bigint");
          }
        });
      });

      it("each post-condition round-trips through its wire format", () => {
        const pcs = roundTrip(c.call).postConditions;
        expect(pcs).toHaveLength(c.pcAmounts.length);
        pcs.forEach((pc, i) => {
          const wire = deserializePostConditionWire(postConditionToHex(pc));
          expect(wireToPostCondition(wire)).toStrictEqual(pc);
          if (!("amount" in pc)) throw new Error(`no amount in ${pc.type}`);
          expect(BigInt(pc.amount)).toBe(c.pcAmounts[i]);
        });
      });
    });
  }
});

describe("post-condition amounts must fit u64", () => {
  const over = 2n ** 64n;

  function expectInvalidAmount(field: string, build: () => VaultCall) {
    let returned: VaultCall | undefined;
    try {
      returned = build();
    } catch (e) {
      expect(e).toBeInstanceOf(TxBuildError);
      expect((e as TxBuildError).code).toBe("INVALID_AMOUNT");
      expect((e as TxBuildError).message).toContain(field);
      expect((e as TxBuildError).message).toContain("2^64 - 1");
      return;
    }
    expect.fail(`expected INVALID_AMOUNT, got ${JSON.stringify(returned)}`);
  }

  const swap = (amountIn: bigint, minOut: bigint) =>
    sdk.buildExecuteSwap(config, {
      owner: D,
      adapter: dex,
      tokenIn: sbtc,
      tokenOut: usd,
      amountIn,
      minOut,
    });

  it("exports the bound as 2^64 - 1", () => {
    expect(MAX_POST_CONDITION_AMOUNT).toBe(18446744073709551615n);
  });

  it("refuses 2^64 in deposit and withdraw", () => {
    expectInvalidAmount("amount", () =>
      sdk.buildDeposit(config, { owner: D, token: sbtc, amount: over }),
    );
    expectInvalidAmount("amount", () =>
      sdk.buildWithdraw(config, { token: sbtc, amount: over }),
    );
  });

  it("refuses 2^64 as amountIn or minOut in execute-swap", () => {
    expectInvalidAmount("amountIn", () => swap(over, 1n));
    expectInvalidAmount("minOut", () => swap(1n, over));
    // amountIn is checked first.
    expectInvalidAmount("amountIn", () => swap(over, over));
  });

  it("refuses 2^64 as amountIn or minOut in request-swap and approve-swap", () => {
    const terms = { adapter: dex, tokenIn: sbtc, tokenOut: usd };
    const request = (amountIn: bigint, minOut: bigint) =>
      sdk.buildRequestSwap(config, { owner: D, ...terms, amountIn, minOut });
    const approve = (amountIn: bigint, minOut: bigint) =>
      sdk.buildApproveSwap(config, {
        ...terms,
        amountIn,
        minOut,
        requestedAt: REQUESTED_AT,
      });
    // A request carries no post-condition, but the approval of it must.
    for (const build of [request, approve]) {
      expectInvalidAmount("amountIn", () => build(over, 1n));
      expectInvalidAmount("minOut", () => build(1n, over));
      expectInvalidAmount("amountIn", () => build(0n, 1n));
    }
    const max = MAX_POST_CONDITION_AMOUNT;
    expect(request(max, max).postConditions).toStrictEqual([]);
    expect(approve(max, max).postConditions).toHaveLength(2);
  });

  it("builds 2^64 - 1 in every post-condition field", () => {
    const max = MAX_POST_CONDITION_AMOUNT;
    expect(
      sdk.buildDeposit(config, { owner: D, token: sbtc, amount: max })
        .postConditions,
    ).toHaveLength(1);
    expect(
      sdk.buildWithdraw(config, { token: sbtc, amount: max }).postConditions,
    ).toHaveLength(1);
    expect(swap(max, max).postConditions).toHaveLength(2);
  });

  it("still builds set-policy and set-token-caps at 2^128 - 1", () => {
    const max = 2n ** 128n - 1n;
    expect(
      sdk.buildSetPolicy(config, { cooldownBlocks: max, expiresAt: max })
        .functionName,
    ).toBe("set-policy");
    expect(
      sdk.buildSetTokenCaps(config, {
        token: sbtc,
        maxPerTrade: max,
        maxPerDay: max,
      }).functionName,
    ).toBe("set-token-caps");
  });
});
