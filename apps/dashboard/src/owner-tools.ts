// The owner's tools beyond the single-call forms, wired to the page for both
// modes: the pending approval request, policy setup from a sentence, an
// agent's history before it is named, the accountability record, and leaving
// in one action. The logic is in the modules imported below; this file only
// puts it on the page. Text is set with textContent only.
import {
  TxBuildError,
  type VaultCall,
} from "../../../packages/sdk/src/build-tx.js";
import { accountabilityView } from "./accountability.js";
import { agentHistoryView, type HistoryView } from "./agent-history.js";
import {
  approvalDecision,
  approveCall,
  pendingView,
  rejectCall,
  type PredictedRefusal,
} from "./approval.js";
import type { PendingSwap } from "../../../packages/sdk/src/vault.js";
import type { ChainSession } from "./chain.js";
import { describeReceipt, progressWords } from "./format.js";
import {
  leavePlan,
  runLeave,
  type LeavePlan,
  type LeaveStepState,
} from "./leave.js";
import { contextOf, proposePolicy, type Proposal } from "./plain-policy.js";
import {
  byId,
  el,
  errors,
  factList,
  fillFlow,
  flowHandle,
  latestJournal,
  latestRead,
  nextFrame,
  onRefresh,
  receiptNodes,
  refresh,
  reviewAndSubmit,
  reviewCalls,
  saveFile,
  setReviewNotes,
  showLines,
} from "./ui.js";

const words = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const paragraphs = (lines: readonly string[]): HTMLElement[] =>
  lines.map((line) => el("p", {}, [line]));

const list = (lines: readonly string[]): HTMLElement =>
  el(
    "ul",
    {},
    lines.map((line) => el("li", {}, [line])),
  );

// ---- the pending request ----------------------------------------------------

function refusalNodes(refusal: PredictedRefusal): HTMLElement[] {
  return [
    el("p", { class: "verdict refused" }, [refusal.headline]),
    ...(refusal.reason === null
      ? []
      : [el("p", { class: "reason" }, [refusal.reason])]),
    el("p", { class: "returned" }, [
      el("code", { class: "tag refused" }, [
        el("b", {}, [`(err ${refusal.code})`]),
        ...(refusal.name === null ? [] : [` ${refusal.name}`]),
      ]),
    ]),
    el("p", { class: "detail" }, [
      "Predicted by the SDK's checkApproval from the vault as it is now. Nothing was sent, so nothing was refused or charged. You can change what refuses it and approve while the request lasts, or reject it.",
    ]),
  ];
}

function buildPending(session: ChainSession): void {
  const section = byId("pending", HTMLElement);
  const card = byId("pending-card", HTMLDivElement);
  const body = el("div", { "aria-live": "polite" });
  const result = el("div", { class: "result", role: "status" });
  card.replaceChildren(body, result);
  let busy = false;
  /** The request the card last drew, so a new one starts with a clean result. */
  let drawn: string | null = null;

  /** Reject: removes whatever request is stored. It takes no argument. */
  const reject = async (): Promise<void> => {
    // Decided on a fresh read, not on what the page last drew.
    const view = pendingView(await session.read(), session.config, errors);
    if (view === null) {
      showLines(result, [
        "There is no request waiting any more. Nothing was sent.",
      ]);
      await refresh(session);
      return;
    }
    await reviewAndSubmit(session, rejectCall(session.config), result, {
      intro: [
        "Nothing has been submitted yet. This removes the agent's request without running it. No token moves.",
      ],
      notes: [el("h3", {}, ["The request"]), ...paragraphs(view.lines)],
    });
  };

  /**
   * Approve, for `shown`: the request drawn above the button that was
   * pressed. A fresh read can only stop the approval. If it holds another
   * request, nothing is sent and the card is redrawn with that one, whose
   * own Approve button the owner must press after reading it.
   */
  const approve = async (shown: PendingSwap): Promise<void> => {
    const decision = approvalDecision(
      shown,
      await session.read(),
      session.config,
      errors,
    );
    switch (decision.kind) {
      case "gone":
        showLines(result, [
          "There is no request waiting any more. Nothing was sent.",
        ]);
        await refresh(session);
        return;
      case "changed":
        result.replaceChildren(
          el("p", { class: "verdict refused" }, ["Not sent"]),
          ...decision.lines.map((line) => el("p", { class: "reason" }, [line])),
        );
        await refresh(session);
        return;
      case "expired":
        showLines(result, [
          "The request has expired, so it can no longer be approved. Nothing was sent. Reject it to clear it.",
        ]);
        await refresh(session);
        return;
      case "refused":
        // The request's own lines, redrawn by the refresh, say why in full.
        result.replaceChildren(
          el("p", { class: "verdict refused" }, ["Not sent"]),
          el("p", { class: "reason" }, [
            `${decision.refusal.headline} (${decision.refusal.code}).`,
          ]),
          el("p", { class: "detail" }, [
            "The SDK's checkApproval predicts the contract would refuse this approval, so the call was not sent.",
          ]),
        );
        await refresh(session);
        return;
      case "send": {
        let call: VaultCall;
        try {
          call = approveCall(session.config, shown);
        } catch (error) {
          if (!(error instanceof TxBuildError)) throw error;
          showLines(result, [
            `Not sent. The SDK refused to build this call (${error.code}): ${error.message}.`,
          ]);
          return;
        }
        await reviewAndSubmit(session, call, result, {
          intro: [
            `Nothing has been submitted yet. This approves exactly the request you were shown, the one the agent made at burn height ${shown.requestedAt}: the same adapter, tokens, amount and minimum. If the agent replaces it before your call arrives, even with the same trade, the vault refuses the call. The vault runs every check again when the call arrives.`,
          ],
          notes: [
            el("h3", {}, ["The request"]),
            ...paragraphs(decision.view.lines),
          ],
        });
      }
    }
  };

  const act = async (run: () => Promise<void>): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      await nextFrame();
      await run();
    } catch (error) {
      showLines(result, [`This could not run: ${words(error)}`]);
    } finally {
      busy = false;
    }
  };

  const draw = (): void => {
    const read = latestRead();
    const view =
      read === null ? null : pendingView(read, session.config, errors);
    const key =
      view === null
        ? null
        : `${view.pending.requestedAt}:${view.pending.tokenIn}:${view.pending.amountIn}:${view.pending.minOut}`;
    // What happened to the last request does not belong under a new one.
    if (key !== null && drawn === null && !busy) result.replaceChildren();
    drawn = key;
    section.hidden = view === null && result.childElementCount === 0;
    if (view === null) {
      body.replaceChildren(el("p", {}, ["No request is waiting now."]));
      return;
    }
    const approveButton = el("button", { type: "button", class: "go" }, [
      "Approve this trade",
    ]);
    const rejectButton = el("button", { type: "button", class: "secondary" }, [
      view.expired ? "Reject, to clear it" : "Reject this request",
    ]);
    // Each button approves the request drawn with it, and no other.
    const shown = view.pending;
    approveButton.addEventListener(
      "click",
      () => void act(() => approve(shown)),
    );
    rejectButton.addEventListener("click", () => void act(reject));
    body.replaceChildren(
      el("h3", { class: view.expired ? "expired" : undefined }, [
        view.headline,
      ]),
      ...paragraphs(view.lines),
      ...(view.refusal === null
        ? []
        : [el("div", { class: "result" }, refusalNodes(view.refusal))]),
      el(
        "div",
        { class: "row" },
        view.expired ? [rejectButton] : [approveButton, rejectButton],
      ),
    );
  };
  onRefresh(draw);
  draw();
}

// ---- policy from a sentence -------------------------------------------------

function proposalTable(proposal: Proposal): HTMLElement {
  const head = ["Setting", "Exact value", "In human units", "Where it is from"];
  return el("table", { class: "proposal" }, [
    el("caption", {}, ["What would be set, as exact values"]),
    el("thead", {}, [
      el(
        "tr",
        {},
        head.map((text) => el("th", { scope: "col" }, [text])),
      ),
    ]),
    el(
      "tbody",
      {},
      proposal.rows.map((row) =>
        el(
          "tr",
          { class: row.source === "from your sentence" ? "stated" : undefined },
          [
            el("th", { scope: "row" }, [row.setting]),
            el("td", {}, [el("code", {}, [row.exact])]),
            el("td", {}, [row.human]),
            el("td", {}, [row.source]),
          ],
        ),
      ),
    ),
  ]);
}

function buildPlainPolicy(session: ChainSession): void {
  const card = byId("plain-policy", HTMLDivElement);
  const input = el("textarea", {
    id: "plain-sentence",
    name: "sentence",
    rows: "3",
    spellcheck: "false",
    "aria-describedby": "plain-sentence-hint",
    placeholder:
      "let the agent trade up to 0.01 BTC per trade and 0.05 BTC per day, wait 3 blocks between trades, stop after 2 weeks, max slippage 1%, ask me above 0.005 BTC",
  });
  const button = el("button", { type: "submit" }, ["Read my sentence"]);
  const output = el("div", { class: "result", role: "status" });
  const form = el(
    "form",
    { novalidate: "", "aria-labelledby": "plain-policy-title" },
    [
      el("div", { class: "field" }, [
        el("label", { for: "plain-sentence" }, ["Your limits, in a sentence"]),
        input,
        el("p", { id: "plain-sentence-hint", class: "hint" }, [
          `Amounts need a unit: BTC, sats${session.config.tokens
            .filter((t) => t.id !== session.config.read.sbtcToken)
            .map((t) => ` or ${t.symbol}`)
            .join(
              "",
            )}. Times are turned into burn blocks at 10 minutes a block.`,
        ]),
      ]),
      button,
    ],
  );

  const accept = (proposal: Proposal): void => {
    // Later forms of the same kind overwrite earlier ones, so each step's
    // button fills its own form again before showing it.
    for (const flow of [...proposal.flows].reverse()) {
      fillFlow(flow.id, flow.values);
    }
    const steps = el(
      "ol",
      { class: "steps" },
      proposal.flows.map((flow) => {
        const open = el("button", { type: "button", class: "secondary" }, [
          "Fill in and open this form",
        ]);
        open.addEventListener("click", () => fillFlow(flow.id, flow.values));
        return el("li", {}, [el("span", {}, [flow.title]), open]);
      }),
    );
    output.append(
      el("p", { class: "verdict ok" }, ["Forms filled in. Nothing was sent."]),
      el("p", {}, [
        `Review and sign ${proposal.flows.length === 1 ? "this form" : `these ${proposal.flows.length} forms, one at a time`}. Each is an ordinary call with its own review step.`,
      ]),
      steps,
    );
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const read = latestRead();
    if (read === null) {
      showLines(output, ["The vault has not been read yet. Try again."]);
      return;
    }
    const proposal = proposePolicy(
      input.value,
      contextOf(session.config, read),
    );
    const unclear =
      proposal.notUnderstood.length === 0
        ? []
        : [
            el("h4", {}, ["Not understood, and not used"]),
            list(proposal.notUnderstood),
          ];
    if (!proposal.ok) {
      output.replaceChildren(
        el("p", { class: "verdict refused" }, [
          "Nothing was proposed, and nothing was sent",
        ]),
        list(proposal.errors),
        ...unclear,
      );
      return;
    }
    const acceptButton = el("button", { type: "button", class: "go" }, [
      proposal.flows.length === 1
        ? "Accept: fill in the form"
        : `Accept: fill in the ${proposal.flows.length} forms`,
    ]);
    acceptButton.addEventListener("click", () => {
      acceptButton.disabled = true;
      accept(proposal);
    });
    output.replaceChildren(
      el("p", { class: "verdict ok" }, ["Read. Nothing has been sent."]),
      ...unclear,
      proposalTable(proposal),
      el("h4", {}, ["The most a trade can give up"]),
      ...paragraphs(proposal.worstCase),
      ...(proposal.notes.length === 0
        ? []
        : [el("h4", {}, ["Worth knowing"]), list(proposal.notes)]),
      el("p", {}, [
        "Accepting only fills in the ordinary forms below with these exact values. You then review and sign each one; the sentence itself is never sent.",
      ]),
      acceptButton,
    );
  });

  card.replaceChildren(
    el("span", { class: "label" }, ["Start here, if you like"]),
    el("h3", { id: "plain-policy-title" }, ["Describe your limits in words"]),
    el("p", {}, [
      "A fixed set of rules reads the sentence on this page: no AI model and no network. You get the exact values to check before anything is filled in, and anything it cannot read is listed.",
    ]),
    form,
    output,
  );
}

// ---- an agent's history -----------------------------------------------------

function historyNodes(view: HistoryView | null): HTMLElement[] {
  if (view === null) {
    return [
      el("p", { class: "hint" }, [
        "Enter a valid Stacks address or contract id to see what the journal says about it.",
      ]),
    ];
  }
  return [
    el("p", { class: view.known ? "history-head" : "history-head none" }, [
      view.headline,
    ]),
    ...(view.facts.length === 0 ? [] : [factList(view.facts)]),
    el("p", { class: "hint" }, [view.scope]),
    el("p", { class: "caution" }, [view.caution]),
  ];
}

function buildAgentHistory(session: ChainSession): void {
  const handle = flowHandle("set-agent");
  const input = handle.controls[0]?.input;
  if (input === undefined) throw new Error("set-agent has no agent field");
  const view = (text: string): HistoryView | null =>
    agentHistoryView(
      latestJournal(),
      text,
      session.config,
      session.journalScope,
    );
  const region = el("div", {
    class: "history",
    role: "status",
    "aria-label": "What the journal says about this principal",
  });
  const draw = (): void => {
    region.replaceChildren(
      el("h5", {}, ["What the journal says about this principal"]),
      ...historyNodes(view(input.value)),
    );
  };
  handle.slot.append(region);
  input.addEventListener("input", draw);
  onRefresh(draw);
  draw();
  setReviewNotes("set-agent", (values) => [
    el("h3", {}, ["What the journal says about this principal"]),
    ...historyNodes(view(values.agent ?? "")),
  ]);
}

// ---- the accountability record ----------------------------------------------

function buildAccountability(session: ChainSession): void {
  const card = byId("accountability", HTMLDivElement);
  const view = () =>
    accountabilityView(
      latestJournal(),
      session.config,
      session.owner,
      session.kind,
    );
  const summary = el("p", { role: "status" });
  const rows = el("ol", { class: "trades" });
  const note = el("p", { class: "hint", role: "status" });
  const save = (which: "markdown" | "json", text: string): HTMLElement => {
    const button = el("button", { type: "button", class: "secondary" }, [text]);
    button.addEventListener("click", () => {
      try {
        const file = view()[which];
        saveFile(file.name, file.type, file.text);
        note.textContent = `Saved ${file.name}. The file was made in this page; nothing was sent anywhere.`;
      } catch (error) {
        note.textContent = `The file could not be saved: ${words(error)}`;
      }
    });
    return button;
  };
  const draw = (): void => {
    const current = view();
    summary.textContent = current.summary;
    rows.replaceChildren(
      ...current.rows.map((row) =>
        el("li", { class: row.issues.length > 0 ? "issue" : undefined }, [
          el("strong", {}, [row.title]),
          el("p", {}, [row.who]),
          el("p", {}, [row.what]),
          el("p", { class: "label" }, ["Limits in force when it ran"]),
          list(row.limits),
          ...(row.issues.length === 0
            ? [
                el("p", { class: "hint" }, [
                  "Replay check: every limit was found in the journal, and the trade is inside each one.",
                ]),
              ]
            : [
                el("p", { class: "error" }, [
                  "Replay check: the journal read does not account for this trade.",
                ]),
                list(row.issues),
              ]),
        ]),
      ),
    );
  };
  card.replaceChildren(
    el("h3", { id: "accountability-title" }, ["Accountability record"]),
    el("p", {}, [
      "Every trade made for your vault, with who sent it and the limits that were in force, rebuilt by replaying the journal. Save it to show what the agent was and was not allowed to do.",
    ]),
    summary,
    el("div", { class: "row" }, [
      save("markdown", "Download the report (Markdown)"),
      save("json", "Download the data (JSON)"),
    ]),
    note,
    rows,
  );
  onRefresh(draw);
  draw();
}

// ---- leaving ----------------------------------------------------------------

function stepWords(session: ChainSession, state: LeaveStepState): string {
  switch (state.status) {
    case "sending":
      return session.kind === "simulation"
        ? "Sending…"
        : "Waiting for your wallet…";
    case "waiting":
      return progressWords(state.progress);
    case "done":
      return "Done.";
    case "stopped":
      return `${describeReceipt(state.receipt, errors, session.kind).headline}.`;
    case "failed":
      return `Could not run: ${state.message}`;
  }
}

function buildLeave(session: ChainSession): void {
  const card = byId("leave", HTMLDivElement);
  const plan = el("div", { class: "leave-plan" });
  const button = el("button", { type: "button", class: "go dark" }, [
    "Pause the agent and withdraw everything",
  ]);
  const result = el("div", { class: "result", role: "status" });

  const planOf = (withPause = true): LeavePlan | null => {
    const read = latestRead();
    return read === null
      ? null
      : leavePlan(session.config, read, session.kind, withPause);
  };

  const drawPlan = (): void => {
    let current: LeavePlan | null;
    try {
      current = planOf();
    } catch (error) {
      plan.replaceChildren(
        el("p", { class: "error" }, [
          `The steps could not be built: ${words(error)}`,
        ]),
      );
      return;
    }
    if (current === null) return;
    plan.replaceChildren(
      el("p", {}, [current.summary]),
      el(
        "ol",
        {},
        current.steps.map((step) => el("li", {}, [step.title])),
      ),
      el("p", { class: "hint" }, [`This takes ${current.signatures}.`]),
    );
  };

  /** Reviews `current`, sends it, and shows each step as it goes. */
  const run = async (current: LeavePlan, again: boolean): Promise<void> => {
    const count = current.steps.length;
    const confirmed = await reviewCalls(
      session,
      current.steps.map((step, i) => ({
        heading: `Step ${i + 1} of ${count}: ${step.title}`,
        call: step.call,
      })),
      {
        title: again
          ? "Review: withdraw everything"
          : "Review: pause the agent and withdraw everything",
        intro: [
          `Nothing has been submitted yet. ${current.summary} This takes ${current.signatures}. The steps are sent in this order, and the rest are not sent if one is refused.`,
        ],
        confirm:
          session.kind === "simulation"
            ? {
                button: `Confirm and submit ${count === 1 ? "the call" : `all ${count} calls`} to the simnet`,
                about:
                  "Confirm runs these calls on the simnet in this page, one after another, each with its post-conditions enforced. Nothing is signed or broadcast.",
              }
            : {
                button: `Confirm and open the wallet (${count === 1 ? "1 signature" : `${count} signatures`})`,
                about:
                  "Confirm hands these unsigned calls to your wallet one at a time, each with its post-conditions, in Deny mode. Each needs its own approval in the wallet, and the next is handed over only once the one before is in a block. This page holds no key.",
              },
      },
    );
    if (!confirmed) {
      result.append(el("p", {}, ["Cancelled. Nothing more was submitted."]));
      return;
    }
    const items = current.steps.map((step) => {
      const state = el("span", { class: "state" }, ["Not sent yet."]);
      return { state, node: el("li", {}, [step.title, el("br"), state]) };
    });
    result.append(
      el(
        "ol",
        { class: "steps" },
        items.map((item) => item.node),
      ),
    );
    await nextFrame();
    const outcome = await runLeave(session, current, (index, state) => {
      const item = items[index]!;
      item.state.textContent = stepWords(session, state);
      item.node.className = state.status;
    });
    switch (outcome.status) {
      case "done":
        result.append(
          el("p", { class: "verdict ok" }, [
            "Done: the agent is paused and everything is in your account",
          ]),
        );
        return;
      case "stopped":
        result.append(
          ...receiptNodes(
            describeReceipt(outcome.receipt, errors, session.kind),
            `Stopped at step ${outcome.at + 1}. `,
          ),
          el("p", { class: "detail" }, [
            outcome.at + 1 < count
              ? "The later steps were not sent. Read the vault below, then run this again for what is left."
              : "Read the vault below, then run this again for what is left.",
          ]),
        );
        return;
      case "failed":
        result.append(
          el("p", { class: "verdict refused" }, [
            `Stopped at step ${outcome.at + 1}`,
          ]),
          el("p", { class: "reason" }, [outcome.message]),
          el("p", { class: "detail" }, [
            "The later steps were not sent. Read the vault below, then run this again for what is left.",
          ]),
        );
        return;
      case "changed":
        result.append(
          el("p", { class: "verdict aborted" }, [
            "The agent is paused. The balances changed first, so review the withdrawals again",
          ]),
          el("p", { class: "reason" }, [
            "The agent traded before the pause took effect, so the vault no longer holds the amounts you reviewed. No withdrawal was sent. The next review shows the amounts as they are now.",
          ]),
        );
        await refresh(session);
        await run(outcome.plan, true);
        return;
    }
  };

  button.addEventListener("click", () => {
    if (button.disabled) return;
    button.disabled = true;
    result.replaceChildren();
    void (async () => {
      try {
        await refresh(session);
        const current = planOf();
        if (current === null) throw new Error("the vault has not been read");
        await run(current, false);
      } catch (error) {
        result.append(el("p", {}, [`This could not run: ${words(error)}`]));
      } finally {
        button.disabled = false;
        try {
          await refresh(session);
        } catch (error) {
          result.append(
            el("p", {}, [`The vault could not be read again: ${words(error)}`]),
          );
        }
      }
    })();
  });

  card.replaceChildren(
    el("span", { class: "label" }, ["Leaving"]),
    el("h3", { id: "leave-title" }, [
      "Pause the agent and withdraw everything",
    ]),
    el("p", {}, [
      "One action to stop the agent and take every token back to your account. You review every step first. Only you can do this, and it works whatever the agent is doing.",
    ]),
    plan,
    button,
    result,
  );
  onRefresh(drawPlan);
  drawPlan();

  const quick = el("button", { type: "button", class: "go dark" }, [
    "Leave: pause and withdraw everything",
  ]);
  quick.addEventListener("click", () => {
    card.scrollIntoView({ block: "center" });
    button.focus({ preventScroll: true });
  });
  byId("quick", HTMLDivElement).append(quick);
}

/**
 * Builds the owner's tools on the page. Call it once, after `buildFlows` and
 * the first `refresh`.
 */
export function buildOwnerTools(session: ChainSession): void {
  buildPending(session);
  buildPlainPolicy(session);
  buildAgentHistory(session);
  buildAccountability(session);
  buildLeave(session);
}
