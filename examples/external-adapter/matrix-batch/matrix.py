#!/usr/bin/env python3
"""Operator-trusted GLIP v1 CUDA batch matrix transform; no GPULink imports.

For acceptance only. One JSON object in and out; no network, descendants, or client device selection.
"""
import json
import math
import os
import re
import struct
import sys
import time

MAGIC = b"GLIP"
MAX = 65536
HELLO, READY, BINARY, TEXT, END, ERROR, CANCEL = range(1, 8)


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
    if (not isinstance(hello, dict) or set(hello) != {"protocol", "version", "sessionId"}
            or hello["protocol"] != "gpulink.adapter.ipc" or hello["version"] != 1
            or not isinstance(hello["sessionId"], str)):
        return 2
    send(READY, b'{"protocol":"gpulink.adapter.ipc","version":1,"ready":true}')
    frame = read_frame()
    if frame is None or frame[0] != TEXT or len(frame[1]) > 32768:
        return 2
    request = json.loads(frame[1].decode("utf-8", errors="strict"))
    if not isinstance(request, dict) or set(request) != {"values", "holdMs"}:
        return 2
    values, hold = request["values"], request["holdMs"]
    if (not isinstance(values, list) or len(values) != 4 or
            not all(type(x) in (int, float) and math.isfinite(x) and abs(x) <= 16 for x in values)
            or type(hold) is not int or not 0 <= hold <= 15000):
        return 2
    if read_frame() != (END, b""):
        return 2
    torch, device, matrix = prepare()
    with torch.inference_mode():
        inputs = torch.tensor(values, dtype=torch.float32, device=device).reshape(2, 2)
        start = torch.cuda.Event(enable_timing=True)
        finish = torch.cuda.Event(enable_timing=True)
        start.record()
        result = torch.mm(matrix, inputs)
        finish.record()
        finish.synchronize()
        output = result.flatten().tolist()
        elapsed = float(start.elapsed_time(finish))
        if not all(math.isfinite(x) for x in output) or not math.isfinite(elapsed):
            return 2
        # Explicit bounded acceptance-only delay keeps the CUDA context alive
        # for the operator cancellation exercise; not a performance benchmark.
        time.sleep(hold / 1000)
        send(TEXT, json.dumps({"values": output, "backend": "pytorch-cuda",
            "elapsedMs": round(elapsed, 4)}, separators=(",", ":"), allow_nan=False).encode("utf-8"))
    send(END)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        sys.exit(2)
