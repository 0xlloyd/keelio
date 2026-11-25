// What replaces `simnet-harness.ts` on a real network: the agent's `Chain`
// over a Stacks node. It only reads. The example never runs it against a
// network; tests/example-agent.test.ts runs it against a stand-in `fetch`
// that answers from the simnet.
//
// The SDK's `stacksApiClient` covers the contract reads. The SDK has no call
// for the burn height, the block time or the contract's print events, so you
// supply those three from your own node or API client. There is no `Wallet`
// here at all: signing and broadcasting belong to the wallet that holds the
// agent's key, and Keelio never does either.
import {
  stacksApiClient,
  type FetchLike,
} from "../../packages/sdk/src/index.js";
import type { Chain } from "./agent.js";

export interface NetworkChainOptions {
  /** The node or API root. */
  baseUrl: string;
  /** The simulated caller for read-only calls; any valid principal. */
  sender: string;
  /** Injected: the SDK never reads `globalThis.fetch`. */
  fetch: FetchLike;
  /** The current burn block height, from your node. */
  burnHeight: Chain["burnHeight"];
  /** The latest Stacks block's time in ms, from your node. */
  blockTimeMs: Chain["blockTimeMs"];
  /** The vault contract's print events, oldest first, from your node. */
  journal: Chain["journal"];
}

export function networkChain(options: NetworkChainOptions): Chain {
  const { baseUrl, sender, fetch, burnHeight, blockTimeMs, journal } = options;
  return {
    client: stacksApiClient({ baseUrl, sender, fetch }),
    burnHeight,
    blockTimeMs,
    journal,
  };
}
