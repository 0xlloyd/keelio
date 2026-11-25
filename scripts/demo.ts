// `pnpm run demo`: an owner, an agent and a refused trade, on a fresh
// in-process simnet. Every keelio-vault call is built with @keelio/sdk; the mock
// setup calls are plain simnet calls. Nothing is signed or broadcast.
import { initSimnet } from "@stacks/clarinet-sdk";
import { Cl, type ClarityValue } from "@stacks/transactions";
import {
  buildAllowAdapter,
  buildAllowToken,
  buildDeposit,
  buildPause,
  buildSetAgent,
  buildSetPolicy,
  buildSetPriceBounds,
  buildSetTokenCaps,
  buildWithdraw,
  readVault,
  simnetClient,
  type TxConfig,
  type VaultConfig,
  type VaultRead,
} from "../packages/sdk/src/index.js";
import {
  attemptSwap,
  journalLine,
  okValue,
  runAsScript,
  show,
  showCheck,
  showRefusal,
  uintOf,
  vaultSender,
  type Simnet,
  type SwapAttempt,
} from "./demo-shared.js";
import { formatBtc, formatUnits } from "./format-amount.js";

export type { Simnet, SwapAttempt } from "./demo-shared.js";

const SBTC_SUPPLY = 100_000_000n;
const USD_RESERVES = 1_000_000_000_000n;
const RATE = 900n;
const DEPOSIT = 100_000_000n;
const MAX_PER_TRADE = 10_000_000n;
const MAX_PER_DAY = 30_000_000n;
// The quote token's caps, in its own base units (6 decimals).
const USD_MAX_PER_TRADE = 10_000_000_000n;
const USD_MAX_PER_DAY = 30_000_000_000n;
const POLICY_BLOCKS = 1000n;
const SWAP = 10_000_000n;
const MIN_OUT = SWAP * RATE;
const BIG_SWAP = 50_000_000n;
// Half the USD from step 2, back to sBTC at 900 USD base units a sat.
const BUY_BACK = 4_500_000_000n;
const BUY_BACK_OUT = 5_000_000n;
// The mock oracle's BTC/USD price ($90,000 with 8 decimals, the dex rate 900)
// and the owner's price bounds: 1% below it at most, a price at most an hour
// old.
const ORACLE_PRICE = 9_000_000_000_000n;
const MAX_SLIPPAGE_BPS = 100n;
const MAX_PRICE_AGE_MS = 3_600_000n;
// The vault's PRICE-SCALE: 10^(8 + 8 - 6) for the oracle's 8 decimals,
// sBTC's 8 and mock-usd's 6.
const PRICE_SCALE = 10_000_000_000n;

export interface DemoResult {
  /** The principals the output names, by label. */
  labels: Readonly<Record<string, string>>;
  /** Results of the four mock setup calls, then of every step-1 call. */
  setup: ClarityValue[];
  deposit: ClarityValue;
  swap: SwapAttempt;
  /** The simnet-only mock call that sets the buy-back rate. */
  buyBackRate: ClarityValue;
  buyBack: SwapAttempt;
  bigSwap: SwapAttempt;
  agentWithdraw: ClarityValue;
  /** The owner's sBTC ledger after step 5. */
  vaultBeforeWithdraw: bigint;
  /** The owner's USD ledger after step 5. */
  usdBeforeWithdraw: bigint;
  pause: ClarityValue;
  pausedSwap: SwapAttempt;
  ownerWithdraw: { sbtc: ClarityValue; usd: ClarityValue };
  final: {
    vault: VaultRead;
    ownerWallet: { sbtc: bigint; usd: bigint };
    agentWallet: { sbtc: bigint };
  };
  /** Every keelio-vault print event, in call order. */
  journal: ClarityValue[];
  /** The burn height the policy was set at, so expiry prints as a distance. */
  policyHeight: bigint;
  ids: { sbtc: string; usd: string; dex: string };
}

/** Runs setup and steps 1 to 7 and collects the journal. Prints nothing. */
export async function runDemo(simnet: Simnet): Promise<DemoResult> {
  const accounts = simnet.getAccounts();
  const account = (name: string): string => {
    const address = accounts.get(name);
    if (address === undefined) throw new Error(`no simnet account ${name}`);
    return address;
  };
  const deployer = account("deployer");
  const owner = account("wallet_1");
  const agent = account("wallet_2");
  const sbtc = `${deployer}.mock-sbtc`;
  const usd = `${deployer}.mock-usd`;
  const dex = `${deployer}.mock-dex`;
  const vaultId = `${deployer}.keelio-vault`;

  const tx: TxConfig = {
    vault: vaultId,
    assetNames: { [sbtc]: "mock-sbtc", [usd]: "mock-usd" },
    adapters: { [dex]: { pool: null } },
  };
  const readConfig: VaultConfig = {
    vault: "keelio-vault",
    tokens: [sbtc, usd],
    adapters: [dex],
    oracle: "mock-oracle",
    sbtcToken: sbtc,
    priceScale: PRICE_SCALE,
  };
  const client = simnetClient(simnet, deployer);
  const { journal, send } = vaultSender(simnet, vaultId);
  const mock = (contract: string, fn: string, args: ClarityValue[]) =>
    simnet.callPublicFn(contract, fn, args, deployer).result;
  const wallet = (token: "mock-sbtc" | "mock-usd", who: string): bigint =>
    uintOf(
      okValue(
        simnet.callReadOnlyFn(
          token,
          "get-balance",
          [Cl.principal(who)],
          deployer,
        ).result,
      ),
    );
  const swapContext = {
    simnet,
    client,
    readConfig,
    tx,
    send,
    owner,
    agent,
    adapter: dex,
  };
  const attempt = async (
    amountIn: bigint,
    tokenIn = sbtc,
    minOut = amountIn * RATE,
  ): Promise<SwapAttempt> => {
    const tokenOut = tokenIn === sbtc ? usd : sbtc;
    const { check, result } = await attemptSwap(swapContext, {
      tokenIn,
      tokenOut,
      amountIn,
      minOut,
    });
    return { check, result };
  };

  // Setup: simnet mocks only.
  const setup = [
    mock("mock-sbtc", "mint", [Cl.uint(SBTC_SUPPLY), Cl.principal(owner)]),
    mock("mock-usd", "mint", [Cl.uint(USD_RESERVES), Cl.principal(dex)]),
    mock("mock-dex", "set-rate", [Cl.uint(RATE), Cl.uint(1)]),
    // The price, timestamped at this block.
    mock("mock-oracle", "set-value-aged", [
      Cl.stringAscii("BTC/USD"),
      Cl.uint(ORACLE_PRICE),
      Cl.uint(0),
    ]),
  ];

  // 1. The owner opens the vault.
  const deposit = send(
    buildDeposit(tx, { owner, token: sbtc, amount: DEPOSIT }),
    owner,
  );
  const policyHeight = BigInt(simnet.burnBlockHeight);
  setup.push(
    deposit,
    send(buildSetAgent(tx, { agent }), owner),
    send(
      buildSetTokenCaps(tx, {
        token: sbtc,
        maxPerTrade: MAX_PER_TRADE,
        maxPerDay: MAX_PER_DAY,
      }),
      owner,
    ),
    send(
      buildSetTokenCaps(tx, {
        token: usd,
        maxPerTrade: USD_MAX_PER_TRADE,
        maxPerDay: USD_MAX_PER_DAY,
      }),
      owner,
    ),
    send(
      buildSetPolicy(tx, {
        cooldownBlocks: 0n,
        expiresAt: policyHeight + POLICY_BLOCKS,
      }),
      owner,
    ),
    send(buildAllowToken(tx, { token: sbtc, allowed: true }), owner),
    send(buildAllowToken(tx, { token: usd, allowed: true }), owner),
    send(buildAllowAdapter(tx, { adapter: dex, allowed: true }), owner),
    send(
      buildSetPriceBounds(tx, {
        maxSlippageBps: MAX_SLIPPAGE_BPS,
        maxPriceAge: MAX_PRICE_AGE_MS,
      }),
      owner,
    ),
  );

  // 2. The agent sells sBTC inside its caps.
  const swap = await attempt(SWAP);

  // 3. The agent buys half of it back, inside the USD caps.
  const buyBackRate = mock("mock-dex", "set-rate", [Cl.uint(1), Cl.uint(RATE)]);
  const buyBack = await attempt(BUY_BACK, usd, BUY_BACK_OUT);

  // 4. The agent tries a trade above the sBTC per-trade cap.
  const bigSwap = await attempt(BIG_SWAP);

  // 5. The agent tries to withdraw.
  const agentWithdraw = send(
    buildWithdraw(tx, { token: sbtc, amount: SWAP }),
    agent,
  );
  const ledgers = (await readVault(client, readConfig, owner)).balances;
  const vaultBeforeWithdraw = ledgers[sbtc];
  const usdBeforeWithdraw = ledgers[usd];
  if (vaultBeforeWithdraw === undefined || usdBeforeWithdraw === undefined)
    throw new Error("no ledger read");

  // 6. The owner pauses the vault.
  const pause = send(buildPause(tx), owner);
  const pausedSwap = await attempt(SWAP);

  // 7. The owner withdraws everything.
  const ownerWithdraw = {
    sbtc: send(
      buildWithdraw(tx, { token: sbtc, amount: vaultBeforeWithdraw }),
      owner,
    ),
    usd: send(
      buildWithdraw(tx, { token: usd, amount: usdBeforeWithdraw }),
      owner,
    ),
  };

  return {
    labels: {
      [owner]: "owner",
      [agent]: "agent",
      [sbtc]: "mock-sbtc",
      [usd]: "mock-usd",
      [dex]: "mock-dex",
    },
    setup,
    deposit,
    swap,
    buyBackRate,
    buyBack,
    bigSwap,
    agentWithdraw,
    vaultBeforeWithdraw,
    usdBeforeWithdraw,
    pause,
    pausedSwap,
    ownerWithdraw,
    final: {
      vault: await readVault(client, readConfig, owner),
      ownerWallet: {
        sbtc: wallet("mock-sbtc", owner),
        usd: wallet("mock-usd", owner),
      },
      agentWallet: { sbtc: wallet("mock-sbtc", agent) },
    },
    journal,
    policyHeight,
    ids: { sbtc, usd, dex },
  };
}

/** The full stdout of the demo, ending in one newline. Pure. */
export function renderDemo(result: DemoResult): string {
  const { ids, labels } = result;
  const usd = (amount: bigint) => `${formatUnits(amount, 6)} USD`;
  const btc = (amount: bigint) => `${formatBtc(amount)} sBTC`;
  const label = (principal: string) => labels[principal] ?? principal;
  const refusal = showRefusal;
  const check = showCheck;
  const amount = (token: string, value: bigint) =>
    token === ids.sbtc ? btc(value) : token === ids.usd ? usd(value) : value;
  const { vault, ownerWallet, agentWallet } = result.final;

  const lines = [
    "Keelio demo: an owner, an agent and a refused trade",
    "A fresh in-process simnet with its throwaway accounts. Nothing is signed or broadcast.",
    "",
    "Setup (simnet-only mocks, not part of Keelio)",
    `  mint ${formatBtc(SBTC_SUPPLY)} mock sBTC to owner: ${show(result.setup[0]!)}`,
    `  mint ${formatUnits(USD_RESERVES, 6)} mock USD to mock-dex: ${show(result.setup[1]!)}`,
    `  set the mock-dex rate to ${RATE} USD base units per sat: ${show(result.setup[2]!)}`,
    `  set the mock-oracle BTC/USD price to ${formatUnits(ORACLE_PRICE, 8)} USD, timestamped now: ${show(result.setup[3]!)}`,
    "",
    "1. The owner opens the vault",
    `  deposit ${btc(DEPOSIT)}: ${show(result.deposit)}`,
    `  set-agent to agent: ${show(result.setup[5]!)}`,
    `  set-token-caps mock-sbtc ${btc(MAX_PER_TRADE)} per trade, ${btc(MAX_PER_DAY)} per day: ${show(result.setup[6]!)}`,
    `  set-token-caps mock-usd ${usd(USD_MAX_PER_TRADE)} per trade, ${usd(USD_MAX_PER_DAY)} per day: ${show(result.setup[7]!)}`,
    `  set-policy no cooldown, for the next ${POLICY_BLOCKS} burn blocks, for both tokens: ${show(result.setup[8]!)}`,
    `  allow-token mock-sbtc: ${show(result.setup[9]!)}`,
    `  allow-token mock-usd: ${show(result.setup[10]!)}`,
    `  allow-adapter mock-dex: ${show(result.setup[11]!)}`,
    `  set-price-bounds ${MAX_SLIPPAGE_BPS} bps below the oracle price at most, a price at most` +
      ` ${MAX_PRICE_AGE_MS} ms old: ${show(result.setup[12]!)}`,
    "  Each token has its own caps in its own base units.",
    "  Every swap must ask for at least the oracle price less 1%, or the vault refuses it.",
    "",
    `2. The agent swaps ${btc(SWAP)} for USD on mock-dex`,
    `  checkIntent: ${check(result.swap.check)}`,
    `  execute-swap: ${show(result.swap.result)}, ${usd(MIN_OUT)} received`,
    "",
    "3. The agent buys sBTC back",
    `  mock: set the mock-dex rate to 1 sat per ${RATE} USD base units: ${show(result.buyBackRate)}`,
    `  The agent swaps ${usd(BUY_BACK)} for at least ${btc(BUY_BACK_OUT)}, inside the USD caps.`,
    `  checkIntent: ${check(result.buyBack.check)}`,
    `  execute-swap: ${show(result.buyBack.result)}, ${btc(BUY_BACK_OUT)} received`,
    "",
    `4. The agent tries ${btc(BIG_SWAP)}`,
    `  checkIntent: ${check(result.bigSwap.check)}`,
    `  execute-swap: ${refusal(result.bigSwap.result)}`,
    "  The contract refuses the trade for the same rule checkIntent named.",
    "",
    `5. The agent tries to withdraw ${btc(SWAP)}`,
    "  checkIntent covers swaps only, so nothing checks this call in advance.",
    `  withdraw: ${refusal(result.agentWithdraw)}`,
    "  withdraw takes no owner argument and pays out only the caller's own ledger; the agent has none.",
    `  The owner's vault still holds ${btc(result.vaultBeforeWithdraw)} and ${usd(result.usdBeforeWithdraw)}.`,
    "",
    "6. The owner pauses the vault",
    `  pause: ${show(result.pause)}`,
    `  The agent tries ${btc(SWAP)}, inside both caps.`,
    `  checkIntent: ${check(result.pausedSwap.check)}`,
    `  execute-swap: ${refusal(result.pausedSwap.result)}`,
    "",
    "7. The owner withdraws everything while the vault is still paused",
    `  withdraw ${btc(result.vaultBeforeWithdraw)}: ${show(result.ownerWithdraw.sbtc)}`,
    `  withdraw ${usd(result.usdBeforeWithdraw)}: ${show(result.ownerWithdraw.usd)}`,
    `  vault ledger: ${btc(vault.balances[ids.sbtc] ?? 0n)}, ${usd(vault.balances[ids.usd] ?? 0n)}, paused: ${vault.vault.paused}`,
    `  owner wallet: ${btc(ownerWallet.sbtc)}, ${usd(ownerWallet.usd)}`,
    `  agent wallet: ${btc(agentWallet.sbtc)}`,
    "",
    "Journal: every keelio-vault print event, in order",
    ...result.journal.map(
      (event) => `  ${journalLine(event, label, amount, result.policyHeight)}`,
    ),
    "The refused calls printed nothing: a call that returns an error leaves no journal entry.",
    "",
    "Each built call also carries post-conditions for a wallet; the simnet does not check them.",
  ];
  return `${lines.join("\n")}\n`;
}

await runAsScript(import.meta.url, async () =>
  renderDemo(await runDemo(await initSimnet())),
);
