/** DP3C3B2B: bounded, versioned UNIX socket client to TEST-ONLY broker.
 * The test-only operations are claim, inspect, cancel, reserve-authoritative; never launch.
 * Transport is available to Linux GPU operators, not GPULink Client SDK users.
 */
import net from 'node:net';
import {validateBrokerLaunchIntent} from './workload-broker-admission.mjs';
import {WorkloadRuntimeError} from './workload-runtime-contract.mjs';

const MAX = 16 * 1024;
const OUT_MAX = 4096;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const fail = code => { throw new WorkloadRuntimeError(code); };
export async function requestTestBroker({socketPath, operation, payload, timeoutMs=2000}) {
  if (typeof socketPath !== 'string' || socketPath.length > 160 || !socketPath.startsWith('/') ||
      socketPath.includes('\0') || !Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 10000) {
    fail('broker_invalid_transport');
  }
  if (!['claim','inspect','cancel','reserve-authoritative','observe-authoritative','observe-host','capture-host-binding','observe-bound-host','spawn-synthetic-probe','observe-synthetic-probe'].includes(operation)) fail('broker_unsupported_operation');
  let body;
  if (operation === 'claim') {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload) ||
        Object.keys(payload).sort().join('|') !== 'intent') fail('broker_invalid_message');
    body = {intent:validateBrokerLaunchIntent(payload.intent)};
  } else if (operation === 'reserve-authoritative') {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload) ||
        Object.getPrototypeOf(payload) !== Object.prototype) fail('broker_invalid_message');
    const entries = Object.getOwnPropertyDescriptors(payload);
    const fields = ['attemptId','leaseId','subjectId','subjectKind'];
    if (Object.keys(entries).sort().join('|') !== fields.join('|') ||
        fields.some(k => !Object.hasOwn(entries[k],'value')) ||
        !['job','session'].includes(entries.subjectKind.value) ||
        ['attemptId','leaseId','subjectId'].some(k => typeof entries[k].value !== 'string' || !ID.test(entries[k].value)))
      fail('broker_invalid_message');
    body=Object.fromEntries(fields.map(k => [k,entries[k].value]));
  } else {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload) ||
        Object.keys(payload).sort().join('|') !== 'attemptId' ||
        typeof payload.attemptId !== 'string' || !ID.test(payload.attemptId)) fail('broker_invalid_message');
    body = {attemptId:payload.attemptId};
  }
  const raw = Buffer.from(JSON.stringify({schemaVersion:1,operation,payload:body}),'utf8');
  if (raw.length < 2 || raw.length > MAX) fail('broker_message_too_large');
  const packet = Buffer.allocUnsafe(4+raw.length);
  packet.writeUInt32BE(raw.length,0); raw.copy(packet,4);
  return new Promise((resolve,reject)=> {
    const socket = net.createConnection({path:socketPath});
    let done=false, buffers=[], size=0, expected=null;
    const finish = (error, value) => {
      if (done) return;
      done=true; socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const failure = code => finish(new WorkloadRuntimeError(code));
    socket.setTimeout(timeoutMs,()=>failure('broker_timeout'));
    socket.once('error',()=>failure('broker_transport_failed'));
    socket.once('connect',()=>socket.write(packet));
    socket.on('data',data=>{
      if (done) return;
      size += data.length;
      if (size > OUT_MAX+4) return failure('broker_message_too_large');
      buffers.push(data);
      const joined=Buffer.concat(buffers,size);
      if (expected===null && joined.length>=4) {
        expected=joined.readUInt32BE(0);
        if (expected<2 || expected>OUT_MAX) return failure('broker_message_too_large');
      }
      if (expected!==null && joined.length >= expected+4) {
        if (joined.length!==expected+4) return failure('broker_invalid_response');
        let parsed;
        try { parsed=JSON.parse(joined.subarray(4).toString('utf8')); }
        catch { return failure('broker_invalid_response'); }
        if (!parsed || typeof parsed!=='object' || parsed.schemaVersion!==1 ||
            typeof parsed.ok!=='boolean' || (parsed.ok && !parsed.result) ||
            (!parsed.ok && typeof parsed.code!=='string')) return failure('broker_invalid_response');
        if (!parsed.ok) return failure(ID.test(parsed.code) ? parsed.code : 'broker_invalid_response');
        if (parsed.result.canLaunch!==false) return failure('broker_unexpected_launch_authority');
        if (parsed.result.schemaVersion!==1 || parsed.result.attemptId!==
            (operation==='claim' ? body.intent.attemptId : body.attemptId)) return failure('broker_invalid_response');
        if (operation==='reserve-authoritative' && (parsed.result.status!=='reserved-not-launchable' ||
            parsed.result.advisoryOnly!==true || !Number.isSafeInteger(parsed.result.fenceEpoch) ||
            parsed.result.fenceEpoch < 1)) return failure('broker_invalid_response');
        if (operation==='observe-authoritative' && (
            !['held','unconfirmed','not_found'].includes(parsed.result.disposition) ||
            parsed.result.canRelease!==false || parsed.result.evidenceVerified!==false ||
            parsed.result.advisoryOnly!==true ||
            !(parsed.result.fenceEpoch===null ||
              (Number.isSafeInteger(parsed.result.fenceEpoch) && parsed.result.fenceEpoch>0)) ||
            ((parsed.result.disposition==='not_found') !== (parsed.result.fenceEpoch===null))))
          return failure('broker_invalid_response');
        if (operation==='observe-host' && (
            Object.keys(parsed.result).sort().join('|') !==
              'advisoryOnly|attemptId|authorityConfirmed|canLaunch|canRelease|cleanupVerified|observation|operatorHintOnly|reason|schemaVersion|source' ||
            !['present','absent','unknown'].includes(parsed.result.observation) ||
            (parsed.result.observation==='present') !== (parsed.result.reason==='identity_present') ||
            (parsed.result.observation==='absent') !== (parsed.result.reason==='identity_not_present') ||
            !['identity_present','identity_not_present','boot_mismatch','identity_changed_or_moved',
              'host_unobservable','epoch_unconfirmed','no_broker_verified_binding',
              'witness_identity_mismatch'].includes(parsed.result.reason) ||
            parsed.result.canRelease!==false || parsed.result.canLaunch!==false ||
            parsed.result.cleanupVerified!==false || parsed.result.authorityConfirmed!==false ||
            parsed.result.operatorHintOnly!==true || parsed.result.advisoryOnly!==true ||
            parsed.result.source !== (parsed.result.observation==='unknown' ? 'none':'linux-procfs-v1')))
          return failure('broker_invalid_response');
        if (operation==='capture-host-binding' && (
            Object.keys(parsed.result).sort().join('|') !==
              'advisoryOnly|attemptId|brokerMeasured|canLaunch|canRelease|cleanupVerified|launchAttested|schemaVersion|status' ||
            parsed.result.status!=='captured-test-only' || parsed.result.brokerMeasured!==true ||
            parsed.result.launchAttested!==false || parsed.result.canRelease!==false ||
            parsed.result.cleanupVerified!==false || parsed.result.advisoryOnly!==true))
          return failure('broker_invalid_response');
        if (operation==='observe-bound-host' && (
            Object.keys(parsed.result).sort().join('|') !==
              'advisoryOnly|attemptId|authorityConfirmed|brokerMeasured|canLaunch|canRelease|cleanupVerified|launchAttested|observation|reason|schemaVersion|source' ||
            !['present','absent','unknown'].includes(parsed.result.observation) ||
            (parsed.result.observation==='present') !== (parsed.result.reason==='identity_present') ||
            (parsed.result.observation==='absent') !== (parsed.result.reason==='identity_not_present') ||
            !['identity_present','identity_not_present','boot_mismatch','identity_changed_or_moved',
              'host_unobservable','no_durable_binding'].includes(parsed.result.reason) ||
            typeof parsed.result.brokerMeasured!=='boolean' ||
            parsed.result.canRelease!==false || parsed.result.cleanupVerified!==false ||
            parsed.result.launchAttested!==false || parsed.result.authorityConfirmed!==false ||
            parsed.result.advisoryOnly!==true ||
            parsed.result.source !== (parsed.result.observation==='unknown' ? 'none':'linux-procfs-v1')))
          return failure('broker_invalid_response');
        if (operation==='spawn-synthetic-probe' && (
            Object.keys(parsed.result).sort().join('|') !==
              'advisoryOnly|attemptId|canLaunch|canRelease|cleanupVerified|identityObserved|intentDurable|origin|schemaVersion|status|workloadLaunchAttested' ||
            parsed.result.status !== 'synthetic-probe-recorded' ||
            parsed.result.origin !== 'broker-created-fixed-synthetic-child-test-only' ||
            parsed.result.intentDurable !== true || parsed.result.identityObserved !== true ||
            parsed.result.workloadLaunchAttested !== false || parsed.result.cleanupVerified !== false ||
            parsed.result.canRelease !== false || parsed.result.advisoryOnly !== true))
          return failure('broker_invalid_response');
        if (operation==='observe-synthetic-probe' && (
            Object.keys(parsed.result).sort().join('|') !==
              'advisoryOnly|attemptId|authorityConfirmed|canLaunch|canRelease|cleanupVerified|observation|origin|reason|schemaVersion|source|status|workloadLaunchAttested' ||
            !['no_intent','intent_uncertain','synthetic_identity_recorded'].includes(parsed.result.status) ||
            !['present','absent','unknown'].includes(parsed.result.observation) ||
            !['no_provenance_intent','birth_not_committed','identity_present','identity_not_present','boot_mismatch',
              'identity_changed_or_moved','host_unobservable'].includes(parsed.result.reason) ||
            parsed.result.origin !== 'broker-created-fixed-synthetic-child-test-only' ||
            parsed.result.workloadLaunchAttested !== false || parsed.result.authorityConfirmed !== false ||
            parsed.result.cleanupVerified !== false || parsed.result.canRelease !== false ||
            parsed.result.advisoryOnly !== true ||
            parsed.result.source !== (parsed.result.observation==='unknown' ? 'none':'linux-procfs-v1')))
          return failure('broker_invalid_response');
        if (operation==='claim' && (parsed.result.status!=='reserved-test-only' ||
            parsed.result.advisoryOnly!==true)) return failure('broker_invalid_response');
        if (!['claim','reserve-authoritative','observe-authoritative','observe-host','capture-host-binding','observe-bound-host','spawn-synthetic-probe','observe-synthetic-probe'].includes(operation) && !['reserved','cancelled','quarantined'].includes(parsed.result.state))
          return failure('broker_invalid_response');
        finish(null, parsed.result);
      }
    });
    socket.once('end',()=>failure('broker_truncated_message'));
    socket.once('close',()=>{if (!done) failure('broker_truncated_message');});
  });
}

export const claimTestBrokerAttempt = ({socketPath,intent,timeoutMs}) =>
  requestTestBroker({socketPath,operation:'claim',payload:{intent},timeoutMs});

// B2C2B2C2: test-only non-executing bridge to control-plane claim authority.
export const reserveAuthoritativeBrokerAttempt = ({socketPath, request, timeoutMs=4000}) =>
  requestTestBroker({socketPath,operation:'reserve-authoritative',payload:request,timeoutMs});

// D1: diagnostic-only observation of an existing local journal entry.
export const observeAuthoritativeBrokerAttempt = ({socketPath,attemptId,timeoutMs=4000}) =>
  requestTestBroker({socketPath,operation:'observe-authoritative',payload:{attemptId},timeoutMs});

// D2A: test-only procfs observation; never cleanup verification or release.
export const observeHostBrokerAttempt = ({socketPath,attemptId,timeoutMs=4000}) =>
  requestTestBroker({socketPath,operation:'observe-host',payload:{attemptId},timeoutMs});

// D2B: broker-measured test-only identity capture, not launch attestation.
export const captureHostBrokerBinding = ({socketPath,attemptId,timeoutMs=4000}) =>
  requestTestBroker({socketPath,operation:'capture-host-binding',payload:{attemptId},timeoutMs});
export const observeBoundHostBrokerAttempt = ({socketPath,attemptId,timeoutMs=4000}) =>
  requestTestBroker({socketPath,operation:'observe-bound-host',payload:{attemptId},timeoutMs});

// D2C: synthetic fixed GPU-free child only. Explicit broker opt-in required.
// These operations are NOT authorization for a real workload launch or GPU release.
export const spawnSyntheticProvenanceProbe = ({socketPath,attemptId,timeoutMs=4000}) =>
  requestTestBroker({socketPath,operation:'spawn-synthetic-probe',payload:{attemptId},timeoutMs});
export const observeSyntheticProvenanceProbe = ({socketPath,attemptId,timeoutMs=4000}) =>
  requestTestBroker({socketPath,operation:'observe-synthetic-probe',payload:{attemptId},timeoutMs});
