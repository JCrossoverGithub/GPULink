import {
  BENCHMARK_TYPE,
  validateBenchmarkPayload,
} from "./benchmark-contract.mjs";
import {
  TRANSCRIPTION_TYPE,
  validateTranscriptionPayload,
} from "./transcription-contract.mjs";

const workloadValidators = new Map([
  [BENCHMARK_TYPE, validateBenchmarkPayload],
  [TRANSCRIPTION_TYPE, validateTranscriptionPayload],
]);

export function validateWorkloadPayload(type, payload) {
  return workloadValidators.get(type)?.(payload) ?? payload;
}
