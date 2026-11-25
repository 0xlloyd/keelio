import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { parseState, type StateStore } from "./monitor.js";

/**
 * Keeps the state in one JSON file. A save writes a sibling file and renames
 * it over the old one, so a crash leaves the old state or the new, never
 * half of either. A missing file is a first run; a file that is not a state
 * is an error, never silently replaced.
 */
export function fileStore(path: string): StateStore {
  return {
    load() {
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch (e) {
        if ((e as { code?: unknown }).code === "ENOENT") return null;
        throw e;
      }
      return parseState(JSON.parse(text));
    },
    save(state) {
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
      renameSync(tmp, path);
    },
  };
}
