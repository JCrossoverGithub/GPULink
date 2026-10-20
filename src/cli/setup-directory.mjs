import { homedir } from "node:os";
import path from "node:path";

// Deliberately independent of the source checkout and process.cwd().
// No implicit lookup of another GPULink deployment is permitted.
export function defaultLocalSetupDirectory() {
  return path.join(homedir(), ".gpulink", "instances", "local");
}

export function parseGlobalCliOptions(argv) {
  if (argv[0] !== "--config-dir") return { args: argv, directory: null };
  if (!argv[1] || argv[1].startsWith("--")) {
    throw new Error("--config-dir requires an explicit directory path");
  }
  return { args: argv.slice(2), directory: path.resolve(argv[1]) };
}
