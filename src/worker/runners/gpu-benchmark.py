#!/usr/bin/env python3
"""Fixed PyTorch CUDA matrix-multiplication benchmark for GPUlink."""

from __future__ import annotations

import argparse
import json
import math
import statistics
import sys

SCHEMA_VERSION = 1
MATRIX_SIZES = (1024, 2048, 4096, 8192)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(add_help=False)
    result.add_argument("--health", action="store_true")
    result.add_argument("--matrix-size", type=int, choices=MATRIX_SIZES)
    result.add_argument("--warmup-iterations", type=int)
    result.add_argument("--measured-iterations", type=int)
    return result


def require_range(value: int | None, name: str, minimum: int, maximum: int) -> int:
    if value is None or value < minimum or value > maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return value


def load_torch():
    import torch

    if not torch.cuda.is_available():
        raise RuntimeError("PyTorch CUDA runtime is unavailable")
    if torch.cuda.device_count() != 1:
        raise RuntimeError("benchmark runner requires exactly one visible CUDA device")
    return torch


def health() -> dict[str, object]:
    torch = load_torch()
    return {
        "schemaVersion": SCHEMA_VERSION,
        "status": "ok",
        "backend": "pytorch-cuda",
        "backendVersion": torch.__version__,
        "cudaRuntimeVersion": torch.version.cuda,
        "deviceCount": torch.cuda.device_count(),
    }


def run(args: argparse.Namespace) -> dict[str, object]:
    matrix_size = args.matrix_size
    if matrix_size not in MATRIX_SIZES:
        raise ValueError(f"matrix-size must be one of {', '.join(map(str, MATRIX_SIZES))}")
    warmup_iterations = require_range(args.warmup_iterations, "warmup-iterations", 1, 10)
    measured_iterations = require_range(args.measured_iterations, "measured-iterations", 1, 25)

    torch = load_torch()
    torch.manual_seed(0)
    torch.cuda.manual_seed_all(0)
    torch.set_float32_matmul_precision("highest")
    torch.backends.cuda.matmul.allow_tf32 = False
    device = torch.device("cuda:0")

    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats(device)
    left = torch.randn((matrix_size, matrix_size), device=device, dtype=torch.float32)
    right = torch.randn((matrix_size, matrix_size), device=device, dtype=torch.float32)

    for _ in range(warmup_iterations):
        torch.mm(left, right)
    torch.cuda.synchronize(device)

    timings_ms: list[float] = []
    for _ in range(measured_iterations):
        start = torch.cuda.Event(enable_timing=True)
        end = torch.cuda.Event(enable_timing=True)
        start.record()
        torch.mm(left, right)
        end.record()
        end.synchronize()
        timings_ms.append(float(start.elapsed_time(end)))

    median_ms = statistics.median(timings_ms)
    sorted_timings = sorted(timings_ms)
    p95_position = (len(sorted_timings) - 1) * 0.95
    p95_lower = math.floor(p95_position)
    p95_upper = math.ceil(p95_position)
    p95_weight = p95_position - p95_lower
    p95_ms = (
        sorted_timings[p95_lower] * (1 - p95_weight)
        + sorted_timings[p95_upper] * p95_weight
    )
    operations = 2 * matrix_size**3
    estimated_tflops = operations / (median_ms / 1000) / 1_000_000_000_000

    return {
        "schemaVersion": SCHEMA_VERSION,
        "backend": "pytorch-cuda",
        "backendVersion": torch.__version__,
        "cudaRuntimeVersion": torch.version.cuda,
        "matrixSize": matrix_size,
        "dtype": "float32",
        "warmupIterations": warmup_iterations,
        "measuredIterations": measured_iterations,
        "medianIterationMs": round(median_ms, 6),
        "p95IterationMs": round(p95_ms, 6),
        "estimatedTflops": round(estimated_tflops, 6),
        "peakAllocatedMiB": round(torch.cuda.max_memory_allocated(device) / 1_048_576, 3),
    }


def main() -> int:
    try:
        args = parser().parse_args()
        if args.health:
            if any(
                value is not None
                for value in (args.matrix_size, args.warmup_iterations, args.measured_iterations)
            ):
                raise ValueError("health probe does not accept benchmark parameters")
            result = health()
        else:
            result = run(args)
        sys.stdout.write(json.dumps(result, separators=(",", ":")) + "\n")
        return 0
    except Exception as error:  # The Node adapter owns the structured job failure.
        sys.stderr.write(f"benchmark runner failed: {error}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
