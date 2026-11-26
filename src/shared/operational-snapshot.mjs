// Read-only projection. No raw payloads, results, lease IDs, labels, or metadata.
const JOB=['queued','leased','running','succeeded','failed','cancelled'];
const SESSION=['requested','allocated','connecting','active','interrupted','closed'];
export const HISTORY_LIMIT=500;
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
const job=(j,projected=false)=>({...placement(j),type:str(j.type),status:state(j.status,JOB),attempt:int(j.attempt),maxAttempts:int(j.maxAttempts),minVramMiB:int(projected?j.minVramMiB:j.constraints.minVramMiB)});
const session=(s,projected=false)=>({...placement(s),capability:str(s.capability),status:state(s.status,SESSION),interruptionCount:int(s.interruptionCount),minVramMiB:int(projected?s.minVramMiB:s.requirements.minVramMiB)});
const hold=h=>({workerId:str(h.workerId),gpuUuid:str(h.gpuUuid),epoch:int(h.epoch),jobId:str(h.jobId)});
const fence=f=>({workerId:str(f.workerId),gpuUuid:str(f.gpuUuid),jobCleanup:bool(f.jobCleanup)});
const event=e=>({sequence:int(e.sequence),type:str(e.type),subjectId:optional(e.subjectId),createdAt:int(e.createdAt)});
const activeJob=j=>['leased','running'].includes(j.status);
const activeSession=s=>['allocated','connecting','active'].includes(s.status);
export const EVENT_LIMIT=200;
// All reads supplied by a single consistent persistence snapshot. Do not call
// scheduler placement, acquire its locks, or infer eligibility for a workload.
export async function collectOperationalState(reader,clock,heartbeatTimeoutMs){
  const workers=await reader.listWorkers();
  const activeJobs=await reader.listActiveJobs();
  const activeSessions=await reader.listOccupyingSessions();
  const fences=await reader.listBlockedGpuResources();
  const holds=await reader.listJobCleanupHolds();
  const recentJobs=await reader.listJobs({limit:HISTORY_LIMIT+1});
  const queued=await reader.listJobs({status:'queued',limit:HISTORY_LIMIT+1});
  const recentSessions=await reader.listSessions({limit:HISTORY_LIMIT+1});
  const requested=await reader.listSessions({status:'requested',limit:HISTORY_LIMIT+1});
  const events=await reader.listRecentEventHeaders(EVENT_LIMIT+1);
  const merged=(...rows)=>[...new Map(rows.flat().map(x=>[x.id,x])).values()].sort((a,b)=>b.createdAt-a.createdAt||a.id.localeCompare(b.id));
  return normalizeOperationalSnapshot({schemaVersion:2,source:'core-http',atomic:true,eligibility:'not-evaluated',observedAt:clock(),heartbeatTimeoutMs,
    workers,jobs:merged(recentJobs.slice(0,HISTORY_LIMIT),queued.slice(0,HISTORY_LIMIT),activeJobs).map(j=>job(j)),
    sessions:merged(recentSessions.slice(0,HISTORY_LIMIT),requested.slice(0,HISTORY_LIMIT),activeSessions).map(s=>session(s)),
    holds,fences:fences.map(f=>({...f,jobCleanup:f.jobCleanup??false})),events:events.slice(0,EVENT_LIMIT),coverage:{jobListsCapped:recentJobs.length>HISTORY_LIMIT||queued.length>HISTORY_LIMIT,sessionListsCapped:recentSessions.length>HISTORY_LIMIT||requested.length>HISTORY_LIMIT,eventsCapped:events.length>EVENT_LIMIT}});
}
// The same projector on the gateway discards any extra fields from upstream.
// Refuse invalid or oversized snapshots, never silently truncate active work.
export function normalizeOperationalSnapshot(raw){
  if(raw.schemaVersion!==2||raw.source!=='core-http'||raw.atomic!==true||raw.eligibility!=='not-evaluated')invalid();
  const observedAt=int(raw.observedAt),heartbeatTimeoutMs=int(raw.heartbeatTimeoutMs);
  if(heartbeatTimeoutMs===0)invalid();
  const workers=list(raw.workers).map(worker),jobs=list(raw.jobs).map(j=>job(j,true)),sessions=list(raw.sessions).map(s=>session(s,true));
  const holds=list(raw.holds).map(hold),fences=list(raw.fences).map(fence),events=list(raw.events,EVENT_LIMIT).map(event);
  for(const rows of [workers,jobs,sessions])if(new Set(rows.map(r=>r.id)).size!==rows.length)invalid();
  if(events.some((e,i)=>i>0&&events[i-1].sequence<=e.sequence))invalid();
  const holdKeys=new Set(holds.map(h=>JSON.stringify([h.workerId,h.gpuUuid])));
  const fenceKeys=new Set(fences.filter(f=>f.jobCleanup).map(f=>JSON.stringify([f.workerId,f.gpuUuid])));
  if(holdKeys.size!==holds.length||holdKeys.size!==fenceKeys.size||[...holdKeys].some(k=>!fenceKeys.has(k)))invalid();
  const active=[...jobs.filter(activeJob).map(j=>({...j,kind:'job'})),...sessions.filter(activeSession).map(s=>({...s,kind:'session'}))];
  if(active.some(r=>!r.assignedGpuUuid||!r.assignedWorkerId))invalid();
  const allocations=new Map(),globalHolds=new Set(),localFences=new Set();
  for(const r of active){const rows=allocations.get(r.assignedGpuUuid)||[];rows.push({kind:r.kind,id:r.id,workerId:r.assignedWorkerId});allocations.set(r.assignedGpuUuid,rows);}
  for(const f of fences){if(f.jobCleanup)globalHolds.add(f.gpuUuid);else localFences.add(JSON.stringify([f.workerId,f.gpuUuid]));}
  const devices=[];
  for(const w of workers){
    const fresh=w.status==='online'&&observedAt-w.lastSeenAt<=heartbeatTimeoutMs&&observedAt>=w.lastSeenAt;
    const seen=new Set();
    for(const g of w.gpus){if(seen.has(g.uuid))invalid();seen.add(g.uuid);
      const assigned=allocations.get(g.uuid)||[],jobHold=globalHolds.has(g.uuid),fenced=localFences.has(JSON.stringify([w.id,g.uuid]));
      // Global UUID occupancy matches scheduler; other fences are worker/UUID scoped.
      const state=jobHold?'job-cleanup-hold':fenced?'safety-fence':assigned.length?'allocated':w.status==='offline'?'offline':!fresh?'heartbeat-stale':w.drainMode?'draining':'unallocated';
      devices.push({workerId:w.id,gpuUuid:g.uuid,state,heartbeatFresh:fresh,allocations:assigned,jobHold,fenced});
    }
  }
  return {schemaVersion:2,source:'core-http',atomic:true,eligibility:'not-evaluated',observedAt,heartbeatTimeoutMs,workers,jobs,sessions,holds,fences,devices,events,coverage:{jobListsCapped:bool(raw.coverage.jobListsCapped),sessionListsCapped:bool(raw.coverage.sessionListsCapped),eventsCapped:bool(raw.coverage.eventsCapped),holds:'all-scheduler-fences',events:'recent-headers'}};
}
