// The default mode: boots the real simnet in the browser from the repo's own
// manifest and contracts, and adds the controls that exist only in a
// simulation. It makes no network request and loads no wallet code.
import { defaultFileStore, initSimnet } from "@stacks/clarinet-sdk-browser";
import manifest from "../../../Clarinet.toml?raw";
// The browser build of the simnet reads its accounts from Devnet.toml.
import devnetSettings from "../../../settings/Devnet.toml?raw";
import {
  MAX_UINT,
  numberError,
  parseUint,
  type FlowField,
  type FormValues,
} from "./flows.js";
import {
  describeReceipt,
  human,
  oraclePriceWords,
  refusalReason,
} from "./format.js";
import { buildOwnerTools } from "./owner-tools.js";
import {
  EXAMPLE,
  ORACLE_PRICE,
  loadProject,
  startSimnetChain,
  type RequestOutcome,
  type SimulationSession,
  type SwapInput,
  type SwapOutcome,
} from "./simnet-chain.js";
import {
  buildFlows,
  byId,
  el,
  errors,
  latestBurnHeight,
  latestRead,
  makeControl,
  nextFrame,
  option,
  receiptNodes,
  refresh,
  setError,
  showLines,
  status,
  valuesOf,
  type Control,
} from "./ui.js";

const contracts = import.meta.glob<string>("../../../contracts/**/*.clar", {
  query: "?raw",
  import: "default",
  eager: true,
});

function initialValue(session: SimulationSession, key: string): string {
  switch (key) {
    case "deposit.amount":
      return EXAMPLE.deposit.toString();
    case "withdraw.amount":
      return "10000000";
    case "set-agent.agent":
      return session.agent;
    case "set-policy.cooldownBlocks":
      return EXAMPLE.cooldownBlocks.toString();
    case "set-policy.expiresAt":
      return (latestBurnHeight() + EXAMPLE.policyBlocks).toString();
    case "set-token-caps.maxPerTrade":
      return EXAMPLE.sbtcMaxPerTrade.toString();
    case "set-token-caps.maxPerDay":
      return EXAMPLE.sbtcMaxPerDay.toString();
    case "set-price-bounds.maxSlippageBps":
      return EXAMPLE.maxSlippageBps.toString();
    case "set-price-bounds.maxPriceAge":
      return EXAMPLE.maxPriceAgeMs.toString();
    case "set-approval-threshold.threshold":
      return EXAMPLE.approvalThreshold.toString();
    default:
      return "";
  }
}

// ---- simulation controls --------------------------------------------------

interface SimForm {
  card: HTMLElement;
  controls: Control[];
  button: HTMLButtonElement;
  result: HTMLElement;
}

function simForm(
  session: SimulationSession,
  id: string,
  title: string,
  about: string,
  buttonText: string,
  fields: readonly (FlowField & { initial: string })[],
  extra: readonly HTMLElement[],
  run: (values: Record<string, bigint>, texts: FormValues) => Promise<Node[]>,
): SimForm {
  const made = fields.map((field) =>
    makeControl(session, id, field, field.initial),
  );
  const controls = made.map((m) => m.control);
  const titleId = `${id}-title`;
  const button = el("button", { type: "submit" }, [buttonText]);
  const result = el("div", { class: "result", role: "status" });
  const form = el("form", { novalidate: "", "aria-labelledby": titleId }, [
    ...extra,
    ...made.map((m) => m.node),
    button,
  ]);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (button.disabled) return;
    const numbers: Record<string, bigint> = {};
    let firstInvalid: Control | null = null;
    for (const c of controls) {
      const n = parseUint(
        c.input.value,
        c.field.min ?? 0n,
        c.field.max ?? MAX_UINT,
      );
      setError(c, n === null ? numberError(c.field) : null);
      if (n === null) firstInvalid ??= c;
      else numbers[c.field.name] = n;
    }
    if (firstInvalid !== null) {
      firstInvalid.input.focus();
      showLines(result, ["Not run: fix the marked field first."]);
      return;
    }
    button.disabled = true;
    void (async () => {
      try {
        await nextFrame();
        result.replaceChildren(...(await run(numbers, valuesOf(controls))));
        await refresh(session);
      } catch (error) {
        showLines(result, [`This could not run: ${String(error)}`]);
      } finally {
        button.disabled = false;
      }
    })();
  });
  const card = el("div", { class: "card sim" }, [
    el("h3", { id: titleId }, [title]),
    el("p", {}, [about]),
    form,
    result,
  ]);
  return { card, controls, button, result };
}

function swapNodes(
  session: SimulationSession,
  ask: SwapInput,
  outcome: SwapOutcome | RequestOutcome,
  checkName: "checkIntent" | "checkRequest" = "checkIntent",
): Node[] {
  const check = outcome.check;
  const predicted = check.ok
    ? `The SDK's ${checkName} predicted: ok, no policy rule refuses.`
    : `The SDK's ${checkName} predicted a refusal: ${check.rule} (u${check.errorCode}), ${check.message}.`;
  if ("buildError" in outcome) {
    return [
      el("p", { class: "verdict refused" }, ["Not sent"]),
      el("p", { class: "reason" }, [
        `The SDK refused to build the call: ${outcome.buildError}.`,
      ]),
      el("p", { class: "detail" }, [predicted]),
    ];
  }
  const { receipt } = outcome;
  const read = latestRead();
  const reason =
    read !== null &&
    receipt.status === "refused" &&
    receipt.result.type === "err" &&
    receipt.result.value.type === "uint"
      ? refusalReason(
          BigInt(receipt.result.value.value),
          ask,
          read,
          session.config,
        )
      : null;
  return [
    ...receiptNodes(describeReceipt(receipt, errors), "", reason),
    ...(checkName === "checkRequest" && receipt.status === "ok"
      ? [
          el("p", { class: "detail" }, [
            'The request is stored and nothing moved. As the owner, approve or reject it under "The agent asks for your approval", above the vault.',
          ]),
        ]
      : []),
    el("p", { class: "detail" }, [predicted]),
  ];
}

function buildSimulation(session: SimulationSession): void {
  const [sbtc, usd] = session.config.tokens;
  if (sbtc === undefined || usd === undefined) throw new Error("no tokens");

  const setup = simForm(
    session,
    "example",
    "Run the example setup",
    "Sends nine owner calls in a row, without the review step: deposit 0.5 mock sBTC, name the agent, set caps for both tokens, set the policy for 1000 burn blocks, allow both tokens and mock-dex, and set the price bounds.",
    "Run the example setup",
    [],
    [],
    async () => {
      const steps = await session.runExampleSetup();
      return steps.flatMap((step) =>
        receiptNodes(
          describeReceipt(step.receipt, errors),
          `${step.call.functionName}: `,
        ),
      );
    },
  );

  const direction = el("select", { id: "trade-direction", name: "direction" }, [
    option("sell", `Sell ${sbtc.name} for ${usd.name}`),
    option("buy", `Sell ${usd.name} for ${sbtc.name}`),
  ]);
  const callKind = el("select", { id: "trade-call", name: "call" }, [
    option("execute", "execute-swap: trade now, alone"),
    option("request", "request-swap: ask the owner to approve the trade"),
  ]);
  const amountMax = 2n ** 64n - 1n;
  const trade = simForm(
    session,
    "trade",
    "Simulate an agent trade",
    "This is the agent acting, not you: the agent account calls execute-swap on mock-dex, or request-swap for a trade above your approval threshold. The call is sent even when the SDK predicts a refusal, so you see the contract refuse it.",
    "Trade as the agent",
    [
      {
        name: "amountIn",
        label: "Amount in, in base units of the token sold",
        kind: "amount",
        min: 1n,
        max: amountMax,
        initial: EXAMPLE.sbtcMaxPerTrade.toString(),
      },
      {
        name: "minOut",
        label: "Minimum out, in base units of the token bought",
        kind: "amount",
        max: amountMax,
        initial: "9000000000",
      },
    ],
    [
      el("div", { class: "field" }, [
        el("label", { for: "trade-call" }, ["The agent's call"]),
        callKind,
      ]),
      el("div", { class: "field" }, [
        el("label", { for: "trade-direction" }, ["Direction"]),
        direction,
      ]),
    ],
    async (n) => {
      const selling = direction.value === "sell";
      const ask: SwapInput = {
        tokenIn: selling ? sbtc.id : usd.id,
        tokenOut: selling ? usd.id : sbtc.id,
        amountIn: n.amountIn!,
        minOut: n.minOut!,
      };
      return callKind.value === "request"
        ? swapNodes(
            session,
            ask,
            await session.agentRequest(ask),
            "checkRequest",
          )
        : swapNodes(session, ask, await session.agentSwap(ask));
    },
  );

  const cancel = simForm(
    session,
    "cancel-request",
    "Withdraw the agent's request",
    "The agent calls cancel-swap-request to take back the request it made. Only the agent that made it can.",
    "Withdraw as the agent",
    [],
    [],
    async () => {
      const outcome = await session.agentCancelRequest();
      return [
        ...receiptNodes(describeReceipt(outcome.receipt, errors)),
        el("p", { class: "detail" }, [
          outcome.check.ok
            ? "The SDK's checkCancelRequest predicted: ok."
            : `The SDK's checkCancelRequest predicted a refusal: ${outcome.check.rule} (u${outcome.check.errorCode}), ${outcome.check.message}.`,
        ]),
      ];
    },
  );
  const tradeHints = () => {
    const selling = direction.value === "sell";
    const tokens = {
      amountIn: selling ? sbtc : usd,
      minOut: selling ? usd : sbtc,
    };
    for (const c of trade.controls) {
      const n = parseUint(c.input.value, c.field.min ?? 0n, amountMax);
      const token = tokens[c.field.name as "amountIn" | "minOut"];
      c.hint.textContent = n === null ? "" : `= ${human(token, n)}`;
    }
  };
  direction.addEventListener("change", tradeHints);
  for (const c of trade.controls) c.input.addEventListener("input", tradeHints);
  tradeHints();

  const blocks = simForm(
    session,
    "blocks",
    "Advance the burn chain",
    "Mines empty burn blocks, so you can watch a cooldown pass, the day window move and the policy expire. The simnet's clock moves about 10 minutes a block, so the mock oracle's price also ages.",
    "Mine burn blocks",
    [
      {
        name: "count",
        label: "Burn blocks to mine",
        kind: "blocks",
        min: 1n,
        max: 2000n,
        initial: "6",
      },
    ],
    [],
    async (n) => {
      const height = await session.advanceBurnBlocks(Number(n.count!));
      return [el("p", {}, [`Done. The burn height is now ${height}.`])];
    },
  );

  const oracle = simForm(
    session,
    "oracle",
    "Set the mock oracle price",
    "Publishes a BTC/USD price on the mock oracle, timestamped now. Use it after mining blocks to make the price fresh again.",
    "Set the price",
    [
      {
        name: "price",
        label: "BTC/USD price, with 8 decimals",
        kind: "amount",
        initial: ORACLE_PRICE.toString(),
      },
    ],
    [],
    async (n) =>
      receiptNodes(
        describeReceipt(await session.setOraclePrice(n.price!), errors),
      ),
  );
  const oracleControl = oracle.controls[0]!;
  const oracleHint = () => {
    const n = parseUint(oracleControl.input.value, 0n, MAX_UINT);
    oracleControl.hint.textContent =
      n === null ? "" : `= ${oraclePriceWords(n)}`;
  };
  oracleControl.input.addEventListener("input", oracleHint);
  oracleHint();

  trade.card.classList.add("lead");
  byId("sim", HTMLDivElement).replaceChildren(
    trade.card,
    el("div", { class: "grid" }, [
      setup.card,
      blocks.card,
      oracle.card,
      cancel.card,
    ]),
  );
}

// ---- boot -----------------------------------------------------------------

async function boot(): Promise<SimulationSession> {
  const files: Record<string, string> = {
    "Clarinet.toml": manifest,
    "settings/Devnet.toml": devnetSettings,
  };
  for (const [path, content] of Object.entries(contracts)) {
    files[path.replace(/^(\.\.\/)+/, "")] = content;
  }
  loadProject(defaultFileStore, files);
  const simnet = await initSimnet();
  // The wasm calls block the main thread, so let the status paint first.
  await nextFrame();
  return startSimnetChain(simnet);
}

export async function startSimulationMode(): Promise<void> {
  status.textContent = "Starting the simnet…";
  try {
    const session = await boot();
    await refresh(session);
    buildFlows(session, (key) => initialValue(session, key));
    buildOwnerTools(session);
    buildSimulation(session);
    await refresh(session);
    status.textContent =
      "Simnet ready. You act as the owner; a second simnet account plays the agent.";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    status.textContent = `The simnet could not start: ${message}`;
  }
}
