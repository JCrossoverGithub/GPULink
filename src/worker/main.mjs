import { WorkerAgent } from "./agent.mjs";
import { loadWorkerConfig } from "./config.mjs";
import { loadApprovedSessionAdapters } from "./approved-session-adapters.mjs";
import { loadApprovedSubprocessSessionAdapters } from "./approved-subprocess-adapters.mjs";

const config = loadWorkerConfig();
const sessionAdapters = [
  ...await loadApprovedSessionAdapters(config.approvedAdapterCatalogPath),
  ...await loadApprovedSubprocessSessionAdapters(config.approvedSubprocessCatalogPath),
];
const agent = new WorkerAgent(config, { sessionAdapters });
await agent.start();

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ event: "worker_stopping", signal }));
  try {
    await agent.stop();
    process.exitCode = 0;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
