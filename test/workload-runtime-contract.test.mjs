import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateRuntimeReport, validateRuntimePolicy, validateWorkloadRequest,
  selectWorkloadRuntime, assertRuntimeAdmission,
} from '../src/worker/workload-runtime-contract.mjs';

const sha = 'c'.repeat(64);
export const artifact = Object.freeze({adapterId:'example.echo', version:'1.0.0', sha256:sha});
export const request = () => ({schemaVersion:1,attemptId:'a1',sessionId:'s1',leaseId:'lease1',
  artifact:{...artifact},requiredIpcVersion:1,requiredIsolation:[]});
export const policy = () => ({schemaVersion:1,approvedArtifacts:[{artifact:{...artifact},trustClass:'operator-trusted'}],
  enabledRuntimeIds:['fake-a','fake-b'],trustedProcessEnabled:true,allowSimulation:true});
export const report = (runtimeId='fake-a') => ({schemaVersion:1,runtimeId,kind:'trusted-process',
  availability:'available',verification:'simulated',supportedIpcVersions:[1],isolationProperties:[]});
const admitted = (overrides={}) => selectWorkloadRuntime({request:request(),policy:policy(),
  runtimeReports:[report()],...overrides});
const code = code => err => err?.code === code;

test('CAP: strict canonical runtime schema and frozen output', () => {
  const normalized = validateRuntimeReport({...report(),supportedIpcVersions:[2,1],isolationProperties:['network','process']});
  assert.deepEqual(normalized.supportedIpcVersions,[1,2]);
  assert.deepEqual(normalized.isolationProperties,['network','process']);
  assert.ok(Object.isFrozen(normalized));
  assert.ok(Object.isFrozen(normalized.isolationProperties));
});
test('CAP: unknown property, missing property, unknown schema rejected', () => {
  for (const value of [{...report(),danger:true},{...report(),schemaVersion:2},
    {...report(),availability:'online'}, {...report(),supportedIpcVersions:[1,1]},
    {...report(),isolationProperties:['gpu-complete']}, {...report(),verification:'verified-by-client'}]) {
    assert.throws(()=>validateRuntimeReport(value),code('invalid_runtime_report'));
  }
});
test('CAP: deterministic selection across runtime list ordering', () => {
  const a = admitted({runtimeReports:[report('fake-b'),report('fake-a')]});
  const b = admitted({runtimeReports:[report('fake-a'),report('fake-b')]});
  assert.equal(a.runtimeId,'fake-a');assert.equal(b.runtimeId,'fake-a');
  assert.ok(Object.isFrozen(a));
});
test('CAP: duplicate runtime IDs rejected, not silently overwritten', () => {
  assert.throws(()=>admitted({runtimeReports:[report(),report()]}),code('duplicate_runtime_id'));
});
test('CAP: unavailable, unsupported IPC, missing isolation all fail closed', () => {
  assert.throws(()=>admitted({runtimeReports:[{...report(),availability:'unavailable'}]}),code('no_eligible_runtime'));
  assert.throws(()=>admitted({request:{...request(),requiredIpcVersion:2}}),code('no_eligible_runtime'));
  assert.throws(()=>admitted({request:{...request(),requiredIsolation:['network']}}),code('no_eligible_runtime'));
});
test('CAP: runtime verification must be allowed by operator policy', () => {
  assert.throws(()=>admitted({policy:{...policy(),allowSimulation:false}}),code('no_eligible_runtime'));
});
test('POL: unknown artifact or mutated immutable digest denied', () => {
  assert.throws(()=>admitted({request:{...request(),artifact:{...artifact,sha256:'d'.repeat(64)}}}),code('artifact_not_approved'));
});
test('POL: reviewed and unknown tenant classes fail closed in B1', () => {
  for(const trustClass of ['reviewed-third-party','untrusted']) {
    assert.throws(()=>admitted({policy:{...policy(),approvedArtifacts:[{artifact,trustClass}]}}),code('trust_class_not_supported'));
  }
});
test('POL: default-deny without explicitly enabled trusted subprocess', () => {
  assert.throws(()=>admitted({policy:{...policy(),trustedProcessEnabled:false}}),code('no_eligible_runtime'));
});
test('POL: disabled runtime selection never falls back', () => {
  assert.throws(()=>admitted({policy:{...policy(),enabledRuntimeIds:['fake-b']}}),code('no_eligible_runtime'));
});
test('POL: isolation requirement prevents trusted-process fallback', () => {
  assert.throws(()=>admitted({request:{...request(),requiredIsolation:['filesystem']},
    runtimeReports:[report(), {...report('fake-b'),kind:'isolated-oci',availability:'unavailable',isolationProperties:['filesystem']}]}),
  code('no_eligible_runtime'));
});
test('POL: duplicate approvals cannot introduce ambiguous trust', () => {
  assert.throws(()=>validateRuntimePolicy({...policy(),approvedArtifacts:[...policy().approvedArtifacts,
    {artifact,trustClass:'untrusted'}]}),code('duplicate_artifact_approval'));
});
test('POL: malicious fields are rejected in request/policy, no paths/commands accepted', () => {
  assert.throws(()=>validateWorkloadRequest({...request(),executable:'/bin/sh'}),code('invalid_workload_request'));
  assert.throws(()=>validateRuntimePolicy({...policy(),hostNetwork:true}),code('invalid_runtime_policy'));
});
test('POL: only branded internal decisions pass fake runtime admission', () => {
  const selection = admitted();
  assert.equal(assertRuntimeAdmission(selection,'fake-a'),selection);
  assert.throws(()=>assertRuntimeAdmission({...selection},'fake-a'),code('invalid_runtime_admission'));
  assert.throws(()=>assertRuntimeAdmission(selection,'fake-b'),code('invalid_runtime_admission'));
});
test('POL: invalid identifiers, digest and IPC fail with bounded code', () => {
  assert.throws(()=>validateWorkloadRequest({...request(),attemptId:'../bad'}),code('invalid_workload_request'));
  assert.throws(()=>validateWorkloadRequest({...request(),requiredIpcVersion:0}),code('invalid_workload_request'));
  assert.throws(()=>validateWorkloadRequest({...request(),artifact:{...artifact,sha256:'no'}}),code('invalid_artifact'));
});
