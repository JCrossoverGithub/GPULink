import {normalizeOperationalSnapshot} from "../src/shared/operational-snapshot.mjs";
async function getJson(origin,path,token){
  const r=await fetch(origin+path,{method:'GET',redirect:'error',signal:AbortSignal.timeout(4000),headers:{Accept:'application/json',...(token?{Authorization:'Bearer '+token}:{})}});
  if(!r.ok||!r.headers.get('content-type')?.startsWith('application/json')){await r.body?.cancel();throw new Error('Core request unsuccessful');}
  const reader=r.body.getReader();let size=0;const chunks=[];
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>8*1024*1024)throw new Error('Core response exceeds limit');chunks.push(Buffer.from(value));}}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function readSnapshot({origin,adminToken}){
  return normalizeOperationalSnapshot(await getJson(origin,'/v1/admin/operational-snapshot',adminToken));
}
