import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { vaultClarityVersion } from "./vault-clarity-version.js";

const manifest = (version: number) =>
  `[contracts.other]\nclarity_version = 3\n\n[contracts.keelio-vault]\npath = "x"\nclarity_version = ${version}\nepoch = 4.0\n`;

describe("vaultClarityVersion", () => {
  it("follows the manifest text", () => {
    expect(vaultClarityVersion(manifest(6))).toBe(6);
    expect(vaultClarityVersion(manifest(9))).toBe(9);
  });

  it("reads the repo's Clarinet.toml by default", () => {
    const real = readFileSync(
      new URL("../Clarinet.toml", import.meta.url),
      "utf8",
    );
    expect(vaultClarityVersion()).toBe(vaultClarityVersion(real));
  });

  it("throws when the block or the key is missing", () => {
    expect(() =>
      vaultClarityVersion("[contracts.other]\nclarity_version = 3\n"),
    ).toThrow(/keelio-vault/);
    expect(() =>
      vaultClarityVersion('[contracts.keelio-vault]\npath = "x"\n'),
    ).toThrow(/clarity_version/);
  });

  it("is used by every test that deploys a vault copy", () => {
    for (const file of [
      "keelio-vault-allowance",
      "keelio-vault-swap",
      "keelio-vault-threats",
    ]) {
      const src = readFileSync(
        new URL(`./${file}.test.ts`, import.meta.url),
        "utf8",
      );
      expect(src, file).toContain("vaultClarityVersion");
      expect(src, file).not.toMatch(/clarityVersion: [0-9]/);
    }
  });

  // The online Bitflow tests deploy a vault copy at run time, into whatever
  // epoch their own manifest reaches. They are skipped in the gate, so this
  // offline check is what notices the two manifests drifting apart.
  it("the Bitflow manifest reaches the vault's epoch", () => {
    const epochs = (toml: string) =>
      [...toml.matchAll(/^\s*epoch\s*=\s*([0-9.]+)/gm)].map((m) =>
        Number(m[1]),
      );
    const real = readFileSync(
      new URL("../Clarinet.toml", import.meta.url),
      "utf8",
    );
    const vaultBlock = real
      .split(/\n(?=\[)/)
      .find((b) => b.startsWith("[contracts.keelio-vault]"))!;
    const vaultEpoch = epochs(vaultBlock)[0]!;
    const remote = readFileSync(
      new URL("./bitflow-remote/Clarinet.toml", import.meta.url),
      "utf8",
    );
    expect(vaultEpoch).toBeGreaterThan(0);
    expect(Math.max(...epochs(remote))).toBeGreaterThanOrEqual(vaultEpoch);
  });
});
