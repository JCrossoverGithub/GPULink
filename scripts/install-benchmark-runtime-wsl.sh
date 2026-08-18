#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this installer with sudo." >&2
  exit 1
fi
if ! systemctl is-active --quiet gpulink-worker.service; then
  echo "Install and start the GPUlink WSL worker before the benchmark runtime." >&2
  exit 1
fi

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runner_source="${repository_root}/src/worker/runners/gpu-benchmark.py"
runner_installed=/opt/gpulink/src/worker/runners/gpu-benchmark.py
runtime_root=/opt/gpulink/runtime/benchmark
runtime_python="${runtime_root}/bin/python"
environment_file=/etc/gpulink/worker.env

if [[ ! -r ${runner_source} || ! -r ${runner_installed} ]]; then
  echo "Install the current GPUlink worker source before the benchmark runtime." >&2
  exit 1
fi
if [[ ! -f ${environment_file} ]]; then
  echo "GPUlink worker environment file is missing." >&2
  exit 1
fi

python_binary="${GPULINK_BENCHMARK_SYSTEM_PYTHON:-$(command -v python3 || true)}"
if [[ -z ${python_binary} || ${python_binary} != /* || ! -x ${python_binary} ]]; then
  echo "Python 3.10 or newer is required." >&2
  exit 1
fi
python_version="$(${python_binary} -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
python_major="${python_version%%.*}"
python_minor="${python_version#*.}"
if [[ ${python_major} -ne 3 || ${python_minor} -lt 10 || ${python_minor} -gt 14 ]]; then
  echo "Python 3.10 through 3.14 is required; found ${python_version}." >&2
  exit 1
fi

install -d -o root -g root -m 0755 /opt/gpulink/runtime
install -d -o gpulink -g gpulink -m 0750 /var/lib/gpulink/cache
if [[ ! -x ${runtime_python} ]]; then
  if ! "${python_binary}" -m venv "${runtime_root}"; then
    echo "Python venv support is required. On Ubuntu, install python3-venv." >&2
    exit 1
  fi
fi

"${runtime_python}" -m pip install \
  --disable-pip-version-check \
  --no-cache-dir \
  "torch==2.12.1" \
  --index-url https://download.pytorch.org/whl/cu130

chown -R root:root "${runtime_root}"
find "${runtime_root}" -type d -exec chmod 0755 {} +
find "${runtime_root}" -type f -exec chmod a+r {} +
chmod 0755 "${runtime_root}/bin/python" "${runtime_root}/bin/python3" 2>/dev/null || true

nvidia_smi_binary="${GPULINK_NVIDIA_SMI_BINARY:-/usr/lib/wsl/lib/nvidia-smi}"
if [[ ${nvidia_smi_binary} != /* || ! -x ${nvidia_smi_binary} ]]; then
  echo "Set GPULINK_NVIDIA_SMI_BINARY to an absolute executable path." >&2
  exit 1
fi
gpu_uuid="$("${nvidia_smi_binary}" --query-gpu=uuid --format=csv,noheader | sed -n '1{s/[[:space:]]*$//;p;}')"
if [[ -z ${gpu_uuid} ]]; then
  echo "No NVIDIA GPU UUID was reported inside WSL." >&2
  exit 1
fi
runuser -u gpulink -- env -i \
  HOME=/var/lib/gpulink \
  XDG_CACHE_HOME=/var/lib/gpulink/cache \
  PATH=/opt/gpulink/runtime:/usr/lib/wsl/lib:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/bin \
  LD_LIBRARY_PATH=/usr/lib/wsl/lib \
  CUDA_VISIBLE_DEVICES="${gpu_uuid}" \
  PYTHONUNBUFFERED=1 \
  "${runtime_python}" "${runner_installed}" --health >/dev/null

capabilities="$(sed -n 's/^GPULINK_WORKER_CAPABILITIES=//p' "${environment_file}")"
if [[ -z ${capabilities} ]]; then
  echo "GPUlink worker capabilities are missing." >&2
  exit 1
fi
if [[ ,${capabilities}, != *,benchmark.gpu,* ]]; then
  sed -i "s/^GPULINK_WORKER_CAPABILITIES=.*/GPULINK_WORKER_CAPABILITIES=${capabilities},benchmark.gpu/" "${environment_file}"
fi
grep -q '^GPULINK_WORKER_CAPABILITY_PROBE_INTERVAL_MS=' "${environment_file}" || \
  echo 'GPULINK_WORKER_CAPABILITY_PROBE_INTERVAL_MS=300000' >> "${environment_file}"
grep -q '^GPULINK_BENCHMARK_PYTHON=' "${environment_file}" || \
  echo "GPULINK_BENCHMARK_PYTHON=${runtime_python}" >> "${environment_file}"
grep -q '^GPULINK_BENCHMARK_TIMEOUT_MS=' "${environment_file}" || \
  echo 'GPULINK_BENCHMARK_TIMEOUT_MS=60000' >> "${environment_file}"
chown root:gpulink "${environment_file}"
chmod 0640 "${environment_file}"

systemctl restart gpulink-worker.service
systemctl is-active gpulink-worker.service
echo "GPUlink benchmark runtime installed and worker restarted"
