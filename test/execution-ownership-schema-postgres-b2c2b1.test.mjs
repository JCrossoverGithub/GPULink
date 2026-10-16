import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { PostgresPersistence } from '../src/control-plane/persistence/postgres.mjs';

const url = process.env.GPULINK_TEST_POSTGRES_URL;
const authorized = process.env.GPULINK_B2C2B1_TEST_DB_ACK === 'YES_DISPOSABLE';
const onlyIfEnabled = {skip: url && authorized ? false :
  'requires GPULINK_TEST_POSTGRES_URL and GPULINK_B2C2B1_TEST_DB_ACK=YES_DISPOSABLE'};

test('B2C2B1 PostgreSQL: migration checksum, constraints, atomic rollback and independent-connection lock', onlyIfEnabled, async () => {
  const persistence = new PostgresPersistence(url, {maxConnections:3});
  const pool = new pg.Pool({connectionString:url,max:3});
  const prefix=randomUUID().replaceAll('-','');
  const workerId='schema_worker_'+prefix, attemptA='schema_a_'+prefix, attemptB='schema_b_'+prefix;
  const deviceId='schema_gpu_'+prefix;
  let a, b;
  try {
    await persistence.initialize(); // Intentionally migrates disposable test database.
    const checksum=(await pool.query(
      `SELECT checksum FROM gpulink_schema_migrations
       WHERE filename = '0003-execution-ownership-storage.sql'`)).rows[0]?.checksum;
    assert.match(checksum ?? '', /^[0-9a-f]{64}$/u);
    for (const name of ['gpu_resource_fences','execution_attempts']) {
      const result=await pool.query(`SELECT to_regclass($1) AS obj`, [name]);
      assert.ok(result.rows[0].obj,name);
    }
    await pool.query(`INSERT INTO workers
      (id,name,version,status,labels_json,capabilities_json,adapter_manifests_json,
        adapter_health_json,warm_models_json,model_inventory_json,gpu_inventory_json,
        last_seen_at,created_at,updated_at)
      VALUES ($1,$1,'v','online','{}','[]','[]','[]','[]','[]','[]',1,1,1)`,[workerId]);
    await pool.query(`INSERT INTO gpu_resource_fences
      (worker_id,gpu_uuid,epoch,safety_state,subject_kind,subject_id,lease_id,updated_at)
      VALUES ($1,$2,1,'allocated','session','schema_session','schema_lease',1)`,[workerId,deviceId]);
    const insertSql=`INSERT INTO execution_attempts
      (attempt_id,subject_kind,subject_id,project_id,lease_id,worker_id,gpu_uuid,
       fence_epoch,artifact_digest,adapter_identity,runtime_policy_revision,approval_ref,
       status,created_at,updated_at)
      VALUES ($1,'session','schema_session','schema_project','schema_lease',$2,$3,1,
       'sha256:test','adapter','rev1','approved','reserved',1,1)`;
    a=await pool.connect(); b=await pool.connect();
    await a.query('BEGIN');
    await a.query(insertSql,[attemptA,workerId,deviceId]);
    await b.query('BEGIN');
    await b.query("SET LOCAL lock_timeout = '350ms'");
    await assert.rejects(b.query(insertSql,[attemptB,workerId,deviceId]),/lock timeout|canceling statement/u);
    await b.query('ROLLBACK');
    await a.query('COMMIT');
    await a.query('BEGIN');
    await assert.rejects(a.query(insertSql,[attemptB,workerId,deviceId]),/duplicate key/u);
    await a.query('ROLLBACK');
    const one=await pool.query('SELECT COUNT(*)::integer AS n FROM execution_attempts WHERE worker_id=$1 AND gpu_uuid=$2',[workerId,deviceId]);
    assert.equal(one.rows[0].n,1);
    await pool.query("UPDATE gpu_resource_fences SET safety_state='quarantined' WHERE worker_id=$1 AND gpu_uuid=$2",[workerId,deviceId]);
    assert.equal((await pool.query('SELECT safety_state FROM gpu_resource_fences WHERE worker_id=$1 AND gpu_uuid=$2',[workerId,deviceId])).rows[0].safety_state,'quarantined');
  } finally {
    // Does not drop schema, delete other test rows, or modify non-test databases by design.
    for (const client of [a,b]) if (client) {try {await client.query('ROLLBACK')} catch {} client.release();}
    try {
      await pool.query('DELETE FROM execution_attempts WHERE worker_id=$1',[workerId]);
      await pool.query('DELETE FROM gpu_resource_fences WHERE worker_id=$1',[workerId]);
      await pool.query('DELETE FROM workers WHERE id=$1',[workerId]);
    } catch (error) {console.error('Test fixture cleanup failed:',error.code ?? 'unknown'); throw error;}
    await pool.end();await persistence.close();
  }
});
