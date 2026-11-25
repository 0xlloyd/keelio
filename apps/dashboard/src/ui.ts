// The owner dashboard's page code, shared by both modes: the forms, the
// review step, the vault panel and the journal, wired to a `ChainSession`
// and to nothing else. Text is set with textContent only.
import errorsDoc from "../../../docs/errors.md?raw";
import type { VaultCall } from "../../../packages/sdk/src/build-tx.js";
import type { ChainRead, ChainSession, JournalRecord } from "./chain.js";
import {
  FLOWS,
  fieldHint,
  prepareCall,
  type Flow,
  type FlowField,
  type FlowId,
  type FormValues,
} from "./flows.js";
import {
  blocksAsTime,
  capUseWords,
  compact,
  describeReceipt,
  human,
  parseErrorTable,
  progressWords,
  thresholdWords,
  type ReceiptText,
} from "./format.js";
import { journalEntries, TRADE_EVENTS } from "./journal.js";
import { vaultPanel, vaultSummary, type TokenView } from "./panel.js";
import { reviewCall } from "./review.js";

export const errors = parseErrorTable(errorsDoc);

export function byId<T extends HTMLElement>(id: string, type: new () => T): T {
  const node = document.getElementById(id);
  if (!(node instanceof type)) throw new Error(`missing #${id}`);
  return node;
}

type Child = Node | string;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, string>> = {},
  children: readonly Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value !== undefined) node.setAttribute(name, value);
  }
  node.append(...children);
  return node;
}

export const status = byId("status", HTMLParagraphElement);
const dialog = byId("review", HTMLDialogElement);
const reviewTitle = byId("review-title", HTMLHeadingElement);
const reviewBody = byId("review-body", HTMLDivElement);
const confirmButton = byId("review-confirm", HTMLButtonElement);
const cancelButton = byId("review-cancel", HTMLButtonElement);

/** The latest chain read, for hints and the review step. */
let latest: ChainRead | null = null;
/** The journal as of the latest read, oldest first. */
let journal: readonly JournalRecord[] = [];
const refreshers: (() => void)[] = [];

/** Runs `run` after every chain read, once the panels are redrawn. */
export function onRefresh(run: () => void): void {
  refreshers.push(run);
}

/** The journal as of the latest read, oldest first. */
export function latestJournal(): readonly JournalRecord[] {
  return journal;
}

/** The latest chain read, or null before the first one. */
export function latestRead(): ChainRead | null {
  return latest;
}

/** The burn height of the latest read, or 0 before the first one. */
export function latestBurnHeight(): bigint {
  return latest?.burnHeight ?? 0n;
}

/**
 * Lets the browser paint before a wasm call blocks the main thread. A hidden
 * tab gets no animation frames, so a timer ends the wait there.
 */
export const nextFrame = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
    setTimeout(resolve, 200);
  });

// ---- fields ---------------------------------------------------------------

export interface Control {
  field: FlowField;
  input: HTMLInputElement | HTMLSelectElement;
  hint: HTMLParagraphElement;
  error: HTMLParagraphElement;
}

export function setError(control: Control, message: string | null): void {
  const { input, hint, error } = control;
  if (message === null) {
    input.removeAttribute("aria-invalid");
    input.setAttribute("aria-describedby", hint.id);
    error.textContent = "";
    error.hidden = true;
  } else {
    input.setAttribute("aria-invalid", "true");
    input.setAttribute("aria-describedby", `${hint.id} ${error.id}`);
    error.textContent = message;
    error.hidden = false;
  }
}

export function option(value: string, text: string): HTMLOptionElement {
  return el("option", { value }, [text]);
}

export function makeControl(
  session: ChainSession,
  prefix: string,
  field: FlowField,
  initial: string,
): { control: Control; node: HTMLElement } {
  const id = `${prefix}-${field.name}`;
  const hint = el("p", { id: `${id}-hint`, class: "hint" });
  const error = el("p", { id: `${id}-error`, class: "error", hidden: "" });
  let input: HTMLInputElement | HTMLSelectElement;
  if (field.kind === "token") {
    input = el("select", { id, name: field.name }, [
      ...session.config.tokens.map((t) =>
        option(t.id, `${t.name} (${t.unit}, ${t.decimals} decimals)`),
      ),
    ]);
  } else if (field.kind === "adapter") {
    input = el("select", { id, name: field.name }, [
      ...session.config.adapters.map((a) => option(a.id, a.name)),
    ]);
  } else if (field.kind === "allowed") {
    input = el("select", { id, name: field.name }, [
      option("allow", "Allow"),
      option("revoke", "Revoke"),
    ]);
  } else {
    input = el("input", {
      id,
      name: field.name,
      type: "text",
      inputmode: field.kind === "principal" ? undefined : "numeric",
      autocomplete: "off",
      spellcheck: "false",
      value: initial,
    });
  }
  input.setAttribute("aria-describedby", hint.id);
  const node = el("div", { class: "field" }, [
    el("label", { for: id }, [field.label]),
    input,
    hint,
    error,
  ]);
  return { control: { field, input, hint, error }, node };
}

export function valuesOf(controls: readonly Control[]): FormValues {
  const values: Record<string, string> = {};
  for (const c of controls) values[c.field.name] = c.input.value;
  return values;
}

function showHints(session: ChainSession, controls: readonly Control[]) {
  const values = valuesOf(controls);
  for (const c of controls) {
    c.hint.textContent = fieldHint(
      c.field,
      values,
      session.config,
      latestBurnHeight(),
    );
  }
}

// ---- results --------------------------------------------------------------

/**
 * A receipt on the page: the plain headline in large type, an optional line
 * of the owner's own numbers, then what the contract returned, then the rest.
 */
export function receiptNodes(
  text: ReceiptText,
  lead = "",
  reason: string | null = null,
): HTMLElement[] {
  return [
    el("p", { class: `verdict ${text.kind}` }, [lead + text.headline]),
    ...(reason === null ? [] : [el("p", { class: "reason" }, [reason])]),
    ...(text.returned === undefined
      ? []
      : [
          el("p", { class: "returned" }, [
            el("code", { class: `tag ${text.kind}` }, [
              el("b", {}, [text.returned]),
              ...(text.name === undefined ? [] : [` ${text.name}`]),
            ]),
          ]),
        ]),
    ...text.details.map((line) => el("p", { class: "detail" }, [line])),
  ];
}

export function showLines(region: HTMLElement, lines: readonly string[]): void {
  region.replaceChildren(...lines.map((line) => el("p", {}, [line])));
}

// ---- panels ---------------------------------------------------------------

export function factList(
  facts: readonly (readonly [string, string])[],
): HTMLElement {
  return el(
    "dl",
    { class: "facts" },
    facts.flatMap(([name, value]) => [
      el("dt", {}, [name]),
      el("dd", {}, [value]),
    ]),
  );
}

function short(principal: string): string {
  return principal.length <= 16
    ? principal
    : `${principal.slice(0, 7)}…${principal.slice(-6)}`;
}

function meter(view: TokenView): HTMLElement {
  return el(
    "span",
    {
      class: view.dayPercent >= 100 ? "meter full" : "meter",
      "aria-hidden": "true",
    },
    [el("b", { style: `width: ${view.dayPercent}%` })],
  );
}

function figure(value: string, unit: string, cls: string): HTMLElement {
  return el("span", { class: cls }, [value, el("small", {}, [unit])]);
}

/** What each headline figure last showed, so a changed one can be marked. */
const shown = new Map<string, string>();

function stat(
  key: string,
  name: string,
  value: HTMLElement,
  sub: string,
  extra: readonly HTMLElement[] = [],
  alert = false,
): HTMLElement {
  const text = `${value.textContent}|${sub}`;
  const before = shown.get(key);
  shown.set(key, text);
  const classes = ["stat"];
  if (alert) classes.push("alert");
  if (before !== undefined && before !== text) classes.push("changed");
  return el("div", { class: classes.join(" ") }, [
    value,
    el("span", { class: "label" }, [name]),
    el("span", { class: "stat-sub" }, [sub]),
    ...extra,
  ]);
}

function tokenCard(view: TokenView): HTMLElement {
  const { token } = view;
  return el("div", { class: "card token-card" }, [
    el("div", { class: "token-head" }, [
      el("h3", {}, [token.name]),
      el("span", { class: view.allowed ? "chip ok" : "chip off" }, [
        view.allowed ? "Allowed for swaps" : "Not allowed for swaps",
      ]),
    ]),
    figure(compact(token, view.inVault), token.symbol, "token-balance"),
    el("span", { class: "label" }, [
      `In the vault: ${view.inVault} ${token.unit}`,
    ]),
    meter(view),
    el("p", { class: "meter-note" }, [
      el("span", {}, ["Day window, last 144 burn blocks"]),
      el("span", {}, [`${view.dayPercent}% used`]),
    ]),
    factList([
      ["Day window", capUseWords(token, view.dayUsed, view.maxPerDay)],
      [
        "Max per trade",
        `${human(token, view.maxPerTrade)} (${view.maxPerTrade} ${token.unit})`,
      ],
      [
        "Max per day",
        `${human(token, view.maxPerDay)} (${view.maxPerDay} ${token.unit})`,
      ],
      ["Approval threshold", thresholdWords(token, view.approvalThreshold)],
      [
        "In your account",
        `${human(token, view.inWallet)} (${view.inWallet} ${token.unit})`,
      ],
    ]),
  ]);
}

export async function refresh(session: ChainSession): Promise<void> {
  latest = await session.read();
  const summary = vaultSummary(latest, session.config);
  const first = summary.tokens[0];
  byId("summary", HTMLDivElement).replaceChildren(
    ...(first === undefined
      ? []
      : [
          stat(
            "vault",
            `${first.token.name} in the vault`,
            figure(
              compact(first.token, first.inVault),
              first.token.symbol,
              "stat-value",
            ),
            `${first.inVault} ${first.token.unit}`,
          ),
          stat(
            "day",
            "Left in the day window",
            figure(
              compact(first.token, first.dayLeft),
              first.token.symbol,
              "stat-value",
            ),
            first.maxPerDay === 0n
              ? "no day cap set"
              : `${first.dayPercent}% of ${human(first.token, first.maxPerDay)} used`,
            [meter(first)],
          ),
        ]),
    stat(
      "agent",
      "Agent",
      el("span", { class: "stat-value" }, [
        summary.paused ? "Paused" : summary.agent === null ? "None" : "Named",
      ]),
      summary.paused
        ? "the agent cannot trade"
        : summary.agent === null
          ? "no one can trade for this vault"
          : short(summary.agent),
      [],
      summary.paused,
    ),
    stat(
      "expiry",
      "Policy expires",
      summary.blocksLeft === null
        ? el("span", { class: "stat-value" }, [
            summary.expiresAt === 0n ? "Not set" : "Expired",
          ])
        : figure(summary.blocksLeft.toString(), "burn blocks", "stat-value"),
      summary.blocksLeft === null
        ? `burn height now ${summary.burnHeight}`
        : `${blocksAsTime(summary.blocksLeft)}, burn height now ${summary.burnHeight}`,
    ),
  );

  const [policy] = vaultPanel(latest, session.config, session.owner);
  byId("vault-panel", HTMLDivElement).replaceChildren(
    ...summary.tokens.map(tokenCard),
    ...(policy === undefined
      ? []
      : [
          el("div", { class: "card" }, [
            el("h3", {}, [policy.title]),
            factList(policy.facts),
          ]),
        ]),
  );

  journal = await session.journal();
  const entries = journalEntries(journal, session.config, session.owner);
  byId("journal-count", HTMLParagraphElement).textContent =
    entries.length === 0
      ? session.kind === "simulation"
        ? "No events yet. Make a deposit, or run the example setup."
        : "No events yet for this owner on this vault contract."
      : `${entries.length} ${entries.length === 1 ? "event" : "events"}.`;
  byId("journal-list", HTMLOListElement).replaceChildren(
    ...entries.map((entry) =>
      el(
        "li",
        {
          class: TRADE_EVENTS.has(entry.event)
            ? "swap"
            : entry.event === "pause" || entry.event === "remove-agent"
              ? "stop"
              : undefined,
        },
        [
          el("span", { class: "when" }, [
            el("code", {}, [entry.event]),
            `burn height ${entry.burnHeight}`,
          ]),
          el("span", {}, [entry.text]),
        ],
      ),
    ),
  );
  for (const run of refreshers) run();
}

// ---- review step ----------------------------------------------------------

/** What Confirm does, for each kind of chain. */
const CONFIRM = {
  simulation: {
    button: "Confirm and submit to the simnet",
    about:
      "Confirm runs this call on the simnet in this page, with these post-conditions enforced. Nothing is signed or broadcast.",
  },
  testnet: {
    button: "Confirm and open the wallet",
    about:
      "Confirm hands this unsigned call to your wallet with these post-conditions, in Deny mode. This page holds no key: your wallet shows the call, and signs and broadcasts it only if you approve. Approve only if the wallet shows the same post-conditions.",
  },
} as const;

/** One call of a review: an optional heading, then the call. */
export interface ReviewStep {
  /** For a review of several calls: "Step 1 of 3: Pause the agent". */
  heading?: string;
  call: VaultCall;
}

export interface ReviewOptions {
  /** The dialog's title. Default: "Review: <function>". */
  title?: string;
  /** Shown first, in place of the usual opening line. */
  intro?: readonly Child[];
  /** Shown after the calls, before what Confirm does. */
  notes?: readonly Node[];
  /** The Confirm button's text and the line that says what it does. */
  confirm?: { button: string; about: string };
}

function callNodes(session: ChainSession, call: VaultCall): HTMLElement[] {
  const text = reviewCall(call, session.config, latestBurnHeight());
  return [
    factList([
      ["Function", text.functionName],
      ["Contract", text.contract],
      ["Sent by", `${session.owner} (the owner)`],
    ]),
    el("h3", {}, ["Arguments"]),
    text.args.length === 0
      ? el("p", {}, ["This function takes no arguments."])
      : el(
          "dl",
          { class: "facts" },
          text.args.flatMap((arg) => [
            el("dt", {}, [arg.name]),
            el("dd", {}, [el("code", {}, [arg.value])]),
            el("dd", {}, [arg.meaning]),
          ]),
        ),
    el("h3", {}, ["Post-conditions"]),
    text.postConditions.length === 0
      ? el("p", {}, ["None."])
      : el(
          "ul",
          {},
          text.postConditions.map((pc) =>
            el("li", {}, [
              pc.text,
              el("br"),
              el("span", { class: "raw" }, [
                "As built: ",
                el("code", {}, [pc.raw]),
              ]),
            ]),
          ),
        ),
    el("p", {}, [text.mode]),
  ];
}

/**
 * Shows one or more calls, in the order they would be sent, and resolves
 * `true` on Confirm, `false` on Cancel or Escape. Nothing is sent here.
 */
export function reviewCalls(
  session: ChainSession,
  steps: readonly ReviewStep[],
  options: ReviewOptions = {},
): Promise<boolean> {
  const confirm = options.confirm ?? CONFIRM[session.kind];
  reviewTitle.textContent =
    options.title ??
    (steps.length === 1
      ? `Review: ${steps[0]!.call.functionName}`
      : `Review: ${steps.length} calls, in order`);
  confirmButton.textContent = confirm.button;
  reviewBody.replaceChildren(
    el(
      "p",
      {},
      options.intro ?? [
        "Nothing has been submitted yet. This is the call the Keelio SDK built from the form.",
      ],
    ),
    ...steps.flatMap((step) => [
      ...(step.heading === undefined
        ? []
        : [el("h3", { class: "step" }, [step.heading])]),
      ...callNodes(session, step.call),
    ]),
    ...(options.notes ?? []),
    el("p", {}, [confirm.about]),
  );
  return new Promise((resolve) => {
    const done = (confirmed: boolean) => {
      confirmButton.removeEventListener("click", onConfirm);
      cancelButton.removeEventListener("click", onCancel);
      dialog.removeEventListener("close", onClose);
      if (dialog.open) dialog.close();
      resolve(confirmed);
    };
    const onConfirm = () => done(true);
    const onCancel = () => done(false);
    // Escape closes a modal dialog without a click.
    const onClose = () => done(false);
    confirmButton.addEventListener("click", onConfirm);
    cancelButton.addEventListener("click", onCancel);
    dialog.addEventListener("close", onClose);
    dialog.showModal();
    reviewTitle.focus();
  });
}

/**
 * Reviews one call and, on Confirm, submits it and shows what happened in
 * `result`, then reads the vault again. Resolves `true` when a receipt came
 * back, whatever it says.
 */
export async function reviewAndSubmit(
  session: ChainSession,
  call: VaultCall,
  result: HTMLElement,
  options: ReviewOptions = {},
): Promise<boolean> {
  if (!(await reviewCalls(session, [{ call }], options))) {
    showLines(result, ["Cancelled. Nothing was submitted."]);
    return false;
  }
  try {
    await nextFrame();
    const receipt = await session.submit(call, (progress) =>
      showLines(result, [progressWords(progress)]),
    );
    result.replaceChildren(
      ...receiptNodes(describeReceipt(receipt, errors, session.kind)),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showLines(result, [`The call could not run: ${message}`]);
    return false;
  }
  try {
    await refresh(session);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.append(
      el("p", {}, [`The vault could not be read again: ${message}`]),
    );
  }
  return true;
}

/** Saves `text` as a file made in the browser: a Blob and an object URL. */
export function saveFile(name: string, type: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = el("a", { href: url, download: name, hidden: "" });
  document.body.append(link);
  link.click();
  link.remove();
  // The click has started the save; the URL is no longer needed.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// ---- owner flows ----------------------------------------------------------

/** A form field's starting text, by `flow.field`, for example `deposit.amount`. */
export type InitialValue = (key: string) => string;

/** One built form, for the parts of the page that add to it or fill it in. */
export interface FlowHandle {
  controls: readonly Control[];
  /** An empty region inside the form, above its button. */
  slot: HTMLElement;
  /** Shows this form in the tab list. */
  open(): void;
  /** Called after the form's values change from outside. */
  changed(): void;
}

const handles = new Map<FlowId, FlowHandle>();
/** More to show in a flow's review step, by flow. */
const reviewNotes = new Map<FlowId, (values: FormValues) => Node[]>();

/** The built form of a flow. Throws before `buildFlows` has run. */
export function flowHandle(id: FlowId): FlowHandle {
  const handle = handles.get(id);
  if (handle === undefined) throw new Error(`flow ${id} is not built`);
  return handle;
}

/** Adds content to the review step of every call of flow `id`. */
export function setReviewNotes(
  id: FlowId,
  notes: (values: FormValues) => Node[],
): void {
  reviewNotes.set(id, notes);
}

/**
 * Writes `values` into the form of flow `id` and shows it. Nothing is
 * submitted: the owner still presses Review and confirms.
 */
export function fillFlow(id: FlowId, values: FormValues): void {
  const handle = flowHandle(id);
  for (const control of handle.controls) {
    const value = values[control.field.name];
    if (value !== undefined) control.input.value = value;
    setError(control, null);
  }
  handle.changed();
  handle.open();
}

function buildFlow(
  session: ChainSession,
  flow: Flow,
  initialValue: InitialValue,
): HTMLElement {
  const made = flow.fields.map((field) =>
    makeControl(
      session,
      flow.id,
      field,
      initialValue(`${flow.id}.${field.name}`),
    ),
  );
  const controls = made.map((m) => m.control);
  const titleId = `${flow.id}-title`;
  const button = el("button", { type: "submit" }, [`Review ${flow.title}`]);
  const result = el("div", { class: "result", role: "status" });
  const slot = el("div", { class: "flow-extra" });
  const form = el("form", { novalidate: "", "aria-labelledby": titleId }, [
    ...made.map((m) => m.node),
    slot,
    button,
  ]);
  const hints = () => showHints(session, controls);
  handles.set(flow.id, { controls, slot, open: () => {}, changed: hints });
  for (const c of controls) {
    c.input.addEventListener("input", hints);
    c.input.addEventListener("change", hints);
  }
  refreshers.push(hints);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (button.disabled) return;
    const prepared = prepareCall(session, flow.id, valuesOf(controls));
    for (const c of controls) {
      setError(
        c,
        prepared.ok ? null : (prepared.fieldErrors[c.field.name] ?? null),
      );
    }
    if (!prepared.ok) {
      const firstInvalid = controls.find(
        (c) => prepared.fieldErrors[c.field.name] !== undefined,
      );
      firstInvalid?.input.focus();
      showLines(
        result,
        prepared.formError === null
          ? ["Not submitted: fix the marked field first."]
          : [`Not submitted. ${prepared.formError}`],
      );
      return;
    }
    const notes = reviewNotes.get(flow.id)?.(valuesOf(controls));
    button.disabled = true;
    void reviewAndSubmit(
      session,
      prepared.call,
      result,
      notes === undefined ? {} : { notes },
    ).finally(() => {
      button.disabled = false;
    });
  });

  return el("div", { class: "card flow" }, [
    el("code", { class: "call" }, [`keelio-vault.${flow.id}`]),
    el("h4", { id: titleId }, [flow.title]),
    el("p", {}, [flow.about]),
    form,
    result,
  ]);
}

/** The flows the hero offers as shortcuts. */
const QUICK: readonly Flow["id"][] = ["deposit", "pause"];

/**
 * Builds the owner's forms as a vertical tab list: one form shows at a time.
 * The same forms serve both modes.
 */
export function buildFlows(
  session: ChainSession,
  initialValue: InitialValue,
): void {
  const tabs: HTMLButtonElement[] = [];
  const panels: HTMLElement[] = [];
  const select = (index: number, focus: boolean): void => {
    tabs.forEach((tab, i) => {
      tab.setAttribute("aria-selected", i === index ? "true" : "false");
      tab.tabIndex = i === index ? 0 : -1;
      panels[i]!.hidden = i !== index;
    });
    if (focus) tabs[index]?.focus();
  };
  const rail = el("div", {
    class: "rail",
    role: "tablist",
    "aria-orientation": "vertical",
    "aria-labelledby": "actions-heading",
  });
  let group = "";
  FLOWS.forEach((flow, index) => {
    if (flow.group !== group) {
      group = flow.group;
      rail.append(
        el("span", { class: "label", role: "presentation" }, [group]),
      );
    }
    const tab = el(
      "button",
      {
        type: "button",
        role: "tab",
        id: `${flow.id}-tab`,
        "aria-controls": `${flow.id}-panel`,
      },
      [flow.title],
    );
    tab.addEventListener("click", () => select(index, false));
    tab.addEventListener("keydown", (event) => {
      const last = FLOWS.length - 1;
      const next =
        event.key === "ArrowDown"
          ? index === last
            ? 0
            : index + 1
          : event.key === "ArrowUp"
            ? index === 0
              ? last
              : index - 1
            : event.key === "Home"
              ? 0
              : event.key === "End"
                ? last
                : null;
      if (next === null) return;
      event.preventDefault();
      select(next, true);
    });
    const panel = buildFlow(session, flow, initialValue);
    handles.get(flow.id)!.open = () => {
      select(index, false);
      panel.scrollIntoView({ block: "center" });
      tab.focus({ preventScroll: true });
    };
    panel.id = `${flow.id}-panel`;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", tab.id);
    tabs.push(tab);
    panels.push(panel);
    rail.append(tab);
  });
  select(0, false);
  byId("flows", HTMLDivElement).replaceChildren(rail, el("div", {}, panels));

  byId("quick", HTMLDivElement).replaceChildren(
    ...QUICK.map((id, i) => {
      const index = FLOWS.findIndex((flow) => flow.id === id);
      const button = el(
        "button",
        { type: "button", class: i === 0 ? "go" : "go dark" },
        [id === "pause" ? "Kill switch: pause the agent" : FLOWS[index]!.title],
      );
      button.addEventListener("click", () => {
        select(index, false);
        panels[index]!.scrollIntoView({ block: "center" });
        tabs[index]!.focus({ preventScroll: true });
      });
      return button;
    }),
  );
}
