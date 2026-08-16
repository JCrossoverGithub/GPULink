import { createControlPlane } from "./app.mjs";
import { loadControlPlaneConfig } from "./config.mjs";

const config = loadControlPlaneConfig();
const controlPlane = createControlPlane(config);
const address = await controlPlane.start();

console.log(JSON.stringify({
  event: "control_plane_started",
  address: typeof address === "object" ? address.address : config.host,
  port: typeof address === "object" ? address.port : config.port,
  dataPath: config.dataPath,
}));

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ event: "control_plane_stopping", signal }));
  try {
    await controlPlane.stop();
    process.exitCode = 0;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
