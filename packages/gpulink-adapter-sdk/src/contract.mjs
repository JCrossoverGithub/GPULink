/**
 * Pre-v1 author-facing compatibility declaration. This is not a runtime
 * negotiation protocol and cannot approve or launch adapters. The existing
 * GLIP wire format, manifest, package and operator catalog remain authoritative.
 */
export const ADAPTER_SDK_COMPATIBILITY = Object.freeze({
  sdkVersion: '0.1.0',
  stability: 'experimental-pre-v1',
  ipc: Object.freeze({protocol: 'gpulink.adapter.ipc', version: 1}),
  manifestSchemaVersion: 2,
  packageSchemaVersion: 1,
  catalogSchemaVersion: 1,
  executionMode: 'streaming-gateway',
  completionModes: Object.freeze(['explicit-text-v1']),
});

export class AdapterCompatibilityError extends Error {
  constructor(code) {
    super(`GPULink Adapter SDK compatibility: ${code}`);
    this.code = code;
  }
}
const exact = (value, keys) => value !== null && typeof value === 'object' &&
  !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
function requireThat(ok, code) {
  if (!ok) throw new AdapterCompatibilityError(code);
}

/**
 * Author-side check of declared *version compatibility only*.
 * This does NOT validate package integrity, manifest identity, worker readiness,
 * adapter protocol behavior or operator approval. Those use separate tools.
 *
 * @param {{protocol:string, ipcVersion:number, manifestSchemaVersion:number,
 *   packageSchemaVersion:number, executionMode:string, completionMode:string}} declaration
 * @returns {Readonly<{compatible:true, sdkVersion:string}>}
 */
export function assertAdapterCompatibility(declaration) {
  requireThat(exact(declaration, ['protocol', 'ipcVersion', 'manifestSchemaVersion',
    'packageSchemaVersion', 'executionMode', 'completionMode']), 'invalid_declaration');
  const c = ADAPTER_SDK_COMPATIBILITY;
  requireThat(declaration.protocol === c.ipc.protocol &&
    declaration.ipcVersion === c.ipc.version, 'unsupported_ipc');
  requireThat(declaration.manifestSchemaVersion === c.manifestSchemaVersion,
    'unsupported_manifest');
  requireThat(declaration.packageSchemaVersion === c.packageSchemaVersion,
    'unsupported_package');
  requireThat(declaration.executionMode === c.executionMode, 'unsupported_execution_mode');
  requireThat(c.completionModes.includes(declaration.completionMode),
    'unsupported_completion_mode');
  return Object.freeze({compatible: true, sdkVersion: c.sdkVersion});
}
