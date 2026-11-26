import {readSnapshot} from './snapshot.mjs';

// These operations act on logical records, not on individual process IDs or
// lease attempts. Core remains responsible for authorization and transitions.
const specs=new Map([
  ['drain',{kind:'workers',record:'worker',suffix:'drain',token:'adminToken',desired:true}],
  ['resume',{kind:'workers',record:'worker',suffix:'drain',token:'adminToken',desired:false}],
  ['cancel-job',{kind:'jobs',record:'job',suffix:'cancel',token:'clientToken',allowed:['queued','leased','running'],desired:'cancelled'}],
  ['close-session',{kind:'sessions',record:'session',suffix:'close',token:'clientToken',allowed:['requested','allocated','connecting','active'],desired:'closed'}],
]);
const reply=(status,outcome)=>({status,outcome});
const identityPart=x=>typeof x==='string'&&x.length>0&&x.length<=128;
export function parseOperation(input){
  if(input?.action==='recover-job-hold'){
    if(Object.keys(input).sort().join(',')!=='action,confirmStopped,epoch,gpuUuid,jobId,typedGpuUuid,workerId'||
      ![input.workerId,input.gpuUuid,input.jobId].every(identityPart)||!Number.isSafeInteger(input.epoch)||input.epoch<1||
      input.confirmStopped!==true||input.typedGpuUuid!==input.gpuUuid)return null;
    return {action:input.action,workerId:input.workerId,gpuUuid:input.gpuUuid,jobId:input.jobId,epoch:input.epoch,confirmStopped:true};
  }
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='action,expected,id')return null;
  const spec=specs.get(input.action);
  // IDs containing path syntax are not supported by these controls.
  if(!spec||typeof input.id!=='string'||! /^(?!\.{1,2}$)[A-Za-z0-9_.:-]{1,100}$/.test(input.id))return null;
  if(spec.record==='worker'?typeof input.expected!=='boolean'||input.expected===spec.desired:!spec.allowed.includes(input.expected))return null;
  return {action:input.action,id:input.id,expected:input.expected};
}
async function boundedJson(response){
  if(!response.headers.get('content-type')?.startsWith('application/json')){await response.body?.cancel();throw Error('invalid acknowledgement');}
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>8*1024*1024)throw Error('oversize acknowledgement');chunks.push(Buffer.from(value));}}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function recoverJobHold(config,operation){
  const {workerId,gpuUuid,jobId,epoch}=operation;
  const same=h=>h.workerId===workerId&&h.gpuUuid===gpuUuid&&h.jobId===jobId&&h.epoch===epoch;
  const headers={Authorization:'Bearer '+config.adminToken,Accept:'application/json'};
  let leaseId;
  try{
    const snapshot=await readSnapshot(config);
    const worker=snapshot.workers.find(w=>w.id===workerId);
    if(!snapshot.holds.some(same)||!worker||worker.status!=='offline'||!worker.drainMode||
      [...snapshot.jobs,...snapshot.sessions].some(r=>r.assignedGpuUuid===gpuUuid&&['leased','running','allocated','connecting','active'].includes(r.status)))return reply(409,'state-changed');
    // Resolve the exact lease on the server; never send it to the browser.
    await config.assertCore?.();
    const response=await fetch(config.origin+'/v1/admin/job-cleanup-holds',{headers,redirect:'error',signal:AbortSignal.timeout(4000)});
    if(!response.ok){await response.body?.cancel();return reply(503,'not-dispatched');}
    const {holds}=await boundedJson(response);
    if(!Array.isArray(holds)||holds.length>5000)return reply(503,'not-dispatched');
    const matches=holds.filter(same);
    if(matches.length!==1||!identityPart(matches[0].leaseId))return reply(409,'state-changed');
    leaseId=matches[0].leaseId;
  }catch{return reply(503,'not-dispatched');}
  // Core atomically checks the exact epoch, lease, worker, terminal job and
  // absence of open execution attempts/active allocations before releasing.
  try{await config.assertCore?.();}catch{return reply(503,'not-dispatched');}
  try{
    const response=await fetch(config.origin+'/v1/admin/job-cleanup-holds/release',{method:'POST',headers:{...headers,'Content-Type':'application/json'},redirect:'error',signal:AbortSignal.timeout(4000),body:JSON.stringify({workerId,gpuUuid,jobId,epoch,leaseId,confirmStopped:true})});
    if(!response.ok){await response.body?.cancel();return [400,401,403,404,409].includes(response.status)?reply(409,'rejected'):reply(502,'uncertain');}
    const result=await boundedJson(response);
    return response.status===200&&result.released===true&&result.operatorAttested===true?reply(200,'acknowledged'):reply(502,'uncertain');
  }catch{return reply(502,'uncertain');}
}
export async function executeOperation(config,operation){
  if(operation.action==='recover-job-hold')return recoverJobHold(config,operation);
  const {action,id,expected}=operation,spec=specs.get(action);
  // Never dispatch on a stale or missing preflight. The check is advisory,
  // not an atomic compare-and-set: Core arbitrates concurrent transitions.
  let snapshot;
  try{snapshot=await readSnapshot(config);}catch{return reply(503,'not-dispatched');}
  const target=snapshot[spec.kind].find(r=>r.id===id);
  if(!target||(spec.record==='worker'?target.drainMode:target.status)!==expected)return reply(409,'state-changed');
  try{await config.assertCore?.();}catch{return reply(503,'not-dispatched');}
  try{
    const r=await fetch(`${config.origin}/v1/${spec.kind}/${encodeURIComponent(id)}/${spec.suffix}`,{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(4000),headers:{Authorization:'Bearer '+config[spec.token],Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify(spec.record==='worker'?{drain:spec.desired}:{})});
    if(!r.ok){await r.body?.cancel();return [400,401,403,404,409].includes(r.status)?reply(409,'rejected'):reply(502,'uncertain');}
    const record=(await boundedJson(r))[spec.record];
    if(r.status!==200||record?.id!==id||(spec.record==='worker'?record.drainMode:record.status)!==spec.desired)return reply(502,'uncertain');
    return reply(200,'acknowledged');
  }catch{return reply(502,'uncertain');} // No automatic retry after dispatch.
}
