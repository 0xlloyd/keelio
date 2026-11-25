import { defineConfig } from "vite";

// The dev server must not pre-bundle the simnet's wasm glue: that breaks its
// `new URL("clarinet_sdk_bg.wasm", import.meta.url)`.
export default defineConfig({
  optimizeDeps: {
    exclude: [
      "@stacks/clarinet-sdk-browser",
      "@stacks/clarinet-sdk-wasm-browser",
    ],
  },
});
