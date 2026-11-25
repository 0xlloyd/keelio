// What the page says in testnet mode before any session exists: which mode
// it is in, and what is missing. It imports no wallet or API code, so it is
// safe to load when there is no config.
import { byId, el, status } from "./ui.js";

const CONFIG_STEPS =
  "Copy apps/dashboard/testnet.config.example.json to apps/dashboard/testnet.config.json, fill in the ids of your deployed vault, then start the dashboard again.";

/** Rewrites the simulation's page text for testnet mode and removes its controls. */
export function setTestnetPage(): void {
  document.title = "Keelio owner dashboard: testnet";
  byId("banner-text", HTMLParagraphElement).replaceChildren(
    el("strong", {}, ["Testnet mode."]),
    " Testnet tokens only, no mainnet. Your wallet signs and broadcasts; this page holds no key. This mode has not yet been run against a real wallet or a deployed vault.",
  );
  byId("intro", HTMLParagraphElement).textContent =
    "Give a trading agent bounded swap rights over your sBTC without giving it custody. In this mode the page reads your vault on Stacks testnet and hands each call to your wallet.";
  byId("mode-switch", HTMLParagraphElement).replaceChildren(
    "Mode: testnet. ",
    el("a", { href: "?" }, ["Switch to the local simulation"]),
    ".",
  );
  byId("simulation", HTMLElement).remove();
  byId("nav-simulation", HTMLLIElement).remove();
  status.textContent = "Testnet mode is starting…";
}

/** Says why testnet mode did not start and how to give it a config. */
export function showSetup(lead: string, lines: readonly string[]): void {
  status.textContent = lead;
  byId("connect", HTMLDivElement).replaceChildren(
    el(
      "ul",
      {},
      lines.map((line) => el("li", {}, [line])),
    ),
    el("p", {}, [CONFIG_STEPS]),
  );
}

export function showMissingConfig(): void {
  showSetup("Testnet mode needs a config, and none was found.", [
    "apps/dashboard/testnet.config.json is missing.",
  ]);
}
