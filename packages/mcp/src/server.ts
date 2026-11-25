import {
  accountabilityJson,
  accountabilityRecords,
  agentHistory,
  buildCancelSwapRequest,
  buildExecuteSwap,
  buildRequestSwap,
  checkCancelRequest,
  checkIntent,
  checkRequest,
  MAX_POST_CONDITION_AMOUNT,
  parseJournal,
  readVault,
  renderAccountabilityReport,
  sizePosition,
  SizingError,
  toJsonSafe,
  tradeWarnings,
  TxBuildError,
  type Refusal,
  type TxConfig,
  type VaultCall,
  type VaultConfig,
  type VaultRead,
  type VaultRuleName,
  type VaultState,
} from "@keelio/sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { isClarityName } from "@stacks/transactions";
import type { KeelioChain } from "./chain.js";
import {
  accountabilityShape,
  agentShape,
  cancelShape,
  decodeEvent,
  encodeVaultCall,
  journalShape,
  parseAmount,
  parseLimit,
  parsePrincipal,
  requestShape,
  sizeShape,
  swapShape,
  ToolInputError,
  tradeShape,
  vaultShape,
} from "./inputs.js";

export interface KeelioMcpDeps {
  /** The chain to read; the server never builds one of its own. */
  chain: KeelioChain;
  /** The vault id and the tokens and adapters `readVault` looks at. */
  read: VaultConfig;
  /**
   * The full vault id, token asset names and adapter routes
   * `buildExecuteSwap` needs. `buildRequestSwap` and
   * `buildCancelSwapRequest` read the vault id only.
   */
  tx: TxConfig;
}

const NOT_PREDICTED =
  "ok: true means no policy or oracle rule refuses the trade: the check " +
  "covers the oracle floor, u119 and u121 to u125. It does not predict u104 " +
  "(allowance exceeded), u117 (adapter failed) or u118 (below min-out): the " +
  "contract decides those after it calls the adapter. The oracle price's " +
  "age is measured against the latest block's time, while the swap runs in " +
  "a later block, so near the owner's max price age the contract can still " +
  "refuse with u123.";

const AGENT_RULE =
  "`agent` is the principal that will send the swap and must be the vault's " +
  "agent: any other principal, the owner included, is refused with NOT_AGENT " +
  "(u108).";

const AMOUNTS =
  "Amounts and heights are decimal strings of base units. The vault contract " +
  "enforces every rule itself; this check is advisory.";

const REFUSAL =
  "{ ok: false, rule, errorCode, message, burnHeight }; a refusal is a " +
  "normal result";

const SUGGESTION =
  "A size or cooldown refusal (u114, u126, u115, u116, u101) also carries " +
  "`suggestion`: maxAmountIn (the largest amount that passes the per-trade " +
  "cap, the day cap and the ledger), maxDirectAmountIn (the largest the " +
  "agent can send alone, under the owner's approval threshold) and the " +
  "heights at which waiting helps. A refusal with rule APPROVAL_REQUIRED " +
  "(u126) has requestNeeded: true: the amount is above the owner's " +
  "approval threshold, so build it with keelio_build_swap_request instead.";

const OWNER_ONLY =
  "Approving, rejecting and setting the threshold are the owner's calls, " +
  "made from the owner's dashboard: this server builds none of them.";

const DESCRIPTIONS = {
  keelio_get_vault:
    "Reads one owner's Keelio vault: agent, paused flag, policy (caps per " +
    "token, shared cooldown and expiry), today's usage per token, ledger " +
    "balances and dayRemaining (what is left of each token's daily cap), at " +
    "burnHeight. A token with caps of 0 may not be sold. approvalThresholds " +
    "gives, per input token, the amount above which a trade needs the " +
    "owner's approval (null: no threshold). pendingSwap is the owner's " +
    "stored swap request, or null; `expired` says whether it can still be " +
    "approved at burnHeight. An owner with no " +
    "vault returns empty values, not an error. " +
    "Amounts and heights are decimal strings of base units.",
  keelio_check_trade:
    "Checks a swap against the owner's vault policy and the oracle floor " +
    "(minOut at least the oracle price less the owner's max slippage) " +
    "before any fee is paid. " +
    "Returns { ok: true, burnHeight, warnings } or { ok: false, rule, " +
    "errorCode, message, burnHeight, warnings }; a refusal is a normal " +
    `result. ${SUGGESTION} ` +
    "`warnings` compares the trade with the vault's past trades in the " +
    "journal (a first trade in this direction, an unusually large one, a " +
    "burst, a first trade after a long gap). Warnings are advisory: they " +
    "never change ok, and the contract does not enforce them. " +
    `${AGENT_RULE} ${NOT_PREDICTED} ${AMOUNTS}`,
  keelio_build_swap:
    "Checks a swap exactly as keelio_check_trade does and, only if it passes, " +
    "returns { ok: true, burnHeight, call }: an unsigned execute-swap " +
    "contract call with deny-mode post-conditions. A refused trade returns " +
    "the refusal and no call. The call is unsigned: the agent principal must " +
    "sign and send it from its own wallet. This tool never signs a " +
    "transaction and never submits one to the network. functionArgs are hex Clarity values " +
    `(Cl.deserialize). ${SUGGESTION} ${AGENT_RULE} ${NOT_PREDICTED} ${AMOUNTS}`,
  keelio_build_swap_request:
    "For a trade above the owner's approval threshold (keelio_check_trade " +
    "refused it with APPROVAL_REQUIRED, u126). Runs request-swap's checks " +
    "and, only if they pass, returns { ok: true, burnHeight, call }: an " +
    "unsigned request-swap contract call in deny mode with no " +
    "post-conditions, because a request moves no tokens. Otherwise " +
    `${REFUSAL}, with no call. ` +
    "A request is refused with APPROVAL_NOT_NEEDED (u127) when the amount " +
    "is at or below the threshold or there is none (use keelio_build_swap), " +
    "and with REQUEST_PENDING (u128) while the owner has a request that has " +
    "not expired. The agent signs and sends the call itself; this tool " +
    "never signs or sends. Once mined, the owner can approve the request " +
    "for 6 burn blocks; the swap runs only then, with the day cap, the " +
    "cooldown and the oracle floor checked at that moment, so ok: true is " +
    "not a promise that the trade will run. Read keelio_get_vault's " +
    "pendingSwap and keelio_journal (approve-swap, reject-swap) to see what " +
    `became of it. ${OWNER_ONLY} ${AGENT_RULE} ${AMOUNTS}`,
  keelio_build_cancel_request:
    "Builds the unsigned cancel-swap-request call that withdraws the " +
    "owner's pending swap request, expired or not: { ok: true, burnHeight, " +
    "call }, deny mode, no post-conditions. Refused, with no call, as " +
    `${REFUSAL}: NO_PENDING_SWAP (u129) when the owner has no stored ` +
    "request, NOT_REQUESTER (u133) when `agent` is not the agent that made " +
    "it. The agent signs and sends the call itself; this tool never signs " +
    `or sends. ${OWNER_ONLY}`,
  keelio_journal:
    "Returns the owner's vault journal events, newest first, at most `limit` " +
    "(1 to 500, default 50). Each event keeps the contract's kebab-case " +
    "field names; uints are decimal strings.",
  keelio_agent_history:
    "What the vault contract's journal, across every owner, shows about one " +
    "agent principal: where it first appears, the owners that named it and " +
    "whether each still does, how many trades it made and the amount sold " +
    "per input token, its last trade, and its swap requests (made, " +
    "approved, rejected, cancelled). A principal no event names returns " +
    "{ known: false, agent }, not an error. Only calls that succeeded are " +
    "in the journal, so refused calls are not counted, and a short history " +
    "says little: anyone can make a new principal. Counts, amounts and " +
    "heights are decimal strings.",
  keelio_accountability:
    "For one owner's most recent trades (`limit`, 1 to 500, default 50), " +
    "the limits that were in force when each ran, rebuilt by replaying the " +
    "journal: the agent, cooldown and expiry, the input token's caps and " +
    "approval threshold, the price bounds and the token and adapter lists, " +
    "each with the journal event that set it, and whether the agent sent " +
    "the trade alone or the owner approved it. Returns { owner, " +
    "totalTrades, records, report }: `records` oldest first, and `report` " +
    "the same as Markdown. `issues` on a record is empty unless the journal " +
    "read does not account for the trade. Amounts and heights are decimal " +
    "strings of base units.",
  keelio_size_position:
    "Sizes a position so a stop-out loses at most riskBps of capital. " +
    "Returns { ok: true, quantity, riskAmount } in base units; a quantity " +
    'that rounds down to zero lots is a success with "0". This tool only ' +
    "computes a size: it does not read the vault and does not check the " +
    "policy, so a size is not permission to trade. A sizing error " +
    "(NON_POSITIVE_INPUT, RISK_ABOVE_CEILING, ENTRY_EQUALS_STOP) is a normal " +
    "refusal { ok: false, code, message }. Amounts are decimal strings.",
} as const;

type Json = Record<string, unknown>;

interface ErrorBody {
  code: string;
  field: string | null;
  message: string;
}

function success(result: Json): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

function failure(error: ErrorBody): CallToolResult {
  const body = { error };
  return {
    content: [{ type: "text", text: JSON.stringify(body) }],
    structuredContent: body,
    isError: true,
  };
}

function toError(e: unknown): ErrorBody {
  if (e instanceof ToolInputError) {
    return { code: e.code, field: e.field, message: e.message };
  }
  return {
    code: "CHAIN_ERROR",
    field: null,
    message: e instanceof Error ? e.message : String(e),
  };
}

/** Runs a handler and turns anything it throws into an `isError` result. */
function tool<A>(handler: (args: A) => Promise<Json>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return success(await handler(args));
    } catch (e) {
      return failure(toError(e));
    }
  };
}

type Args = Record<string, unknown>;

interface Trade {
  owner: string;
  agent: string;
  adapter: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  minOut: bigint;
}

function parseTrade(args: Args): Trade {
  return {
    owner: parsePrincipal("owner", args.owner, false),
    agent: parsePrincipal("agent", args.agent, false),
    adapter: parsePrincipal("adapter", args.adapter, true),
    tokenIn: parsePrincipal("tokenIn", args.tokenIn, true),
    tokenOut: parsePrincipal("tokenOut", args.tokenOut, true),
    amountIn: parseAmount("amountIn", args.amountIn),
    minOut: parseAmount("minOut", args.minOut),
  };
}

/** The vault as `checkIntent` and the other checks read it, at one height. */
async function snapshot(
  deps: KeelioMcpDeps,
  owner: string,
): Promise<VaultRead & { burnHeight: bigint }> {
  const burnHeight = await deps.chain.burnHeight();
  const read = await readVault(deps.chain, deps.read, owner, { burnHeight });
  return { ...read, burnHeight };
}

async function stateOf(
  deps: KeelioMcpDeps,
  owner: string,
): Promise<VaultState> {
  const state = await snapshot(deps, owner);
  const nowMs = await deps.chain.blockTimeMs();
  return { ...state, nowMs };
}

function intentOf(trade: Trade) {
  return {
    caller: trade.agent,
    adapter: trade.adapter,
    tokenIn: trade.tokenIn,
    tokenOut: trade.tokenOut,
    amountIn: trade.amountIn,
    minOut: trade.minOut,
  };
}

/** The trade as the SDK's swap builders take it: no agent, the sender. */
function swapInput(trade: Trade) {
  return {
    owner: trade.owner,
    adapter: trade.adapter,
    tokenIn: trade.tokenIn,
    tokenOut: trade.tokenOut,
    amountIn: trade.amountIn,
    minOut: trade.minOut,
  };
}

type Check = { ok: true } | Refusal<VaultRuleName>;

/**
 * A check's answer as the tools return it. A size refusal keeps its
 * suggestion, and u126 says a request is needed.
 */
function verdict(c: Check, burnHeight: bigint): Json {
  if (c.ok) return { ok: true, burnHeight: burnHeight.toString() };
  return {
    ok: false,
    rule: c.rule,
    errorCode: c.errorCode,
    message: c.message,
    burnHeight: burnHeight.toString(),
    ...(c.suggestion === undefined
      ? {}
      : { suggestion: toJsonSafe(c.suggestion) }),
    ...(c.rule === "APPROVAL_REQUIRED" ? { requestNeeded: true } : {}),
  };
}

/**
 * The SDK's `tradeWarnings` for the trade against the journal. Advisory: a
 * journal that cannot be read gives `warnings: null` and the reason, and
 * never changes the verdict beside it.
 */
async function warningsFor(
  deps: KeelioMcpDeps,
  trade: Trade,
  burnHeight: bigint,
): Promise<Json> {
  try {
    const events = parseJournal(await deps.chain.vaultEvents());
    const warnings = tradeWarnings(events, {
      owner: trade.owner,
      tokenIn: trade.tokenIn,
      tokenOut: trade.tokenOut,
      amountIn: trade.amountIn,
      burnHeight,
    });
    return { warnings: toJsonSafe(warnings) };
  } catch (e) {
    return {
      warnings: null,
      warningsError: e instanceof Error ? e.message : String(e),
    };
  }
}

function hasAssetName(tx: TxConfig, token: string): boolean {
  const name = Object.hasOwn(tx.assetNames, token)
    ? tx.assetNames[token]
    : undefined;
  return typeof name === "string" && isClarityName(name);
}

async function getVault(deps: KeelioMcpDeps, args: Args): Promise<Json> {
  const owner = parsePrincipal("owner", args.owner, false);
  const {
    vault,
    policy,
    usage,
    balances,
    burnHeight,
    approvalThresholds,
    pendingSwap,
  } = await snapshot(deps, owner);
  const tokens = deps.read.tokens;
  const zero = { maxPerTrade: 0n, maxPerDay: 0n };
  const capsOf = (token: string) => policy.caps[token] ?? zero;
  const totalOf = (token: string) => usage.dayTotals[token] ?? 0n;
  const dayRemaining = Object.fromEntries(
    tokens.map((token) => {
      const { maxPerDay } = capsOf(token);
      const total = totalOf(token);
      return [token, (total >= maxPerDay ? 0n : maxPerDay - total).toString()];
    }),
  );
  return {
    owner,
    burnHeight: burnHeight.toString(),
    agent: vault.agent,
    paused: vault.paused,
    policy: {
      cooldownBlocks: policy.cooldownBlocks.toString(),
      expiresAt: policy.expiresAt.toString(),
      caps: Object.fromEntries(
        tokens.map((token) => {
          const { maxPerTrade, maxPerDay } = capsOf(token);
          return [
            token,
            {
              maxPerTrade: maxPerTrade.toString(),
              maxPerDay: maxPerDay.toString(),
            },
          ];
        }),
      ),
      allowedTokens: [...policy.allowedTokens],
      allowedAdapters: [...policy.allowedAdapters],
    },
    usage: {
      dayTotals: Object.fromEntries(
        tokens.map((token) => [token, totalOf(token).toString()]),
      ),
      lastTradeHeight:
        usage.lastTradeHeight === null
          ? null
          : usage.lastTradeHeight.toString(),
    },
    balances: Object.fromEntries(
      Object.entries(balances).map(([token, b]) => [token, b.toString()]),
    ),
    dayRemaining,
    approvalThresholds: Object.fromEntries(
      tokens.map((token) => {
        const threshold = Object.hasOwn(approvalThresholds, token)
          ? (approvalThresholds[token] ?? null)
          : null;
        return [token, threshold === null ? null : threshold.toString()];
      }),
    ),
    pendingSwap: pendingSwap === null ? null : toJsonSafe(pendingSwap),
  };
}

async function checkTrade(deps: KeelioMcpDeps, args: Args): Promise<Json> {
  const trade = parseTrade(args);
  const state = await stateOf(deps, trade.owner);
  const c = checkIntent(state, intentOf(trade));
  return {
    ...verdict(c, state.burnHeight),
    ...(await warningsFor(deps, trade, state.burnHeight)),
  };
}

/**
 * Runs an SDK builder and turns its `TxBuildError`s into the tools' input
 * errors, naming the field at fault.
 */
function build(deps: KeelioMcpDeps, trade: Trade, make: () => VaultCall): Json {
  try {
    return encodeVaultCall(make()) as unknown as Json;
  } catch (e) {
    if (e instanceof TxBuildError && e.code === "UNKNOWN_ASSET") {
      // The swap builders look up tokenIn first, then tokenOut.
      const field = hasAssetName(deps.tx, trade.tokenIn)
        ? "tokenOut"
        : "tokenIn";
      throw new ToolInputError("UNKNOWN_ASSET", field, e.message);
    }
    if (e instanceof TxBuildError && e.code === "UNKNOWN_ADAPTER")
      throw new ToolInputError("UNKNOWN_ADAPTER", "adapter", e.message);
    if (e instanceof TxBuildError && e.code === "INVALID_AMOUNT") {
      // A post-condition amount must fit u64; amountIn is checked first.
      const field =
        trade.amountIn > MAX_POST_CONDITION_AMOUNT ? "amountIn" : "minOut";
      throw new ToolInputError("INVALID_AMOUNT", field, e.message);
    }
    throw e;
  }
}

async function buildSwap(deps: KeelioMcpDeps, args: Args): Promise<Json> {
  const trade = parseTrade(args);
  // The check runs here on every call; nothing in the input can skip it.
  const state = await stateOf(deps, trade.owner);
  const c = checkIntent(state, intentOf(trade));
  if (!c.ok) return verdict(c, state.burnHeight);
  const call = build(deps, trade, () =>
    buildExecuteSwap(deps.tx, swapInput(trade)),
  );
  return { ...verdict(c, state.burnHeight), call };
}

async function buildSwapRequest(
  deps: KeelioMcpDeps,
  args: Args,
): Promise<Json> {
  const trade = parseTrade(args);
  // As for keelio_build_swap: no input can skip the check.
  const state = await stateOf(deps, trade.owner);
  const c = checkRequest(state, intentOf(trade));
  if (!c.ok) return verdict(c, state.burnHeight);
  const call = build(deps, trade, () =>
    buildRequestSwap(deps.tx, swapInput(trade)),
  );
  return { ...verdict(c, state.burnHeight), call };
}

async function buildCancelRequest(
  deps: KeelioMcpDeps,
  args: Args,
): Promise<Json> {
  const owner = parsePrincipal("owner", args.owner, false);
  const agent = parsePrincipal("agent", args.agent, false);
  const state = await snapshot(deps, owner);
  const c = checkCancelRequest(state, agent);
  if (!c.ok) return verdict(c, state.burnHeight);
  const call = encodeVaultCall(buildCancelSwapRequest(deps.tx, { owner }));
  return { ...verdict(c, state.burnHeight), call };
}

async function sizePositionTool(args: Args): Promise<Json> {
  const input = {
    capital: parseAmount("capital", args.capital),
    riskBps: parseAmount("riskBps", args.riskBps),
    entry: parseAmount("entry", args.entry),
    stop: parseAmount("stop", args.stop),
    lotSize: parseAmount("lotSize", args.lotSize),
  };
  try {
    const { quantity, riskAmount } = sizePosition(input);
    return {
      ok: true,
      quantity: quantity.toString(),
      riskAmount: riskAmount.toString(),
    };
  } catch (e) {
    if (e instanceof SizingError) {
      return { ok: false, code: e.code, message: e.message };
    }
    throw e;
  }
}

async function journal(deps: KeelioMcpDeps, args: Args): Promise<Json> {
  const owner = parsePrincipal("owner", args.owner, false);
  const limit = parseLimit(args.limit);
  const records = await deps.chain.vaultEvents();
  const events = [];
  for (let i = records.length - 1; i >= 0 && events.length < limit; i--) {
    const record = records[i]!;
    const decoded = decodeEvent(record.value);
    if (decoded.owner !== owner) continue;
    events.push({ burnHeight: record.burnHeight.toString(), ...decoded });
  }
  return { owner, events };
}

async function agentHistoryTool(
  deps: KeelioMcpDeps,
  args: Args,
): Promise<Json> {
  const agent = parsePrincipal("agent", args.agent, false);
  const events = parseJournal(await deps.chain.vaultEvents());
  return toJsonSafe(agentHistory(events, agent));
}

async function accountability(deps: KeelioMcpDeps, args: Args): Promise<Json> {
  const owner = parsePrincipal("owner", args.owner, false);
  const limit = parseLimit(args.limit);
  // The whole journal is replayed, so an event's index is its position in
  // the contract's journal whatever the limit.
  const events = parseJournal(await deps.chain.vaultEvents());
  const all = accountabilityRecords(events, { owner });
  const records = all.slice(-limit);
  return {
    owner,
    totalTrades: all.length.toString(),
    records: accountabilityJson(records),
    report: renderAccountabilityReport(records, {
      title: `Keelio accountability record for ${owner}`,
    }),
  };
}

/**
 * An MCP server with the nine Keelio vault tools, over the injected chain.
 * Every call it builds is one the agent sends: it builds none of the
 * owner's (`approve-swap`, `reject-swap`, `set-approval-threshold`).
 */
export function createServer(deps: KeelioMcpDeps): McpServer {
  const server = new McpServer({ name: "keelio", version: "0.0.0" });
  server.registerTool(
    "keelio_get_vault",
    { description: DESCRIPTIONS.keelio_get_vault, inputSchema: vaultShape },
    tool((args: Args) => getVault(deps, args)),
  );
  server.registerTool(
    "keelio_check_trade",
    { description: DESCRIPTIONS.keelio_check_trade, inputSchema: tradeShape },
    tool((args: Args) => checkTrade(deps, args)),
  );
  server.registerTool(
    "keelio_build_swap",
    { description: DESCRIPTIONS.keelio_build_swap, inputSchema: swapShape },
    tool((args: Args) => buildSwap(deps, args)),
  );
  server.registerTool(
    "keelio_build_swap_request",
    {
      description: DESCRIPTIONS.keelio_build_swap_request,
      inputSchema: requestShape,
    },
    tool((args: Args) => buildSwapRequest(deps, args)),
  );
  server.registerTool(
    "keelio_build_cancel_request",
    {
      description: DESCRIPTIONS.keelio_build_cancel_request,
      inputSchema: cancelShape,
    },
    tool((args: Args) => buildCancelRequest(deps, args)),
  );
  server.registerTool(
    "keelio_journal",
    { description: DESCRIPTIONS.keelio_journal, inputSchema: journalShape },
    tool((args: Args) => journal(deps, args)),
  );
  server.registerTool(
    "keelio_agent_history",
    { description: DESCRIPTIONS.keelio_agent_history, inputSchema: agentShape },
    tool((args: Args) => agentHistoryTool(deps, args)),
  );
  server.registerTool(
    "keelio_accountability",
    {
      description: DESCRIPTIONS.keelio_accountability,
      inputSchema: accountabilityShape,
    },
    tool((args: Args) => accountability(deps, args)),
  );
  server.registerTool(
    "keelio_size_position",
    {
      description: DESCRIPTIONS.keelio_size_position,
      inputSchema: sizeShape,
    },
    tool((args: Args) => sizePositionTool(args)),
  );
  return server;
}

/**
 * Serves `createServer(deps)` over stdio. Refuses to start without an
 * injected chain client; it never builds one of its own.
 */
export async function runStdio(deps: KeelioMcpDeps): Promise<McpServer> {
  const chain = deps?.chain as Partial<KeelioChain> | undefined;
  if (
    typeof chain?.callReadOnly !== "function" ||
    typeof chain.burnHeight !== "function" ||
    typeof chain.blockTimeMs !== "function" ||
    typeof chain.vaultEvents !== "function"
  ) {
    throw new Error("keelio-mcp: a chain client must be injected");
  }
  const server = createServer(deps);
  await server.connect(new StdioServerTransport());
  return server;
}
