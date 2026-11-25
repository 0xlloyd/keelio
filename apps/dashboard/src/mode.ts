// Which mode the page runs in. The simulation is the default; testnet mode is
// entered only by asking for it in the address: `?mode=testnet`.
export type Mode = "simulation" | "testnet";

/** The mode a URL's query string asks for. Anything unclear is the simulation. */
export function modeFromSearch(search: string): Mode {
  return new URLSearchParams(search).get("mode") === "testnet"
    ? "testnet"
    : "simulation";
}
