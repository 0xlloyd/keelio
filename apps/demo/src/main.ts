// The demo page: boots the real simnet in the browser from the repo's own
// manifest and contracts, opens the vault as `runDemo` does, and lets the
// agent try a swap. Text is set with textContent only.
import { defaultFileStore, initSimnet } from "@stacks/clarinet-sdk-browser";
import manifest from "../../../Clarinet.toml?raw";
// The browser build of the simnet reads its accounts from Devnet.toml.
import devnetSettings from "../../../settings/Devnet.toml?raw";
import {
  describeCheck,
  describeResult,
  formatSbtc,
  formatUsd,
  loadProject,
  parseBaseUnits,
  startDemo,
  type DemoSession,
  type SwapOutcome,
} from "./session.js";

const contracts = import.meta.glob<string>("../../../contracts/**/*.clar", {
  query: "?raw",
  import: "default",
  eager: true,
});

function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const node = document.getElementById(id);
  if (!(node instanceof type)) throw new Error(`missing #${id}`);
  return node;
}

const status = element("status", HTMLParagraphElement);
const form = element("swap-form", HTMLFormElement);
const button = element("swap", HTMLButtonElement);
const result = element("result", HTMLDivElement);

interface AmountField {
  input: HTMLInputElement;
  hint: HTMLParagraphElement;
  error: HTMLParagraphElement;
  min: bigint;
  message: string;
  format: (value: bigint) => string;
}

function field(
  id: string,
  min: bigint,
  message: string,
  format: (value: bigint) => string,
): AmountField {
  return {
    input: element(id, HTMLInputElement),
    hint: element(`${id}-hint`, HTMLParagraphElement),
    error: element(`${id}-error`, HTMLParagraphElement),
    min,
    message,
    format,
  };
}

const amountIn = field(
  "amount-in",
  1n,
  "Enter a whole number of sats, 1 or more.",
  formatSbtc,
);
const minOut = field(
  "min-out",
  0n,
  "Enter a whole number of base units, 0 or more.",
  formatUsd,
);
const fields = [amountIn, minOut];

function showHint(f: AmountField): void {
  const value = parseBaseUnits(f.input.value, f.min);
  f.hint.textContent = value === null ? "" : `= ${f.format(value)}`;
}

function setError(f: AmountField, invalid: boolean): void {
  if (invalid) {
    f.input.setAttribute("aria-invalid", "true");
    f.input.setAttribute("aria-describedby", `${f.hint.id} ${f.error.id}`);
    f.error.textContent = f.message;
    f.error.hidden = false;
  } else {
    f.input.removeAttribute("aria-invalid");
    f.input.setAttribute("aria-describedby", f.hint.id);
    f.error.textContent = "";
    f.error.hidden = true;
  }
}

function lines(container: HTMLElement, texts: readonly string[]): void {
  container.replaceChildren(
    ...texts.map((text) => {
      const p = document.createElement("p");
      p.textContent = text;
      return p;
    }),
  );
}

function outcomeLines(outcome: SwapOutcome): string[] {
  const second =
    "result" in outcome
      ? `execute-swap: ${describeResult(outcome.result)}`
      : `execute-swap: not sent, the SDK refused to build the call: ${outcome.buildError}`;
  return [`checkIntent: ${describeCheck(outcome.check)}`, second];
}

async function showVault(session: DemoSession): Promise<void> {
  const { vault, burnHeight } = await session.read();
  const { sbtc, usd } = session.ids;
  const rows = [
    { name: "mock sBTC", id: sbtc, format: formatSbtc },
    { name: "mock USD", id: usd, format: formatUsd },
  ].map(({ name, id, format }) => {
    const caps = vault.policy.caps[id] ?? { maxPerTrade: 0n, maxPerDay: 0n };
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.scope = "row";
    th.textContent = name;
    tr.append(th);
    for (const amount of [
      vault.balances[id] ?? 0n,
      caps.maxPerTrade,
      caps.maxPerDay,
      vault.usage.dayTotals[id] ?? 0n,
    ]) {
      const td = document.createElement("td");
      td.textContent = format(amount);
      tr.append(td);
    }
    return tr;
  });
  element("vault-rows", HTMLTableSectionElement).replaceChildren(...rows);

  const agent =
    vault.vault.agent === null
      ? "none"
      : vault.vault.agent === session.agent
        ? "Agent"
        : vault.vault.agent;
  const policy = element("vault-policy", HTMLUListElement);
  policy.replaceChildren(
    ...[
      `Agent: ${agent}`,
      `Paused: ${vault.vault.paused ? "yes" : "no"}`,
      `Cooldown: ${vault.policy.cooldownBlocks} burn blocks`,
      `Policy expires at burn height ${vault.policy.expiresAt} (now ${burnHeight})`,
    ].map((text) => {
      const li = document.createElement("li");
      li.textContent = text;
      return li;
    }),
  );
}

const nextFrame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

async function boot(): Promise<DemoSession> {
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
  return startDemo(simnet);
}

function wire(session: DemoSession): void {
  for (const f of fields) {
    f.input.addEventListener("input", () => showHint(f));
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (button.disabled) return;
    const values = fields.map((f) => parseBaseUnits(f.input.value, f.min));
    fields.forEach((f, i) => setError(f, values[i] === null));
    const firstInvalid = fields.find((_, i) => values[i] === null);
    if (firstInvalid !== undefined) {
      firstInvalid.input.focus();
      return;
    }
    const [amount, min] = values as [bigint, bigint];
    button.disabled = true;
    void (async () => {
      try {
        await nextFrame();
        lines(
          result,
          outcomeLines(await session.swap({ amountIn: amount, minOut: min })),
        );
        await showVault(session);
      } catch (error) {
        lines(result, [`The swap could not run: ${String(error)}`]);
      } finally {
        button.disabled = false;
      }
    })();
  });
}

async function main(): Promise<void> {
  status.textContent = "Starting the simnet…";
  let session: DemoSession;
  try {
    session = await boot();
    element("owner", HTMLElement).textContent = session.owner;
    element("agent", HTMLElement).textContent = session.agent;
    await showVault(session);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    status.textContent = `The simnet could not start: ${message}`;
    return;
  }
  wire(session);
  status.textContent =
    "Simnet ready. The owner opened the vault, named the agent and set its caps.";
  button.disabled = false;
}

void main();
