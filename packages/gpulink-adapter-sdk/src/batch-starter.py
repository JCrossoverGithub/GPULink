#!/usr/bin/env python3
"""GLIP v1 batch starter. Edit run(payload); stdout is reserved for protocol.
CPU example only: not evidence of CUDA execution. Trusted synchronous code only.
GPU work must use worker-assigned CUDA_VISIBLE_DEVICES and synchronize before returning.
"""
import json
import struct
import sys

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


def run(payload):
    """Replace this function with your own trusted workload. CPU example only."""
    return {"echo": payload, "backend": "cpu-starter"}


def reject_constant(value):
    raise ValueError("nonfinite JSON")


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
    payload = json.loads(frame[1].decode("utf-8", errors="strict"), parse_constant=reject_constant)
    if not isinstance(payload, dict) or read_frame() != (END, b""):
        return 2
    result = run(payload)
    if not isinstance(result, dict):
        return 2
    output = json.dumps(result, separators=(",", ":"), allow_nan=False).encode("utf-8")
    if len(output) > 32768:
        return 2
    send(TEXT, output)
    send(END)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        sys.exit(2)
