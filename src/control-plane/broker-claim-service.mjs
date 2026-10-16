/**
 * B2C2B2C1: operator-provisioned, worker-scoped broker claims.
 * An authenticated broker can reserve exactly one attempt under an existing
 * lease, but the result ALWAYS denies launch. No host execution path exists.
 */
import { timingSafeEqual } from 'node:crypto';
import { ExecutionClaimDenied } from './execution-claim-authority.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const APPROVAL_FIELDS = [
  'brokerId', 'workerId', 'projectId', 'token', 'artifactDigest',
  'adapterIdentity', 'runtimePolicyRevision', 'approvalRef',
];
const REQUEST_FIELDS = ['schemaVersion', 'subjectKind', 'subjectId', 'leaseId', 'attemptId'];
const isPlain = input => input !== null && typeof input === 'object' &&
  !Array.isArray(input) && (Object.getPrototypeOf(input) === Object.prototype ||
  Object.getPrototypeOf(input) === null);
const ownValues = (value, fields) => {
  if (!isPlain(value)) return null;
  const desc = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(desc).length !== fields.length || fields.some(k =>
    !Object.hasOwn(desc, k) || !Object.hasOwn(desc[k], 'value'))) return null;
  return Object.fromEntries(fields.map(k => [k, desc[k].value]));
};
export class BrokerClaimError extends Error {
  constructor(code, statusCode = 409) {
    super(code);
    this.name = 'BrokerClaimError';
    this.code = code;
    this.statusCode = statusCode;
  }
}
const deny = (code, statusCode) => { throw new BrokerClaimError(code, statusCode); };

/** Configuration deliberately keeps broker credentials out of source control.
 * Each token is pinned to one worker AND project; approvals are operator-issued,
 * never taken from a broker request. No admin/worker/client token is accepted.
 */
export function parseBrokerProfiles(raw, otherSecrets = []) {
  if (raw === undefined || raw === null || raw === '') return Object.freeze([]);
  if (typeof raw !== 'string' || raw.length > 16000) throw new Error('invalid GPULINK_BROKER_PROFILES_JSON');
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error('invalid GPULINK_BROKER_PROFILES_JSON'); }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 16)
    throw new Error('GPULINK_BROKER_PROFILES_JSON must contain 1-16 broker profiles');
  const seenTokens = new Set(otherSecrets);
  const seenIds = new Set();
  const identities = new Set();
  const profiles = [];
  for (const candidate of parsed) {
    const entry = ownValues(candidate, APPROVAL_FIELDS);
    if (!entry) throw new Error('invalid GPULINK_BROKER_PROFILES_JSON profile');
    for (const field of ['brokerId','workerId','projectId','adapterIdentity','runtimePolicyRevision','approvalRef']) {
      if (typeof entry[field] !== 'string' || !ID.test(entry[field]))
        throw new Error('invalid GPULINK_BROKER_PROFILES_JSON identifier');
    }
    if (typeof entry.artifactDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(entry.artifactDigest))
      throw new Error('invalid GPULINK_BROKER_PROFILES_JSON digest');
    if (typeof entry.token !== 'string' || entry.token.length < 32 || entry.token.length > 512 ||
        !/^[\x21-\x7e]+$/u.test(entry.token))
      throw new Error('invalid GPULINK_BROKER_PROFILES_JSON credential');
    const identity = `${entry.workerId}\u0000${entry.projectId}`;
    if (seenIds.has(entry.brokerId) || identities.has(identity) || seenTokens.has(entry.token))
      throw new Error('GPULINK_BROKER_PROFILES_JSON contains ambiguous/reused broker identity or credential');
    seenIds.add(entry.brokerId); identities.add(identity); seenTokens.add(entry.token);
    profiles.push(Object.freeze(entry));
  }
  return Object.freeze(profiles);
}

export function authenticateBroker(profiles, authorization) {
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ') || authorization.length > 530) return null;
  const supplied = Buffer.from(authorization.slice(7), 'utf8');
  // Visit every entry to avoid revealing a broker identity via early exit.
  let matched = null;
  for (const principal of profiles) {
    const known = Buffer.from(principal.token, 'utf8');
    if (known.length === supplied.length && timingSafeEqual(known, supplied)) matched = principal;
  }
  return matched;
}

export function validateBrokerClaimRequest(raw) {
  const value = ownValues(raw, REQUEST_FIELDS);
  if (!value || value.schemaVersion !== 1 || !['job','session'].includes(value.subjectKind) ||
      ['subjectId','leaseId','attemptId'].some(k => typeof value[k] !== 'string' || !ID.test(value[k])))
    deny('broker_invalid_request', 400);
  return Object.freeze(value);
}

/** All decisions, including the exact GPU, are based on persisted control-plane
 * state. The existing atomic DB writer repeats all lease/worker checks under the
 * allocation lock, so a preliminary lookup cannot grant stale authority.
 */
export async function reserveBrokerBoundAttempt({persistence, profiles, authorization, request, clock, maxHeartbeatAgeMs}) {
  if (!Array.isArray(profiles) || profiles.length === 0) deny('broker_disabled', 404);
  const principal = authenticateBroker(profiles, authorization);
  if (!principal) deny('broker_unauthorized', 401);
  const input = validateBrokerClaimRequest(request);
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 1 ||
      !Number.isSafeInteger(maxHeartbeatAgeMs) || maxHeartbeatAgeMs < 1 || maxHeartbeatAgeMs > 300000)
    deny('broker_authority_unavailable', 503);
  if (!persistence || typeof persistence.transaction !== 'function') deny('broker_authority_unavailable', 503);
  try {
    return await persistence.transaction(async tx => {
      const lookup = input.subjectKind === 'job' ? 'getJob' : 'getSession';
      if (!tx || typeof tx[lookup] !== 'function' || typeof tx.reserveExecutionAttempt !== 'function')
        deny('broker_authority_unavailable', 503);
      const stored = await tx[lookup](input.subjectId);
      if (!stored || stored.projectId !== principal.projectId ||
          stored.assignedWorkerId !== principal.workerId ||
          stored.leaseId !== input.leaseId ||
          typeof stored.assignedGpuUuid !== 'string') deny('broker_claim_denied');
      const result = await tx.reserveExecutionAttempt({
        subjectKind: input.subjectKind, subjectId: stored.id,
        leaseId: input.leaseId, workerId: principal.workerId,
        gpuUuid: stored.assignedGpuUuid, attemptId: input.attemptId,
        artifactDigest: principal.artifactDigest,
        adapterIdentity: principal.adapterIdentity,
        runtimePolicyRevision: principal.runtimePolicyRevision,
        approvalRef: principal.approvalRef, now, maxHeartbeatAgeMs,
      });
      if (!result || result.canLaunch !== false || result.attemptId !== input.attemptId ||
          !Number.isSafeInteger(result.fenceEpoch) || result.fenceEpoch < 1)
        deny('broker_authority_unavailable', 503);
      return Object.freeze({schemaVersion:1,attemptId:result.attemptId,fenceEpoch:result.fenceEpoch,
        status:'reserved-not-launchable',canLaunch:false});
    });
  } catch (error) {
    if (error instanceof BrokerClaimError) throw error;
    if (error instanceof ExecutionClaimDenied) deny('broker_claim_denied');
    // Database uniqueness, lock contention, missing schema, or service outage;
    // never disclose database internals or make a best-effort admission.
    deny('broker_authority_unavailable', 503);
  }
}

/**
 * D1 read-only broker reconciliation. A matching database hold is not physical
 * cleanup evidence; missing/mismatched records never permit release or launch.
 * Observations are scoped to the authenticated operator's worker + project.
 */
export async function observeBrokerBoundAttempt({persistence,profiles,authorization,request}) {
  if (!Array.isArray(profiles) || profiles.length===0) deny('broker_disabled',404);
  const principal=authenticateBroker(profiles,authorization);
  if (!principal) deny('broker_unauthorized',401);
  const input=validateBrokerClaimRequest(request);
  if (!persistence || typeof persistence.transaction!=='function')
    deny('broker_authority_unavailable',503);
  try {
    return await persistence.transaction(async tx=>{
      if (!tx || typeof tx.observeExecutionAttempt!=='function')
        deny('broker_authority_unavailable',503);
      const row=await tx.observeExecutionAttempt({...input,
        workerId:principal.workerId,projectId:principal.projectId});
      const held=Boolean(row && row.fenceState !== null &&
        row.fenceState!=='clear' &&
        row.fenceAttemptId===row.attemptId &&
        row.fenceLeaseId===row.leaseId &&
        row.fenceSubjectKind===row.subjectKind &&
        row.fenceSubjectId===row.subjectId &&
        row.currentFenceEpoch===row.fenceEpoch);
      if (row && (!Number.isSafeInteger(row.fenceEpoch) || row.fenceEpoch<1))
        deny('broker_authority_unavailable',503);
      return Object.freeze({
        schemaVersion:1,attemptId:input.attemptId,
        disposition:row?(held?'held':'unconfirmed'):'not_found',
        fenceEpoch:row?row.fenceEpoch:null,
        canLaunch:false,canRelease:false,evidenceVerified:false,
      });
    });
  } catch(error) {
    if (error instanceof BrokerClaimError) throw error;
    deny('broker_authority_unavailable',503);
  }
}
