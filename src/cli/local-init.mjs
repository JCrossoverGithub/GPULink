import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { defaultLocalSetupDirectory } from "./setup-directory.mjs";

const defaultDirectory = defaultLocalSetupDirectory();
const files = Object.freeze([
  "control-plane.env",
  "worker.env",
  "client.env",
  "admin.env",
]);

function localPath(value) {
  if (/[\r\n"]/.test(value)) {
    throw new Error("Setup directory must not contain newlines or double quotes.");
  }
  return value.replaceAll("\\", "/");
}

function renderEnvironment(entries) {
  return `${Object.entries(entries)
    .map(([key, value]) => `${key}="${localPath(String(value))}"`)
    .join("\n")}\n`;
}

function writePrivateFile(filename, contents) {
  const fd = openSync(
    filename,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    writeFileSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Create a fresh, localhost-only GPULink configuration. Never starts a service
 * or modifies an existing deployment. The generated values are never returned.
 */
export function createLocalSetup(outputDirectory = defaultDirectory) {
  const directory = path.resolve(outputDirectory);
  if (existsSync(directory)) {
    throw new Error("Setup directory already exists; choose a new directory. Nothing was overwritten.");
  }
  localPath(directory);
  const token = () => randomBytes(32).toString("hex");
  const clientToken = token();
  const workerToken = token();
  const adminToken = token();
  const signingKey = token();
  const origin = "http://127.0.0.1:8088";
  const profiles = {
    "control-plane.env": {
      GPULINK_CONTROL_HOST: "127.0.0.1",
      GPULINK_CONTROL_PORT: "8088",
      GPULINK_CONTROL_DATABASE: "sqlite",
      GPULINK_CONTROL_DATA_PATH: path.join(directory, "control-plane.sqlite"),
      GPULINK_CLIENT_TOKEN: clientToken,
      GPULINK_WORKER_TOKEN: workerToken,
      GPULINK_ADMIN_TOKEN: adminToken,
      GPULINK_DATA_PLANE_SIGNING_KEY: signingKey,
    },
    "worker.env": {
      GPULINK_CONTROL_PLANE_URL: origin,
      GPULINK_WORKER_NAME: "local-gpu-worker",
      GPULINK_WORKER_TOKEN: workerToken,
    },
    "client.env": {
      GPULINK_URL: origin,
      GPULINK_CLIENT_TOKEN: clientToken,
    },
    "admin.env": {
      GPULINK_URL: origin,
      GPULINK_ADMIN_TOKEN: adminToken,
    },
  };

  // The default parent is under the repository's gitignored data/ directory.
  mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
  mkdirSync(directory, { mode: 0o700 }); // EEXIST protects concurrent runs.
  try {
    for (const file of files) {
      writePrivateFile(path.join(directory, file), renderEnvironment(profiles[file]));
    }
  } catch (error) {
    // This directory did not exist before this operation; remove only its contents.
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return { directory, filenames: [...files] };
}

export function runLocalInit(args, output = console) {
  if (args.length < 1 || args[0] !== "local" || args.length > 2 || args[1] === "") {
    output.error("Usage: gpulink init local [output-directory]");
    output.error("Creates private localhost-only configuration; never starts GPULink or provisions hardware.");
    return 2;
  }
  try {
    const result = createLocalSetup(args[1] || defaultDirectory);
    output.log(`Created local-only configuration in ${result.directory}`);
    output.log(`Files: ${result.filenames.join(", ")}`);
    output.log("No services started. No secrets printed. This is not a production or cross-machine deployment.");
    output.log("See the GPULink self-hosting guide before starting any process.");
    if (process.platform === "win32") {
      output.log("SECURITY: Windows file-mode bits are not an NTFS ACL check. Restrict directory access to your Windows account.");
    }
    return 0;
  } catch (error) {
    output.error(`Local setup failed: ${error.message}`);
    return 1;
  }
}
