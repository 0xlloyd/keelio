import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Testnet mode's code, with the wallet library and the API client, is part
// of the page only when the owner has written a config. Without one the
// page is the simulation alone and `?mode=testnet` says what is missing.
const hasTestnetConfig = existsSync(
  fileURLToPath(new URL("./testnet.config.json", import.meta.url)),
);

// The dev server must not pre-bundle the simnet's wasm glue: that breaks its
// `new URL("clarinet_sdk_bg.wasm", import.meta.url)`.
export default defineConfig({
  define: {
    __KEELIO_TESTNET_CONFIG__: JSON.stringify(hasTestnetConfig),
  },
  optimizeDeps: {
    exclude: [
      "@stacks/clarinet-sdk-browser",
      "@stacks/clarinet-sdk-wasm-browser",
    ],
  },
});
