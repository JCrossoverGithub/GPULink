import { WorkerAgent } from "./agent.mjs";
import { loadWorkerConfig } from "./config.mjs";

const agent = new WorkerAgent(loadWorkerConfig());
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
