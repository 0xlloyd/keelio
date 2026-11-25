// Repo hygiene that a careless edit could undo without any other test noticing:
// exact dependency pins, pnpm's install policies, the CI workflow's hardening,
// what .gitignore keeps out, and the wallet library's unused WalletConnect path.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(path, "utf8");
const git = (...args: string[]): string =>
  execFileSync("git", args, { encoding: "utf8" });

const MANIFESTS = [
  "package.json",
  "packages/sdk/package.json",
  "packages/mcp/package.json",
  "packages/monitor/package.json",
  "apps/dashboard/package.json",
];

describe("dependencies", () => {
  it.each(MANIFESTS)("%s pins every dependency exactly", (path) => {
    const manifest = JSON.parse(read(path)) as Record<string, unknown>;
    for (const field of ["dependencies", "devDependencies"]) {
      const deps = (manifest[field] ?? {}) as Record<string, string>;
      for (const [name, spec] of Object.entries(deps)) {
        expect(
          spec === "workspace:*" || /^\d+\.\d+\.\d+$/.test(spec),
          `${path} ${name}@${spec}`,
        ).toBe(true);
      }
    }
  });

  it("pins pnpm itself and keeps its install policies", () => {
    const manifest = JSON.parse(read("package.json")) as {
      packageManager: string;
    };
    expect(manifest.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
    const workspace = read("pnpm-workspace.yaml");
    expect(workspace).toMatch(/^savePrefix: ""$/m);
    expect(workspace).toMatch(/^minimumReleaseAge: [1-9]\d*$/m);
    expect(workspace).toMatch(/^blockExoticSubdeps: true$/m);
    expect(workspace).toMatch(/^strictDepBuilds: true$/m);
    // No package is allowed to run an install script.
    expect(workspace).not.toMatch(/^\s+\S+: true$/m);
  });

  it("resolves every package from the registry with an integrity hash", () => {
    const lock = read("pnpm-lock.yaml");
    expect(lock).not.toMatch(/tarball:|git\+|github:|codeload\./);
    const resolutions = lock.match(/resolution: \{[^}]*\}/g) ?? [];
    expect(resolutions.length).toBeGreaterThan(0);
    for (const resolution of resolutions) {
      expect(resolution).toMatch(/integrity: sha512-/);
    }
  });
});

describe("the wallet library", () => {
  // Every advisory `pnpm audit` reports for the dashboard sits under
  // @reown/appkit, which @stacks/connect imports only when given a
  // WalletConnect project id. The dashboard must never pass one.
  it("is never given a WalletConnect option", () => {
    const dir = "apps/dashboard/src";
    for (const file of readdirSync(dir)) {
      const source = read(join(dir, file));
      expect(source, file).not.toMatch(/walletConnect|@reown|@walletconnect/i);
    }
  });
});

describe("CI", () => {
  const workflows = readdirSync(".github/workflows").map((file) =>
    read(join(".github/workflows", file)),
  );

  it("pins every action by commit SHA", () => {
    for (const workflow of workflows) {
      for (const [, ref] of workflow.matchAll(/uses: \S+@(\S+)/g)) {
        expect(ref).toMatch(/^[0-9a-f]{40}$/);
      }
    }
  });

  it("reads only, holds no secret, runs on hosted runners and drops the token after checkout", () => {
    for (const workflow of workflows) {
      expect(workflow).not.toMatch(/pull_request_target|workflow_run/);
      expect(workflow).toMatch(/^permissions:\n {2}contents: read$/m);
      expect(workflow).not.toMatch(/\$\{\{\s*secrets\./);
      // The repo is public, so a fork's pull request can rewrite a workflow.
      // No job may name a self-hosted runner: every job is GitHub-hosted,
      // with a literal label a fork cannot steer by an expression.
      expect(workflow).not.toMatch(/self-hosted/);
      const jobs = workflow.match(/^ {4}runs-on: .*$/gm) ?? [];
      expect(jobs.length).toBeGreaterThan(0);
      for (const runsOn of jobs) {
        expect(runsOn).toBe("    runs-on: ubuntu-latest");
      }
      const checkouts = workflow.match(/uses: actions\/checkout@/g) ?? [];
      const dropped = workflow.match(/persist-credentials: false/g) ?? [];
      expect(dropped.length).toBe(checkouts.length);
    }
  });
});

describe("secrets", () => {
  it.each([
    "apps/dashboard/testnet.config.json",
    ".env",
    ".env.local",
    ".cache/x",
    "settings/Testnet.toml",
    "settings/Mainnet.toml",
    "tests/bitflow-remote/settings/Testnet.toml",
    "tests/bitflow-remote/settings/Mainnet.toml",
    "deployments/default.testnet-plan.yaml",
  ])("git ignores %s", (path) => {
    expect(git("check-ignore", "--no-index", path).trim()).toBe(path);
  });

  it("tracks only the Simnet and Devnet settings, with Clarinet's public test mnemonics", () => {
    const settings = git("ls-files", "*settings/*.toml").trim().split("\n");
    for (const path of settings) {
      expect(path).toMatch(/(^|\/)settings\/(Simnet|Devnet)\.toml$/);
    }
    const mnemonics = new Set(
      settings.flatMap((path) =>
        [...read(path).matchAll(/^mnemonic = "([^"]+)"/gm)].map((m) => m[1]),
      ),
    );
    const documented = new Set(
      [...read("settings/Simnet.toml").matchAll(/^mnemonic = "([^"]+)"/gm)].map(
        (m) => m[1],
      ),
    );
    expect([...mnemonics].filter((m) => !documented.has(m))).toStrictEqual([]);
  });
});
