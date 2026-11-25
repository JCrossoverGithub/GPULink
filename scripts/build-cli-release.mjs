#!/usr/bin/env node
// Explicit release candidate build. Never publishes or starts services.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareCliPackage } from './build-cli-package.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCli = process.env.npm_execpath;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = (file, data) => writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
function npm(args, cwd) {
  return execFileSync(process.execPath, [npmCli, ...args], { cwd, encoding: 'utf8', windowsHide: true, timeout: 240_000 });
}
function git(args) {
  return execFileSync('git', args, {cwd: root, encoding: 'utf8'}).trim();
}
let scratch, output, complete = false;
try {
  if (!npmCli || Number(process.versions.node.split('.')[0]) < 24) throw new Error('Run npm run build:cli:release with Node.js 24+.');
  if (process.argv.length !== 3) throw new Error('Supply a NEW output directory: npm run build:cli:release -- <directory>');
  const dest = path.resolve(process.argv[2]);
  const revision = git(['rev-parse', 'HEAD']);
  const clean = git(['status', '--porcelain', '--untracked-files=all']) === '';
  if (git(['ls-files', '--others', '--exclude-standard', '--', 'src']) ||
      git(['ls-files', '--others', '--ignored', '--exclude-standard', '--', 'src'])) {
    throw new Error('Untracked or ignored files under src; remove them from the build checkout before packaging.');
  }
  // New directory only: never replace an existing candidate or delete operator data.
  mkdirSync(path.dirname(dest), {recursive: true, mode: 0o700});
  mkdirSync(dest, {mode: 0o700});
  output = dest;
  scratch = mkdtempSync(path.join(os.tmpdir(), 'gpl-release-'));
  const stage = prepareCliPackage(root, path.join(scratch, 'package'));
  const pkgFile = path.join(stage, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
  // Reuse exactly the checked-in dependency graph. Bundle it for a network-free consumer install.
  const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  if (lock.lockfileVersion !== 3 || !lock.packages?.[''] ||
      JSON.stringify(lock.packages[''].dependencies) !== JSON.stringify(pkg.dependencies)) {
    throw new Error('Root lockfile does not match CLI dependency contract.');
  }
  pkg.bundleDependencies = Object.keys(pkg.dependencies);
  json(pkgFile, pkg);
  lock.name = pkg.name;
  lock.packages[''].name = pkg.name;
  lock.packages[''].version = pkg.version;
  lock.packages[''].license = pkg.license;
  lock.packages[''].bin = pkg.bin;
  json(path.join(stage, 'package-lock.json'), lock);
  npm(['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], stage);
  const pack = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', scratch], stage));
  const expected = `gpulink-cli-${pkg.version}.tgz`;
  if (pack.length !== 1 || pack[0].filename !== expected ||
      !pkg.bundleDependencies.every(name => pack[0].bundled?.includes(name))) {
    throw new Error('npm pack did not include all declared runtime dependencies.');
  }
  const tarball = path.join(scratch, expected);
  const bytes = readFileSync(tarball);
  copyFileSync(tarball, path.join(dest, expected), constants.COPYFILE_EXCL);
  writeFileSync(path.join(dest, 'SHA256SUMS'), `${sha256(bytes)}  ${expected}\n`, {flag:'wx'});
  json(path.join(dest, 'release.json'), {
    schemaVersion: 1, package: pkg.name, version: pkg.version, artifact: expected,
    sha256: sha256(bytes), bytes: bytes.length,
    sourceRevision: clean ? revision : null, baseRevision: revision, workingTreeClean: clean,
    dependencyLockSha256: sha256(readFileSync(path.join(root, 'package-lock.json'))),
    builderNode: process.version, builderPlatform: process.platform, builderArch: process.arch,
    status: 'candidate-not-published',
  });
  complete = true;
  console.log(`PASS: CLI release candidate built in ${dest}; dependencies bundled; SHA-256 recorded.`);
  if (!clean) console.log('NOTE: dirty-tree QA candidate; not eligible for publication. Build from a clean reviewed commit for release.');
} catch (error) {
  console.error(`CLI release build failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (scratch) rmSync(scratch, {recursive:true, force:true});
  if (output && !complete) rmSync(output, {recursive:true, force:true});
}
