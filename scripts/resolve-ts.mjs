// Lets Node run the TypeScript sources directly. Node strips types itself,
// but the SDK imports its siblings as `./x.js` while the files are `x.ts`.
// This hook retries such an import with `.ts` only when the `.js` file does
// not exist, so a real `.js` file always wins.
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      const relative =
        specifier.startsWith("./") || specifier.startsWith("../");
      if (
        error?.code !== "ERR_MODULE_NOT_FOUND" ||
        !relative ||
        !specifier.endsWith(".js")
      ) {
        throw error;
      }
      return next(`${specifier.slice(0, -3)}.ts`, context);
    }
  },
});
