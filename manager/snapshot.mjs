// Read-only projection. No raw payloads, results, lease IDs, labels, or metadata.
const JOB=['queued','leased','running','succeeded','failed','cancelled'];
const SESSION=['requested','allocated','connecting','active','interrupted','closed'];
const LIMIT=500;
const invalid=()=>{throw new Error('Invalid Core response');};
const str=(x,n=250)=>typeof x==='string'&&x.length>0&&x.length<=n?x:invalid();
const num=x=>Number.isFinite(x)?x:invalid();
const int=x=>Number.isSafeInteger(x)&&x>=0?x:invalid();
const optional=x=>x===null?null:str(x);
const list=(x,n=5000)=>Array.isArray(x)&&x.length<=n?x:invalid();
const state=(x,values)=>values.includes(x)?x:invalid();
const bool=x=>typeof x==='boolean'?x:invalid();
const gpu=g=>({uuid:str(g.uuid),index:int(g.index),name:str(g.name),memoryTotalMiB:int(g.memoryTotalMiB),memoryUsedMiB:int(g.memoryUsedMiB),utilizationPercent:int(g.utilizationPercent),temperatureC:int(g.temperatureC),powerDrawWatts:g.powerDrawWatts===null?null:num(g.powerDrawWatts)});
const manifest=m=>({schemaVersion:state(m.schemaVersion,[1,2]),type:str(m.type),adapterId:m.schemaVersion===2?str(m.adapterId):null,version:str(m.version),executionMode:str(m.executionMode)});
const health=h=>({schemaVersion:state(h.schemaVersion,[1,2]),type:str(h.type),adapterId:h.schemaVersion===2?str(h.adapterId):null,state:state(h.state,['ready','unavailable','not-installed']),checkedAt:int(h.checkedAt)});
const worker=w=>({id:str(w.id),name:str(w.name),version:str(w.version),status:state(w.status,['online','offline']),drainMode:bool(w.drainMode),lastSeenAt:int(w.lastSeenAt),gpus:list(w.gpus,16).map(gpu),capabilities:list(w.capabilities,256).map(x=>str(x)),adapterManifests:list(w.adapterManifests,64).map(manifest),adapterHealth:list(w.adapterHealth,64).map(health)});
const placement=x=>({id:str(x.id),projectId:str(x.projectId),assignedWorkerId:optional(x.assignedWorkerId),assignedGpuUuid:optional(x.assignedGpuUuid),createdAt:int(x.createdAt),updatedAt:int(x.updatedAt)});
const job=j=>({...placement(j),type:str(j.type),status:state(j.status,JOB),attempt:int(j.attempt),maxAttempts:int(j.maxAttempts),minVramMiB:int(j.constraints.minVramMiB)});
const session=s=>({...placement(s),capability:str(s.capability),status:state(s.status,SESSION),interruptionCount:int(s.interruptionCount),minVramMiB:int(s.requirements.minVramMiB)});
const hold=h=>({workerId:str(h.workerId),gpuUuid:str(h.gpuUuid),epoch:int(h.epoch),jobId:str(h.jobId)});
async function getJson(origin,path,token){
  const r=await fetch(origin+path,{method:'GET',redirect:'error',signal:AbortSignal.timeout(4000),headers:{Accept:'application/json',...(token?{Authorization:'Bearer '+token}:{})}});
  if(!r.ok||!r.headers.get('content-type')?.startsWith('application/json')){await r.body?.cancel();throw new Error('Core request unsuccessful');}
  const reader=r.body.getReader();let size=0;const chunks=[];
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>8*1024*1024)throw new Error('Core response exceeds limit');chunks.push(Buffer.from(value));}}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function readSnapshot({origin,adminToken,clientToken}){
  const startedAt=Date.now();
  // One request per active lifecycle state prevents recent terminal records hiding active work.
  // These are NOT an atomic transaction; the UI must not infer eligibility or complete absence.
  const get=(p,t)=>getJson(origin,p,t);
  const routes=[['ready','/readyz',null],['workers','/v1/workers',adminToken],['holds','/v1/admin/job-cleanup-holds',adminToken],['jobs','/v1/jobs?limit=500',clientToken],['sessions','/v1/sessions?limit=500',clientToken],...['queued','leased','running'].map(s=>['job-'+s,`/v1/jobs?status=${s}&limit=500`,clientToken]),...['requested','allocated','connecting','active'].map(s=>['session-'+s,`/v1/sessions?status=${s}&limit=500`,clientToken])];
  const res=Object.fromEntries(await Promise.all(routes.map(async([k,p,t])=>[k,await get(p,t)])));
  if(res.ready?.status!=='ready')invalid();
  const merged=(field,prefix,project)=>{
    const records=new Map();const conflicts=new Set();let capped=false;
    for(const [key,r] of Object.entries(res))if(key===field||key.startsWith(prefix)){
      const rows=list(r[field],LIMIT);if(rows.length===LIMIT)capped=true;
      for(const raw of rows){const row=project(raw),old=records.get(row.id);if(old&&JSON.stringify(old)!==JSON.stringify(row))conflicts.add(row.id);if(!old||row.updatedAt>=old.updatedAt)records.set(row.id,row);}
    }
    return {records:[...records.values()].sort((a,b)=>b.createdAt-a.createdAt),capped,conflicts:[...conflicts]};
  };
  const jobs=merged('jobs','job-',job),sessions=merged('sessions','session-',session);
  return {schemaVersion:1,startedAt,observedAt:Date.now(),source:'core-http',atomic:false,eligibility:'not-evaluated',workers:list(res.workers.workers).map(worker),jobs:jobs.records,sessions:sessions.records,holds:list(res.holds.holds).map(hold),coverage:{jobListsCapped:jobs.capped,sessionListsCapped:sessions.capped,conflictingJobIds:jobs.conflicts,conflictingSessionIds:sessions.conflicts,holds:'job-cleanup-only',events:'not-connected'}};
}
