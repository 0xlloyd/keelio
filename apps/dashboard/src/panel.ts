// The vault panel's content, as label and value pairs, from one chain read.
// No DOM, so tests run it in Node.
import type { ChainConfig, ChainRead, TokenInfo } from "./chain.js";
import {
  amountWords,
  blocksWords,
  bpsWords,
  capUseWords,
  expiryWords,
  label,
  msWords,
  oraclePriceWords,
  thresholdWords,
} from "./format.js";

export type Fact = readonly [label: string, value: string];

export interface PanelCard {
  title: string;
  facts: Fact[];
}

/** The vault card, then one card per token. */
export function vaultPanel(
  read: ChainRead,
  config: ChainConfig,
  owner: string,
): PanelCard[] {
  const { vault, burnHeight, nowMs, wallet } = read;
  const { policy, usage, priceBounds, oracle } = vault;
  const agent = vault.vault.agent;
  const boundsSet =
    priceBounds.maxSlippageBps > 0n && priceBounds.maxPriceAge > 0n;
  const price = oracle.price;
  const priceAge =
    price === null
      ? null
      : price.timestamp <= nowMs
        ? nowMs - price.timestamp
        : price.timestamp - nowMs;

  const cards: PanelCard[] = [
    {
      title: "Owner, agent and policy",
      facts: [
        ["Owner", owner],
        [
          "Agent",
          agent === null
            ? "none: no one can trade for this vault"
            : label(config, agent) === agent
              ? agent
              : `${agent} (${label(config, agent)})`,
        ],
        ["Paused", vault.vault.paused ? "yes: the agent cannot trade" : "no"],
        ["Burn height now", burnHeight.toString()],
        ["Policy expires", expiryWords(policy.expiresAt, burnHeight)],
        ["Cooldown between trades", blocksWords(policy.cooldownBlocks)],
        [
          "Last trade",
          usage.lastTradeHeight === null
            ? "none yet"
            : `burn height ${usage.lastTradeHeight}`,
        ],
        [
          "Price bounds",
          boundsSet
            ? `at most ${bpsWords(priceBounds.maxSlippageBps)} below the oracle price; price at most ${msWords(priceBounds.maxPriceAge)} old`
            : `not set (slippage ${priceBounds.maxSlippageBps} bps, max age ${priceBounds.maxPriceAge} ms): the agent may not trade`,
        ],
        [
          "Oracle price",
          price === null || priceAge === null
            ? "the oracle returned no price"
            : `${oraclePriceWords(price.value)}, ${msWords(priceAge)} from the latest block's time${
                boundsSet && priceAge > priceBounds.maxPriceAge
                  ? ": too old, the agent may not trade"
                  : ""
              }`,
        ],
        ...config.adapters.map((adapter): Fact => [
          `Adapter ${adapter.name}`,
          policy.allowedAdapters.includes(adapter.id)
            ? "allowed"
            : "not allowed: the agent may not swap through it",
        ]),
      ],
    },
  ];

  for (const token of config.tokens) {
    const caps = policy.caps[token.id] ?? { maxPerTrade: 0n, maxPerDay: 0n };
    cards.push({
      title: token.name,
      facts: [
        ["In the vault", amountWords(token, vault.balances[token.id] ?? 0n)],
        ["In your account", amountWords(token, wallet[token.id] ?? 0n)],
        [
          "Allowed for swaps",
          policy.allowedTokens.includes(token.id) ? "yes" : "no",
        ],
        ["Max per trade", amountWords(token, caps.maxPerTrade)],
        ["Max per day", amountWords(token, caps.maxPerDay)],
        [
          "Approval threshold",
          thresholdWords(token, vault.approvalThresholds[token.id] ?? null),
        ],
        [
          "Day window (last 144 burn blocks)",
          capUseWords(token, usage.dayTotals[token.id] ?? 0n, caps.maxPerDay),
        ],
      ],
    });
  }
  return cards;
}

/** One token's numbers, for the headline figures and the day-cap meter. */
export interface TokenView {
  token: TokenInfo;
  inVault: bigint;
  inWallet: bigint;
  allowed: boolean;
  maxPerTrade: bigint;
  maxPerDay: bigint;
  /** Above this the agent must ask; `null` when the owner set none. */
  approvalThreshold: bigint | null;
  dayUsed: bigint;
  dayLeft: bigint;
  /** How much of the day cap is used, 0 to 100. 0 when no cap is set. */
  dayPercent: number;
}

export interface VaultSummary {
  agent: string | null;
  paused: boolean;
  burnHeight: bigint;
  expiresAt: bigint;
  /** Burn blocks until the policy expires, or null when unset or expired. */
  blocksLeft: bigint | null;
  tokens: TokenView[];
}

/** The same read as `vaultPanel`, as numbers. */
export function vaultSummary(
  read: ChainRead,
  config: ChainConfig,
): VaultSummary {
  const { vault, burnHeight, wallet } = read;
  const { policy, usage } = vault;
  return {
    agent: vault.vault.agent,
    paused: vault.vault.paused,
    burnHeight,
    expiresAt: policy.expiresAt,
    blocksLeft:
      policy.expiresAt === 0n || policy.expiresAt < burnHeight
        ? null
        : policy.expiresAt - burnHeight,
    tokens: config.tokens.map((token) => {
      const caps = policy.caps[token.id] ?? { maxPerTrade: 0n, maxPerDay: 0n };
      const dayUsed = usage.dayTotals[token.id] ?? 0n;
      const cap = caps.maxPerDay;
      const percent = cap === 0n ? 0n : (dayUsed * 100n) / cap;
      return {
        token,
        inVault: vault.balances[token.id] ?? 0n,
        inWallet: wallet[token.id] ?? 0n,
        allowed: policy.allowedTokens.includes(token.id),
        maxPerTrade: caps.maxPerTrade,
        maxPerDay: cap,
        approvalThreshold: vault.approvalThresholds[token.id] ?? null,
        dayUsed,
        dayLeft: dayUsed >= cap ? 0n : cap - dayUsed,
        dayPercent: Number(percent > 100n ? 100n : percent),
      };
    }),
  };
}
