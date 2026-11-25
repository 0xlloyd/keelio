// Policy setup in plain language: a sentence in, exact policy values out.
//
// The parser is a fixed set of rules. It uses no model and no network, and
// the same sentence always gives the same result. Every number is read as a
// decimal string and turned into a bigint with integer maths: nothing passes
// through a JavaScript `number`. Anything the rules cannot place is reported,
// never dropped, and an ambiguous amount is an error, not a guess.
//
// Nothing here builds or sends a call. A proposal only names the ordinary
// forms to fill in (`flows`), which the owner then reviews and signs one by
// one as for any other change.
import type { ChainConfig, ChainRead, TokenInfo } from "./chain.js";
import type { FlowId, FormValues } from "./flows.js";
import {
  blocksAsTime,
  bpsWords,
  expiryWords,
  human,
  msWords,
  thresholdWords,
} from "./format.js";

const MAX_UINT = 2n ** 128n - 1n;
const BPS = 10_000n;
/** The conversion this file uses and states: one burn block is 10 minutes. */
export const MS_PER_BURN_BLOCK = 600_000n;

export const FROM_SENTENCE = "from your sentence";
export const UNCHANGED = "not stated: unchanged";
export type RowSource = typeof FROM_SENTENCE | typeof UNCHANGED;

/** What the parser needs to know about the vault: its tokens and its values now. */
export interface PolicyContext {
  tokens: readonly TokenInfo[];
  /** The sBTC token id: "BTC" and "sats" are amounts of it. */
  sbtcToken: string;
  burnHeight: bigint;
  current: {
    caps: Readonly<Record<string, { maxPerTrade: bigint; maxPerDay: bigint }>>;
    thresholds: Readonly<Record<string, bigint | null>>;
    cooldownBlocks: bigint;
    expiresAt: bigint;
    maxSlippageBps: bigint;
    maxPriceAge: bigint;
  };
}

/** The context from the page's token config and its latest read. */
export function contextOf(config: ChainConfig, read: ChainRead): PolicyContext {
  const { policy, priceBounds, approvalThresholds } = read.vault;
  return {
    tokens: config.tokens,
    sbtcToken: config.read.sbtcToken,
    burnHeight: read.burnHeight,
    current: {
      caps: policy.caps,
      thresholds: approvalThresholds,
      cooldownBlocks: policy.cooldownBlocks,
      expiresAt: policy.expiresAt,
      maxSlippageBps: priceBounds.maxSlippageBps,
      maxPriceAge: priceBounds.maxPriceAge,
    },
  };
}

export interface ProposalRow {
  /** For example "mock sBTC: max per trade". */
  setting: string;
  /** The exact value the form would carry, with its unit: "1000000 sats". */
  exact: string;
  /** The same value for a person: "0.01000000 sBTC". */
  human: string;
  source: RowSource;
}

/** One ordinary form to fill in, with the text for each of its fields. */
export interface ProposalFlow {
  id: FlowId;
  /** What this form will set, for the list the owner works through. */
  title: string;
  values: FormValues;
}

export interface Proposal {
  /** `true` when there is no error and the sentence set at least one value. */
  ok: boolean;
  /** Why nothing can be proposed. Each is a full sentence for the owner. */
  errors: string[];
  /** Parts of the sentence no rule understood. Shown, never dropped. */
  notUnderstood: string[];
  /** Every policy value: the ones from the sentence and the ones left alone. */
  rows: ProposalRow[];
  /** The worst-case loss per trade and per day, in sentences. */
  worstCase: string[];
  /** Conversions and consequences worth saying. */
  notes: string[];
  /** The forms to review and sign, in order. Empty unless `ok`. */
  flows: ProposalFlow[];
}

// ---- exact numbers ----------------------------------------------------------

/** A decimal string as `digits / 10^scale`, with trailing zeros dropped. */
interface Decimal {
  digits: bigint;
  scale: number;
}

function decimalOf(text: string): Decimal {
  const [whole = "0", fraction = ""] = text.split(".");
  const trimmed = fraction.replace(/0+$/, "");
  return { digits: BigInt(whole + trimmed), scale: trimmed.length };
}

/**
 * `text` in units of `10^-decimals`, or `null` when it has more decimal
 * places than that: 0.015 BTC is 1500000 sats, and 0.000000001 BTC is no
 * whole number of sats.
 */
export function toBaseUnits(text: string, decimals: number): bigint | null {
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const { digits, scale } = decimalOf(text);
  if (scale > decimals) return null;
  return digits * 10n ** BigInt(decimals - scale);
}

const ceilDiv = (n: bigint, d: bigint): bigint =>
  n / d + (n % d > 0n ? 1n : 0n);

// ---- the grammar ------------------------------------------------------------

/** A number that starts a token: not the tail of another number or word. */
const NUM = String.raw`(?<![\w.,\-+])(\d+(?:\.\d+)?)`;
const END = String.raw`(?![\w%])`;

const TIME_UNITS: readonly (readonly [RegExp, bigint | "block"])[] = [
  [/^(?:burn )?blocks?$/, "block"],
  [/^(?:ms|milliseconds?)$/, 1n],
  [/^(?:seconds?|secs?)$/, 1_000n],
  [/^(?:minutes?|mins?)$/, 60_000n],
  [/^(?:hours?|hrs?)$/, 3_600_000n],
  [/^days?$/, 86_400_000n],
  [/^weeks?$/, 604_800_000n],
];
const DUR = `${NUM}\\s*(burn blocks?|blocks?|milliseconds?|ms|seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?)${END}`;
const PERCENT = `${NUM}\\s*(%|percent|pct|bps|bp|basis points?)(?![\\w])`;

interface Unit {
  token: TokenInfo;
  /** Decimal places one of this unit has in base units. */
  decimals: number;
}

function unitsOf(ctx: PolicyContext): Map<string, Unit> {
  const units = new Map<string, Unit>();
  for (const token of ctx.tokens) {
    units.set(token.symbol.toLowerCase(), { token, decimals: token.decimals });
  }
  const sbtc = ctx.tokens.find((t) => t.id === ctx.sbtcToken);
  if (sbtc !== undefined) {
    for (const word of ["btc", "sbtc", "bitcoin", "bitcoins"]) {
      units.set(word, { token: sbtc, decimals: sbtc.decimals });
    }
    for (const word of ["sat", "sats", "satoshi", "satoshis"]) {
      units.set(word, { token: sbtc, decimals: 0 });
    }
  }
  return units;
}

const escape = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The settings a sentence can state, before they are merged with the vault's. */
interface Stated {
  perTrade: Map<string, bigint>;
  perDay: Map<string, bigint>;
  threshold: Map<string, bigint>;
  cooldownBlocks?: bigint;
  expiresAt?: bigint;
  maxSlippageBps?: bigint;
  maxPriceAge?: bigint;
}

interface Work {
  stated: Stated;
  errors: string[];
  notes: string[];
}

type Handler = (match: RegExpExecArray, work: Work) => void;

interface Rule {
  pattern: RegExp;
  handle: Handler;
}

const FILLER = new Set(
  "let the agent bot it its trade trades trading swap swaps up to can may at most max maximum of a an is be i want with also please should must sell allow set keep my limit limits cap caps on in".split(
    " ",
  ),
);

const NEGATION =
  /\b(?:not|no|never|none|without|except|unless|nor|neither|don't|dont|doesn't|doesnt|won't|wont|cannot|can't|cant)\b/;

/** The clauses of a sentence, lower-cased, with a few phrases made regular. */
export function clausesOf(sentence: string): string[] {
  const text = sentence
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d"]/g, " ")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/:/g, " ")
    .replace(/[\r\n]+/g, "; ")
    // "5-minute", "per-trade": a hyphen between a letter or digit and a letter.
    .replace(/(?<=[a-z0-9])-(?=[a-z])/g, " ")
    .replace(/\b(?:no|not) (?:more|greater|bigger|larger) than\b/g, "at most")
    .replace(/\b(?:no|not) older than\b/g, "at most")
    .replace(/\s+/g, " ");
  return (
    text
      // A full stop or comma inside a number ("0.01", "1,000") does not split.
      .split(/;|\n|\.(?!\d)|,(?!\d)|(?<!\d),|\b(?:and|then|but)\b/)
      .map((clause) => clause.trim())
      .filter((clause) => clause !== "")
  );
}

function rulesFor(ctx: PolicyContext): Rule[] {
  const units = unitsOf(ctx);
  const unitWords = [...units.keys()]
    .sort((a, b) => b.length - a.length)
    .map(escape)
    .join("|");
  const AMOUNT = `${NUM}\\s*(${unitWords})${END}`;
  const unitList = [
    ...(units.has("sats") ? ["BTC", "sats"] : []),
    ...ctx.tokens.filter((t) => t.id !== ctx.sbtcToken).map((t) => t.symbol),
  ].join(", ");

  /** The amount of a match's number and unit, or `null` after an error. */
  const amountOf = (
    number: string,
    unitWord: string,
    work: Work,
  ): { token: TokenInfo; amount: bigint } | null => {
    const unit = units.get(unitWord)!;
    const amount = toBaseUnits(number, unit.decimals);
    if (amount === null) {
      work.errors.push(
        unit.decimals === 0
          ? `"${number} ${unitWord}" is not a whole number of ${unit.token.unit}.`
          : `"${number} ${unitWord}" has more than ${unit.decimals} decimal places, so it is not a whole number of ${unit.token.unit}.`,
      );
      return null;
    }
    if (amount > MAX_UINT) {
      work.errors.push(`"${number} ${unitWord}" is too large for the vault.`);
      return null;
    }
    return { token: unit.token, amount };
  };

  const setOnce = <T>(
    work: Work,
    what: string,
    current: T | undefined,
    value: T,
    assign: (value: T) => void,
  ): void => {
    if (current !== undefined && current !== value) {
      work.errors.push(
        `The sentence states ${what} twice, with different values. State it once.`,
      );
      return;
    }
    assign(value);
  };

  const cap =
    (which: "perTrade" | "perDay"): Handler =>
    (match, work) => {
      const got = amountOf(match[1]!, match[2]!, work);
      if (got === null) return;
      const map = work.stated[which];
      setOnce(
        work,
        `the ${which === "perTrade" ? "per-trade" : "per-day"} cap for ${got.token.name}`,
        map.get(got.token.id),
        got.amount,
        (v) => map.set(got.token.id, v),
      );
    };

  const threshold: Handler = (match, work) => {
    const got = amountOf(match[1]!, match[2]!, work);
    if (got === null) return;
    const map = work.stated.threshold;
    setOnce(
      work,
      `the approval threshold for ${got.token.name}`,
      map.get(got.token.id),
      got.amount,
      (v) => map.set(got.token.id, v),
    );
  };

  const twoScopes: Handler = (match, work) => {
    work.errors.push(
      `"${match[0].trim()}" names both a trade and a day for one amount. State each cap on its own, for example "0.01 BTC per trade and 0.05 BTC per day".`,
    );
  };

  const noUnit: Handler = (match, work) => {
    work.errors.push(
      `"${match[0].trim()}" has no unit, so the amount could mean anything. Write it with a unit: ${unitList}.`,
    );
  };

  /** A duration as milliseconds, or as whole burn blocks when given in blocks. */
  const duration = (
    number: string,
    unitWord: string,
    work: Work,
  ): { blocks: bigint } | { ms: bigint } | null => {
    const unit = TIME_UNITS.find(([pattern]) => pattern.test(unitWord))![1];
    const { digits, scale } = decimalOf(number);
    const divisor = 10n ** BigInt(scale);
    if (unit === "block") {
      if (scale > 0) {
        work.errors.push(
          `"${number} ${unitWord}" is not a whole number of burn blocks.`,
        );
        return null;
      }
      return { blocks: digits };
    }
    const scaled = digits * unit;
    if (scaled % divisor !== 0n) {
      work.errors.push(
        `"${number} ${unitWord}" is not a whole number of milliseconds.`,
      );
      return null;
    }
    return { ms: scaled / divisor };
  };

  const cooldown: Handler = (match, work) => {
    const text = `${match[1]} ${match[2]}`;
    const got = duration(match[1]!, match[2]!, work);
    if (got === null) return;
    let blocks: bigint;
    if ("blocks" in got) blocks = got.blocks;
    else {
      blocks = ceilDiv(got.ms, MS_PER_BURN_BLOCK);
      work.notes.push(
        `Cooldown: ${text} is ${blocks} burn ${blocks === 1n ? "block" : "blocks"} at 10 minutes per burn block${
          got.ms % MS_PER_BURN_BLOCK === 0n ? "" : ", rounded up"
        }. The vault counts burn blocks, not minutes, and a real block can take more or less than 10 minutes.`,
      );
    }
    if (blocks > MAX_UINT) {
      work.errors.push(`The cooldown "${text}" is too large for the vault.`);
      return;
    }
    setOnce(work, "the cooldown", work.stated.cooldownBlocks, blocks, (v) => {
      work.stated.cooldownBlocks = v;
    });
  };

  const expiryIn: Handler = (match, work) => {
    const text = `${match[1]} ${match[2]}`;
    const got = duration(match[1]!, match[2]!, work);
    if (got === null) return;
    let blocks: bigint;
    if ("blocks" in got) blocks = got.blocks;
    else {
      blocks = got.ms / MS_PER_BURN_BLOCK;
      work.notes.push(
        `Expiry: ${text} is ${blocks} burn ${blocks === 1n ? "block" : "blocks"} at 10 minutes per burn block${
          got.ms % MS_PER_BURN_BLOCK === 0n ? "" : ", rounded down"
        }, counted from burn height ${ctx.burnHeight} (now). The vault counts burn blocks, not days, so the real date can come sooner or later.`,
      );
    }
    const height = ctx.burnHeight + blocks;
    if (height > MAX_UINT) {
      work.errors.push(`The expiry "${text}" is too large for the vault.`);
      return;
    }
    setOnce(work, "the expiry", work.stated.expiresAt, height, (v) => {
      work.stated.expiresAt = v;
    });
  };

  const expiryAt: Handler = (match, work) => {
    const number = match[1]!;
    if (number.includes(".")) {
      work.errors.push(`"${number}" is not a whole burn height.`);
      return;
    }
    const height = BigInt(number);
    if (height > MAX_UINT) {
      work.errors.push(
        `The burn height "${number}" is too large for the vault.`,
      );
      return;
    }
    if (height < ctx.burnHeight) {
      work.errors.push(
        `Burn height ${height} has already passed (it is now ${ctx.burnHeight}), so the policy would be expired at once.`,
      );
      return;
    }
    setOnce(work, "the expiry", work.stated.expiresAt, height, (v) => {
      work.stated.expiresAt = v;
    });
  };

  const slippage: Handler = (match, work) => {
    const number = match[1]!;
    const unit = match[2]!;
    const percent = unit === "%" || unit === "percent" || unit === "pct";
    const bps = toBaseUnits(number, percent ? 2 : 0);
    if (bps === null) {
      work.errors.push(
        percent
          ? `"${number}${unit === "%" ? "%" : ` ${unit}`}" is not a whole number of basis points: use at most two decimal places.`
          : `"${number} ${unit}" is not a whole number of basis points.`,
      );
      return;
    }
    if (bps === 0n) {
      work.errors.push(
        "A slippage of 0 means the agent may not trade at all. To stop the agent, pause it; to let it trade, give a slippage above 0.",
      );
      return;
    }
    if (bps >= BPS) {
      work.errors.push(
        `A slippage of ${bpsWords(bps)} is 100% or more, which the vault refuses.`,
      );
      return;
    }
    setOnce(work, "the slippage", work.stated.maxSlippageBps, bps, (v) => {
      work.stated.maxSlippageBps = v;
    });
  };

  const priceAge: Handler = (match, work) => {
    const text = `${match[1]} ${match[2]}`;
    const got = duration(match[1]!, match[2]!, work);
    if (got === null) return;
    if ("blocks" in got) {
      work.errors.push(
        `The price age "${text}" is in burn blocks, but the vault measures the price's age in time. Write it in seconds, minutes or hours.`,
      );
      return;
    }
    if (got.ms === 0n) {
      work.errors.push(
        "A price age of 0 means the agent may not trade at all. Give an age above 0.",
      );
      return;
    }
    if (got.ms > MAX_UINT) {
      work.errors.push(`The price age "${text}" is too large for the vault.`);
      return;
    }
    setOnce(work, "the price age", work.stated.maxPriceAge, got.ms, (v) => {
      work.stated.maxPriceAge = v;
    });
  };

  const rule = (source: string, handle: Handler): Rule => ({
    pattern: new RegExp(source),
    handle,
  });
  const ASK = String.raw`(?:ask me|check with me|confirm with me|ask|my approval|my ok|approval)`;
  const ASK_WORDS = String.raw`(?:\s+(?:first|for|on|before|when|if|is|needed|required|any|a|each|every|trade|trades|swap|swaps|anything|it|sells|selling|of))*`;
  const ABOVE = String.raw`(?:above|over|beyond|more than|exceeding|larger than|greater than|bigger than)`;
  const ONE_TRADE = String.raw`(?:per|a|each|every|in one|in a single|in any one)\s+(?:single\s+)?(?:trade|swap)`;
  const ONE_DAY = String.raw`(?:(?:per|a|each|every)\s+day|daily|(?:per|every|in any)\s+24 hours)`;
  const IS = String.raw`(?:\s+(?:of|is|at|:))?`;
  const CAP = String.raw`(?:cap|limit|max|maximum)`;
  // "trade limit 0.01 BTC per day" names two scopes: left for the error path.
  const NO_SCOPE = String.raw`(?!\s+(?:per|a|each|every|daily|in)\b)`;

  return [
    // The approval threshold: "ask me above 0.005 BTC".
    rule(
      `${ASK}${ASK_WORDS}\\s+${ABOVE}\\s+${AMOUNT}(?:\\s+${ONE_TRADE})?`,
      threshold,
    ),
    rule(`approval threshold${IS}\\s+${AMOUNT}`, threshold),
    rule(
      `(?:(?:trades?|swaps?|anything|amounts?)\\s+)?${ABOVE}\\s+${AMOUNT}\\s+(?:needs?|requires?|must have|should have)\\s+(?:my\\s+)?(?:approval|ok|sign off|confirmation)`,
      threshold,
    ),
    rule(`${ASK}${ASK_WORDS}\\s+${ABOVE}\\s+${NUM}${END}`, noUnit),
    // The caps: "0.01 BTC per trade", "0.05 BTC per day".
    rule(
      `(?:per trade|trade)\\s+${CAP}${IS}\\s+${AMOUNT}\\s+${ONE_DAY}`,
      twoScopes,
    ),
    rule(
      `(?:daily|per day|day)\\s+${CAP}${IS}\\s+${AMOUNT}\\s+${ONE_TRADE}`,
      twoScopes,
    ),
    rule(`${AMOUNT}\\s+${ONE_TRADE}`, cap("perTrade")),
    rule(
      `(?:per trade|trade)\\s+${CAP}${IS}\\s+${AMOUNT}${NO_SCOPE}`,
      cap("perTrade"),
    ),
    rule(
      `${CAP}\\s+per\\s+trade${IS}\\s+${AMOUNT}${NO_SCOPE}`,
      cap("perTrade"),
    ),
    rule(`${AMOUNT}\\s+${ONE_DAY}`, cap("perDay")),
    rule(
      `(?:daily|per day|day)\\s+${CAP}${IS}\\s+${AMOUNT}${NO_SCOPE}`,
      cap("perDay"),
    ),
    rule(`${CAP}\\s+per\\s+day${IS}\\s+${AMOUNT}${NO_SCOPE}`, cap("perDay")),
    rule(`${NUM}\\s+(?:${ONE_TRADE}|${ONE_DAY})`, noUnit),
    // The price's age: "price at most 1 hour old".
    rule(
      `(?:reject|refuse|ignore)\\s+(?:a\\s+|any\\s+)?(?:oracle\\s+)?prices?\\s+older than\\s+${DUR}`,
      priceAge,
    ),
    rule(
      `(?:max(?:imum)?\\s+)?(?:oracle\\s+)?prices?(?:\\s+(?:age|data|feed))?(?:\\s+(?:of|is|are|at most|up to|under|within|max|maximum|older than|:))*\\s+${DUR}(?:\\s+old)?`,
      priceAge,
    ),
    // Slippage: "max slippage 1%", "50 bps slippage".
    rule(
      `(?:max(?:imum)?\\s+)?slippage(?:\\s+(?:of|is|at most|up to|under|below|max|maximum|limit|cap|:))*\\s*${PERCENT}`,
      slippage,
    ),
    rule(`${PERCENT}\\s+(?:max(?:imum)?\\s+)?slippage`, slippage),
    // The cooldown: "wait 3 blocks between trades".
    rule(
      `(?:wait|cool ?down|gap)(?:\\s+(?:of|is|for|at least|:))*\\s+${DUR}(?:\\s+(?:between|after)\\s+(?:trades|swaps|each trade|every trade|each swap|a trade))?`,
      cooldown,
    ),
    rule(
      `${DUR}\\s+(?:between|after)\\s+(?:trades|swaps|each trade|every trade)`,
      cooldown,
    ),
    rule(`${DUR}\\s+cool ?down`, cooldown),
    // The expiry: "stop after 2 weeks", "until burn height 900000".
    rule(
      `(?:stops?|expires?|ends?|expiry|until|valid until|run until)(?:\\s+(?:at|is|on|after|until|:))*\\s+(?:burn\\s+)?(?:block\\s+)?(?:height|block)\\s+#?${NUM}${END}`,
      expiryAt,
    ),
    rule(
      `(?:stops?|expires?|ends?|valid|runs?|lasts?)(?:\\s+trading)?\\s+(?:after|in|for|within)\\s+(?:the next\\s+)?${DUR}`,
      expiryIn,
    ),
    rule(`expiry(?:\\s+(?:of|is|in|after|:))?\\s+${DUR}`, expiryIn),
    rule(`for\\s+(?:the next\\s+)?${DUR}`, expiryIn),
  ];
}

// ---- the proposal -----------------------------------------------------------

/** Applies the rules to one clause and reports whatever is left over. */
function readClause(
  clause: string,
  rules: readonly Rule[],
  work: Work,
  notUnderstood: string[],
): void {
  const negation = NEGATION.exec(clause);
  if (negation !== null) {
    if (/\d/.test(clause)) {
      work.errors.push(
        `"${clause}" says "${negation[0]}", and this parser does not read negations. Say it as a limit, for example "up to 0.01 BTC per trade".`,
      );
    } else {
      notUnderstood.push(clause);
    }
    return;
  }
  let rest = clause;
  let any = false;
  for (let matched = true; matched;) {
    matched = false;
    for (const { pattern, handle } of rules) {
      const match = pattern.exec(rest);
      if (match === null) continue;
      handle(match, work);
      rest = `${rest.slice(0, match.index)} | ${rest.slice(match.index + match[0].length)}`;
      matched = true;
      any = true;
      break;
    }
  }
  const left = rest
    .split(/[\s|]+/)
    .map((word) => word.replace(/^[^\w%#$.-]+|[^\w%]+$/g, ""))
    .filter((word) => word !== "" && !FILLER.has(word));
  if (left.length === 0) return;
  if (left.some((word) => /\d/.test(word))) {
    work.errors.push(
      `Could not tell what "${left.join(" ")}" means in "${clause}". A number needs a unit and a purpose, for example "0.01 BTC per trade", "wait 3 blocks between trades" or "max slippage 1%".`,
    );
    return;
  }
  // A clause no rule touched is listed whole; otherwise the words left over.
  notUnderstood.push(any ? `"${left.join(" ")}" in "${clause}"` : clause);
}

const sourceOf = (stated: boolean): RowSource =>
  stated ? FROM_SENTENCE : UNCHANGED;

/**
 * Reads the owner's sentence against the vault's tokens and current values.
 * Deterministic and pure: it never throws for any text, and it builds no
 * call.
 */
export function proposePolicy(sentence: string, ctx: PolicyContext): Proposal {
  const work: Work = {
    stated: { perTrade: new Map(), perDay: new Map(), threshold: new Map() },
    errors: [],
    notes: [],
  };
  const notUnderstood: string[] = [];
  const rules = rulesFor(ctx);
  const clauses = clausesOf(sentence);
  for (const clause of clauses) {
    readClause(clause, rules, work, notUnderstood);
  }
  const { stated, errors, notes } = work;
  const { current } = ctx;
  const anything =
    stated.perTrade.size +
      stated.perDay.size +
      stated.threshold.size +
      [
        stated.cooldownBlocks,
        stated.expiresAt,
        stated.maxSlippageBps,
        stated.maxPriceAge,
      ].filter((v) => v !== undefined).length >
    0;
  if (clauses.length === 0) {
    errors.push(
      'Write a sentence first, for example "let the agent trade up to 0.01 BTC per trade and 0.05 BTC per day".',
    );
  } else if (!anything && errors.length === 0) {
    errors.push(
      "Nothing in the sentence set a limit this parser knows: caps per trade and per day, a cooldown, an expiry, a slippage, a price age or an approval threshold.",
    );
  }

  const rows: ProposalRow[] = [];
  const flows: ProposalFlow[] = [];
  const worstCase: string[] = [];
  const slippageBps = stated.maxSlippageBps ?? current.maxSlippageBps;
  const maxPriceAge = stated.maxPriceAge ?? current.maxPriceAge;
  const cooldownBlocks = stated.cooldownBlocks ?? current.cooldownBlocks;
  const expiresAt = stated.expiresAt ?? current.expiresAt;

  for (const token of ctx.tokens) {
    const now = current.caps[token.id] ?? { maxPerTrade: 0n, maxPerDay: 0n };
    const perTrade = stated.perTrade.get(token.id);
    const perDay = stated.perDay.get(token.id);
    const maxPerTrade = perTrade ?? now.maxPerTrade;
    const maxPerDay = perDay ?? now.maxPerDay;
    const base = (n: bigint) => `${n} ${token.unit}`;
    rows.push(
      {
        setting: `${token.name}: max per trade`,
        exact: base(maxPerTrade),
        human: human(token, maxPerTrade),
        source: sourceOf(perTrade !== undefined),
      },
      {
        setting: `${token.name}: max per day (144 burn blocks)`,
        exact: base(maxPerDay),
        human: human(token, maxPerDay),
        source: sourceOf(perDay !== undefined),
      },
    );
    if (perTrade !== undefined || perDay !== undefined) {
      if (maxPerDay < maxPerTrade) {
        errors.push(
          `For ${token.name} the day cap (${human(token, maxPerDay)}${perDay === undefined ? ", unchanged" : ""}) would be below the trade cap (${human(token, maxPerTrade)}${perTrade === undefined ? ", unchanged" : ""}), which the vault refuses. State both caps, with the day cap at least the trade cap.`,
        );
      }
      flows.push({
        id: "set-token-caps",
        title: `Caps for ${token.name}: ${human(token, maxPerTrade)} per trade, ${human(token, maxPerDay)} per day`,
        values: {
          token: token.id,
          maxPerTrade: maxPerTrade.toString(),
          maxPerDay: maxPerDay.toString(),
        },
      });
    }

    const asked = stated.threshold.get(token.id);
    const threshold =
      asked !== undefined ? asked : (current.thresholds[token.id] ?? null);
    rows.push({
      setting: `${token.name}: approval threshold`,
      exact: threshold === null ? "none" : base(threshold),
      human: thresholdWords(token, threshold),
      source: sourceOf(asked !== undefined),
    });
    if (asked !== undefined) {
      if (asked >= maxPerTrade) {
        notes.push(
          `For ${token.name} the approval threshold (${human(token, asked)}) is not below the per-trade cap (${human(token, maxPerTrade)}), so no trade can be above it and inside the cap: the agent would never need to ask.`,
        );
      }
      flows.push({
        id: "set-approval-threshold",
        title: `Approval threshold for ${token.name}: ask me above ${human(token, asked)}`,
        values: { token: token.id, threshold: asked.toString() },
      });
    }

    if (maxPerTrade === 0n || maxPerDay === 0n) {
      worstCase.push(
        `${token.name}: no cap is set, so the agent may not sell it. Nothing is at risk from trades selling it.`,
      );
    } else if (slippageBps === 0n) {
      worstCase.push(
        `${token.name}: the slippage bound is not set, so the agent may not trade and there is no worst case to work out yet.`,
      );
    } else {
      const lossTrade = ceilDiv(maxPerTrade * slippageBps, BPS);
      const lossDay = ceilDiv(maxPerDay * slippageBps, BPS);
      worstCase.push(
        `${token.name}: one trade can sell at most ${human(token, maxPerTrade)} and may settle up to ${bpsWords(slippageBps)} below the oracle price, so it can give up at most ${lossTrade} ${token.unit} (${human(token, lossTrade)}) of value against that price. Over a day (144 burn blocks) the agent can sell at most ${human(token, maxPerDay)} and give up at most ${lossDay} ${token.unit} (${human(token, lossDay)}).`,
      );
    }
  }
  worstCase.push(
    "These figures are the cap times the slippage, rounded up. They count only how far below the oracle's price a trade may settle. They do not count the market price itself moving, a wrong or stale oracle price inside your price-age bound, or the risk of the tokens themselves.",
  );

  rows.push(
    {
      setting: "Cooldown between trades",
      exact: `${cooldownBlocks} burn blocks`,
      human: cooldownBlocks === 0n ? "none" : blocksAsTime(cooldownBlocks),
      source: sourceOf(stated.cooldownBlocks !== undefined),
    },
    {
      setting: "Policy expires",
      exact: `burn height ${expiresAt}`,
      human: expiryWords(expiresAt, ctx.burnHeight),
      source: sourceOf(stated.expiresAt !== undefined),
    },
    {
      setting: "Max slippage below the oracle price",
      exact: `${slippageBps} bps`,
      human:
        slippageBps === 0n
          ? "not set: the agent may not trade"
          : bpsWords(slippageBps),
      source: sourceOf(stated.maxSlippageBps !== undefined),
    },
    {
      setting: "Max price age",
      exact: `${maxPriceAge} ms`,
      human:
        maxPriceAge === 0n
          ? "not set: the agent may not trade"
          : msWords(maxPriceAge),
      source: sourceOf(stated.maxPriceAge !== undefined),
    },
  );

  if (stated.cooldownBlocks !== undefined || stated.expiresAt !== undefined) {
    if (expiresAt === 0n) {
      notes.push(
        "No expiry is set (burn height 0) and the sentence states none, so the agent may not trade until you set one.",
      );
    }
    flows.push({
      id: "set-policy",
      title: `Cooldown and expiry: ${cooldownBlocks} burn blocks between trades, expiry at burn height ${expiresAt}`,
      values: {
        cooldownBlocks: cooldownBlocks.toString(),
        expiresAt: expiresAt.toString(),
      },
    });
  }
  if (stated.maxSlippageBps !== undefined || stated.maxPriceAge !== undefined) {
    if (slippageBps === 0n) {
      notes.push(
        "No slippage bound is set and the sentence states none, so the agent may not trade until you set one.",
      );
    }
    if (maxPriceAge === 0n) {
      notes.push(
        "No price age is set and the sentence states none, so the agent may not trade until you set one.",
      );
    }
    flows.push({
      id: "set-price-bounds",
      title: `Price bounds: ${slippageBps} bps slippage, price at most ${maxPriceAge} ms old`,
      values: {
        maxSlippageBps: slippageBps.toString(),
        maxPriceAge: maxPriceAge.toString(),
      },
    });
  }

  const ok = errors.length === 0 && anything;
  return {
    ok,
    errors,
    notUnderstood,
    rows,
    worstCase,
    notes,
    flows: ok ? flows : [],
  };
}
