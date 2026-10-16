-- GPULink DP3C3B2C2B1: storage-only. Managed execution remains disabled.
-- Never backfill missing fence rows as clear: existing workloads may still be running.
CREATE TABLE gpu_resource_fences (
  worker_id TEXT NOT NULL REFERENCES workers(id),
  gpu_uuid TEXT NOT NULL CHECK (length(gpu_uuid) > 0),
  epoch BIGINT NOT NULL CHECK (epoch >= 1),
  safety_state TEXT NOT NULL CHECK (safety_state IN
    ('clear','allocated','reserved','running','cleanup_required','quarantined')),
  subject_kind TEXT CHECK (subject_kind IN ('session','job')),
  subject_id TEXT,
  lease_id TEXT,
  attempt_id TEXT,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (worker_id, gpu_uuid),
  CHECK (
    (safety_state = 'clear' AND subject_kind IS NULL AND
      subject_id IS NULL AND lease_id IS NULL AND attempt_id IS NULL)
    OR
    (safety_state <> 'clear' AND subject_kind IS NOT NULL AND
      subject_id IS NOT NULL AND lease_id IS NOT NULL)
  ),
  CHECK (safety_state <> 'allocated' OR attempt_id IS NULL)
);
CREATE INDEX gpu_resource_fences_state_idx
  ON gpu_resource_fences (safety_state, worker_id, gpu_uuid);

CREATE TABLE execution_attempts (
  attempt_id TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('session','job')),
  subject_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  worker_id TEXT NOT NULL REFERENCES workers(id),
  gpu_uuid TEXT NOT NULL CHECK (length(gpu_uuid) > 0),
  fence_epoch BIGINT NOT NULL CHECK (fence_epoch >= 1),
  artifact_digest TEXT NOT NULL,
  adapter_identity TEXT NOT NULL,
  runtime_policy_revision TEXT NOT NULL,
  approval_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN
    ('reserved','preparing','running','stopping','terminated','cleanup_required','quarantined')),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  cleanup_evidence_id TEXT,
  FOREIGN KEY (worker_id, gpu_uuid) REFERENCES gpu_resource_fences(worker_id, gpu_uuid) ON DELETE RESTRICT,
  CHECK (length(attempt_id) > 0 AND length(subject_id) > 0 AND
    length(project_id) > 0 AND length(lease_id) > 0 AND
    length(artifact_digest) > 0 AND length(adapter_identity) > 0 AND
    length(runtime_policy_revision) > 0 AND length(approval_ref) > 0)
);
CREATE UNIQUE INDEX execution_attempts_open_resource_idx
  ON execution_attempts (worker_id, gpu_uuid)
  WHERE status <> 'terminated';
CREATE INDEX execution_attempts_lease_idx
  ON execution_attempts (subject_kind, subject_id, lease_id);
