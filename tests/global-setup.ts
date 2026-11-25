import { initSimnet } from "@stacks/clarinet-sdk";

// initSimnet writes deployments/default.simnet-plan.yaml when it is missing.
// Test files run in parallel forks, and in a fresh checkout several of them
// would write that file at once while others read it half-written ("unable to
// read file missing field `name`"). Starting one simnet here, before any fork,
// writes the plan once so every test file only reads it.
export default async function setup() {
  await initSimnet();
}
