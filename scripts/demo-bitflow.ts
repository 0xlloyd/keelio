// `pnpm run demo:bitflow`: the story of `pnpm run demo`, traded through
// contracts/adapters/bitflow-adapter.clar against Bitflow's mainnet sBTC/USDCx
// DLMM pool.
//
// It needs the network: the simnet of tests/bitflow-remote/Clarinet.toml reads
// mainnet contract state through Hiro's public API (read only) at a pinned
// height. Everything else happens in that local simnet. Nothing is signed or
// broadcast, and no key for any mainnet principal exists here.
//
// Every keelio-vault call is built with @keelio/sdk. The amounts that come back
// are the live pool's at the pinned height, so nothing here fixes them.
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
  minOutFloor,
  readVault,
  simnetClient,
  type TxConfig,
  type VaultConfig,
  type VaultRead,
  type VaultState,
} from "../packages/sdk/src/index.js";
import {
  BITFLOW_MANIFEST,
  BITFLOW_VAULT_NAME,
  deployBitflowVault,
  fundSbtc,
  pinnedHeight,
  POOL,
  SBTC,
  SBTC_FT,
  USDCX,
  USDCX_FT,
} from "./bitflow-world.js";
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

// In sats. The owner is funded with exactly what it deposits.
export const DEPOSIT = 1_000_000n;
export const MAX_PER_TRADE = 100_000n;
export const MAX_PER_DAY = 300_000n;
// USDCx caps, in its own base units (6 decimals).
export const USDCX_MAX_PER_TRADE = 100_000_000n;
export const USDCX_MAX_PER_DAY = 300_000_000n;
const POLICY_BLOCKS = 1000n;
export const SWAP = 100_000n;
export const BIG_SWAP = 500_000n;
// The owner's price bounds: 2% below the oracle price at most (the pool takes
// 0.5% in fees and its bins are 0.1% apart), a price at most an hour old.
const MAX_SLIPPAGE_BPS = 200n;
const MAX_PRICE_AGE_MS = 3_600_000n;
// The vault's PRICE-SCALE: 10^(8 + 8 - 6) for the oracle's 8 decimals,
// sBTC's 8 and USDCx's 6.
const PRICE_SCALE = 10_000_000_000n;
// A DLMM bin price is USDCx base units per sat times 10^8. Times 100 it is
// USD per BTC with the oracle's 8 decimals.
const BIN_PRICE_TO_ORACLE = 100n;

/** A swap attempt with the trade it asked for. */
export interface BitflowSwap extends SwapAttempt {
  amountIn: bigint;
  /** The vault's oracle floor for the trade, from the SDK's `minOutFloor`. */
  minOut: bigint;
}

export interface BitflowDemoResult {
  /** The principals the output names, by label. */
  labels: Readonly<Record<string, string>>;
  /** The mainnet height the simnet reads state at. */
  pinnedHeight: bigint;
  /** Simnet-only steps that are not part of Keelio. */
  setup: {
    deploy: ClarityValue;
    fund: ClarityValue;
    /** The pool's active bin (signed) and its price, read from Bitflow. */
    activeBin: bigint;
    oraclePrice: bigint;
    oracle: ClarityValue;
  };
  /** The owner's wallet after funding, before the deposit. */
  ownerWalletBefore: { sbtc: bigint; usdcx: bigint };
  /** Step 1: deposit, set-agent, two set-token-caps, set-policy, two allow-token, allow-adapter, set-price-bounds. */
  open: ClarityValue[];
  swap: BitflowSwap;
  buyBack: BitflowSwap;
  bigSwap: BitflowSwap;
  agentWithdraw: ClarityValue;
  /** The owner's ledgers after step 5. */
  ledgerBeforeWithdraw: { sbtc: bigint; usdcx: bigint };
  pause: ClarityValue;
  pausedSwap: BitflowSwap;
  ownerWithdraw: { sbtc: ClarityValue; usdcx: ClarityValue };
  final: {
    vault: VaultRead;
    ownerWallet: { sbtc: bigint; usdcx: bigint };
    agentWallet: { sbtc: bigint; usdcx: bigint };
    adapterWallet: { sbtc: bigint; usdcx: bigint };
  };
  /** Every print event of the vault copy, in call order. */
  journal: ClarityValue[];
  /** The burn height the policy was set at, so expiry prints as a distance. */
  policyHeight: bigint;
  ids: { vault: string; adapter: string };
}

/**
 * Runs setup and steps 1 to 7 on a simnet started from BITFLOW_MANIFEST and
 * collects the journal. Prints nothing.
 */
export async function runBitflowDemo(
  simnet: Simnet,
): Promise<BitflowDemoResult> {
  const accounts = simnet.getAccounts();
  const account = (name: string): string => {
    const address = accounts.get(name);
    if (address === undefined) throw new Error(`no simnet account ${name}`);
    return address;
  };
  const deployer = simnet.deployer;
  const owner = account("wallet_1");
  const agent = account("wallet_2");
  const adapter = `${deployer}.bitflow-adapter`;
  const oracle = `${deployer}.mock-oracle`;
  const vaultId = `${deployer}.${BITFLOW_VAULT_NAME}`;

  const tx: TxConfig = {
    vault: vaultId,
    assetNames: { [SBTC]: SBTC_FT, [USDCX]: USDCX_FT },
    adapters: { [adapter]: { pool: POOL } },
  };
  const readConfig: VaultConfig = {
    vault: vaultId,
    tokens: [SBTC, USDCX],
    adapters: [adapter],
    oracle,
    sbtcToken: SBTC,
    priceScale: PRICE_SCALE,
  };
  const client = simnetClient(simnet, deployer);
  const { journal, send } = vaultSender(simnet, vaultId);
  const readOnly = (contract: string, fn: string, args: ClarityValue[]) =>
    simnet.callReadOnlyFn(contract, fn, args, deployer).result;
  const wallet = (who: string) => ({
    sbtc: uintOf(okValue(readOnly(SBTC, "get-balance", [Cl.principal(who)]))),
    usdcx: uintOf(okValue(readOnly(USDCX, "get-balance", [Cl.principal(who)]))),
  });

  // Setup: the vault copy, the owner's sBTC and the mock oracle's price. None
  // of it is part of Keelio, and all of it stays in the simnet.
  const deploy = deployBitflowVault(simnet);
  if (deploy.type !== "ok")
    throw new Error(`the vault copy did not deploy: ${show(deploy)}`);
  const fund = fundSbtc(simnet, owner, DEPOSIT);
  // The mock oracle stands in for a price feed. It is given the price of the
  // pool's active bin, read from Bitflow, so the floor is near what the pool
  // pays at whatever height the manifest pins.
  const pool = okValue(readOnly(POOL, "get-pool", []));
  if (pool.type !== "tuple") throw new Error("get-pool returned no tuple");
  const poolField = (name: string): ClarityValue => {
    const value = pool.value[name];
    if (value === undefined) throw new Error(`get-pool has no ${name}`);
    return value;
  };
  const activeBinCv = poolField("active-bin-id");
  if (activeBinCv.type !== "int") throw new Error("active-bin-id is no int");
  const activeBin = BigInt(activeBinCv.value);
  const binPrice = uintOf(
    okValue(
      readOnly(
        show(poolField("core-address")).replace(/^'/, ""),
        "get-bin-price",
        [poolField("initial-price"), poolField("bin-step"), activeBinCv],
      ),
    ),
  );
  const oraclePrice = binPrice * BIN_PRICE_TO_ORACLE;
  const oracleSet = simnet.callPublicFn(
    oracle,
    "set-value-aged",
    [Cl.stringAscii("BTC/USD"), Cl.uint(oraclePrice), Cl.uint(0)],
    deployer,
  ).result;
  const ownerWalletBefore = wallet(owner);

  // 1. The owner opens the vault.
  const deposit = send(
    buildDeposit(tx, { owner, token: SBTC, amount: DEPOSIT }),
    owner,
  );
  const policyHeight = BigInt(simnet.burnBlockHeight);
  const open = [
    deposit,
    send(buildSetAgent(tx, { agent }), owner),
    send(
      buildSetTokenCaps(tx, {
        token: SBTC,
        maxPerTrade: MAX_PER_TRADE,
        maxPerDay: MAX_PER_DAY,
      }),
      owner,
    ),
    send(
      buildSetTokenCaps(tx, {
        token: USDCX,
        maxPerTrade: USDCX_MAX_PER_TRADE,
        maxPerDay: USDCX_MAX_PER_DAY,
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
    send(buildAllowToken(tx, { token: SBTC, allowed: true }), owner),
    send(buildAllowToken(tx, { token: USDCX, allowed: true }), owner),
    send(buildAllowAdapter(tx, { adapter, allowed: true }), owner),
    send(
      buildSetPriceBounds(tx, {
        maxSlippageBps: MAX_SLIPPAGE_BPS,
        maxPriceAge: MAX_PRICE_AGE_MS,
      }),
      owner,
    ),
  ];

  const swapContext = {
    simnet,
    client,
    readConfig,
    tx,
    send,
    owner,
    agent,
    adapter,
  };
  // Each attempt asks for the least the vault accepts: its oracle floor.
  const attempt = async (
    amountIn: bigint,
    tokenIn = SBTC,
  ): Promise<BitflowSwap> => {
    const tokenOut = tokenIn === SBTC ? USDCX : SBTC;
    const floor = (state: VaultState): bigint => {
      const answer = minOutFloor(state, tokenIn, amountIn);
      if (!answer.ok) throw new Error(`no oracle floor: ${answer.message}`);
      return answer.floor;
    };
    const { check, result, minOut } = await attemptSwap(swapContext, {
      tokenIn,
      tokenOut,
      amountIn,
      minOut: floor,
    });
    return { check, result, amountIn, minOut };
  };
  const ledgers = async () => {
    const { balances } = await readVault(client, readConfig, owner);
    const sbtc = balances[SBTC];
    const usdcx = balances[USDCX];
    if (sbtc === undefined || usdcx === undefined)
      throw new Error("no ledger read");
    return { sbtc, usdcx };
  };

  // 2. The agent sells sBTC inside its caps, through bitflow-adapter.
  const swap = await attempt(SWAP);

  // 3. The agent buys sBTC back with half of the USDCx that came in.
  const buyBack = await attempt((await ledgers()).usdcx / 2n, USDCX);

  // 4. The agent tries a trade above the sBTC per-trade cap.
  const bigSwap = await attempt(BIG_SWAP);

  // 5. The agent tries to withdraw.
  const agentWithdraw = send(
    buildWithdraw(tx, { token: SBTC, amount: SWAP }),
    agent,
  );
  const ledgerBeforeWithdraw = await ledgers();

  // 6. The owner pauses the vault.
  const pause = send(buildPause(tx), owner);
  const pausedSwap = await attempt(SWAP);

  // 7. The owner withdraws everything.
  const ownerWithdraw = {
    sbtc: send(
      buildWithdraw(tx, { token: SBTC, amount: ledgerBeforeWithdraw.sbtc }),
      owner,
    ),
    usdcx: send(
      buildWithdraw(tx, { token: USDCX, amount: ledgerBeforeWithdraw.usdcx }),
      owner,
    ),
  };

  return {
    labels: {
      [owner]: "owner",
      [agent]: "agent",
      [SBTC]: "sbtc-token",
      [USDCX]: "usdcx",
      [adapter]: "bitflow-adapter",
    },
    pinnedHeight: pinnedHeight(),
    setup: { deploy, fund, activeBin, oraclePrice, oracle: oracleSet },
    ownerWalletBefore,
    open,
    swap,
    buyBack,
    bigSwap,
    agentWithdraw,
    ledgerBeforeWithdraw,
    pause,
    pausedSwap,
    ownerWithdraw,
    final: {
      vault: await readVault(client, readConfig, owner),
      ownerWallet: wallet(owner),
      agentWallet: wallet(agent),
      adapterWallet: wallet(adapter),
    },
    journal,
    policyHeight,
    ids: { vault: vaultId, adapter },
  };
}

/** The full stdout of the Bitflow demo, ending in one newline. Pure. */
export function renderBitflowDemo(result: BitflowDemoResult): string {
  const { labels, setup } = result;
  const usd = (amount: bigint) => `${formatUnits(amount, 6)} USDCx`;
  const btc = (amount: bigint) => `${formatBtc(amount)} sBTC`;
  const label = (principal: string) => labels[principal] ?? principal;
  const amount = (token: string, value: bigint) =>
    token === SBTC ? btc(value) : token === USDCX ? usd(value) : value;
  // What a swap paid, or the refusal when the contract refused it.
  const outcome = (s: BitflowSwap, unit: (amount: bigint) => string) =>
    s.result.type === "ok"
      ? `${show(s.result)}, ${unit(uintOf(s.result.value))} received`
      : showRefusal(s.result);
  const { vault, ownerWallet, agentWallet, adapterWallet } = result.final;
  const poolName = POOL.split(".")[1];

  const lines = [
    "Keelio demo on Bitflow: the same story, traded through bitflow-adapter",
    `Needs the network: it reads mainnet contract state through Hiro's public API (read only), pinned at height ${result.pinnedHeight}.`,
    "Every call runs in a local simnet with throwaway accounts. Nothing is signed or broadcast.",
    "The amounts are what Bitflow's pool paid at that height; none of them is fixed in the script.",
    "",
    "Setup (simnet only, not part of Keelio)",
    `  deploy a copy of keelio-vault configured for sbtc-token, usdcx and bitflow-adapter: ${show(setup.deploy)}`,
    `  move ${btc(DEPOSIT)} to owner in the simnet, sent as a mainnet holder (no key, no signature): ${show(setup.fund)}`,
    `  read ${poolName}: active bin ${setup.activeBin}, price ${formatUnits(setup.oraclePrice, 8)} USD per BTC`,
    `  set the mock-oracle BTC/USD price to that, timestamped now: ${show(setup.oracle)}`,
    "  The mock oracle stands in for a price feed; the pool, the router and both tokens are Bitflow's and the tokens' own mainnet contracts.",
    "",
    "1. The owner opens the vault",
    `  deposit ${btc(DEPOSIT)}: ${show(result.open[0]!)}`,
    `  set-agent to agent: ${show(result.open[1]!)}`,
    `  set-token-caps sbtc-token ${btc(MAX_PER_TRADE)} per trade, ${btc(MAX_PER_DAY)} per day: ${show(result.open[2]!)}`,
    `  set-token-caps usdcx ${usd(USDCX_MAX_PER_TRADE)} per trade, ${usd(USDCX_MAX_PER_DAY)} per day: ${show(result.open[3]!)}`,
    `  set-policy no cooldown, for the next ${POLICY_BLOCKS} burn blocks, for both tokens: ${show(result.open[4]!)}`,
    `  allow-token sbtc-token: ${show(result.open[5]!)}`,
    `  allow-token usdcx: ${show(result.open[6]!)}`,
    `  allow-adapter bitflow-adapter: ${show(result.open[7]!)}`,
    `  set-price-bounds ${MAX_SLIPPAGE_BPS} bps below the oracle price at most, a price at most` +
      ` ${MAX_PRICE_AGE_MS} ms old: ${show(result.open[8]!)}`,
    "  Every swap below asks for the least the vault accepts: the oracle price less 2%.",
    "",
    `2. The agent swaps ${btc(result.swap.amountIn)} for USDCx on Bitflow, for at least ${usd(result.swap.minOut)}`,
    `  checkIntent: ${showCheck(result.swap.check)}`,
    `  execute-swap: ${outcome(result.swap, usd)}`,
    "",
    "3. The agent buys sBTC back with half of that USDCx",
    `  The agent swaps ${usd(result.buyBack.amountIn)} for at least ${btc(result.buyBack.minOut)}, inside the USDCx caps.`,
    `  checkIntent: ${showCheck(result.buyBack.check)}`,
    `  execute-swap: ${outcome(result.buyBack, btc)}`,
    "",
    `4. The agent tries ${btc(result.bigSwap.amountIn)}`,
    `  checkIntent: ${showCheck(result.bigSwap.check)}`,
    `  execute-swap: ${outcome(result.bigSwap, usd)}`,
    "  The contract refuses the trade for the same rule checkIntent named.",
    "",
    `5. The agent tries to withdraw ${btc(SWAP)}`,
    "  checkIntent covers swaps only, so nothing checks this call in advance.",
    `  withdraw: ${showRefusal(result.agentWithdraw)}`,
    "  withdraw takes no owner argument and pays out only the caller's own ledger; the agent has none.",
    `  The owner's vault still holds ${btc(result.ledgerBeforeWithdraw.sbtc)} and ${usd(result.ledgerBeforeWithdraw.usdcx)}.`,
    "",
    "6. The owner pauses the vault",
    `  pause: ${show(result.pause)}`,
    `  The agent tries ${btc(result.pausedSwap.amountIn)}, inside both caps.`,
    `  checkIntent: ${showCheck(result.pausedSwap.check)}`,
    `  execute-swap: ${outcome(result.pausedSwap, usd)}`,
    "",
    "7. The owner withdraws everything while the vault is still paused",
    `  withdraw ${btc(result.ledgerBeforeWithdraw.sbtc)}: ${show(result.ownerWithdraw.sbtc)}`,
    `  withdraw ${usd(result.ledgerBeforeWithdraw.usdcx)}: ${show(result.ownerWithdraw.usdcx)}`,
    `  vault ledger: ${btc(vault.balances[SBTC] ?? 0n)}, ${usd(vault.balances[USDCX] ?? 0n)}, paused: ${vault.vault.paused}`,
    `  owner wallet: ${btc(ownerWallet.sbtc)}, ${usd(ownerWallet.usdcx)}`,
    `  agent wallet: ${btc(agentWallet.sbtc)}, ${usd(agentWallet.usdcx)}`,
    `  bitflow-adapter: ${btc(adapterWallet.sbtc)}, ${usd(adapterWallet.usdcx)}`,
    "",
    "Journal: every print event of the vault, in order",
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
  renderBitflowDemo(await runBitflowDemo(await initSimnet(BITFLOW_MANIFEST))),
);
