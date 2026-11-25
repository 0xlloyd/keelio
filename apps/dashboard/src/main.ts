// The owner dashboard's entry: picks the mode and loads only that mode's
// code. The simulation is the default and never loads the wallet library or
// the API client. Testnet mode's code is in the page only when the owner has
// written a config (see vite.config.ts); without one, `?mode=testnet` says
// what is missing.
import { modeFromSearch } from "./mode.js";

if (modeFromSearch(window.location.search) === "testnet") {
  if (__KEELIO_TESTNET_CONFIG__) {
    void import("./testnet-mode.js").then((mode) => mode.startTestnetMode());
  } else {
    void import("./testnet-page.js").then((page) => {
      page.setTestnetPage();
      page.showMissingConfig();
    });
  }
} else {
  void import("./simulation-mode.js").then((mode) =>
    mode.startSimulationMode(),
  );
}
