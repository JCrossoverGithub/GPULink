import test from "node:test";
import assert from "node:assert/strict";
import {
  ASR_MAX_FRAME_SAMPLES, ASR_MAX_QUEUED_SAMPLES, ASR_MAX_SESSION_SAMPLES,
  AsrProtocolError, createAsrClientIngress, decodeAsrAudioFrame, parseAsrControlFrame,
} from "../src/shared/asr-protocol-v1.mjs";

const start = JSON.stringify({type:"asr.start.v1",audio:{encoding:"pcm_s16le",sampleRateHz:16000,channels:1}});
const end = (n) => JSON.stringify({type:"asr.end.v1",lastSequence:n});
function frame(sequence = 0, sampleOffset = 0, count = 640) {
  const b = Buffer.alloc(16 + count * 2);
  b.write("ASR1", 0, "ascii");
  b.writeUInt32LE(sequence, 4);
  b.writeUInt32LE(sampleOffset, 8);
  b.writeUInt32LE(count, 12);
  return b;
}
const rejects = (fn, code="input_invalid") => assert.throws(fn, (err) => err instanceof AsrProtocolError && err.code===code);

test("valid v1 audio and directional control", () => {
  assert.equal(decodeAsrAudioFrame(frame(),0,0).sampleCount,640);
  assert.equal(parseAsrControlFrame(start,"client").type,"asr.start.v1");
  assert.equal(parseAsrControlFrame(end(0),"client").lastSequence,0);
  assert.equal(parseAsrControlFrame('{"type":"asr.cancel.v1"}',"client").type,"asr.cancel.v1");
  assert.equal(parseAsrControlFrame(JSON.stringify({type:"asr.model_ready.v1", modelId:"nvidia/model", revision:"a".repeat(40)}),"worker").type,"asr.model_ready.v1");
  assert.equal(parseAsrControlFrame(JSON.stringify({type:"asr.final.v1",segmentId:1,revision:2,startSample:0,endSample:640,text:"hi"}),"worker").type,"asr.final.v1");
  assert.equal(parseAsrControlFrame('{"type":"asr.completed.v1","lastSequence":0}',"worker").type,"asr.completed.v1");
  assert.equal(parseAsrControlFrame('{"type":"asr.error.v1","code":"cuda_oom","retryable":false}',"worker").code,"cuda_oom");
});

test("control rejects unknown fields, directions, overrides, types and sizes", () => {
  rejects(() => parseAsrControlFrame(start,"worker"));
  rejects(() => parseAsrControlFrame('{"type":"asr.final.v1","segmentId":1,"revision":1,"startSample":0,"endSample":1,"text":"x"}',"client"));
  rejects(() => parseAsrControlFrame(start.slice(0,-1)+',"modelId":"evil"}',"client"));
  rejects(() => parseAsrControlFrame('{"type":"asr.cancel.v1","adapter":"evil"}',"client"));
  rejects(() => parseAsrControlFrame('{"type":"asr.cancel.v1","type":"asr.cancel.v1"}',"client"));
  rejects(() => parseAsrControlFrame('{"type":"asr.start.v1","audio":{"encoding":"pcm_s16le","\\u0065ncoding":"pcm_s16le","sampleRateHz":16000,"channels":1}}',"client"));
  rejects(() => parseAsrControlFrame('{"type":"asr.cancel.v1"}',"other"));
  rejects(() => parseAsrControlFrame('{',"client"));
  rejects(() => parseAsrControlFrame('[]',"client"));
  rejects(() => parseAsrControlFrame(' '.repeat(16385),"client"));
  rejects(() => parseAsrControlFrame('{"type":"asr.error.v1","code":"oops","retryable":false}',"worker"));
  rejects(() => parseAsrControlFrame('{"type":"asr.model_ready.v1","modelId":"foo","revision":"main"}',"worker"));
  rejects(() => parseAsrControlFrame(JSON.stringify({type:"asr.partial.v1",segmentId:1,revision:1,startSample:0,endSample:640,text:"😀".repeat(2000)}),"worker"));
  rejects(() => parseAsrControlFrame('{"type":"asr.start.v1","audio":{"encoding":"wav","sampleRateHz":16000,"channels":1}}',"client"));
});

test("audio parser rejects malformed, reordered, oversized and over-duration frames", () => {
  rejects(() => decodeAsrAudioFrame("not-buffer",0,0));
  rejects(() => decodeAsrAudioFrame(Buffer.alloc(15),0,0));
  const wrongMagic=frame();wrongMagic[0]=0;rejects(() => decodeAsrAudioFrame(wrongMagic,0,0));
  rejects(() => decodeAsrAudioFrame(frame(1),0,0));
  rejects(() => decodeAsrAudioFrame(frame(0,640),0,0));
  rejects(() => decodeAsrAudioFrame(frame().subarray(0, 17),0,0));
  rejects(() => decodeAsrAudioFrame(frame(0,0,ASR_MAX_FRAME_SAMPLES+1),0,0));
  rejects(() => decodeAsrAudioFrame(frame(0,ASR_MAX_SESSION_SAMPLES-1,2),0,ASR_MAX_SESSION_SAMPLES-1));
  rejects(() => decodeAsrAudioFrame(frame(0),4294967296,0));
});

test("ingress enforces start, ordering, end and cancellation", () => {
  const ingress=createAsrClientIngress();
  rejects(() => ingress.onAudio(frame()));
  rejects(() => ingress.onControl(end(0)));
  ingress.onControl(start);
  rejects(() => ingress.onControl(start));
  ingress.onAudio(frame());
  rejects(() => ingress.onAudio(frame(0,640)));
  rejects(() => ingress.onAudio(frame(2,640)));
  ingress.onAudio(frame(1,640));
  assert.equal(ingress.snapshot().nextSampleOffset,1280);
  rejects(() => ingress.onControl(end(9)));
  ingress.onControl(end(1));
  assert.equal(ingress.snapshot().state,"draining");
  rejects(() => ingress.onAudio(frame(2,1280)));
  ingress.onControl('{"type":"asr.cancel.v1"}');
  assert.equal(ingress.snapshot().state,"cancelled");
  rejects(() => ingress.onControl(start));
});

test("bounded queue rejects overflow without losing sequence and allows credit release", () => {
  const ingress=createAsrClientIngress();ingress.onControl(start);
  const samples=640;
  for(let i=0;i<ASR_MAX_QUEUED_SAMPLES/samples;i++) ingress.onAudio(frame(i,i*samples));
  assert.equal(ingress.snapshot().queuedSamples,ASR_MAX_QUEUED_SAMPLES);
  rejects(() => ingress.onAudio(frame(50,32_000)), "backpressure_limit");
  assert.equal(ingress.snapshot().nextSequence,50);
  ingress.releaseSamples(samples);
  ingress.onAudio(frame(50,32_000));
  assert.equal(ingress.snapshot().queuedSamples,ASR_MAX_QUEUED_SAMPLES);
  rejects(() => ingress.releaseSamples(ASR_MAX_QUEUED_SAMPLES+1));
});
