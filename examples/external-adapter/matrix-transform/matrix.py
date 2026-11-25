#!/usr/bin/env python3
"""Operator-trusted GLIP v1 CUDA matrix transform; no GPULink imports.

For acceptance only: no model weights, network calls, arbitrary program inputs, or
client-specified device selection. GLIP READY means IPC ready; the explicit
example.matrix.ready.v1 event means the model and GPU are actually ready.
"""
import json
import math
import os
import re
import struct
import sys

MAGIC = b"GLIP"
MAX = 65536
HELLO, READY, BINARY, TEXT, END, ERROR, CANCEL = range(1, 8)
PREPARE = b'{"type":"example.matrix.prepare.v1"}'
READY_TEXT = b'{"type":"example.matrix.ready.v1","backend":"pytorch-cuda"}'


def read_exact(length):
    result = bytearray()
    while len(result) < length:
        part = sys.stdin.buffer.read(length - len(result))
        if not part:
            raise EOFError("unexpected EOF")
        result.extend(part)
    return bytes(result)


def read_frame():
    head = sys.stdin.buffer.read(9)
    if not head:
        return None
    if len(head) < 9:
        head += read_exact(9 - len(head))
    if head[:4] != MAGIC:
        raise ValueError("magic")
    kind, length = struct.unpack(">BI", head[4:])
    if kind not in range(1, 8) or length > MAX:
        raise ValueError("invalid frame")
    return kind, read_exact(length)


def send(kind, data=b""):
    if len(data) > MAX:
        raise ValueError("oversized output")
    sys.stdout.buffer.write(MAGIC + struct.pack(">BI", kind, len(data)) + data)
    sys.stdout.buffer.flush()


def prepare():
    # Set by the worker-selected physical UUID, never by the client request.
    uuid = os.environ.get("CUDA_VISIBLE_DEVICES", "")
    if not re.fullmatch(r"GPU-[A-Fa-f0-9-]{32,64}", uuid):
        raise ValueError("missing trusted CUDA device assignment")

    import torch
    if not torch.cuda.is_available() or torch.cuda.device_count() != 1:
        raise ValueError("assigned CUDA device unavailable")
    device = torch.device("cuda:0")
    torch.cuda.set_device(device)
    with torch.inference_mode():
        matrix = torch.tensor([[2., 3.], [-1., 4.]], device=device)
        torch.mm(matrix, torch.eye(2, device=device))
        torch.cuda.synchronize(device)
    return torch, device, matrix


def main():
    first = read_frame()
    if first is None or first[0] != HELLO:
        return 2
    hello = json.loads(first[1].decode("utf-8", errors="strict"))
    if (not isinstance(hello, dict) or
        set(hello) != {"protocol", "version", "sessionId"} or
        hello["protocol"] != "gpulink.adapter.ipc" or
        hello["version"] != 1 or
        not isinstance(hello["sessionId"], str) or
        not 1 <= len(hello["sessionId"]) <= 128):
        return 2
    send(READY, b'{"protocol":"gpulink.adapter.ipc","version":1,"ready":true}')

    if read_frame() != (TEXT, PREPARE):
        return 2
    torch, device, matrix = prepare()
    send(TEXT, READY_TEXT)

    incoming = read_frame()
    if incoming is None or incoming[0] != BINARY or len(incoming[1]) != 16:
        return 2
    values = struct.unpack(">4f", incoming[1])
    if not all(math.isfinite(x) and abs(x) <= 16 for x in values):
        return 2
    with torch.inference_mode():
        inputs = torch.tensor(values, dtype=torch.float32, device=device).reshape(2, 2)
        start = torch.cuda.Event(enable_timing=True)
        finish = torch.cuda.Event(enable_timing=True)
        start.record()
        result = torch.mm(matrix, inputs)
        finish.record()
        finish.synchronize()
        values_out = result.flatten().tolist()
        elapsed_ms = float(start.elapsed_time(finish))
    if not all(math.isfinite(v) for v in values_out) or not math.isfinite(elapsed_ms):
        return 2
    send(BINARY, struct.pack(">4f", *values_out))
    send(TEXT, json.dumps({"type":"example.matrix.executed.v1", "elapsedMs": round(elapsed_ms, 4)},
                          separators=(",", ":")).encode("utf-8"))
    terminal = read_frame()
    if terminal != (END, b""):
        return 2
    send(END)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (EOFError, UnicodeError, ValueError, ImportError, RuntimeError, OSError):
        # Never write sensitive environment, payloads or filesystem paths.
        sys.exit(2)
