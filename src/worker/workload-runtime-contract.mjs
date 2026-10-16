/**
 * DP3C3B1: runtime-neutral internal workload admission contract.
 * NOT invoked by production worker paths in B1; fake-only conformance foundation.
 * Runtime reports are trustworthy only when supplied by operator-controlled code.
 */
export const WORKLOAD_RUNTIME_CONTRACT_VERSION = 1;
export const ISOLATION_PROPERTIES = Object.freeze([
  'process', 'filesystem', 'network', 'identity', 'resource-limits', 'gpu-device',
]);
export const RUNTIME_KINDS = Object.freeze(['trusted-process', 'isolated-oci', 'dedicated-host']);

const selectionBrand = new WeakSet();
const HEX = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const isRecord = v => !!v && typeof v === 'object' && !Array.isArray(v);
const own = (v, k) => Object.prototype.hasOwnProperty.call(v, k);
const hasKeys = (v, keys) => isRecord(v) && Object.keys(v).sort().join('|') === [...keys].sort().join('|');

export class WorkloadRuntimeError extends Error {
  constructor(code) {
    super(`GPULink workload runtime: ${code}`);
    this.name = 'WorkloadRuntimeError';
    this.code = code;
  }
}
const fail = code => { throw new WorkloadRuntimeError(code); };
const validId = s => typeof s === 'string' && ID.test(s);
const unique = arr => Array.isArray(arr) && new Set(arr).size === arr.length;

export function validateRuntimeReport(report) {
  if (!hasKeys(report, [
    'schemaVersion', 'runtimeId', 'kind', 'availability', 'verification',
    'supportedIpcVersions', 'isolationProperties',
  ]) || report.schemaVersion !== 1 || !validId(report.runtimeId) ||
      !RUNTIME_KINDS.includes(report.kind) ||
      !['available', 'unavailable'].includes(report.availability) ||
      !['simulated', 'operator-verified'].includes(report.verification) ||
      !unique(report.supportedIpcVersions) || report.supportedIpcVersions.length > 16 ||
      report.supportedIpcVersions.some(v => !Number.isSafeInteger(v) || v < 1 || v > 255) ||
      !unique(report.isolationProperties) || report.isolationProperties.length > ISOLATION_PROPERTIES.length ||
      report.isolationProperties.some(v => !ISOLATION_PROPERTIES.includes(v))) {
    fail('invalid_runtime_report');
  }
  return Object.freeze({
    ...report,
    supportedIpcVersions: Object.freeze([...report.supportedIpcVersions].sort((a, b) => a - b)),
    isolationProperties: Object.freeze([...report.isolationProperties].sort()),
  });
}

function validateArtifact(a) {
  if (!hasKeys(a, ['adapterId', 'version', 'sha256']) ||
      !validId(a.adapterId) || !VERSION.test(a.version) ||
      typeof a.sha256 !== 'string' || !HEX.test(a.sha256)) fail('invalid_artifact');
  return Object.freeze({...a});
}

export function validateWorkloadRequest(req) {
  if (!hasKeys(req, [
    'schemaVersion', 'attemptId', 'sessionId', 'leaseId', 'artifact',
    'requiredIpcVersion', 'requiredIsolation',
  ]) || req.schemaVersion !== 1 ||
      ![req.attemptId, req.sessionId, req.leaseId].every(validId) ||
      !Number.isSafeInteger(req.requiredIpcVersion) || req.requiredIpcVersion < 1 ||
      req.requiredIpcVersion > 255 ||
      !unique(req.requiredIsolation) ||
      req.requiredIsolation.length > ISOLATION_PROPERTIES.length ||
      req.requiredIsolation.some(v => !ISOLATION_PROPERTIES.includes(v))) {
    fail('invalid_workload_request');
  }
  return Object.freeze({
    ...req, artifact: validateArtifact(req.artifact),
    requiredIsolation: Object.freeze([...req.requiredIsolation].sort()),
  });
}

export function validateRuntimePolicy(policy) {
  if (!hasKeys(policy, [
    'schemaVersion', 'approvedArtifacts', 'enabledRuntimeIds',
    'trustedProcessEnabled', 'allowSimulation',
  ]) || policy.schemaVersion !== 1 ||
      typeof policy.trustedProcessEnabled !== 'boolean' ||
      typeof policy.allowSimulation !== 'boolean' ||
      !unique(policy.enabledRuntimeIds) || policy.enabledRuntimeIds.length > 64 ||
      policy.enabledRuntimeIds.some(id => !validId(id)) ||
      !Array.isArray(policy.approvedArtifacts) || policy.approvedArtifacts.length > 64) {
    fail('invalid_runtime_policy');
  }
  const seen = new Set();
  const approved = policy.approvedArtifacts.map(entry => {
    if (!hasKeys(entry, ['artifact', 'trustClass']) ||
        !['operator-trusted', 'reviewed-third-party', 'untrusted'].includes(entry.trustClass)) {
      fail('invalid_runtime_policy');
    }
    const artifact = validateArtifact(entry.artifact);
    const identity = `${artifact.adapterId}\0${artifact.version}\0${artifact.sha256}`;
    if (seen.has(identity)) fail('duplicate_artifact_approval');
    seen.add(identity);
    return Object.freeze({artifact, trustClass: entry.trustClass});
  });
  return Object.freeze({
    ...policy,
    approvedArtifacts: Object.freeze(approved),
    enabledRuntimeIds: Object.freeze([...policy.enabledRuntimeIds].sort()),
  });
}

/**
 * Decide only, never execute. All arguments are operator-controlled inputs;
 * untrusted users may not furnish policy or runtime verification status.
 * B1 deliberately allows ONLY operator-trusted artifacts. A future certified
 * B2 backend will require its own independent admission at workload launch.
 */
export function selectWorkloadRuntime({request, policy, runtimeReports}) {
  const req = validateWorkloadRequest(request);
  const p = validateRuntimePolicy(policy);
  if (!Array.isArray(runtimeReports) || runtimeReports.length > 64) fail('invalid_runtime_reports');
  const reports = runtimeReports.map(validateRuntimeReport);
  if (new Set(reports.map(r => r.runtimeId)).size !== reports.length) fail('duplicate_runtime_id');

  const approval = p.approvedArtifacts.find(({artifact}) =>
    artifact.adapterId === req.artifact.adapterId && artifact.version === req.artifact.version &&
    artifact.sha256 === req.artifact.sha256,
  );
  if (!approval) fail('artifact_not_approved');
  if (approval.trustClass !== 'operator-trusted') fail('trust_class_not_supported');

  const eligible = reports.filter(r =>
    p.enabledRuntimeIds.includes(r.runtimeId) && r.availability === 'available' &&
    (r.verification === 'operator-verified' || p.allowSimulation) &&
    (r.kind !== 'trusted-process' || p.trustedProcessEnabled) &&
    r.supportedIpcVersions.includes(req.requiredIpcVersion) &&
    req.requiredIsolation.every(property => r.isolationProperties.includes(property))
  ).sort((a, b) => a.runtimeId.localeCompare(b.runtimeId));
  if (!eligible.length) fail('no_eligible_runtime');
  const chosen = eligible[0];
  const selection = Object.freeze({
    schemaVersion: 1, runtimeId: chosen.runtimeId, attemptId: req.attemptId,
    sessionId: req.sessionId, leaseId: req.leaseId, artifact: req.artifact,
    requiredIpcVersion: req.requiredIpcVersion, simulation: chosen.verification === 'simulated',
  });
  selectionBrand.add(selection);
  return selection;
}

/** Private validation for fake-runtime conformance, not a wire-format token. */
export function assertRuntimeAdmission(selection, runtimeId) {
  if (!isRecord(selection) || !selectionBrand.has(selection) ||
      selection.runtimeId !== runtimeId) fail('invalid_runtime_admission');
  return selection;
}
