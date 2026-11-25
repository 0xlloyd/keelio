import { readFileSync } from "node:fs";

const manifestUrl = new URL("../Clarinet.toml", import.meta.url);

/**
 * `keelio-vault`'s `clarity_version` from a Clarinet manifest (default: the repo's own).
 * Throws if the block or the key is missing. No `expect`, so it works outside a test.
 */
export function vaultClarityVersion(
  manifest: string = readFileSync(manifestUrl, "utf8"),
): number {
  const block = manifest
    .split(/\n(?=\[)/)
    .find((b) => b.startsWith("[contracts.keelio-vault]"));
  if (!block)
    throw new Error("Clarinet.toml has no [contracts.keelio-vault] block");
  const match = /^\s*clarity_version\s*=\s*(\d+)/m.exec(block);
  if (!match)
    throw new Error("[contracts.keelio-vault] has no clarity_version key");
  return Number(match[1]);
}
