import { createCipheriv, createDecipheriv, randomBytes, X509Certificate } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { readServerSetup, normalizeServerOrigin } from './server-profile.mjs';
import { runWorkerEnrollment, runWorkerCommand } from './remote-worker-profile.mjs';
const aad=Buffer.from('GPULink LAN invitation v1');
const strict=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===keys.sort().join(',');
export function sealInvitation(payload,key=randomBytes(32)) {
  const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',key,iv); cipher.setAAD(aad);
  const data=Buffer.concat([cipher.update(JSON.stringify(payload),'utf8'),cipher.final()]);
  return {code:key.toString('hex'),envelope:{version:1,iv:iv.toString('hex'),data:data.toString('base64'),tag:cipher.getAuthTag().toString('hex')}};
}
export function openInvitation(envelope,code,now=Date.now()) {
  if(!strict(envelope,['version','iv','data','tag'])||envelope.version!==1||typeof code!=='string'||! /^[a-f0-9]{64}$/.test(code)||! /^[a-f0-9]{24}$/.test(envelope.iv)||! /^[a-f0-9]{32}$/.test(envelope.tag)||typeof envelope.data!=='string'||envelope.data.length>32768) throw new Error('Invalid invitation or code.');
  const decipher=createDecipheriv('aes-256-gcm',Buffer.from(code,'hex'),Buffer.from(envelope.iv,'hex')); decipher.setAAD(aad);decipher.setAuthTag(Buffer.from(envelope.tag,'hex'));
  const value=JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data,'base64')),decipher.final()]).toString('utf8'));
  if(!strict(value,['bundle','ca','expiresAt'])||!Number.isSafeInteger(value.expiresAt)||value.expiresAt<=now||!strict(value.bundle,['schemaVersion','publicOrigin','workerToken'])||value.bundle.schemaVersion!==1||normalizeServerOrigin(value.bundle.publicOrigin)!==value.bundle.publicOrigin||! /^[a-f0-9]{64}$/.test(value.bundle.workerToken)||typeof value.ca!=='string'||value.ca.length>16384||!new X509Certificate(value.ca).ca) throw new Error('Invalid or expired invitation.');
  return value;
}
export function exportInvitation(directory,filename,output=console) {
  const setup=readServerSetup(directory);
  const ca=readFileSync(path.join(setup.directory,'managed-lan','ca.pem'),'utf8');
  const {code,envelope}=sealInvitation({bundle:{schemaVersion:1,publicOrigin:setup.publicOrigin,workerToken:setup.profiles['worker.env'].GPULINK_WORKER_TOKEN},ca,expiresAt:Date.now()+30*60*1000});
  writeFileSync(path.resolve(filename),JSON.stringify(envelope)+'\n',{flag:'wx',mode:0o600});
  output.log('Encrypted invitation created. Transfer the file and share the code through a separate trusted channel.');
  output.log(`Invitation code (secret): ${code}`);
  output.log('Expires locally in 30 minutes. Not a one-time or individually revocable server credential.');
}
async function promptCode() {
  if(!process.stdin.isTTY||!process.stderr.isTTY) throw new Error('Run join in an interactive terminal.');
  const mute=new Writable({write(_chunk,_enc,cb){cb();}});
  const rl=createInterface({input:process.stdin,output:mute,terminal:true});
  process.stderr.write('Invitation code (hidden): ');
  try{return (await rl.question('')).trim();}finally{rl.close();process.stderr.write('\n');}
}
export async function joinInvitation(args,directory,output=console) {
  if(![2,3].includes(args.length)||args[0]!=='--invite'||(args.length===3&&args[2]!=='--accept-assigned-work')){output.error('Usage: gpulink join --invite FILE [--accept-assigned-work]');return 2;}
  let tmp;
  try {
    const st=lstatSync(args[1]);if(!st.isFile()||st.isSymbolicLink()||st.size>65536) throw new Error('Invalid invitation file.');
    const payload=openInvitation(JSON.parse(readFileSync(args[1],'utf8')),await promptCode());
    tmp=mkdtempSync(path.join(tmpdir(),'gpl-join-'));
    const bundle=path.join(tmp,'worker.json'),ca=path.join(tmp,'ca.pem');
    writeFileSync(bundle,JSON.stringify(payload.bundle),{mode:0o600,flag:'wx'});writeFileSync(ca,payload.ca,{mode:0o600,flag:'wx'});
    if(runWorkerEnrollment(['--bundle',bundle,'--ca-file',ca],directory,output))return 1;
    return await runWorkerCommand(args.length===3?['start','--accept-assigned-work']:['doctor','--live','--gpu'],directory,output);
  }catch{output.error('Join failed. Check the invitation, code, expiry and new worker configuration directory.');return 1;}
  finally{if(tmp)rmSync(tmp,{recursive:true,force:true});}
}
