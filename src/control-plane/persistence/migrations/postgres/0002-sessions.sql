CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL
    CHECK (schema_version = 1),
  project_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  priority INTEGER NOT NULL,
  status TEXT NOT NULL
    CHECK (
      status IN (
        'requested',
        'allocated',
        'connecting',
        'active',
        'interrupted',
        'closed'
      )
    ),
  gpu_count INTEGER NOT NULL
    CHECK (gpu_count = 1),
  min_vram_mib INTEGER NOT NULL
    CHECK (min_vram_mib >= 0),
  required_capabilities_json JSONB NOT NULL,
  requested_model TEXT,
  requested_adapter TEXT,
  metadata_json JSONB NOT NULL,
  max_interruptions INTEGER NOT NULL
    CHECK (
      max_interruptions >= 0
      AND max_interruptions <= 3
    ),
  interruption_count INTEGER NOT NULL DEFAULT 0
    CHECK (interruption_count >= 0),
  assigned_worker_id TEXT REFERENCES workers(id),
  assigned_gpu_uuid TEXT,
  lease_id TEXT,
  lease_expires_at BIGINT,
  idempotency_key TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (project_id, idempotency_key)
);

CREATE INDEX sessions_queue_index
  ON sessions (
    status,
    priority DESC,
    created_at ASC,
    id ASC
  );

CREATE INDEX sessions_worker_index
  ON sessions (
    assigned_worker_id,
    status
  );
