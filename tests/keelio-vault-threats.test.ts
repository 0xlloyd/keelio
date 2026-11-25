import { readFileSync } from "node:fs";
import { initSimnet } from "@stacks/clarinet-sdk";
import { Cl, type ClarityValue } from "@stacks/transactions";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PRICE_90K, armOracle, floorOf } from "./oracle-fixture.js";
import { vaultClarityVersion } from "./vault-clarity-version.js";

// Tests for the claims in docs/threat-model.md that no other file proves.
// Each describe block is named by its threat ID in that doc. The helpers copy
// the shapes in keelio-vault-swap.test.ts; importing that file would run its
// simnet and its tests here too.

const simnet = await initSimnet();
const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const alice = accounts.get("wallet_1")!;
const bob = accounts.get("wallet_2")!;
const mallory = accounts.get("wallet_3")!;
const carol = accounts.get("wallet_4")!;

const sbtc = `${deployer}.mock-sbtc`;
const usd = `${deployer}.mock-usd`;
const dex = `${deployer}.mock-dex`;
const vault = `${deployer}.keelio-vault`;
const intermediary = `${deployer}.vault-caller`;

const MAX_UINT = 340282366920938463463374607431768211455n;

// The passing fixture, as in keelio-vault-swap.test.ts. Rate 900/1.
const RATE = 900n;
const DEPOSIT = 1_000_000n;
const AMOUNT_IN = 10_000n;
const OUT = AMOUNT_IN * RATE; // 9_000_000
const MAX_PER_TRADE = 100_000n;
const MAX_PER_DAY = 1_000_000_000n;
const EXPIRES_AT = 1_000_000n;
// The oracle fixture: $90,000 (the dex rate 900), 100 bps, and an age limit
// no test here reaches. FLOOR is the least min-out for AMOUNT_IN.
const SLIPPAGE_BPS = 100n;
const ORACLE = {
  price: PRICE_90K,
  slippageBps: SLIPPAGE_BPS,
  maxAgeMs: 10n ** 15n,
};
const FLOOR = floorOf(AMOUNT_IN, PRICE_90K, SLIPPAGE_BPS, true); // 8_910_000

const everyone = [alice, bob, mallory, carol, deployer, intermediary];

const vaultSource = readFileSync(
  new URL("../contracts/keelio-vault.clar", import.meta.url),
  "utf8",
);

function readUint(value: ClarityValue, wrappedInOk: boolean): bigint {
  const inner = wrappedInOk && value.type === "ok" ? value.value : value;
  if (inner.type !== "uint")
    throw new Error(`expected uint, got ${inner.type}`);
  return BigInt(inner.value);
}

function mint(contract: string, amount: bigint, recipient: string) {
  const { result } = simnet.callPublicFn(
    contract,
    "mint",
    [Cl.uint(amount), Cl.principal(recipient)],
    deployer,
  );
  expect(result).toStrictEqual(Cl.ok(Cl.bool(true)));
}

function wallet(contract: string, who: string): bigint {
  const { result } = simnet.callReadOnlyFn(
    contract,
    "get-balance",
    [Cl.principal(who)],
    deployer,
  );
  return readUint(result, true);
}

function ledger(owner: string, token: string, contract = "keelio-vault") {
  const { result } = simnet.callReadOnlyFn(
    contract,
    "get-balance",
    [Cl.principal(owner), Cl.principal(token)],
    deployer,
  );
  return readUint(result, false);
}

function printEvents(events: { event: string; data: unknown }[]) {
  return events
    .filter((e) => e.event === "print_event")
    .map((e) => (e.data as { value: ClarityValue }).value);
}

function ok(call: { result: ClarityValue }) {
  expect(call.result).toStrictEqual(Cl.ok(Cl.bool(true)));
}

function vaultCall(sender: string, fn: string, args: ClarityValue[] = []) {
  return simnet.callPublicFn("keelio-vault", fn, args, sender);
}

function readOnly(fn: string, args: ClarityValue[]) {
  return simnet.callReadOnlyFn("keelio-vault", fn, args, deployer).result;
}

function deposit(sender: string, token: string, amount: bigint) {
  return vaultCall(sender, "deposit", [Cl.principal(token), Cl.uint(amount)]);
}

function withdraw(sender: string, token: string, amount: bigint) {
  return vaultCall(sender, "withdraw", [Cl.principal(token), Cl.uint(amount)]);
}

function setPolicy(
  maxPerTrade: bigint,
  maxPerDay: bigint,
  cooldownBlocks: bigint,
  expiresAt: bigint,
  owner = alice,
  token = sbtc,
) {
  ok(
    vaultCall(owner, "set-token-caps", [
      Cl.principal(token),
      Cl.uint(maxPerTrade),
      Cl.uint(maxPerDay),
    ]),
  );
  ok(
    vaultCall(owner, "set-policy", [
      Cl.uint(cooldownBlocks),
      Cl.uint(expiresAt),
    ]),
  );
}

function allowToken(token: string, allowed: boolean, owner = alice) {
  ok(vaultCall(owner, "allow-token", [Cl.principal(token), Cl.bool(allowed)]));
}

function allowAdapter(allowed: boolean, owner = alice) {
  ok(vaultCall(owner, "allow-adapter", [Cl.principal(dex), Cl.bool(allowed)]));
}

function setSkim(amount: bigint) {
  ok(simnet.callPublicFn("mock-dex", "set-skim", [Cl.uint(amount)], deployer));
}

type Swap = {
  sender?: string;
  owner?: string;
  amountIn?: bigint;
  minOut?: bigint;
};

function swapArgs(s: Swap) {
  return [
    Cl.principal(s.owner ?? alice),
    Cl.principal(dex),
    Cl.principal(sbtc),
    Cl.principal(usd),
    Cl.uint(s.amountIn ?? AMOUNT_IN),
    Cl.uint(s.minOut ?? 0n),
  ];
}

function swap(s: Swap = {}) {
  const call = vaultCall(s.sender ?? bob, "execute-swap", swapArgs(s));
  expectInvariant();
  return call;
}

function tradeState(owner = alice, token = sbtc) {
  return readOnly("get-trade-state", [
    Cl.principal(owner),
    Cl.principal(token),
  ]);
}

// The vault's balance of each token equals the sum of every ledger.
// `get-ledger-total` reads that sum too.
function expectInvariant() {
  for (const token of [sbtc, usd]) {
    let sum = 0n;
    for (const who of everyone) sum += ledger(who, token);
    expect(wallet(token, vault)).toBe(sum);
    const total = simnet.callReadOnlyFn(
      "keelio-vault",
      "get-ledger-total",
      [Cl.principal(token)],
      deployer,
    ).result;
    expect(readUint(total, false)).toBe(sum);
  }
}

function snapshot(owner = alice) {
  return {
    ledgers: [sbtc, usd].map((t) => everyone.map((w) => ledger(w, t))),
    tradeState: [tradeState(owner, sbtc), tradeState(owner, usd)],
    vault: [sbtc, usd].map((t) => wallet(t, vault)),
    dex: [sbtc, usd].map((t) => wallet(t, dex)),
    wallets: [sbtc, usd].map((t) => everyone.map((w) => wallet(t, w))),
  };
}

// A refused swap returns its own error, prints nothing and changes nothing.
function expectRefused(code: number, s: Swap = {}) {
  const before = snapshot(s.owner ?? alice);
  const call = swap(s);
  expect(call.result).toStrictEqual(Cl.error(Cl.uint(code)));
  expect(printEvents(call.events)).toStrictEqual([]);
  expect(snapshot(s.owner ?? alice)).toStrictEqual(before);
  expectInvariant();
}

// A swap at the oracle floor that succeeds and receives exactly the floor:
// the input leaves Alice's ledger and only the floor arrives.
function expectFloorFill(amountIn: bigint) {
  const floor = floorOf(amountIn, PRICE_90K, SLIPPAGE_BPS, true);
  const before = { sbtc: ledger(alice, sbtc), usd: ledger(alice, usd) };
  const call = swap({ amountIn, minOut: floor });
  expect(call.result).toStrictEqual(Cl.ok(Cl.uint(floor)));
  expect(ledger(alice, sbtc)).toBe(before.sbtc - amountIn);
  expect(ledger(alice, usd)).toBe(before.usd + floor);
  return call;
}

// Alice's whole state in the real vault, read through every read-only.
function aliceEntries() {
  return {
    vault: readOnly("get-vault", [Cl.principal(alice)]),
    policy: [sbtc, usd].map((t) =>
      readOnly("get-policy", [Cl.principal(alice), Cl.principal(t)]),
    ),
    tokens: [sbtc, usd].map((t) =>
      readOnly("is-token-allowed", [Cl.principal(alice), Cl.principal(t)]),
    ),
    adapter: readOnly("is-adapter-allowed", [
      Cl.principal(alice),
      Cl.principal(dex),
    ]),
    priceBounds: readOnly("get-price-bounds", [Cl.principal(alice)]),
    ledgers: [ledger(alice, sbtc), ledger(alice, usd)],
  };
}

beforeAll(() => {
  mint("mock-usd", 10n ** 18n, dex);
});

beforeEach(() => {
  simnet.mineEmptyBurnBlocks(144);
  ok(
    simnet.callPublicFn(
      "mock-dex",
      "set-rate",
      [Cl.uint(RATE), Cl.uint(1)],
      deployer,
    ),
  );
  setSkim(0n);
  mint("mock-sbtc", DEPOSIT, alice);
  expect(deposit(alice, sbtc, DEPOSIT).result.type).toBe("ok");
  ok(vaultCall(alice, "set-agent", [Cl.principal(bob)]));
  ok(vaultCall(alice, "unpause"));
  allowToken(sbtc, true);
  allowToken(usd, true);
  allowAdapter(true);
  setPolicy(MAX_PER_TRADE, MAX_PER_DAY, 0n, EXPIRES_AT);
  armOracle(simnet, alice, ORACLE);
  expectInvariant();
});

// mock-dex with skim >= out keeps the input, delivers nothing and still
// reports `(ok out)`. The skim-1 test in keelio-vault-swap.test.ts is a partial
// skim; this is the whole output.
describe("T2b: an adapter that keeps the input and returns nothing", () => {
  it("T2b: min-out at the oracle floor refuses an adapter that returns nothing, with u118", () => {
    setSkim(MAX_UINT);
    try {
      expectRefused(118, { minOut: FLOOR });
    } finally {
      setSkim(0n);
    }
  });

  it("T2b: min-out 0 is refused with u125 before the adapter is called", () => {
    setSkim(MAX_UINT);
    try {
      const call = vaultCall(bob, "execute-swap", swapArgs({ minOut: 0n }));
      // No transfer event: the adapter never ran.
      expect(call.events).toStrictEqual([]);
      expect(call.result).toStrictEqual(Cl.error(Cl.uint(125)));
      expectRefused(125, { minOut: 0n });
      expectRefused(125, { minOut: FLOOR - 1n });
    } finally {
      setSkim(0n);
    }
  });
});

describe("T3: a bad price inside the caps", () => {
  it("T3: min-out at the floor loses at most max-slippage-bps of max-per-day per window", () => {
    const T = 100_000n;
    setPolicy(T, 2n * T, 0n, EXPIRES_AT);
    // The worst fill the floor allows: 891 USD units a sat, 1% under the
    // oracle's 900.
    ok(
      simnet.callPublicFn(
        "mock-dex",
        "set-rate",
        [Cl.uint(891), Cl.uint(1)],
        deployer,
      ),
    );
    const h = BigInt(simnet.burnBlockHeight);
    const start = { sbtc: ledger(alice, sbtc), usd: ledger(alice, usd) };
    // The reference value of what was sold, less what came back.
    const loss = () =>
      (start.sbtc - ledger(alice, sbtc)) * RATE -
      (ledger(alice, usd) - start.usd);

    // Anything below the floor is refused before the adapter is called.
    expectRefused(125, { amountIn: T, minOut: 0n });
    expectFloorFill(T);
    expectFloorFill(T);
    expectRefused(115, { amountIn: 1n });
    // max-per-day is sold, and the loss is max-slippage-bps of its value.
    expect(loss()).toBe((2n * T * RATE * SLIPPAGE_BPS) / 10_000n);

    // Still inside the window at H+143.
    simnet.mineEmptyBurnBlocks(143);
    expect(BigInt(simnet.burnBlockHeight)).toBe(h + 143n);
    expectRefused(115, { amountIn: 1n });

    // The window rolls at H+144; the next window's loss is bounded the same way.
    simnet.mineEmptyBurnBlocks(1);
    expect(BigInt(simnet.burnBlockHeight)).toBe(h + 144n);
    expectFloorFill(T);
    expect(loss()).toBe((3n * T * RATE * SLIPPAGE_BPS) / 10_000n);
  });
});

// The adapter is the only contract the vault calls with its own authority, so
// these tests deploy a copy of the shipped vault whose fixed adapter calls
// back into the copy. The copy is made by exact string replacement, asserted
// to change the source, as the allowance tests do.
describe("T2e: an adapter that calls back into the vault", () => {
  const reenterVault = `${deployer}.vault-reenter`;
  const reenterAdapter = `${deployer}.reenter-adapter`;

  // mode 1: withdraw token-in amount-in from the vault copy.
  // mode 2: execute-swap for `victim` with the same tokens and amounts. A
  //   contract cannot name itself as a trait argument (deploy fails with
  //   "use of unresolved contract"), so it passes .mock-dex as the adapter.
  //   The agent check comes before the adapter check, and the result below is
  //   decided before either runs.
  // mode 3: deposit u1 of token-in into the vault copy.
  // Modes 4 to 6 act as the adapter itself (`as-contract`), so the token
  // accepts the transfer and the callback succeeds:
  // mode 4: take amount-in of token-in, then pay only by depositing min-out
  //   of its own token-out into the copy, crediting its own ledger.
  // mode 5: as mode 4, and also send min-out of token-out to `recipient`.
  // mode 6: take amount-in - `own` of token-in, withdraw `own` of token-in
  //   from its own ledger in the copy, and send min-out of token-out to
  //   `recipient`. The vault's outflow is still exactly amount-in.
  // It `try!`s the vault's result and returns (ok u0); it has no error codes
  // of its own.
  const adapterSource = `
(impl-trait .swap-adapter-trait.swap-adapter-trait)
(use-trait sip-010 .sip-010-trait.sip-010-trait)
(define-data-var mode uint u1)
(define-data-var victim principal tx-sender)
(define-data-var own uint u0)
(define-public (set-mode (m uint)) (begin (var-set mode m) (ok true)))
(define-public (set-victim (v principal)) (begin (var-set victim v) (ok true)))
(define-public (set-own (n uint)) (begin (var-set own n) (ok true)))
(define-public (seed (t <sip-010>) (n uint)) (as-contract (contract-call? .vault-reenter deposit t n)))
(define-public (swap (token-in <sip-010>) (token-out <sip-010>) (amount-in uint) (min-out uint) (recipient principal))
  (let ((m (var-get mode)) (self (as-contract tx-sender)))
    (if (is-eq m u1)
      (begin (try! (contract-call? .vault-reenter withdraw token-in amount-in)) true)
      (if (is-eq m u2)
        (begin (try! (contract-call? .vault-reenter execute-swap (var-get victim) .mock-dex token-in token-out amount-in min-out)) true)
        (if (is-eq m u3)
          (begin (try! (contract-call? .vault-reenter deposit token-in u1)) true)
          (if (is-eq m u6)
            (begin
              (try! (contract-call? token-in transfer (- amount-in (var-get own)) contract-caller self none))
              (try! (as-contract (contract-call? .vault-reenter withdraw token-in (var-get own))))
              (try! (as-contract (contract-call? token-out transfer min-out tx-sender recipient none)))
              true)
            (begin
              (try! (contract-call? token-in transfer amount-in contract-caller self none))
              (try! (as-contract (contract-call? .vault-reenter deposit token-out min-out)))
              (if (is-eq m u5)
                (try! (as-contract (contract-call? token-out transfer min-out tx-sender recipient none)))
                true)
              true))
        )
      )
    )
    (ok u0)
  )
)`;

  function copyCall(sender: string, fn: string, args: ClarityValue[] = []) {
    return simnet.callPublicFn("vault-reenter", fn, args, sender);
  }

  function adapterCall(fn: string, arg: ClarityValue) {
    ok(simnet.callPublicFn("reenter-adapter", fn, [arg], deployer));
  }

  function state() {
    return {
      alice: [sbtc, usd].map((t) => ledger(alice, t, "vault-reenter")),
      adapterLedger: [sbtc, usd].map((t) =>
        ledger(reenterAdapter, t, "vault-reenter"),
      ),
      copy: [sbtc, usd].map((t) => wallet(t, reenterVault)),
      adapter: [sbtc, usd].map((t) => wallet(t, reenterAdapter)),
    };
  }

  function bobSwaps() {
    return copyCall(bob, "execute-swap", [
      Cl.principal(alice),
      Cl.principal(reenterAdapter),
      Cl.principal(sbtc),
      Cl.principal(usd),
      Cl.uint(AMOUNT_IN),
      Cl.uint(FLOOR),
    ]);
  }

  beforeAll(() => {
    const copySource = vaultSource.replace(
      "(define-constant ALLOWED-ADAPTER .mock-dex)",
      "(define-constant ALLOWED-ADAPTER .reenter-adapter)",
    );
    expect(copySource).not.toBe(vaultSource);
    // The copy first: the adapter names it statically, while the copy only
    // reaches the adapter through the trait argument.
    for (const [name, code, version] of [
      ["vault-reenter", copySource, vaultClarityVersion()],
      ["reenter-adapter", adapterSource, 3],
    ] as const) {
      const { result } = simnet.deployContract(
        name,
        code,
        { clarityVersion: version },
        deployer,
      );
      expect(result).toStrictEqual(Cl.ok(Cl.bool(true)));
    }

    // Alice opens a vault in the copy, Bob as agent.
    mint("mock-sbtc", DEPOSIT, alice);
    expect(
      copyCall(alice, "deposit", [Cl.principal(sbtc), Cl.uint(DEPOSIT)]).result,
    ).toStrictEqual(Cl.ok(Cl.uint(DEPOSIT)));
    for (const token of [sbtc, usd])
      ok(copyCall(alice, "allow-token", [Cl.principal(token), Cl.bool(true)]));
    ok(
      copyCall(alice, "allow-adapter", [
        Cl.principal(reenterAdapter),
        Cl.bool(true),
      ]),
    );
    ok(copyCall(alice, "set-agent", [Cl.principal(bob)]));
    ok(
      copyCall(alice, "set-token-caps", [
        Cl.principal(sbtc),
        Cl.uint(MAX_PER_TRADE),
        Cl.uint(MAX_PER_DAY),
      ]),
    );
    ok(copyCall(alice, "set-policy", [Cl.uint(0), Cl.uint(EXPIRES_AT)]));
    armOracle(simnet, alice, ORACLE, "vault-reenter");
    adapterCall("set-victim", Cl.principal(alice));
  });

  it("T2e: a callback to withdraw is refused, and the swap returns u117", () => {
    adapterCall("set-mode", Cl.uint(1));
    const before = state();
    expect(before.alice).toStrictEqual([DEPOSIT, 0n]);
    const call = bobSwaps();
    // The adapter is contract-caller inside withdraw, so withdraw reads the
    // adapter's own ledger (0) and refuses with u101. The vault maps the
    // adapter's error to u117, which hides the inner code.
    expect(call.result).toStrictEqual(Cl.error(Cl.uint(117)));
    expect(printEvents(call.events)).toStrictEqual([]);
    expect(state()).toStrictEqual(before);
  });

  it("T2e: a callback to execute-swap aborts with CircularReference", () => {
    adapterCall("set-mode", Cl.uint(2));
    const before = state();
    // Clarity refuses to call a function already on the call stack, and the
    // whole transaction aborts. The simnet reports it as a thrown error.
    expect(() => bobSwaps()).toThrow(
      `RuntimeCheck(CircularReference(["${reenterVault}:execute-swap"]))`,
    );
    expect(state()).toStrictEqual(before);
  });

  it("T2e: a callback to deposit is refused, and the swap returns u117", () => {
    adapterCall("set-mode", Cl.uint(3));
    const before = state();
    const call = bobSwaps();
    // The deposit would credit the adapter's own ledger from the adapter's
    // own wallet, never the owner's. The token refuses the transfer, and the
    // vault maps the adapter's error to u117, which hides the inner code.
    expect(call.result).toStrictEqual(Cl.error(Cl.uint(117)));
    expect(printEvents(call.events)).toStrictEqual([]);
    expect(state()).toStrictEqual(before);
  });

  // The copy's balance of each token equals Alice's ledger plus the adapter's:
  // no one else has a ledger in the copy.
  function expectCopySolvent() {
    const now = state();
    for (const i of [0, 1])
      expect(now.copy[i]).toBe(now.alice[i]! + now.adapterLedger[i]!);
  }

  it("T2e: a callback deposit is not credited to the owner, so paying only by deposit is refused with u118", () => {
    mint("mock-usd", FLOOR, reenterAdapter);
    adapterCall("set-mode", Cl.uint(4));
    expectCopySolvent();
    const before = state();
    const call = bobSwaps();
    // The deposit raises the copy's mock-usd balance by FLOOR but credits the
    // adapter's own ledger for it, so none of it arrived for Alice.
    expect(call.result).toStrictEqual(Cl.error(Cl.uint(118)));
    expect(printEvents(call.events)).toStrictEqual([]);
    expect(state()).toStrictEqual(before);
    expectCopySolvent();
  });

  it("T2e: a callback deposit beside a real payment credits the owner only the payment", () => {
    mint("mock-usd", 2n * FLOOR, reenterAdapter);
    adapterCall("set-mode", Cl.uint(5));
    const before = state();
    const call = bobSwaps();
    expect(call.result).toStrictEqual(Cl.ok(Cl.uint(FLOOR)));
    const after = state();
    expect(after.alice).toStrictEqual([
      before.alice[0]! - AMOUNT_IN,
      before.alice[1]! + FLOOR,
    ]);
    expect(after.adapterLedger[1]).toBe(before.adapterLedger[1]! + FLOOR);
    expect(after.copy[1]).toBe(before.copy[1]! + 2n * FLOOR);
    expectCopySolvent();
  });

  it("T2e: a callback withdrawal of the adapter's own ledger is not debited from the owner", () => {
    const own = 4_000n;
    mint("mock-sbtc", own, reenterAdapter);
    expect(
      simnet.callPublicFn(
        "reenter-adapter",
        "seed",
        [Cl.principal(sbtc), Cl.uint(own)],
        deployer,
      ).result,
    ).toStrictEqual(Cl.ok(Cl.uint(own)));
    mint("mock-usd", FLOOR, reenterAdapter);
    adapterCall("set-own", Cl.uint(own));
    adapterCall("set-mode", Cl.uint(6));
    expectCopySolvent();
    const before = state();
    const call = bobSwaps();
    // The copy sends out AMOUNT_IN, inside the allowance, but only
    // AMOUNT_IN - own of it is Alice's: the rest is the adapter's withdrawal.
    expect(call.result).toStrictEqual(Cl.ok(Cl.uint(FLOOR)));
    const after = state();
    expect(after.copy[0]).toBe(before.copy[0]! - AMOUNT_IN);
    expect(after.alice).toStrictEqual([
      before.alice[0]! - (AMOUNT_IN - own),
      before.alice[1]! + FLOOR,
    ]);
    expect(after.adapterLedger[0]).toBe(before.adapterLedger[0]! - own);
    expectCopySolvent();
  });
});

describe("T7: the deployer has no power over vaults", () => {
  it("T7: the deployer cannot withdraw from or trade for another owner's vault", () => {
    const before = snapshot();
    const wd = withdraw(deployer, sbtc, 1n);
    expect(wd.result).toStrictEqual(Cl.error(Cl.uint(101)));
    expect(printEvents(wd.events)).toStrictEqual([]);
    expect(snapshot()).toStrictEqual(before);

    expectRefused(108, { sender: deployer });
  });

  it("T7: the deployer's setters write only the deployer's own entries", () => {
    const aliceBefore = aliceEntries();
    const calls: [string, ClarityValue[]][] = [
      ["pause", []],
      ["set-agent", [Cl.principal(carol)]],
      ["set-agent", [Cl.principal(mallory)]],
      ["remove-agent", []],
      ["set-token-caps", [Cl.principal(sbtc), Cl.uint(0), Cl.uint(0)]],
      ["set-token-caps", [Cl.principal(usd), Cl.uint(0), Cl.uint(0)]],
      ["set-policy", [Cl.uint(MAX_UINT), Cl.uint(0)]],
      ["allow-token", [Cl.principal(sbtc), Cl.bool(false)]],
      ["allow-token", [Cl.principal(usd), Cl.bool(false)]],
      ["allow-adapter", [Cl.principal(dex), Cl.bool(false)]],
      ["set-price-bounds", [Cl.uint(0), Cl.uint(0)]],
    ];
    for (const [fn, args] of calls) {
      const call = vaultCall(deployer, fn, args);
      expect(call.result).toStrictEqual(Cl.ok(Cl.bool(true)));
      // Every event names the deployer as owner.
      for (const event of printEvents(call.events)) {
        if (event.type !== "tuple") throw new Error("expected tuple");
        expect(event.value.owner).toStrictEqual(Cl.principal(deployer));
      }
      expect(aliceEntries()).toStrictEqual(aliceBefore);
    }
    expect(readOnly("get-vault", [Cl.principal(deployer)])).toStrictEqual(
      Cl.tuple({ agent: Cl.none(), paused: Cl.bool(true) }),
    );

    // Bob still trades for Alice.
    const call = swap({ minOut: OUT });
    expect(call.result).toStrictEqual(Cl.ok(Cl.uint(OUT)));
    expect(ledger(alice, sbtc)).toBe(aliceBefore.ledgers[0]! - AMOUNT_IN);
    expect(ledger(alice, usd)).toBe(aliceBefore.ledgers[1]! + OUT);
  });

  it("T7: the vault source has no admin, no mutable config and no owner argument", () => {
    // No data var, so nothing outside the per-owner maps can change.
    expect(vaultSource).not.toMatch(/define-data-var/);
    // Each fixed principal is one constant, defined once.
    for (const name of [
      "ALLOWED-TOKEN",
      "QUOTE-TOKEN",
      "ALLOWED-ADAPTER",
      "ORACLE",
    ]) {
      const defs = vaultSource.match(
        new RegExp(`\\(define-constant ${name} `, "g"),
      );
      expect(defs, name).toHaveLength(1);
    }
    // No privileged principal.
    expect(vaultSource).not.toMatch(/contract-owner|CONTRACT-OWNER|deployer/);

    // Every public function takes no owner argument and binds the owner to
    // contract-caller, except the three the agent calls.
    const publics = vaultSource.split("(define-public (").slice(1);
    const names = publics.map((body) => body.split(/[\s)]/)[0]!);
    expect(names).toStrictEqual([
      "deposit",
      "withdraw",
      "set-agent",
      "remove-agent",
      "pause",
      "unpause",
      "set-policy",
      "set-token-caps",
      "allow-token",
      "allow-adapter",
      "set-price-bounds",
      "set-approval-threshold",
      "execute-swap",
      "request-swap",
      "approve-swap",
      "reject-swap",
      "cancel-swap-request",
    ]);
    // What each agent-called function checks its caller with. `check-trade`
    // compares the principal it is handed with the owner's stored agent.
    const agentCalled: Record<string, string> = {
      "execute-swap": "(run-swap owner contract-caller adapter ",
      "request-swap": "(check-trade owner contract-caller ",
      "cancel-swap-request":
        "(asserts! (is-eq (get agent request) contract-caller) ERR-NOT-REQUESTER)",
    };
    expect(vaultSource).toContain(
      "(try! (check-trade owner agent adapter-id token-in-id token-out-id amount-in))",
    );
    expect(vaultSource).toContain(
      "(asserts! (is-eq (get agent vault) (some agent)) ERR-NOT-AGENT)",
    );
    for (const body of publics) {
      const name = body.split(/[\s)]/)[0]!;
      const fn = body.split("(define-")[0]!;
      const callerCheck = agentCalled[name];
      if (callerCheck !== undefined) {
        // The owner is an argument, and the caller check is contract-caller.
        expect(fn, name).toContain("(owner principal)");
        expect(fn, name).toContain(callerCheck);
        continue;
      }
      expect(fn, name).toContain("(owner contract-caller)");
      expect(fn, name).not.toContain("(owner principal)");
      expect(fn, name).not.toMatch(/\(owner tx-sender\)/);
    }
  });

  it("T7: set-policy and set-token-caps cannot write each other's data", () => {
    const body = (name: string) => {
      const start = vaultSource.indexOf(`(define-public (${name}\n`);
      expect(start, name).toBeGreaterThanOrEqual(0);
      const end = vaultSource.indexOf("(define-", start + 1);
      return vaultSource.slice(start, end === -1 ? undefined : end);
    };
    const setPolicy = body("set-policy");
    const setTokenCaps = body("set-token-caps");
    expect(setPolicy).toContain("(map-set policies owner");
    expect(setPolicy).not.toContain("map-set token-caps");
    expect(setPolicy).not.toContain("map-delete");
    expect(setTokenCaps).toContain("(map-set token-caps");
    expect(setTokenCaps).not.toContain("map-set policies");
    expect(setTokenCaps).not.toContain("map-delete");
    // The fixed-set check comes before the cap check.
    expect(setTokenCaps.indexOf("ERR-TOKEN-NOT-SUPPORTED")).toBeLessThan(
      setTokenCaps.indexOf("ERR-INVALID-POLICY"),
    );
  });
});

// docs/threat-model.md cites tests by their exact `it(...)` name. These
// checks fail when a cited test is renamed or removed, so the doc cannot
// drift from the tests that back it.
describe("docs/threat-model.md citations", () => {
  const docUrl = new URL("../docs/threat-model.md", import.meta.url);
  const doc = readFileSync(docUrl, "utf8");

  function section(heading: string): string {
    const start = doc.indexOf(`\n## ${heading}\n`);
    expect(start, heading).toBeGreaterThanOrEqual(0);
    const end = doc.indexOf("\n## ", start + 1);
    return doc.slice(start, end === -1 ? undefined : end);
  }

  // Data rows of the first table in a section, as trimmed cells.
  function rows(heading: string): string[][] {
    return section(heading)
      .split("\n")
      .filter((line) => line.startsWith("|"))
      .slice(2)
      .map((line) =>
        line
          .split("|")
          .slice(1, -1)
          .map((cell) => cell.trim()),
      );
  }

  const LINK = /\[([^\]]+)\]\(\.\.\/tests\/([\w.-]+\.test\.ts)\)/g;

  function citations(text: string) {
    return [...text.matchAll(LINK)].map((m) => ({ name: m[1]!, file: m[2]! }));
  }

  it("every cited test name appears in the cited test file", () => {
    const cited = citations(doc);
    expect(cited.length).toBeGreaterThan(0);
    const missing = cited.filter(({ name, file }) => {
      const url = new URL(`../tests/${file}`, import.meta.url);
      let text: string;
      try {
        text = readFileSync(url, "utf8");
      } catch {
        return true;
      }
      return !text.includes(`"${name}"`);
    });
    expect(missing).toStrictEqual([]);
  });

  it("names the six actors and every threat, each with one status", () => {
    expect(rows("Actors").map((cells) => cells[0])).toStrictEqual([
      "owner",
      "agent",
      "adapter",
      "DEX",
      "stranger",
      "deployer",
    ]);

    const threats = rows("Threats");
    expect(threats.map((cells) => cells[0])).toStrictEqual([
      "T1",
      "T2a",
      "T2b",
      "T2c",
      "T2d",
      "T2e",
      "T2f",
      "T3",
      "T4",
      "T5",
      "T6",
      "T7",
      "T8",
      "T9a",
      "T9b",
      "T9c",
      "T9d",
      "T9e",
      "T9f",
    ]);
    for (const cells of threats) {
      expect(cells, cells[0]).toHaveLength(5);
      const status = cells[2]!;
      expect(["handled", "accepted", "planned"], cells[0]).toContain(status);
      if (status === "handled")
        expect(citations(cells.join("|")).length, cells[0]).toBeGreaterThan(0);
    }
  });
});
