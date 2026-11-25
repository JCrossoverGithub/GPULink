import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { createLocalSetup } from './local-init.mjs';
import { readLocalSmokeSetup } from './local-smoke.mjs';
import { runDoctor } from './doctor.mjs';
import { runLocalStart, runLocalStop } from './local-lifecycle.mjs';
import { inspectLocalStatus, runLocalStatus } from './local-status.mjs';

const marker = 'server.json';
export const defaultServerSetupDirectory = () => path.join(homedir(), '.gpulink', 'instances', 'server');
export function normalizeServerOrigin(value) {
  // No credentials, paths, query, fragments, encoded authority or whitespace.
  if (typeof value !== 'string' || !/^https:\/\/[A-Za-z0-9.:[\]-]+\/?$/u.test(value))
    throw new Error('Provide an HTTPS origin only, e.g. https://gpu.example.org.');
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid HTTPS origin.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('Provide an HTTPS origin only.');
  return url.origin;
}
export function hasServerMarker(directory) {
  if (!directory) return false;
  try { lstatSync(path.join(directory, marker)); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
export function readServerSetup(directory) {
  if (!directory) throw new Error('No server installation selected.');
  const setup = readLocalSmokeSetup(directory);
  const file = path.join(setup.directory, marker);
  const st = lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.size > 2048 || (process.platform !== 'win32' && (st.mode & 0o077)))
    throw new Error('Invalid private server profile.');
  let data;
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== st.dev || opened.ino !== st.ino || opened.size > 2048 || (process.platform !== 'win32' && (opened.mode & 0o077))) throw new Error('Server profile changed during inspection.');
    const bytes = readFileSync(fd);
    if (bytes.length > 2048) throw new Error('Oversized server profile.');
    data = JSON.parse(bytes.toString('utf8'));
  } catch { throw new Error('Invalid private server profile.'); } finally { closeSync(fd); }
  if (!data || Object.keys(data).sort().join(',') !== 'publicOrigin,schemaVersion' || data.schemaVersion !== 1 || normalizeServerOrigin(data.publicOrigin) !== data.publicOrigin)
    throw new Error('Invalid server profile contract.');
  return { ...setup, publicOrigin: data.publicOrigin };
}
export function runServerInit(args, directory, output = console) {
  if (args.length !== 2 || args[0] !== '--public-url') {
    output.error('Usage: gpulink [--config-dir DIRECTORY] init server --public-url https://gpu.example.org');
    return 2;
  }
  if (process.platform !== 'linux') { output.error('Managed server preview requires Linux.'); return 1; }
  try {
    const publicOrigin = normalizeServerOrigin(args[1]);
    const result = createLocalSetup(directory ?? defaultServerSetupDirectory(), { publicOrigin });
    output.log(`Created private server configuration in ${result.directory}`);
    output.log(`Configured HTTPS origin: ${publicOrigin}`);
    output.log('Backend: http://127.0.0.1:8088. Configure an operator-owned TLS reverse proxy on this host. No services started; no credentials printed.');
    return 0;
  } catch (error) { output.error(`Server setup failed: ${error.message}`); return 1; }
}
// Explicit certificate and hostname verification, no redirects or credentials.
// Never treat a successful HTTP response as local process ownership.
export function checkServerHttps(origin) {
  return new Promise(resolve => {
    let settled = false;
    const finish = result => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    const req = https.get(`${normalizeServerOrigin(origin)}/readyz`, { rejectUnauthorized: true, agent: false }, response => {
      let bytes = 0, body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 4096) { finish('invalid-readiness'); response.destroy(); }
        else body += chunk;
      });
      response.on('error', () => finish('invalid-readiness'));
      response.on('end', () => {
        try { finish(response.statusCode === 200 && JSON.parse(body).status === 'ready' ? 'ready' : 'invalid-readiness'); }
        catch { finish('invalid-readiness'); }
      });
    });
    const timer = setTimeout(() => { finish('timeout'); req.destroy(); }, 5000);
    req.on('error', error => finish(['CERT_HAS_EXPIRED','CERT_NOT_YET_VALID','DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','ERR_TLS_CERT_ALTNAME_INVALID'].includes(error.code) ? 'tls-trust-failed' : 'connection-failed'));
  });
}
export async function runServerDoctor(args, directory, output = console) {
  if (args.length > 1 || (args.length === 1 && args[0] !== '--live')) {
    output.error('Usage: gpulink [--config-dir DIRECTORY] doctor server [--live]'); return 2;
  }
  try {
    const setup = readServerSetup(directory);
    if (process.platform !== 'linux') { output.error('Managed server preview requires Linux.'); return 1; }
    const result = runDoctor(['control-plane'], setup.profiles['control-plane.env'], output);
    if (result) return result;
    output.log(`PASS: HTTPS origin configured: ${setup.publicOrigin}; backend restricted to 127.0.0.1:8088.`);
    if (!args.length) { output.log('Offline only; use doctor server --live to check TLS and readiness.'); return 0; }
    const live = await checkServerHttps(setup.publicOrigin);
    if (live === 'ready') { output.log('PASS: verified HTTPS certificate/hostname and readiness response. No credentials sent; not proof of remote worker connectivity or process ownership.'); return 0; }
    output.error(`FAIL: HTTPS readiness: ${live}. Check DNS, proxy, certificate trust and backend status; redirects are not followed.`);
    return 1;
  } catch { output.error('Server profile validation failed; check the private server configuration.'); return 1; }
}
export async function runServerLifecycle(args, directory, output = console) {
  if (args.length !== 1 || !['start','status','stop'].includes(args[0])) {
    output.error('Usage: gpulink [--config-dir DIRECTORY] server <start|status|stop>'); return 2;
  }
  let setup;
  try { setup = readServerSetup(directory); } catch { output.error('Server profile validation failed. Use init server; no service operation performed.'); return 1; }
  if (process.platform !== 'linux') { output.error('Managed server preview requires Linux.'); return 1; }
  // Same ownership, locking, loopback readiness and teardown implementation.
  if (args[0] === 'start') {
    if ((await inspectLocalStatus(setup)).controlPlane !== 'offline') {
      output.error('Backend port 8088 is occupied or cannot be verified offline. No service started or adopted.'); return 1;
    }
    return runLocalStart([], directory, {output});
  }
  if (args[0] === 'stop') return runLocalStop([], directory, {output});
  return runLocalStatus([], directory, {output: {error: message => output.error(message), log: message => {
    const status = JSON.parse(message);
    output.log(JSON.stringify({...status, scope: 'server-preview', publicOrigin: setup.publicOrigin}, null, 2));
  }}});
}
