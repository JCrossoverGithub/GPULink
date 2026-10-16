import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DATA_PLANE_SUBPROTOCOL,
  DATA_PLANE_SUBPROTOCOL_V2,
  DATA_PLANE_RELAY_READY_V2,
  DATA_PLANE_MAX_FRAME_BYTES,
  validateDataPlaneFrameSize,
} from "../src/shared/data-plane-contract.mjs";

import {
  createSessionAdapterRegistry,
  probeSessionAdapters,
} from "../src/worker/session-adapters.mjs";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/phase6a-asr-v1.json", import.meta.url),
    "utf8",
  ),
);

test("ASR fixture pins audio format and version", () => {
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.applicationProtocol, "gpulink.asr.v1");

  const audio = fixture.audio;

  assert.equal(audio.encoding, "pcm_s16le");
  assert.equal(audio.sampleRateHz, 16_000);
  assert.equal(audio.channels, 1);
  assert.equal(audio.frameMagic, "ASR1");
  assert.equal(audio.frameHeaderBytes, 16);

  const samples = audio.sampleRateHz * audio.frameDurationMs / 1000;
  assert.equal(samples, 640);
  assert.equal(audio.example.sampleCount, samples);
  assert.equal(audio.example.totalFrameBytes, 16 + samples * 2);
  assert.equal(
    validateDataPlaneFrameSize(audio.example.totalFrameBytes),
    true,
  );

  assert.equal(DATA_PLANE_MAX_FRAME_BYTES, 1_048_576);
});

test("ASR fixture defines distinct control message types", () => {
  const expected = [
    "asr.start.v1",
    "asr.model_ready.v1",
    "asr.partial.v1",
    "asr.final.v1",
    "asr.end.v1",
    "asr.completed.v1",
    "asr.cancel.v1",
    "asr.cancelled.v1",
    "asr.error.v1",
  ];

  const observed = fixture.messages.map((message) => message.type);

  assert.deepEqual(observed, expected);
  assert.equal(new Set(observed).size, expected.length);

  for (const message of fixture.messages) {
    assert.ok(
      Buffer.byteLength(JSON.stringify(message), "utf8") <= 16_384,
      `${message.type} exceeds proposed control-frame limit`,
    );
  }

  const partial = fixture.messages.find(
    (message) => message.type === "asr.partial.v1",
  );
  const final = fixture.messages.find(
    (message) => message.type === "asr.final.v1",
  );

  assert.equal(partial.segmentId, final.segmentId);
  assert.ok(final.revision > partial.revision);
  assert.ok(final.endSample > final.startSample);
});

test("proposed binary header has deterministic offsets", () => {
  const { audio } = fixture;
  const example = audio.example;

  const bytes = Buffer.alloc(example.totalFrameBytes);

  bytes.write(audio.frameMagic, 0, 4, "ascii");
  bytes.writeUInt32LE(example.sequence, 4);
  bytes.writeUInt32LE(example.sampleOffset, 8);
  bytes.writeUInt32LE(example.sampleCount, 12);

  assert.equal(bytes.toString("ascii", 0, 4), "ASR1");
  assert.equal(bytes.readUInt32LE(4), 0);
  assert.equal(bytes.readUInt32LE(8), 0);
  assert.equal(bytes.readUInt32LE(12), 640);
  assert.equal(bytes.length - 16, 640 * 2);
});

test("existing GPULink relay contract stays unchanged", () => {
  assert.equal(DATA_PLANE_SUBPROTOCOL, "gpulink.data-plane.v1");
  assert.equal(DATA_PLANE_SUBPROTOCOL_V2, "gpulink.data-plane.v2");
  assert.equal(
    DATA_PLANE_RELAY_READY_V2,
    "gpulink.relay.ready.v2",
  );
});

test("existing registry accepts a v2 ASR session adapter", async () => {
  const adapter = {
    manifest: {
      schemaVersion: 2,
      type: "speech.streaming.single",
      version: "0.1.0",
      executionMode: "streaming-gateway",
      adapterId: "speech.streaming.single.asr-v1",
    },
    async readinessProbe() {
      return true;
    },
    async handleSession() {},
  };

  const registry = createSessionAdapterRegistry([adapter]);

  assert.equal(registry.size, 1);

  const report = await probeSessionAdapters(registry);

  assert.deepEqual(report.capabilities, [
    "speech.streaming.single",
  ]);
  assert.equal(report.adapterHealth[0].state, "ready");
});

test("unready adapter does not advertise an ASR capability", async () => {
  const registry = createSessionAdapterRegistry([
    {
      manifest: {
        schemaVersion: 2,
        type: "speech.streaming.single",
        version: "0.1.0",
        executionMode: "streaming-gateway",
        adapterId: "speech.streaming.single.asr-v1",
      },
      async readinessProbe() {
        return false;
      },
      async handleSession() {},
    },
  ]);

  const report = await probeSessionAdapters(registry);

  assert.deepEqual(report.capabilities, []);
  assert.deepEqual(report.adapterManifests, []);
  assert.equal(report.adapterHealth[0].state, "unavailable");
});
