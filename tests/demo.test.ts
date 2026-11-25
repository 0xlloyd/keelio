import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initSimnet } from "@stacks/clarinet-sdk";
import { Cl } from "@stacks/transactions";
import { describe, expect, it } from "vitest";
import { renderDemo, runDemo } from "../scripts/demo.js";
import { formatBtc, formatUnits } from "../scripts/format-amount.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("formatUnits and formatBtc", () => {
  it("formats base units with fixed decimals", () => {
    expect(formatBtc(0n)).toBe("0.00000000");
    expect(formatBtc(1n)).toBe("0.00000001");
    expect(formatBtc(100_000_000n)).toBe("1.00000000");
    expect(formatBtc(10_000_000n)).toBe("0.10000000");
    expect(formatBtc(2n ** 128n - 1n)).toBe(
      "3402823669209384634633746074317.68211455",
    );
    expect(formatUnits(9_000_000_000n, 6)).toBe("9000.000000");
    expect(formatUnits(5n, 0)).toBe("5");
  });

  it("refuses a negative amount or bad decimals", () => {
    expect(() => formatBtc(-1n)).toThrow(RangeError);
    expect(() => formatUnits(1n, -1)).toThrow(RangeError);
    expect(() => formatUnits(1n, 1.5)).toThrow(RangeError);
  });
});

describe("runDemo", async () => {
  const simnet = await initSimnet();
  const result = await runDemo(simnet);
  const output = renderDemo(result);
  const deployer = simnet.getAccounts().get("deployer")!;
  const sbtc = `${deployer}.mock-sbtc`;
  const usd = `${deployer}.mock-usd`;

  it("sets up the mocks and opens the vault", () => {
    expect(result.setup).toHaveLength(13);
    for (const value of result.setup) expect(value.type).toBe("ok");
    expect(result.deposit).toStrictEqual(Cl.ok(Cl.uint(100_000_000n)));
    expect(result.setup).toContainEqual(Cl.ok(Cl.uint(100_000_000n)));
  });

  it("lets the agent swap inside the policy", () => {
    expect(result.swap.check).toStrictEqual({ ok: true });
    expect(result.swap.result).toStrictEqual(Cl.ok(Cl.uint(9_000_000_000n)));
  });

  it("lets the agent buy sBTC back inside the USD caps", () => {
    expect(result.buyBackRate).toStrictEqual(Cl.ok(Cl.bool(true)));
    expect(result.buyBack.check).toStrictEqual({ ok: true });
    expect(result.buyBack.result).toStrictEqual(Cl.ok(Cl.uint(5_000_000n)));
    expect(output).toContain("3. The agent buys sBTC back");
  });

  it("refuses the trade above the per-trade cap", () => {
    expect(result.bigSwap.check).toMatchObject({
      ok: false,
      rule: "TRADE_CAP_EXCEEDED",
      errorCode: 114,
    });
    expect(result.bigSwap.result).toStrictEqual(Cl.error(Cl.uint(114)));
  });

  it("refuses the agent's withdrawal and leaves the owner's ledger", () => {
    expect(result.agentWithdraw).toStrictEqual(Cl.error(Cl.uint(101)));
    expect(result.vaultBeforeWithdraw).toBe(95_000_000n);
    expect(result.usdBeforeWithdraw).toBe(4_500_000_000n);
  });

  it("refuses a swap inside the caps once the vault is paused", () => {
    expect(result.pause).toStrictEqual(Cl.ok(Cl.bool(true)));
    expect(result.pausedSwap.check).toMatchObject({
      ok: false,
      rule: "VAULT_PAUSED",
      errorCode: 109,
    });
    expect(result.pausedSwap.result).toStrictEqual(Cl.error(Cl.uint(109)));
  });

  it("lets the owner withdraw everything while paused", () => {
    expect(result.ownerWithdraw.sbtc).toStrictEqual(Cl.ok(Cl.uint(0)));
    expect(result.ownerWithdraw.usd).toStrictEqual(Cl.ok(Cl.uint(0)));
    expect(result.final.vault.balances).toStrictEqual({
      [sbtc]: 0n,
      [usd]: 0n,
    });
    expect(result.final.vault.vault.paused).toBe(true);
    expect(result.final.ownerWallet).toStrictEqual({
      sbtc: 95_000_000n,
      usd: 4_500_000_000n,
    });
    expect(result.final.agentWallet.sbtc).toBe(0n);
  });

  it("journals the fourteen successful vault calls in order", () => {
    expect(result.journal).toHaveLength(14);
    const events = result.journal.map((value) => {
      if (value.type !== "tuple") throw new Error("event is not a tuple");
      return value.value.event;
    });
    expect(events).toStrictEqual(
      [
        "deposit",
        "set-agent",
        "set-token-caps",
        "set-token-caps",
        "set-policy",
        "allow-token",
        "allow-token",
        "allow-adapter",
        "set-price-bounds",
        "execute-swap",
        "execute-swap",
        "pause",
        "withdraw",
        "withdraw",
      ].map((name) => Cl.stringAscii(name)),
    );
  });

  it("prints each set-token-caps in its own token's units", () => {
    expect(output).toContain(
      "set-token-caps   owner: token=mock-sbtc max-per-trade=0.10000000 sBTC max-per-day=0.30000000 sBTC\n",
    );
    expect(output).toContain(
      "set-token-caps   owner: token=mock-usd max-per-trade=10000.000000 USD max-per-day=30000.000000 USD\n",
    );
    expect(output).toContain(
      "set-policy       owner: cooldown-blocks=0, expires 1000 burn blocks after it was set\n",
    );
  });

  it("sets each token's caps, then the policy once, in step 1", () => {
    const step1 = output.slice(
      output.indexOf("1. The owner opens the vault"),
      output.indexOf("2. The agent swaps"),
    );
    const setters = step1
      .split("\n")
      .filter((line) => /^ {2}set-(token-caps|policy) /.test(line));
    expect(setters).toStrictEqual([
      "  set-token-caps mock-sbtc 0.10000000 sBTC per trade, 0.30000000 sBTC per day: (ok true)",
      "  set-token-caps mock-usd 10000.000000 USD per trade, 30000.000000 USD per day: (ok true)",
      "  set-policy no cooldown, for the next 1000 burn blocks, for both tokens: (ok true)",
    ]);
  });

  it("renders the refusals with labels and no addresses", () => {
    for (const text of [
      "TRADE_CAP_EXCEEDED",
      "(err u114)",
      "ERR-INSUFFICIENT-BALANCE",
      "(err u101)",
      "VAULT_PAUSED",
      "(err u109)",
      "1.00000000",
    ]) {
      expect(output).toContain(text);
    }
    expect(/\bS[TP][0-9A-Z]{20,}/.test(output)).toBe(false);
    expect(output.split("\n").filter((line) => /\s$/.test(line))).toEqual([]);
    expect(output.endsWith("\n")).toBe(true);
    expect(output.endsWith("\n\n")).toBe(false);
  });

  it("never claims the simnet checked post-conditions", () => {
    expect(output).not.toMatch(
      /post-conditions? (were |was )?(checked|enforced)/i,
    );
    expect(output).toContain("the simnet does not check them");
  });

  // One spawn, not two: under a loaded CI box each cold simnet start can take
  // tens of seconds. The spawned stdout is compared with the separate
  // in-process run above, so two independent runs still have to agree.
  it("prints the same story from pnpm run demo as the README shows", async () => {
    const pkg = JSON.parse(
      readFileSync(join(root, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts.demo).toBe(
      "node --import ./scripts/resolve-ts.mjs scripts/demo.ts",
    );

    const run = await runScript([
      "--import",
      "./scripts/resolve-ts.mjs",
      "scripts/demo.ts",
    ]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toBe(output);
    expect(run.stdout.replace(/\n$/, "")).toBe(readmeDemoBlock());
    // The simnet's own echo of each contract print goes to stderr.
    expect(run.stdout).not.toContain("(keelio-vault:");
    // Clarinet must not warn about a config key it dropped.
    const warning = /no longer supported|\[repl\.analysis\]/;
    expect(run.stderr).not.toMatch(warning);
    expect(run.stdout).not.toMatch(warning);
  }, 60_000);
});

/** The first ```text block after `## See it work` in README.md, without its fences. */
function readmeDemoBlock(): string {
  const lines = readFileSync(join(root, "README.md"), "utf8").split("\n");
  const heading = lines.indexOf("## See it work");
  expect(heading).toBeGreaterThanOrEqual(0);
  const open = lines.findIndex((l, i) => i > heading && l === "```text");
  expect(open).toBeGreaterThan(heading);
  const close = lines.findIndex((l, i) => i > open && l === "```");
  expect(close).toBeGreaterThan(open);
  return lines.slice(open + 1, close).join("\n");
}

/** Runs node with `args` from the repo root without blocking the test worker. */
function runScript(
  args: string[],
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

describe("Clarinet config", () => {
  it("no Clarinet.toml uses the dropped [repl.analysis] table", () => {
    const skip = new Set(["node_modules", ".git", ".cache"]);
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) {
          if (!skip.has(e.name)) walk(join(dir, e.name));
        } else if (e.name === "Clarinet.toml") {
          const file = join(dir, e.name);
          if (/^\s*\[repl\.analysis/m.test(readFileSync(file, "utf8"))) {
            found.push(file);
          }
        }
      }
    };
    walk(root);
    expect(found).toStrictEqual([]);
  });
});
