/**
 * DP3C3B2A: side-effect-free, NON-AUTHORITATIVE launch-intent validation.
 * This module cannot start an adapter, produce credentials, or authorize
 * a container-engine call. Snapshot evidence is injected for policy tests.
 * A future privileged broker MUST independently authenticate the caller,
 * load its OWN authoritative records, atomically fence attempts, and inspect
 * host control effectiveness at the moment of actual workload creation.
 */
import {ISOLATION_PROPERTIES, WorkloadRuntimeError} from './workload-runtime-contract.mjs';

export const BROKER_ADMISSION_SCHEMA_VERSION = 1;
export const B2A_REQUIRED_CONTROLS = Object.freeze([...ISOLATION_PROPERTIES].sort());
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const HEX = /^[a-f0-9]{64}$/u;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const record = value => value !== null && typeof value === 'object' &&
  !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype ||
  Object.getPrototypeOf(value) === null) &&
  Object.values(Object.getOwnPropertyDescriptors(value)).every(d => Object.hasOwn(d, 'value'));
const exact = (obj, keys) => record(obj) &&
  Object.keys(obj).sort().join('\0') === [...keys].sort().join('\0');
const id = value => typeof value === 'string' && ID.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const time = value => positive(value) && value < 8_640_000_000_000_000;
const fail = code => {throw new WorkloadRuntimeError(code);};
const digest = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
const unique = list => Array.isArray(list) && new Set(list).size === list.length;

function artifact(value) {
  if (!exact(value, ['adapterId','version','sha256']) || !id(value.adapterId) ||
      !VERSION.test(value.version) || typeof value.sha256 !== 'string' || !HEX.test(value.sha256)) {
    fail('broker_invalid_artifact');
  }
  return Object.freeze({...value});
}
function equalArtifact(a, b) {
  return a.adapterId === b.adapterId && a.version === b.version && a.sha256 === b.sha256;
}
function controls(value, code) {
  if (!unique(value) || value.length > ISOLATION_PROPERTIES.length ||
      value.some(item => !ISOLATION_PROPERTIES.includes(item))) fail(code);
  return Object.freeze([...value].sort());
}

/** Wire-shaped untrusted intent; NEVER includes engine options, paths or device IDs. */
export function validateBrokerLaunchIntent(raw) {
  const keys = ['schemaVersion','attemptId','sessionId','leaseId','leaseGeneration',
    'runtimeId','reservationId','artifact','requiredIpcVersion'];
  if (!exact(raw, keys) || raw.schemaVersion !== BROKER_ADMISSION_SCHEMA_VERSION ||
      ![raw.attemptId,raw.sessionId,raw.leaseId,raw.runtimeId,raw.reservationId].every(id) ||
      !positive(raw.leaseGeneration) || !positive(raw.requiredIpcVersion) ||
      raw.requiredIpcVersion > 255) fail('broker_invalid_intent');
  return Object.freeze({...raw, artifact:artifact(raw.artifact)});
}

/**
 * Evaluate a broker-owned RECORD SNAPSHOT for design and conformance ONLY.
 * All snapshot arguments are fake data supplied by tests, NOT authentication.
 * The returned decision is deliberately NON-AUTHORITATIVE and canLaunch=false.
 */
export function evaluateBrokerAdmissionSnapshot({intent, snapshot, nowMs} = {}) {
  const req = validateBrokerLaunchIntent(intent);
  if (!time(nowMs)) fail('broker_invalid_clock');
  if (!exact(snapshot, ['caller','lease','reservation','approval','runtime','attempt'])) {
    fail('broker_invalid_snapshot');
  }
  const {caller,lease,reservation,approval,runtime,attempt} = snapshot;
  if (!exact(caller, ['workerId','runtimeIds','authenticated']) || !id(caller.workerId) ||
      typeof caller.authenticated !== 'boolean' || !unique(caller.runtimeIds) ||
      caller.runtimeIds.length > 64 || caller.runtimeIds.some(value => !id(value))) {
    fail('broker_invalid_caller_record');
  }
  if (!exact(lease, ['sessionId','leaseId','generation','workerId','expiresAtMs','status']) ||
      ![lease.sessionId,lease.leaseId,lease.workerId].every(id) ||
      !positive(lease.generation) || !time(lease.expiresAtMs) ||
      !['active','revoked','closed'].includes(lease.status)) fail('broker_invalid_lease_record');
  if (!exact(reservation, ['reservationId','attemptId','leaseId','deviceIds','expiresAtMs','status']) ||
      ![reservation.reservationId,reservation.attemptId,reservation.leaseId].every(id) ||
      !time(reservation.expiresAtMs) || !['held','released'].includes(reservation.status) ||
      !unique(reservation.deviceIds) || reservation.deviceIds.length === 0 ||
      reservation.deviceIds.length > 8 || reservation.deviceIds.some(value => !id(value))) {
    fail('broker_invalid_reservation_record');
  }
  if (!exact(approval, ['artifact','imageDigest','runtimeId','profileId','trustClass','requiredControls']) ||
      !digest(approval.imageDigest) || !id(approval.runtimeId) || !id(approval.profileId) ||
      !['operator-trusted','reviewed-third-party','untrusted'].includes(approval.trustClass)) {
    fail('broker_invalid_approval_record');
  }
  const approvedArtifact = artifact(approval.artifact);
  const required = controls(approval.requiredControls,'broker_invalid_approval_record');
  if (!exact(runtime, ['runtimeId','available','verifiedControls','supportedIpcVersions']) ||
      !id(runtime.runtimeId) || typeof runtime.available !== 'boolean' ||
      !unique(runtime.supportedIpcVersions) || runtime.supportedIpcVersions.length > 16 ||
      runtime.supportedIpcVersions.some(value => !positive(value) || value > 255)) {
    fail('broker_invalid_runtime_record');
  }
  const verified = controls(runtime.verifiedControls, 'broker_invalid_runtime_record');
  if (!exact(attempt, ['attemptId','state']) || !id(attempt.attemptId) ||
      !['absent','prepared','starting','running','finished','disposed'].includes(attempt.state)) {
    fail('broker_invalid_attempt_record');
  }

  if (!caller.authenticated || !caller.runtimeIds.includes(req.runtimeId)) fail('broker_unauthorized_caller');
  if (lease.status !== 'active' || lease.expiresAtMs <= nowMs || lease.workerId !== caller.workerId ||
      lease.sessionId !== req.sessionId || lease.leaseId !== req.leaseId ||
      lease.generation !== req.leaseGeneration) fail('broker_stale_lease');
  if (reservation.status !== 'held' || reservation.expiresAtMs <= nowMs ||
      reservation.reservationId !== req.reservationId || reservation.attemptId !== req.attemptId ||
      reservation.leaseId !== req.leaseId) fail('broker_reservation_mismatch');
  if (attempt.attemptId !== req.attemptId || attempt.state !== 'absent') fail('broker_attempt_replay');
  if (!equalArtifact(req.artifact,approvedArtifact) || approval.runtimeId !== req.runtimeId ||
      !digest(approval.imageDigest)) fail('broker_artifact_not_approved');
  // B2A expressly cannot promote third-party trust classes to runnable.
  if (approval.trustClass !== 'operator-trusted') fail('broker_trust_class_not_enabled');
  // B2A can evaluate profiles but never certify actual Linux isolation.
  if (B2A_REQUIRED_CONTROLS.some(c => !required.includes(c))) fail('broker_incomplete_security_profile');
  if (!runtime.available || runtime.runtimeId !== req.runtimeId ||
      !runtime.supportedIpcVersions.includes(req.requiredIpcVersion) ||
      required.some(c => !verified.includes(c))) fail('broker_runtime_not_verified');
  return Object.freeze({
    schemaVersion:1,
    status:'eligible-for-implementation-review',
    canLaunch:false,
    advisoryOnly:true,
    attemptId:req.attemptId,
    runtimeId:req.runtimeId,
    profileId:approval.profileId,
    imageDigest:approval.imageDigest,
    reservationId:req.reservationId,
    deviceIds:Object.freeze([...reservation.deviceIds].sort()),
    validatedControls:required,
  });
}
