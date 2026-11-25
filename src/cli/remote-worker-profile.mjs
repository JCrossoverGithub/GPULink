import { randomBytes, X509Certificate } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { rootCertificates } from 'node:tls';
import { normalizeServerOrigin, readServerSetup } from './server-profile.mjs';
import { runDoctor } from './doctor.mjs';
import { loadWorkerConfig } from '../worker/config.mjs';
import { discoverGpus, GPUInventoryError } from '../worker/gpu-inventory.mjs';
import { inspectManagedLocal, runRemoteWorkerStart, runRemoteWorkerStop } from './local-lifecycle.mjs';

const marker = 'remote-worker.json';
const caFile = 'worker-ca.pem';
const secretPattern = /^[a-f0-9]{64}$/u; // generated server credentials only
const namePattern = /^gpu-[a-f0-9]{32}$/u;
export const defaultRemoteWorkerDirectory = () => path.join(homedir(), '.gpulink', 'instances', 'worker');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
function linux() { if (process.platform !== 'linux') throw new Error('Managed remote worker preview requires Linux.'); }
function existsEntry(file) { try { lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
export function hasRemoteWorkerMarker(directory) { return Boolean(directory && existsEntry(path.join(directory, marker))); }
function privateDirectory(directory) {
  const st = lstatSync(directory);
  if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077) || st.uid !== process.getuid()) throw new Error('Require an owner-only real directory.');
}
function readBounded(file, max, secret = true) {
  const before = lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > max || (secret && ((before.mode & 0o077) || before.uid !== process.getuid()))) throw new Error('Invalid file type, size or permissions.');
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const after = fstatSync(fd);
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino || after.size > max || (secret && ((after.mode & 0o077) || after.uid !== process.getuid()))) throw new Error('File changed during inspection.');
    const bytes = readFileSync(fd);
    if (bytes.length > max) throw new Error('Oversized file.');
    return bytes.toString('utf8');
  } finally { closeSync(fd); }
}
function writePrivate(file, value) {
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { writeFileSync(fd, value); } finally { closeSync(fd); }
}
function parseBundle(data) {
  if (!exact(data, ['schemaVersion','publicOrigin','workerToken']) || data.schemaVersion !== 1 || typeof data.workerToken !== 'string' || !secretPattern.test(data.workerToken) || normalizeServerOrigin(data.publicOrigin) !== data.publicOrigin) throw new Error('Invalid worker bundle.');
  return data;
}
function certificates(text) {
  // Copy only certificates, never a private key, arbitrary config or script.
  const entries = text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu) ?? [];
  if (!entries.length || text.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu, '').trim()) throw new Error('CA file must contain PEM certificates only.');
  for (const entry of entries) new X509Certificate(entry);
  return entries;
}
export function runWorkerBundle(args, directory, output = console) {
  if (args.length !== 2 || args[0] !== '--output') { output.error('Usage: gpulink [--config-dir SERVER] server worker-bundle --output FILE'); return 2; }
  try {
    linux();
    const setup = readServerSetup(directory);
    const target = path.resolve(args[1]);
    privateDirectory(path.dirname(target));
    const bundle = parseBundle({schemaVersion:1,publicOrigin:setup.publicOrigin,workerToken:setup.profiles['worker.env'].GPULINK_WORKER_TOKEN});
    writePrivate(target, JSON.stringify(bundle) + '\n');
    output.log('Created private worker-role bundle; transfer securely to an authorized worker. Reusable deployment credential, not a one-time invite. No secrets printed.');
    return 0;
  } catch { output.error('Worker bundle export refused. Select a valid server profile and a new file in an owner-only directory.'); return 1; }
}
export function runWorkerEnrollment(args, directory, output = console) {
  if (![2,4].includes(args.length) || args[0] !== '--bundle' || (args.length === 4 && args[2] !== '--ca-file')) { output.error('Usage: gpulink [--config-dir WORKER] worker enroll --bundle FILE [--ca-file PEM]'); return 2; }
  let created = false, target;
  try {
    linux();
    const bundle = parseBundle(JSON.parse(readBounded(path.resolve(args[1]),4096)));
    const ca = args.length === 4 ? certificates(readBounded(path.resolve(args[3]),65536,false)).join('\n')+'\n' : null;
    target = path.resolve(directory ?? defaultRemoteWorkerDirectory());
    if (existsEntry(target)) throw new Error('Installation already exists.');
    mkdirSync(path.dirname(target), {recursive:true,mode:0o700});
    mkdirSync(target,{mode:0o700}); created = true;
    const profile = {...bundle,workerName:`gpu-${randomBytes(16).toString('hex')}`,installationKey:randomBytes(32).toString('hex'),privateCa:ca !== null};
    writePrivate(path.join(target,marker),JSON.stringify(profile)+'\n');
    if (ca) writePrivate(path.join(target,caFile),ca);
    output.log(`Created independent worker installation ${profile.workerName}. No network requests, GPU allocation or services started.`);
    output.log('Run worker doctor --live --gpu, then explicitly authorize assigned work. Securely remove transferred bundle copies when no longer needed.');
    return 0;
  } catch {
    if (created) rmSync(target,{recursive:true,force:true});
    output.error('Enrollment refused. Check bundle permissions/format, trusted CA PEM, and choose a new installation directory.'); return 1;
  }
}
export function readRemoteWorkerSetup(directory) {
  linux();
  if (!directory) throw new Error('No remote worker installation selected.');
  const target = path.resolve(directory);
  privateDirectory(target);
  const value = JSON.parse(readBounded(path.join(target,marker),4096));
  if (!exact(value,['schemaVersion','publicOrigin','workerToken','workerName','installationKey','privateCa']) || typeof value.workerName !== 'string' || !namePattern.test(value.workerName) || typeof value.installationKey !== 'string' || !secretPattern.test(value.installationKey) || typeof value.privateCa !== 'boolean') throw new Error('Invalid remote worker profile.');
  parseBundle({schemaVersion:value.schemaVersion,publicOrigin:value.publicOrigin,workerToken:value.workerToken});
  const profile = {GPULINK_CONTROL_PLANE_URL:value.publicOrigin,GPULINK_WORKER_TOKEN:value.workerToken,GPULINK_WORKER_NAME:value.workerName,GPULINK_WORKER_CAPABILITIES:'diagnostic.echo,diagnostic.gpu-status'};
  let ca = null;
  if (value.privateCa) {
    const filename = path.join(target,caFile);
    ca = certificates(readBounded(filename,65536));
    profile.NODE_EXTRA_CA_CERTS = filename;
  }
  loadWorkerConfig(profile);
  return {directory:target,kind:'remote-worker',installationKey:value.installationKey,publicOrigin:value.publicOrigin,ca,profiles:{'worker.env':profile}};
}
// Read-only role check: an authenticated request to a random nonexistent worker's
// leases route returns the existing structured 404. This is NOT registration.
export function probeWorkerEndpoint(setup) {
  return new Promise(resolve => {
    const profile = setup.profiles['worker.env'];
    const endpoint = `${setup.publicOrigin}/v1/workers/worker_${randomBytes(16).toString('hex')}/leases`;
    let settled = false, timer;
    const finish = value => { if (!settled) { settled=true; clearTimeout(timer); resolve(value); } };
    const req = https.get(endpoint,{agent:false,rejectUnauthorized:true, ca:[...rootCertificates,...(setup.ca ?? [])],headers:{Authorization:`Bearer ${profile.GPULINK_WORKER_TOKEN}`}},res => {
      let bytes=0, text=''; res.setEncoding('utf8');
      res.on('data',chunk => { bytes+=Buffer.byteLength(chunk); if(bytes>4096) {finish('unexpected-response');res.destroy();} else text+=chunk; });
      res.on('error',()=>finish('unexpected-response'));
      res.on('end',()=>{
        if(res.statusCode===401 || res.statusCode===403) return finish('auth-rejected');
        try { const body=JSON.parse(text); finish(res.statusCode===404 && body.error?.code==='not_found' && body.error?.message==='worker not found' ? 'authorized' : 'unexpected-response'); }
        catch {finish('unexpected-response');}
      });
    });
    timer=setTimeout(()=>{finish('timeout');req.destroy();},5000);
    req.on('error',error=>finish(/CERT|TLS_CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/u.test(error.code??'')?'tls-trust-failed':'connection-failed'));
  });
}
export async function runWorkerDoctor(args, directory, output=console) {
  if (args.some(arg=>!['--live','--gpu'].includes(arg)) || new Set(args).size!==args.length) {output.error('Usage: gpulink worker doctor [--live] [--gpu]');return 2;}
  try {
    const setup=readRemoteWorkerSetup(directory);
    if (runDoctor(['worker'],setup.profiles['worker.env'],output)) return 1;
    if (args.includes('--live')) {
      const result=await probeWorkerEndpoint(setup);
      if(result!=='authorized') {output.error(`FAIL: remote worker HTTPS/authorization: ${result}. Check endpoint, trusted CA, proxy and worker-role credential. No redirects followed.`);return 1;}
      output.log('PASS: trusted HTTPS and worker-role authorization; no registration or assignment requested.');
    }
    if (args.includes('--gpu')) {
      let gpus;
      try { gpus=await discoverGpus(); }
      catch (error) {
        output.error(`FAIL: GPU discovery: ${error instanceof GPUInventoryError ? error.message : 'unexpected discovery error'}. Check NVIDIA driver/nvidia-smi access.`);
        return 1;
      }
      if (!gpus.length) {output.error('FAIL: no physical NVIDIA GPU discovered.');return 1;}
      output.log(`PASS: ${gpus.length} NVIDIA GPU(s) discovered through nvidia-smi. No workload executed.`);
      for(const gpu of gpus) output.log(`${gpu.name}: ${gpu.memoryTotalMiB} MiB`);
    }
    return 0;
  } catch { output.error('Worker preflight failed; check private configuration, Node.js 24 and NVIDIA driver/nvidia-smi access.');return 1; }
}
export async function runWorkerCommand(args,directory,output=console) {
  const [command,...rest]=args;
  if(command==='enroll') return runWorkerEnrollment(rest,directory,output);
  if(command==='doctor') return runWorkerDoctor(rest,directory,output);
  if(command==='start') {
    if(rest.length!==1 || rest[0]!=='--accept-assigned-work') {output.error('Usage: gpulink worker start --accept-assigned-work (may immediately execute queued approved work)');return 2;}
    if(await runWorkerDoctor(['--live','--gpu'],directory,output)) return 1;
    return runRemoteWorkerStart(directory,{output});
  }
  if(command==='stop' && !rest.length) return runRemoteWorkerStop(directory,{output});
  if(command==='status' && !rest.length) {
    try {
      const setup=readRemoteWorkerSetup(directory);
      const state=await inspectManagedLocal(setup,'worker');
      const run=path.join(setup.directory,'run');
      if (existsEntry(run)) privateDirectory(run);
      const absent=!existsEntry(run) || (!existsEntry(path.join(run,'worker.owner.json')) && !existsEntry(path.join(run,'worker.sock')) && !existsEntry(path.join(run,'start.lock')));
      output.log(JSON.stringify({schemaVersion:1,scope:'remote-worker-preview',name:setup.profiles['worker.env'].GPULINK_WORKER_NAME,publicOrigin:setup.publicOrigin,managedState:state??(absent?'not-running':'unverified'),note:'Local ownership only; inspect server workers for heartbeat, GPU inventory and scheduling readiness.'},null,2));
      return state || absent ? 0 : 1;
    } catch {output.error('Invalid remote worker profile.');return 1;}
  }
  output.error('Usage: gpulink worker <enroll|doctor|start|status|stop>');return 2;
}
