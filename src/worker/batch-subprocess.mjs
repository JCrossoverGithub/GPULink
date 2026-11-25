import { ADAPTER_IPC_TYPES as T, decodeAdapterIpcText } from './adapter-ipc-v1.mjs';
import { startAdapterSubprocess } from './adapter-subprocess-supervisor.mjs';
import { batchJson, BATCH_JSON_LIMIT } from '../shared/batch-contract.mjs';

function bad(code) { return Object.assign(new Error(`External batch: ${code}`), {code}); }

// Same credential-free GLIP supervisor as streaming. One JSON object each way;
// END echo and exit 0 are mandatory. On *every* path after spawn, wait for
// child close, not just READY rejection or an AbortSignal notification.
// Trusted operator code must not spawn independent/escaping descendants.
export async function executeBatchSubprocess(job, {signal, gpu}, command, limits) {
  if (!signal || signal.aborted || !gpu || gpu.uuid !== job.assignedGpuUuid ||
      !/^GPU-[a-fA-F0-9-]{32,64}$/u.test(gpu.uuid)) throw bad('invalid_assignment');
  const input = batchJson(job.payload, 'batch input');
  let result;
  let received = false;
  const child = startAdapterSubprocess({
    executable:command.executable, args:command.args, sessionId:job.id,
    signal, cudaVisibleDevices:gpu.uuid,
    sessionTimeoutMs:limits?.sessionTimeoutMs ?? 30_000,
    onFrame(frame) {
      if (received || frame.type !== T.TEXT || frame.payload.length > BATCH_JSON_LIMIT) {
        throw bad('invalid_result_frame');
      }
      const parsed = JSON.parse(decodeAdapterIpcText(frame.payload));
      batchJson(parsed, 'batch result');
      result = parsed;
      received = true;
    },
  });
  try {
    await child.ready;
    await child.sendText(input);
    await child.end();
    if (!received || signal.aborted) throw bad('incomplete_or_cancelled');
    return result;
  } catch (error) {
    child.cancel();
    await child.completed.catch(() => {});
    // Do not forward stderr, executable paths, raw JSON or program exceptions.
    throw bad('execution_failed');
  }
}
