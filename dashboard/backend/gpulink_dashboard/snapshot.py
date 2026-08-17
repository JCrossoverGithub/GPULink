from __future__ import annotations

from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any


JOB_FIELDS = (
    "id",
    "projectId",
    "type",
    "priority",
    "status",
    "assignedWorkerId",
    "assignedGpuUuid",
    "attempt",
    "maxAttempts",
    "createdAt",
    "updatedAt",
)

WORKER_FIELDS = (
    "id",
    "name",
    "version",
    "status",
    "drainMode",
    "lastSeenAt",
    "createdAt",
    "updatedAt",
)

GPU_FIELDS = (
    "uuid",
    "index",
    "name",
    "memoryTotalMiB",
    "memoryUsedMiB",
    "utilizationPercent",
    "temperatureC",
    "powerDrawWatts",
)


def build_snapshot(client: Any) -> dict[str, Any]:
    with ThreadPoolExecutor(max_workers=3, thread_name_prefix="gpulink-snapshot") as executor:
        health_future = executor.submit(client.health)
        workers_future = executor.submit(client.workers)
        jobs_future = executor.submit(client.jobs, limit=100)
        health_payload = health_future.result()
        worker_payload = workers_future.result()
        job_payload = jobs_future.result()

    workers = _project_workers(_list_field(worker_payload, "workers"))
    jobs = _list_field(job_payload, "jobs")
    ordered_jobs = sorted(jobs, key=lambda job: _integer(job.get("createdAt")), reverse=True)
    safe_jobs = [{field: job.get(field) for field in JOB_FIELDS} for job in ordered_jobs]

    gpus = [gpu for worker in workers for gpu in _list_value(worker.get("gpus"))]
    online_workers = sum(worker.get("status") == "online" for worker in workers)
    drained_workers = sum(bool(worker.get("drainMode")) for worker in workers)
    jobs_by_status = Counter(str(job.get("status", "unknown")) for job in jobs)

    memory_total = sum(_number(gpu.get("memoryTotalMiB")) for gpu in gpus)
    memory_used = sum(_number(gpu.get("memoryUsedMiB")) for gpu in gpus)

    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "controlPlane": {
            "status": health_payload.get("status", "unknown"),
        },
        "summary": {
            "workersTotal": len(workers),
            "workersOnline": online_workers,
            "workersDrained": drained_workers,
            "gpusTotal": len(gpus),
            "memoryTotalMiB": memory_total,
            "memoryUsedMiB": memory_used,
            "jobsTotal": len(jobs),
            "jobsQueued": jobs_by_status["queued"],
            "jobsRunning": jobs_by_status["running"],
            "jobsFailed": jobs_by_status["failed"],
        },
        "jobsByStatus": dict(sorted(jobs_by_status.items())),
        "workers": workers,
        "jobs": safe_jobs[:50],
    }


def _list_field(payload: Any, field: str) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        return []
    return [item for item in _list_value(payload.get(field)) if isinstance(item, dict)]


def _project_workers(workers: list[dict[str, Any]]) -> list[dict[str, Any]]:
    projected = []
    for worker in workers:
        safe_worker = {field: worker.get(field) for field in WORKER_FIELDS}
        safe_worker["labels"] = {
            str(key): str(value)
            for key, value in _dict_value(worker.get("labels")).items()
        }
        safe_worker["capabilities"] = [
            str(value) for value in _list_value(worker.get("capabilities"))
        ]
        safe_worker["warmModels"] = [
            str(value) for value in _list_value(worker.get("warmModels"))
        ]
        safe_worker["gpus"] = [
            {field: gpu.get(field) for field in GPU_FIELDS}
            for gpu in _list_value(worker.get("gpus"))
            if isinstance(gpu, dict)
        ]
        projected.append(safe_worker)
    return projected


def _list_value(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _dict_value(value: Any) -> dict[Any, Any]:
    return value if isinstance(value, dict) else {}


def _number(value: Any) -> float:
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else 0


def _integer(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0
