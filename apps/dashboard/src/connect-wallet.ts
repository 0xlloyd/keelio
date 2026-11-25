// The session's `Wallet` over @stacks/connect 8.2.7 (`connect` and
// `request("stx_callContract", …)`), written against the installed package's
// type definitions and README. The library's two functions are arguments, so
// this file imports only their types and tests can pass the real `request`
// with a stand-in provider.
//
// The call's post-conditions and "deny" mode go to `request` as the SDK built
// them. The library hex-encodes Clarity values and post-conditions for the
// wallet; tests/dashboard-wallet.test.ts decodes what a provider receives and
// compares it with the SDK's call.
import type { connect, getSelectedProviderId, request } from "@stacks/connect";
import { validateStacksAddress } from "@stacks/transactions";
import type { Wallet } from "./wallet-chain.js";

export interface ConnectApi {
  connect: typeof connect;
  request: typeof request;
  getSelectedProviderId: typeof getSelectedProviderId;
}

/** Options every request carries. `provider` is set only by tests. */
export type ConnectOptions = Pick<
  NonNullable<Parameters<typeof connect>[0]>,
  "provider" | "approvedProviderIds" | "enableLocalStorage"
>;

/**
 * The wallets offered. The library's README lists `stx_callContract` on
 * "Xverse-like" wallets as having "no support for `postConditions`". A wallet
 * that drops them would sign a call without the limits the owner reviewed,
 * so only Leather, which the README lists as taking hex-encoded
 * post-conditions, is offered.
 */
export const APPROVED_PROVIDER_IDS: readonly string[] = ["LeatherProvider"];

/**
 * Without a provider in its options, `request` signs with whichever wallet
 * id is stored at that moment, and any page on the same origin can change
 * that id. So the adapter takes the wallet picked at connect, checks it is
 * offered, and hands `request` that wallet's provider object itself, which
 * the library then uses without reading the stored id. It also refuses to
 * sign once the stored id differs, so a switch is reported, not ignored.
 */
export function connectWallet(
  api: ConnectApi,
  options: ConnectOptions = { approvedProviderIds: [...APPROVED_PROVIDER_IDS] },
): Wallet {
  const pinned = options.provider !== undefined;
  let connected: { id: string; provider: unknown } | undefined;
  return {
    async connect(network) {
      connected = undefined;
      const { addresses } = await api.connect({ ...options, network });
      if (!pinned) {
        const id = api.getSelectedProviderId();
        if (id === null || !APPROVED_PROVIDER_IDS.includes(id)) {
          throw new Error("the wallet picked is not one this dashboard offers");
        }
        const provider = providerAt(id);
        if (provider === undefined) {
          throw new Error("the wallet picked is not installed in this browser");
        }
        connected = { id, provider };
      }
      // The answer also lists Bitcoin addresses.
      const stacks = addresses.filter(
        (entry) =>
          /^S[PMTN]/.test(entry.address) &&
          validateStacksAddress(entry.address),
      );
      const first = stacks[0];
      if (first === undefined) {
        throw new Error("the wallet returned no Stacks address");
      }
      return first.address;
    },

    async requestContractCall(call, context) {
      let requestOptions = options;
      if (!pinned) {
        if (connected === undefined) {
          throw new Error("connect a wallet first");
        }
        if (api.getSelectedProviderId() !== connected.id) {
          throw new Error(
            "the selected wallet changed since you connected; connect again",
          );
        }
        requestOptions = { ...options, provider: connected.provider as never };
      }
      const result = await api.request(requestOptions, "stx_callContract", {
        contract: `${call.contractAddress}.${call.contractName}`,
        functionName: call.functionName,
        functionArgs: call.functionArgs,
        postConditions: call.postConditions,
        postConditionMode: call.postConditionMode,
        network: context.network,
        address: context.owner,
      });
      if (typeof result.txid !== "string" || result.txid === "") {
        throw new Error(
          "the wallet returned no transaction id, so it may not have broadcast the call",
        );
      }
      return result.txid;
    },
  };
}

/**
 * The provider a wallet injects at the global path `id` (for example
 * `window.LeatherProvider`), as the library itself looks it up.
 */
function providerAt(id: string): unknown {
  let value: unknown = globalThis;
  for (const key of id.split(".")) {
    if (
      typeof value !== "object" ||
      value === null ||
      !Object.hasOwn(value, key)
    ) {
      return undefined;
    }
    value = (value as Record<string, unknown>)[key];
  }
  return value ?? undefined;
}
