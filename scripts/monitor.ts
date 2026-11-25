// `pnpm run monitor`: the journal monitor's runner. It polls a chain, writes
// one JSON object per alert to stdout and keeps its cursor in a state file.
// It only reads: it never signs or broadcasts, and it sends nothing anywhere
// but stdout. Pipe stdout to your own alerting.
//
//
//   pnpm run monitor -- --simnet-demo
//   pnpm run monitor -- --config <file> --state <file> [--once]
//   pnpm run monitor -- (--simnet-demo | --config <file>) --digest
//       [--from <burn height>] [--to <burn height>] [--out <file>] [--json]
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { initSimnet } from "@stacks/clarinet-sdk";
import { Cl, type ClarityValue } from "@stacks/transactions";
import {
  ConfigError,
  createMonitor,
  fileStore,
  memoryStore,
  monitorSimnetChain,
  ownersWithBalance,
  parseConfig,
  readDigest,
  renderDigest,
  stacksApiChain,
  type Alert,
  type Digest,
  type DigestRange,
} from "../packages/monitor/src/index.js";
import type { VaultConfig } from "../packages/sdk/src/index.js";
import { runDemo, type Simnet } from "./demo.js";

const USAGE = [
  "usage:",
  "  pnpm run monitor -- --simnet-demo",
  "      Runs the story of `pnpm run demo`, then a second vault, on a fresh",
  "      in-process simnet, and prints the alerts the monitor raises.",
  "  pnpm run monitor -- --config <file> --state <file> [--once]",
  "      Polls the Stacks API named in the config file. See docs/monitoring.md.",
  "  pnpm run monitor -- (--simnet-demo | --config <file>) --digest",
  "        [--from <burn height>] [--to <burn height>] [--out <file>] [--json]",
  "      Reads once and writes the owner digest for those burn heights (all of",
  "      them by default) to stdout, or to the file. No alerts, no state file.",
].join("\n");

export function alertLine(alert: Alert): string {
  return `${JSON.stringify(alert)}\n`;
}

// The same numbers as scripts/demo.ts and tests/oracle-fixture.ts.
const ORACLE_PRICE = 9_000_000_000_000n;
const PRICE_SCALE = 10_000_000_000n;
const HOUR_MS = 3_600_000n;

export interface DemoSection {
  title: string;
  alerts: Alert[];
}

export interface MonitorDemoResult {
  sections: DemoSection[];
  /** The owners with a ledger balance at the end, from the journal alone. */
  owners: ReturnType<typeof ownersWithBalance>;
  /** The owner digest at the end of the story, for the range asked for. */
  digest: Digest;
}

/**
 * Runs `runDemo` from scripts/demo.ts unchanged, with the monitor watching,
 * then a second vault that shows the alerts the first story never reaches.
 * Polls after each part, and reads the digest for `range` (every burn height
 * by default) at the end. Prints nothing.
 */
export async function runMonitorDemo(
  simnet: Simnet,
  range: DigestRange = {},
): Promise<MonitorDemoResult> {
  const accounts = simnet.getAccounts();
  const account = (name: string): string => {
    const address = accounts.get(name);
    if (address === undefined) throw new Error(`no simnet account ${name}`);
    return address;
  };
  const deployer = account("deployer");
  const agent = account("wallet_2");
  const carol = account("wallet_3");
  const sbtc = `${deployer}.mock-sbtc`;
  const usd = `${deployer}.mock-usd`;
  const dex = `${deployer}.mock-dex`;
  const read: VaultConfig = {
    vault: "keelio-vault",
    tokens: [sbtc, usd],
    adapters: [dex],
    oracle: "mock-oracle",
    sbtcToken: sbtc,
    priceScale: PRICE_SCALE,
  };

  const chain = monitorSimnetChain(simnet, deployer);
  const monitor = createMonitor({ chain, read, store: memoryStore() });
  const sections: DemoSection[] = [];
  const poll = async (title: string) => {
    sections.push({ title, alerts: await monitor.poll() });
  };

  // The demo calls `simnet.callPublicFn`; send those calls through the
  // monitor's chain so it sees what a network's journal would hold.
  const watched = new Proxy(simnet, {
    get(target, property) {
      if (property === "callPublicFn") return chain.callPublicFn;
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await runDemo(watched);
  await poll(
    "The story of `pnpm run demo`: an owner opens a vault, the agent swaps twice, " +
      "three calls are refused, the owner pauses and withdraws",
  );

  const must = (
    contract: string,
    fn: string,
    args: ClarityValue[],
    sender: string,
  ) => {
    const { result } = chain.callPublicFn(contract, fn, args, sender);
    if (result.type !== "ok") {
      throw new Error(`${fn} returned ${Cl.prettyPrint(result)}`);
    }
  };
  const oracleAged = (ageMs: bigint) =>
    must(
      "mock-oracle",
      "set-value-aged",
      [Cl.stringAscii("BTC/USD"), Cl.uint(ORACLE_PRICE), Cl.uint(ageMs)],
      deployer,
    );
  const SWAP = 100_000n;
  // The oracle floor at $90,000 less 1% is 900 * 0.99 = 891 a sat.
  const swap = (amount = SWAP) =>
    chain.callPublicFn(
      "keelio-vault",
      "execute-swap",
      [
        Cl.principal(carol),
        Cl.principal(dex),
        Cl.principal(sbtc),
        Cl.principal(usd),
        Cl.uint(amount),
        Cl.uint(amount * 891n),
      ],
      agent,
    );

  // A second owner opens a vault with a short policy.
  must(
    "mock-sbtc",
    "mint",
    [Cl.uint(1_000_000), Cl.principal(carol)],
    deployer,
  );
  must("mock-dex", "set-rate", [Cl.uint(900), Cl.uint(1)], deployer);
  oracleAged(0n);
  const expiresAt = BigInt(simnet.burnBlockHeight) + 300n;
  must(
    "keelio-vault",
    "deposit",
    [Cl.principal(sbtc), Cl.uint(1_000_000)],
    carol,
  );
  must("keelio-vault", "set-agent", [Cl.principal(agent)], carol);
  must(
    "keelio-vault",
    "set-token-caps",
    [Cl.principal(sbtc), Cl.uint(SWAP), Cl.uint(250_000)],
    carol,
  );
  must("keelio-vault", "set-policy", [Cl.uint(0), Cl.uint(expiresAt)], carol);
  must(
    "keelio-vault",
    "allow-token",
    [Cl.principal(sbtc), Cl.bool(true)],
    carol,
  );
  must(
    "keelio-vault",
    "allow-token",
    [Cl.principal(usd), Cl.bool(true)],
    carol,
  );
  must(
    "keelio-vault",
    "allow-adapter",
    [Cl.principal(dex), Cl.bool(true)],
    carol,
  );
  must(
    "keelio-vault",
    "set-price-bounds",
    [Cl.uint(100), Cl.uint(HOUR_MS)],
    carol,
  );
  await poll("A second owner opens a vault whose policy lasts 300 burn blocks");

  if (swap().result.type !== "ok") throw new Error("the first swap failed");
  must("mock-dex", "set-rate", [Cl.uint(892), Cl.uint(1)], deployer);
  if (swap().result.type !== "ok") throw new Error("the second swap failed");
  await poll(
    "The agent swaps at the oracle price, then again after the DEX price " +
      "falls to just above the floor; the second swap also reaches 80% of the day cap",
  );

  // The approval band: above 5,000 sats the agent must ask.
  const ASK = 10_000n;
  const trade = [
    Cl.principal(dex),
    Cl.principal(sbtc),
    Cl.principal(usd),
    Cl.uint(ASK),
    Cl.uint(ASK * 891n),
  ];
  const request = () =>
    must(
      "keelio-vault",
      "request-swap",
      [Cl.principal(carol), ...trade],
      agent,
    );
  must(
    "keelio-vault",
    "set-approval-threshold",
    [Cl.principal(sbtc), Cl.some(Cl.uint(5_000))],
    carol,
  );
  if (swap(ASK).result.type !== "err") {
    throw new Error("a swap above the approval threshold was not refused");
  }
  // The owner approves the request it read: the trade and the burn height
  // the request was made at.
  const requestedAt = BigInt(simnet.burnBlockHeight);
  request();
  must("keelio-vault", "approve-swap", [...trade, Cl.uint(requestedAt)], carol);
  request();
  must("keelio-vault", "reject-swap", [], carol);
  request();
  must("keelio-vault", "cancel-swap-request", [Cl.principal(carol)], agent);
  request();
  await poll(
    "The owner sets an approval threshold: the agent's swap above it is refused, " +
      "so it asks. The owner approves one request and rejects one, the agent " +
      "withdraws one, and a fourth is left waiting",
  );

  simnet.mineEmptyBurnBlocks(7);
  // Mining moved block time; keep the price fresh for this part.
  oracleAged(0n);
  must(
    "keelio-vault",
    "set-approval-threshold",
    [Cl.principal(sbtc), Cl.none()],
    carol,
  );
  await poll(
    "Seven burn blocks later the request has expired unanswered, and the owner " +
      "clears the threshold",
  );

  oracleAged((HOUR_MS * 5n) / 6n);
  await poll("The oracle's price is 50 minutes old; the owner allows 60");

  oracleAged(HOUR_MS + 1n);
  // Inside every cap, so only the price's age refuses it.
  swap(SWAP / 10n);
  await poll(
    "The oracle's price is older than the owner allows, and the agent's swap is refused",
  );

  simnet.mineEmptyBurnBlocks(Number(expiresAt) - 100 - simnet.burnBlockHeight);
  await poll("100 burn blocks before the policy expires");

  simnet.mineEmptyBurnBlocks(101);
  await poll("One burn block after the policy expired");

  return {
    sections,
    owners: ownersWithBalance(await monitor.state()),
    digest: await readDigest({ chain, read }, range),
  };
}

interface Args {
  simnetDemo: boolean;
  once: boolean;
  config: string | null;
  state: string | null;
  /** Write the owner digest instead of alerts. */
  digest: boolean;
  /** The digest's first and last burn height; `null` for the default. */
  from: bigint | null;
  to: bigint | null;
  /** Where the digest goes instead of stdout. */
  out: string | null;
  /** The digest as one JSON object instead of text. */
  json: boolean;
}

function height(value: string | undefined, arg: string): bigint {
  if (value === undefined || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new ConfigError(`${arg} needs a burn height`);
  }
  return BigInt(value);
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    simnetDemo: false,
    once: false,
    config: null,
    state: null,
    digest: false,
    from: null,
    to: null,
    out: null,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    // pnpm passes its own `--` separator through.
    if (arg === "--") continue;
    if (arg === "--simnet-demo") args.simnetDemo = true;
    else if (arg === "--once") args.once = true;
    else if (arg === "--digest") args.digest = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--from") args.from = height(argv[++i], arg);
    else if (arg === "--to") args.to = height(argv[++i], arg);
    else if (arg === "--config" || arg === "--state" || arg === "--out") {
      const value = argv[++i];
      if (value === undefined) throw new ConfigError(`${arg} needs a path`);
      args[arg.slice(2) as "config" | "state" | "out"] = value;
    } else throw new ConfigError(`unknown argument ${arg}`);
  }
  if (args.simnetDemo) {
    if (args.config !== null || args.state !== null || args.once) {
      throw new ConfigError(
        "--simnet-demo takes no other argument but --digest and its options",
      );
    }
  } else if (args.digest) {
    if (args.config === null) throw new ConfigError("--config is required");
    if (args.state !== null || args.once) {
      throw new ConfigError(
        "--digest reads no state file and runs once: leave out --state and --once",
      );
    }
  } else if (args.config === null || args.state === null) {
    throw new ConfigError("--config and --state are both required");
  }
  if (!args.digest) {
    if (
      args.from !== null ||
      args.to !== null ||
      args.out !== null ||
      args.json
    ) {
      throw new ConfigError("--from, --to, --out and --json need --digest");
    }
  } else if (args.from !== null && args.to !== null && args.from > args.to) {
    throw new ConfigError("--from must not be above --to");
  }
  return args;
}

function rangeOf(args: Args): DigestRange {
  return {
    ...(args.from === null ? {} : { fromHeight: args.from }),
    ...(args.to === null ? {} : { toHeight: args.to }),
  };
}

/** Writes the digest to `--out`, or to stdout. It is sent nowhere else. */
function writeDigest(digest: Digest, args: Args): void {
  const body = args.json ? `${JSON.stringify(digest)}\n` : renderDigest(digest);
  if (args.out === null) process.stdout.write(body);
  else writeFileSync(args.out, body);
}

async function demo(args: Args): Promise<void> {
  // The simnet echoes every contract `print` with console.log. Drop that:
  // stdout carries only alerts, stderr only the lines below.
  console.log = () => {};
  const note = (line: string) => process.stderr.write(`${line}\n`);
  note(
    "Keelio monitor demo on a fresh in-process simnet. Nothing is signed or broadcast.",
  );
  if (args.digest) {
    note("The owner digest of the whole story follows; no alerts are printed.");
    const result = await runMonitorDemo(await initSimnet(), rangeOf(args));
    writeDigest(result.digest, args);
    return;
  }
  note("Alerts are the JSON lines on stdout; these notes are on stderr.");
  const result = await runMonitorDemo(await initSimnet());
  for (const section of result.sections) {
    note("");
    note(`# ${section.title}`);
    for (const alert of section.alerts) process.stdout.write(alertLine(alert));
  }
  note("");
  note("# Owners with a ledger balance, from the journal alone");
  for (const { owner, balances } of result.owners) {
    note(`${owner} ${JSON.stringify(balances)}`);
  }
}

/** How long one request to the Stacks API may take. */
const REQUEST_TIMEOUT_MS = 30_000;

async function live(args: Args): Promise<void> {
  const config = parseConfig(JSON.parse(readFileSync(args.config!, "utf8")));
  const chain = stacksApiChain({
    baseUrl: config.apiUrl,
    sender: config.sender,
    vault: config.read.vault,
    // A request that never answers would stop the loop, and with it every
    // alert, without a word. Timed out, it is a failed poll that is retried.
    fetch: (url, init) =>
      fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
  });
  if (args.digest) {
    writeDigest(
      await readDigest(
        { chain, read: config.read, thresholds: config.thresholds },
        rangeOf(args),
      ),
      args,
    );
    return;
  }
  const monitor = createMonitor({
    chain,
    read: config.read,
    store: fileStore(args.state!),
    thresholds: config.thresholds,
    emit: (alert) => {
      process.stdout.write(alertLine(alert));
    },
  });
  if (args.once) {
    await monitor.poll();
    return;
  }
  let stopped = false;
  let wake = () => {};
  const stop = () => {
    stopped = true;
    wake();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  while (!stopped) {
    try {
      await monitor.poll();
    } catch (error) {
      // A failed poll saved nothing, so the next one starts from the same
      // cursor: nothing is skipped.
      console.error(
        `poll failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (stopped) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, config.intervalMs);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    await (args.simnetDemo ? demo(args) : live(args));
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`${error.message}\n${USAGE}`);
    } else {
      console.error(error);
    }
    process.exitCode = 1;
  }
}
