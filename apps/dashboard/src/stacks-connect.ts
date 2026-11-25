// The one place the wallet library is imported as code. Only testnet mode
// and its test load this file; the simulation never does.
export { connect, getSelectedProviderId, request } from "@stacks/connect";
