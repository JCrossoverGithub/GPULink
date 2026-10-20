#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = path.resolve(process.argv[2] ?? path.join(repoRoot, "data", "cli-artifacts"));

// Packaging is explicit and opt-in. Never npm-publish the private monorepo.
export function prepareCliPackage(sourceRoot, outputRoot) {
  const root = path.resolve(sourceRoot);
  const output = path.resolve(outputRoot);
  if (existsSync(output)) throw new Error("Staging destination already exists; nothing overwritten.");
  const original = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  if (original.private !== true) throw new Error("Refusing to package an unexpectedly public repository root.");
  if (!original.dependencies || !original.engines?.node) throw new Error("Missing dependency or Node engine contract.");
  const source = path.join(root, "src");
  if (!lstatSync(source).isDirectory()) throw new Error("Core source directory missing.");
  mkdirSync(output, { recursive: false, mode: 0o700 });
  try {
    // Source and runtime are one explicitly versioned local-installation artifact.
    // No repository scripts, tests, git metadata, cloud configs or data are packaged.
    cpSync(source, path.join(output, "src"), {
      recursive: true, filter: (entry) => {
        const stat = lstatSync(entry);
        if (stat.isSymbolicLink()) throw new Error("Symlink in source is not permitted in CLI artifact.");
        const name = path.basename(entry);
        if (stat.isFile() && (/\.(env|pem|key|p12|pfx|sqlite|sqlite-wal|sqlite-shm)$/iu.test(name) || name === ".env")) {
          throw new Error("Credential or private state file in source; refusing to package.");
        }
        return true;
      },
    });
    cpSync(path.join(root, "LICENSE"), path.join(output, "LICENSE"));
    writeFileSync(path.join(output, "package.json"), JSON.stringify({
      name: "@gpulink/cli",
      version: original.version,
      description: "GPULink developer/operator CLI and matching local Core runtime (preview)",
      private: true, // local installable tarball; never silently publish
      type: "module",
      license: "Apache-2.0",
      engines: original.engines,
      dependencies: original.dependencies,
      bin: { gpulink: "./src/cli/main.mjs" },
      files: ["src", "LICENSE", "README.md"],
    }, null, 2) + "\n");
    writeFileSync(path.join(output, "README.md"),
      "# @gpulink/cli — Local developer preview\n\n" +
      "A self-contained GPULink CLI + matching Core source runtime for independently owned local deployments. " +
      "Requires Node.js 24+. No automatic daemon, GPU workload, external endpoint, or cloud provisioning.\n" +
      "This artifact is private/nonpublished pending clean-machine release acceptance.\n");
    if (!existsSync(path.join(output, "src/cli/main.mjs")) ||
        !existsSync(path.join(output, "src/control-plane/main.mjs")) ||
        !existsSync(path.join(output, "src/worker/main.mjs"))) {
      throw new Error("Incomplete CLI/Core runtime artifact.");
    }
    return output;
  } catch (error) {
    rmSync(output, { recursive: true, force: true });
    throw error;
  }
}

// Executed only when run as the build command, never on import by tests.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let stage;
  try {
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    stage = mkdtempSync(path.join(os.tmpdir(), "gpulink-cli-pack-"));
    const bundle = prepareCliPackage(repoRoot, path.join(stage, "package"));
    const npmCli = process.env.npm_execpath;
    if (process.platform === "win32" && !npmCli) {
      throw new Error("On Windows run via npm run build:cli to locate the npm CLI safely.");
    }
    const npmArgs = ["pack", "--json", "--pack-destination", destination];
    const pack = JSON.parse(execFileSync(npmCli ? process.execPath : "npm",
      npmCli ? [npmCli, ...npmArgs] : npmArgs, {
        cwd: bundle, encoding: "utf8", windowsHide: true,
      }));
    if (pack.length !== 1 || !pack[0].filename) throw new Error("Unexpected npm pack output.");
    const artifact = path.join(destination, pack[0].filename);
    if (!existsSync(artifact)) throw new Error("CLI tarball was not created.");
    console.log(`PASS: Private installable CLI + Core tarball: ${artifact}`);
    console.log("No npm publish, service start, GPU workload, or deployment performed.");
  } catch (error) {
    console.error(`CLI packaging failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    if (stage) rmSync(stage, { recursive: true, force: true });
  }
}
