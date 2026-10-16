import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ControlPlaneDatabase } from '../src/control-plane/database.mjs';

function worker(db, id='worker_schema') {
  db.database.prepare(`INSERT INTO workers
    (id,name,version,status,labels_json,capabilities_json,adapter_manifests_json,
     adapter_health_json,warm_models_json,model_inventory_json,gpu_inventory_json,
     last_seen_at,created_at,updated_at)
    VALUES (?,?,'v','online','{}','[]','[]','[]','[]','[]','[]',1,1,1)`)
    .run(id,id);
}
const fence = (db, {workerId='worker_schema',gpu='gpu_A',epoch=1,status='allocated',lease='lease_A'}={}) =>
  db.database.prepare(`INSERT INTO gpu_resource_fences
    (worker_id,gpu_uuid,epoch,safety_state,subject_kind,subject_id,lease_id,updated_at)
    VALUES (?,?,?,?, 'session','session_A',?,1)`)
    .run(workerId,gpu,epoch,status,lease);
const attempt = (db, {id='attempt_A',gpu='gpu_A',epoch=1,status='reserved'}={}) =>
  db.database.prepare(`INSERT INTO execution_attempts
    (attempt_id,subject_kind,subject_id,project_id,lease_id,worker_id,gpu_uuid,
     fence_epoch,artifact_digest,adapter_identity,runtime_policy_revision,
     approval_ref,status,created_at,updated_at)
    VALUES (?, 'session','session_A','project_A','lease_A','worker_schema',?,
      ?,'sha256:test','adapter_A','rev1','operator-approved',?,1,1)`)
    .run(id,gpu,epoch,status);

test('B2C2B1: zero backfilled fences on new schema; no execution authority exposed',()=>{
  const db=new ControlPlaneDatabase(':memory:');try{
    const tables=db.database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name);
    assert.ok(tables.includes('gpu_resource_fences'));
    assert.ok(tables.includes('execution_attempts'));
    assert.equal(db.database.prepare('SELECT COUNT(*) AS n FROM gpu_resource_fences').get().n,0);
    assert.equal(db.database.prepare('SELECT COUNT(*) AS n FROM execution_attempts').get().n,0);
    assert.equal(typeof db.claimExecutionAttempt,'undefined');
  }finally{db.close()}
});
test('B2C2B1: invalid fence epoch, bad state, and incomplete ownership are rejected',()=>{
 const db=new ControlPlaneDatabase(':memory:');try{worker(db);
  assert.throws(()=>fence(db,{epoch:0}),/CHECK constraint/i);
  assert.throws(()=>fence(db,{status:'unknown'}),/CHECK constraint/i);
  assert.throws(()=>db.database.prepare(`INSERT INTO gpu_resource_fences (worker_id,gpu_uuid,epoch,safety_state,updated_at) VALUES ('worker_schema','gpu_A',1,'running',1)`).run(),/CHECK constraint/i);
  assert.throws(()=>db.database.prepare(`INSERT INTO gpu_resource_fences (worker_id,gpu_uuid,epoch,safety_state,subject_kind,subject_id,lease_id,updated_at) VALUES ('worker_schema','gpu_A',1,'clear','session','session_A','lease_A',1)`).run(),/CHECK constraint/i);
 }finally{db.close()}
});
test('B2C2B1: partial unique index forbids two nonterminal device attempts',()=>{
 const db=new ControlPlaneDatabase(':memory:');try{worker(db);fence(db);attempt(db);
  assert.throws(()=>attempt(db,{id:'attempt_B'}),/UNIQUE constraint/i);
  assert.throws(()=>attempt(db,{id:'attempt_A',gpu:'gpu_B'}),/UNIQUE constraint/i);
  db.database.prepare("UPDATE execution_attempts SET status='terminated' WHERE attempt_id='attempt_A'").run();
  attempt(db,{id:'attempt_B'});
  assert.equal(db.database.prepare('SELECT COUNT(*) AS n FROM execution_attempts').get().n,2);
  assert.throws(()=>attempt(db,{id:'attempt_A',gpu:'gpu_B'}),/UNIQUE constraint/i);
 }finally{db.close()}
});
test('B2C2B1: attempts require valid worker FK and legal statuses',()=>{
 const db=new ControlPlaneDatabase(':memory:');try{worker(db);
  assert.throws(()=>attempt(db,{status:'launched'}),/CHECK constraint/i);
  db.database.prepare('DELETE FROM workers').run();
  assert.throws(()=>attempt(db),/FOREIGN KEY constraint/i);
 }finally{db.close()}
});
test('B2C2B1: fence and tombstone records persist through SQLite restart',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'gpulink-b2c2b1-'));const file=path.join(dir,'db.sqlite');
 try{
   let db=new ControlPlaneDatabase(file);worker(db);fence(db);
   db.database.prepare("UPDATE gpu_resource_fences SET safety_state='quarantined' WHERE gpu_uuid='gpu_A'").run();
   attempt(db,{status:'quarantined'});db.close();
   db=new ControlPlaneDatabase(file);
   assert.equal(db.database.prepare("SELECT safety_state FROM gpu_resource_fences WHERE gpu_uuid='gpu_A'").get().safety_state,'quarantined');
   assert.equal(db.database.prepare("SELECT status FROM execution_attempts WHERE attempt_id='attempt_A'").get().status,'quarantined');
   assert.throws(()=>attempt(db,{id:'attempt_B'}),/UNIQUE constraint/i);
   db.close();
 } finally {rmSync(dir,{recursive:true,force:true})}
});
test('B2C2B1: separate SQLite connections observe durable uniqueness and transaction rollback',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'gpulink-b2c2b1-'));const file=path.join(dir,'db.sqlite');
 try {
  const a=new ControlPlaneDatabase(file);worker(a);fence(a);
  try {a.transaction(()=>{attempt(a);throw new Error('rollback intentional')});}
  finally {a.close()}
 }catch(e){if(e.message!=='rollback intentional')throw e;
 }finally{
  try{const a=new ControlPlaneDatabase(file), b=new ControlPlaneDatabase(file);
   assert.equal(b.database.prepare('SELECT COUNT(*) AS n FROM execution_attempts').get().n,0);
   attempt(a); assert.throws(()=>attempt(b,{id:'attempt_B'}),/UNIQUE constraint/i);
   a.close(); b.close();
  }finally{rmSync(dir,{recursive:true,force:true})}
 }
});
