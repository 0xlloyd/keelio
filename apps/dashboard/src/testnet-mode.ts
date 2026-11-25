// Testnet mode: reads the owner's config, connects the owner's wallet and
// hands the same forms, review step and panels a testnet `ChainSession`.
// The simulation controls are removed. This page holds no key: the wallet
// signs and broadcasts. It has never been run against a real wallet or a
// deployed vault.
import { connectWallet } from "./connect-wallet.js";
import { connect, getSelectedProviderId, request } from "./stacks-connect.js";
import { parseTestnetConfig, type TestnetConfig } from "./testnet-config.js";
import {
  setTestnetPage,
  showMissingConfig,
  showSetup,
} from "./testnet-page.js";
import { buildOwnerTools } from "./owner-tools.js";
import { buildFlows, byId, el, refresh, status } from "./ui.js";
import { startWalletChain } from "./wallet-chain.js";

// The owner's copy of testnet.config.example.json, filled in.
const configFiles = import.meta.glob<unknown>("../testnet.config.json", {
  eager: true,
  import: "default",
});

const words = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

async function start(config: TestnetConfig, area: HTMLDivElement) {
  status.textContent = "Waiting for your wallet…";
  const session = await startWalletChain({
    config,
    wallet: connectWallet({ connect, request, getSelectedProviderId }),
    fetch: (url, init) => fetch(url, init),
  });
  status.textContent = "Reading the vault…";
  await refresh(session);
  // No example values on testnet: every field starts empty.
  buildFlows(session, () => "");
  buildOwnerTools(session);
  await refresh(session);

  const again = el("button", { type: "button", class: "secondary" }, [
    "Read the vault again",
  ]);
  const note = el("p", { role: "status" });
  again.addEventListener("click", () => {
    again.disabled = true;
    note.textContent = "Reading…";
    refresh(session)
      .then(() => {
        note.textContent = "";
      })
      .catch((error: unknown) => {
        note.textContent = `The vault could not be read: ${words(error)}`;
      })
      .finally(() => {
        again.disabled = false;
      });
  });
  area.replaceChildren(again, note);
  status.textContent = `Connected on testnet as ${session.owner}. Vault contract: ${config.vault}.`;
}

export async function startTestnetMode(): Promise<void> {
  setTestnetPage();
  const raw = Object.values(configFiles)[0];
  if (raw === undefined) {
    showMissingConfig();
    return;
  }
  const parsed = parseTestnetConfig(raw);
  if (!parsed.ok) {
    showSetup(
      parsed.mainnet
        ? "Testnet mode did not start: the config names mainnet."
        : "Testnet mode did not start: the config is incomplete.",
      parsed.problems,
    );
    return;
  }
  const { config } = parsed;
  const area = byId("connect", HTMLDivElement);
  const button = el("button", { type: "button" }, ["Connect wallet"]);
  status.textContent = `Config read. Vault contract: ${config.vault}. API: ${config.apiUrl}. Connect the wallet that owns the vault.`;
  button.addEventListener("click", () => {
    button.disabled = true;
    start(config, area).catch((error: unknown) => {
      status.textContent = `Testnet mode did not start: ${words(error)}`;
      button.disabled = false;
    });
  });
  area.replaceChildren(button);
}
