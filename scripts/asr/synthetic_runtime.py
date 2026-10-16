#!/usr/bin/env python3
"""Deterministic, stdlib-only IPC test runtime. NEVER performs inference."""
import base64
import json
import os
import signal
import sys
import time

MAX_LINE = 16_384
MAX_FRAME_SAMPLES = 3_200
MAX_SESSION_SAMPLES = 28_800_000
MODES = {
    "normal", "no_ready", "wrong_ready", "bad_ack", "no_ack",
    "slow_ack", "crash_on_audio", "oversized_output", "ignore_term",
}


def exact(message, keys):
    if not isinstance(message, dict) or set(message) != set(keys):
        raise ValueError("invalid IPC message fields")


def emit(message):
    line = json.dumps(message, separators=(",", ":"), ensure_ascii=True)
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def read_message():
    line = sys.stdin.buffer.readline(MAX_LINE + 2)
    if not line:
        return None
    if len(line) > MAX_LINE or not line.endswith(b"\n"):
        raise ValueError("invalid IPC message length")
    return json.loads(line.decode("utf-8", errors="strict"))


def run():
    mode = os.environ.get("GPULINK_SYNTHETIC_MODE", "normal")
    if mode not in MODES:
        return 2
    if mode == "ignore_term" and hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, signal.SIG_IGN)

    message = read_message()
    exact(message, ("type", "modelId", "revision", "encoding", "sampleRateHz", "channels"))
    if (message["type"] != "asr.ipc.start.v1" or
            message["encoding"] != "pcm_s16le" or
            message["sampleRateHz"] != 16_000 or message["channels"] != 1 or
            not isinstance(message["modelId"], str) or
            not isinstance(message["revision"], str)):
        raise ValueError("invalid start")

    if mode == "no_ready":
        while True:
            time.sleep(1)
    if mode == "oversized_output":
        sys.stdout.write("X" * (MAX_LINE + 100) + "\n")
        sys.stdout.flush()
        while True:
            time.sleep(1)

    emit({
        "type": "asr.ipc.ready.v1",
        "modelId": "invalid/wrong" if mode == "wrong_ready" else message["modelId"],
        "revision": message["revision"],
    })

    expected_sequence = 0
    offset = 0
    while True:
        m = read_message()
        if m is None:
            return 1  # Unexpected EOF is NOT successful completion.
        if not isinstance(m, dict):
            raise ValueError("invalid message")
        if m.get("type") == "asr.ipc.audio.v1":
            exact(m, ("type", "sequence", "sampleOffset", "sampleCount", "pcmBase64"))
            if (type(m["sequence"]) is not int or m["sequence"] != expected_sequence or
                    type(m["sampleOffset"]) is not int or m["sampleOffset"] != offset or
                    type(m["sampleCount"]) is not int or
                    not 1 <= m["sampleCount"] <= MAX_FRAME_SAMPLES or
                    offset + m["sampleCount"] > MAX_SESSION_SAMPLES or
                    not isinstance(m["pcmBase64"], str)):
                raise ValueError("invalid audio sequence")
            pcm = base64.b64decode(m["pcmBase64"], validate=True)
            if len(pcm) != m["sampleCount"] * 2:
                raise ValueError("invalid audio payload")
            if mode == "crash_on_audio":
                os._exit(33)
            if mode == "slow_ack":
                time.sleep(0.15)
            # Synthetic consumption = checked PCM bytes handled in this loop.
            # Real ASR must ACK only after the inference engine consumes them.
            offset += m["sampleCount"]
            expected_sequence += 1
            if mode != "no_ack":
                emit({
                    "type": "asr.ipc.consumed.v1",
                    "sequence": m["sequence"],
                    "endSample": offset + (1 if mode == "bad_ack" else 0),
                })
        elif m.get("type") == "asr.ipc.end.v1":
            exact(m, ("type", "lastSequence"))
            if (type(m["lastSequence"]) is not int or
                    expected_sequence == 0 or
                    m["lastSequence"] != expected_sequence - 1):
                raise ValueError("invalid end")
            emit({"type": "asr.ipc.completed.v1", "lastSequence": m["lastSequence"]})
            return 0
        else:
            raise ValueError("unexpected IPC message")


if __name__ == "__main__":
    try:
        sys.exit(run())
    except (ValueError, TypeError, KeyError, json.JSONDecodeError):
        # No user audio or local path content is sent over the IPC error channel.
        sys.exit(2)
