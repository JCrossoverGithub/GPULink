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
export function parseOperation(input){
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
export async function executeOperation(config,operation){
  const {action,id,expected}=operation,spec=specs.get(action);
  // Never dispatch on a stale or missing preflight. The check is advisory,
  // not an atomic compare-and-set: Core arbitrates concurrent transitions.
  let snapshot;
  try{snapshot=await readSnapshot(config);}catch{return reply(503,'not-dispatched');}
  const target=snapshot[spec.kind].find(r=>r.id===id);
  if(!target||(spec.record==='worker'?target.drainMode:target.status)!==expected)return reply(409,'state-changed');
  try{
    const r=await fetch(`${config.origin}/v1/${spec.kind}/${encodeURIComponent(id)}/${spec.suffix}`,{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(4000),headers:{Authorization:'Bearer '+config[spec.token],Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify(spec.record==='worker'?{drain:spec.desired}:{})});
    if(!r.ok){await r.body?.cancel();return [400,401,403,404,409].includes(r.status)?reply(409,'rejected'):reply(502,'uncertain');}
    const record=(await boundedJson(r))[spec.record];
    if(r.status!==200||record?.id!==id||(spec.record==='worker'?record.drainMode:record.status)!==spec.desired)return reply(502,'uncertain');
    return reply(200,'acknowledged');
  }catch{return reply(502,'uncertain');} // No automatic retry after dispatch.
}
