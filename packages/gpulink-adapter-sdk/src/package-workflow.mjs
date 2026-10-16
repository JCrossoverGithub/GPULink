/**
 * DP3 developer kit: portable single-file GLIP adapter bundle and operator
 * catalog preview. No GPULink Core/worker imports, installs, signing, approval,
 * process launch, or third-party isolation. Not a general dependency lock.
 */
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {copyFile, lstat, mkdir, open, readFile, readdir, realpath, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';

const MAX_PROGRAM = 4 * 1024 * 1024; // Existing trusted catalog asset cap.
const MAX_INTERPRETER = 64 * 1024 * 1024;
const MAX_RECIPE = 16 * 1024;
const MAX_LOCK = 16 * 1024;
const HEX = /^[a-f0-9]{64}$/u;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u;
const SOURCE_NAME = 'gpulink.adapter.json';
const LOCK_NAME = 'gpulink.adapter.lock.json';
const isRecord = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v, names) => isRecord(v) && Object.keys(v).sort().join(',') === [...names].sort().join(',');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export class AdapterPackageError extends Error {
  constructor(code) {super(`GPULink adapter package: ${code}`); this.code = code;}
}
function requireThat(ok, code) {if (!ok) throw new AdapterPackageError(code);}
function validateEntry(entry) {
  requireThat(typeof entry === 'string' && NAME.test(entry) &&
    ![SOURCE_NAME, LOCK_NAME, '.', '..'].includes(entry), 'invalid_entry_name');
}
function validateManifest(m) {
  requireThat(exact(m, ['schemaVersion','type','adapterId','version','executionMode']) &&
    m.schemaVersion === 2 && m.executionMode === 'streaming-gateway' &&
    typeof m.type === 'string' && m.type.length > 0 && m.type.length <= 100 &&
    typeof m.adapterId === 'string' && m.adapterId.length <= 200 && IDENTIFIER.test(m.adapterId) &&
    typeof m.version === 'string' && m.version.length <= 100 && SEMVER.test(m.version),
  'invalid_v2_manifest');
  // Stable field order for byte-identical package locks from equivalent recipes.
  return {schemaVersion:2, type:m.type, adapterId:m.adapterId,
    version:m.version, executionMode:'streaming-gateway'};
}
function readDescriptor(v, isLock) {
  const keys = ['schemaVersion', 'manifest', 'entry', ...(isLock ? ['sha256'] : [])];
  const withCompletion = [...keys, 'completionMode'];
  requireThat((exact(v, keys) || exact(v, withCompletion)) && v.schemaVersion === 1,
    'invalid_package_descriptor');
  validateEntry(v.entry);
  const manifest = validateManifest(v.manifest);
  requireThat(v.completionMode === undefined || v.completionMode === 'explicit-text-v1',
    'unsupported_completion_mode');
  if (isLock) requireThat(typeof v.sha256 === 'string' && HEX.test(v.sha256), 'invalid_lock_hash');
  return {schemaVersion:1, manifest, entry:v.entry,
    ...(isLock ? {sha256:v.sha256} : {}),
    ...(v.completionMode === undefined ? {} : {completionMode:v.completionMode})};
}
async function readRegular(file, maxBytes, requireOperatorPermissions = false) {
  let stat;
  try {stat = await lstat(file);} catch {throw new AdapterPackageError('file_unavailable');}
  requireThat(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= maxBytes,
    'invalid_file_type_or_size');
  if (requireOperatorPermissions && process.platform !== 'win32') {
    const uid = process.getuid?.();
    requireThat(!(stat.mode & 0o022) && (uid === undefined || stat.uid === uid || stat.uid === 0),
      'unsafe_operator_file');
  }
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    requireThat(opened.isFile() && opened.size === stat.size && opened.size <= maxBytes &&
      opened.ino === stat.ino && opened.dev === stat.dev, 'file_changed');
    return await handle.readFile();
  } catch (err) {
    if (err instanceof AdapterPackageError) throw err;
    throw new AdapterPackageError('file_unavailable');
  } finally {await handle?.close();}
}
function jsonBytes(value) {return Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');}
function parseJson(bytes, code) {
  try {return JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes));}
  catch {throw new AdapterPackageError(code);}
}
async function directory(file) {
  let stat;
  try {stat = await lstat(file);} catch {throw new AdapterPackageError('directory_unavailable');}
  requireThat(stat.isDirectory() && !stat.isSymbolicLink(), 'invalid_directory');
}

/** Build an offline relocatable directory (not an operator install). */
export async function packAdapter({sourceDir, outDir}) {
  requireThat(typeof sourceDir === 'string' && path.isAbsolute(sourceDir) &&
    typeof outDir === 'string' && path.isAbsolute(outDir) && sourceDir !== outDir,
    'absolute_paths_required');
  await directory(sourceDir);
  const recipe = readDescriptor(parseJson(await readRegular(path.join(sourceDir, SOURCE_NAME), MAX_RECIPE),
    'invalid_recipe_json'), false);
  const program = await readRegular(path.join(sourceDir, recipe.entry), MAX_PROGRAM);
  // Do not overwrite a pre-existing package, even if its contents look similar.
  try {await mkdir(outDir, {mode:0o700});}
  catch {throw new AdapterPackageError('output_must_not_exist');}
  try {
    await copyFile(path.join(sourceDir, recipe.entry), path.join(outDir, recipe.entry), constants.COPYFILE_EXCL);
    const lock = {...recipe, sha256:hash(program)};
    // Explicit permissions; the package does not mutate its source.
    await writeFile(path.join(outDir, LOCK_NAME), jsonBytes(lock), {flag:'wx', mode:0o600});
    return await inspectAdapter({bundleDir:outDir});
  } catch (e) {
    await rm(outDir, {recursive:true, force:true});
    throw e;
  }
}

/** Integrity check only. A self-declared digest is not author authenticity. */
export async function inspectAdapter({bundleDir}) {
  requireThat(typeof bundleDir === 'string' && path.isAbsolute(bundleDir), 'absolute_paths_required');
  await directory(bundleDir);
  const lock = readDescriptor(parseJson(await readRegular(path.join(bundleDir, LOCK_NAME), MAX_LOCK),
    'invalid_lock_json'), true);
  const filenames = (await readdir(bundleDir)).sort();
  requireThat(filenames.join('\n') === [LOCK_NAME, lock.entry].sort().join('\n'),
    'unexpected_bundle_files');
  const bytes = await readRegular(path.join(bundleDir, lock.entry), MAX_PROGRAM);
  requireThat(hash(bytes) === lock.sha256, 'artifact_digest_mismatch');
  return Object.freeze({lock:Object.freeze(lock), programPath:path.join(bundleDir, lock.entry)});
}

/** Produce only a JSON CANDIDATE for manual operator review and catalog installation. */
export async function operatorCatalogCandidate({bundleDir, interpreter = null, direct = false}) {
  requireThat(direct === (interpreter === null), 'choose_direct_or_interpreter');
  const {lock, programPath} = await inspectAdapter({bundleDir});
  let executable, args, assets;
  if (direct) {
    executable = programPath;
    const stat = await lstat(executable);
    requireThat(process.platform === 'win32' || Boolean(stat.mode & 0o100),
      'direct_program_not_executable');
    args = [];
    assets = [];
  } else {
    requireThat(typeof interpreter === 'string' && path.isAbsolute(interpreter),
      'absolute_interpreter_required');
    // Resolve common system interpreter symlinks for the loader's O_NOFOLLOW rule.
    executable = await realpath(interpreter);
    requireThat(lock.entry.endsWith('.py'), 'python_entry_required');
    args = ['-I', '-B', programPath];
    assets = [{path:programPath, sha256:lock.sha256}];
  }
  const digest = hash(await readRegular(executable, MAX_INTERPRETER, true));
  // Existing catalog v1, existing manifest v2, no schema changes or activation.
  return {schemaVersion:1, adapters:[{
    manifest:lock.manifest,
    ...(lock.completionMode ? {completionMode:lock.completionMode} : {}),
    command:{executable, sha256:digest, args, assets},
  }]};
}

export const PACKAGE_FILE_NAMES = Object.freeze({recipe:SOURCE_NAME, lock:LOCK_NAME});
