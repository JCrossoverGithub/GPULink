import assert from 'node:assert/strict';
export function rank(payload) {
  const vector = v => Array.isArray(v) && v.length >= 1 && v.length <= 64 && v.every(x => Number.isInteger(x) && Math.abs(x) <= 100);
  assert.ok(payload && typeof payload === 'object' && Object.keys(payload).sort().join(',') === 'items,query,topK' && vector(payload.query), 'invalid query');
  const {query, items, topK} = payload;
  assert.ok(Array.isArray(items) && items.length >= 1 && items.length <= 64 && Number.isInteger(topK) && topK >= 1 && topK <= Math.min(10,items.length), 'invalid items/topK');
  const ids = new Set();
  for (const item of items) {
    assert.ok(item && Object.keys(item).sort().join(',') === 'id,vector' && typeof item.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(item.id) && !ids.has(item.id) && vector(item.vector) && item.vector.length === query.length, 'invalid item');
    ids.add(item.id);
  }
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) <= 32768, 'payload exceeds preview limit');
  return items.map(({id,vector}) => ({id,score:vector.reduce((s,v,i)=>s+v*query[i],0)})).sort((a,b)=>b.score-a.score || (a.id<b.id?-1:a.id>b.id?1:0)).slice(0,topK);
}
export function verify(job, payload) {
  assert.equal(job.status,'succeeded');
  assert.equal(job.attempt,1);
  assert.equal(job.leaseExpiresAt,null);
  assert.ok(/^GPU-[a-fA-F0-9-]{32,64}$/.test(job.assignedGpuUuid));
  assert.ok(typeof job.assignedWorkerId === 'string' && job.assignedWorkerId.length>0);
  assert.equal(job.result.backend,'pytorch-cuda');
  assert.equal(job.result.metric,'inner-product');
  assert.deepEqual(job.result.ranked,rank(payload));
}
