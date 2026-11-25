// Test-only: the MCP client side, re-exported so tests outside this package
// resolve it from this package's own dependencies. Not part of `src`.
export { Client } from "@modelcontextprotocol/sdk/client/index.js";
export { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
export type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
