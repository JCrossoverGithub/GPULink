#!/usr/bin/env python3
"""GPU-free GPULink adapter IPC v1 example, stdlib-only, no worker credentials."""
import json
import struct
import sys

MAGIC = b"GLIP"
MAX_PAYLOAD = 65536
HELLO, READY, BINARY, TEXT, END, ERROR, CANCEL = range(1, 8)


def exact_read(size):
    chunks = []
    while size:
        chunk = sys.stdin.buffer.read(size)
        if not chunk:
            raise EOFError("unexpected end of IPC frame")
        chunks.append(chunk)
        size -= len(chunk)
    return b"".join(chunks)


def read_frame():
    header = sys.stdin.buffer.read(9)
    if not header:
        return None
    if len(header) != 9:
        header += exact_read(9 - len(header))
    if header[:4] != MAGIC:
        raise ValueError("invalid IPC magic")
    kind, length = struct.unpack(">BI", header[4:])
    if kind not in range(HELLO, CANCEL + 1) or length > MAX_PAYLOAD:
        raise ValueError("invalid IPC kind or length")
    return kind, exact_read(length)


def send(kind, payload=b""):
    if len(payload) > MAX_PAYLOAD:
        raise ValueError("outbound IPC frame too large")
    sys.stdout.buffer.write(MAGIC + struct.pack(">BI", kind, len(payload)) + payload)
    sys.stdout.buffer.flush()


def main():
    first = read_frame()
    if first is None or first[0] != HELLO:
        raise ValueError("expected HELLO")
    hello = json.loads(first[1].decode("utf-8", errors="strict"))
    if (not isinstance(hello, dict) or
            set(hello) != {"protocol", "version", "sessionId"} or
            hello["protocol"] != "gpulink.adapter.ipc" or
            hello["version"] != 1 or
            not isinstance(hello["sessionId"], str) or
            not 1 <= len(hello["sessionId"]) <= 128):
        raise ValueError("unsupported handshake")
    send(READY, json.dumps({
        "protocol": "gpulink.adapter.ipc", "version": 1, "ready": True
    }, separators=(",", ":")).encode("utf-8"))
    while True:
        frame = read_frame()
        if frame is None:
            # EOF without an END or CANCEL must not count as successful completion.
            return 2
        kind, payload = frame
        if kind in (BINARY, TEXT):
            if kind == TEXT:
                payload.decode("utf-8", errors="strict")
            send(kind, payload)
        elif kind == END:
            if payload:
                raise ValueError("END requires empty payload")
            send(END)
            return 0
        elif kind == CANCEL:
            if payload:
                raise ValueError("CANCEL requires empty payload")
            return 0
        else:
            raise ValueError("invalid direction")


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (EOFError, UnicodeError, json.JSONDecodeError, ValueError):
        # No user-supplied payload or potentially sensitive text in stderr.
        sys.exit(2)
