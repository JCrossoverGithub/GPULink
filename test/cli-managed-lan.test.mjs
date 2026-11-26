import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { privateIp, sameSubnet, chooseLanPort, validateNetwork, networkScript } from '../src/cli/managed-lan-windows.mjs';
import { sealInvitation, openInvitation } from '../src/cli/managed-lan-invite.mjs';
import { parseSetupOptions, makeCertificates, caddyConfig, probeLan } from '../src/cli/managed-lan.mjs';
const plan={listen:'192.168.1.156',peer:'192.168.1.158',wsl:'172.31.92.31',index:19,profile:'Public',port:8443,rule:'GPULink-LAN-'+'a'.repeat(32)};
test('LAN address selection rejects public, loopback and malformed inputs; subnet check honors prefix',()=>{
  for(const ip of ['192.168.1.1','10.1.2.3','172.31.5.4'])assert.equal(privateIp(ip),true);
  for(const ip of ['127.0.0.1','8.8.8.8','172.32.1.1','192.168.1.999',"192.168.1.1'; Write-Host bad"])assert.equal(privateIp(ip),false);
  assert.equal(sameSubnet(plan.listen,plan.peer,24),true);assert.equal(sameSubnet(plan.listen,'192.168.0.174',24),false);
  assert.equal(sameSubnet(plan.listen,'192.168.0.174',23),true);
});
test('network plan restricts scope, refuses injection, and cleanup checks ownership',()=>{
  const apply=networkScript(plan,'apply'),remove=networkScript(plan,'remove');
  assert.match(apply,/-RemoteAddress \$peer/);assert.match(apply,/-LocalAddress \$ip/);assert.match(apply,/-Profile \$netProfile/);assert.match(apply,/Existing forwarding entry/);
  assert.match(remove,/Forwarding target changed/);assert.match(remove,/Forwarding exists without ownership rule/);assert.match(remove,/Firewall rule changed/);
  for(const bad of [{peer:'8.8.8.8'},{port:8088},{rule:'x;whoami'},{profile:'Any'},{index:'19;whoami'}])assert.throws(()=>validateNetwork({...plan,...bad}));
  assert.throws(()=>networkScript(plan,'other'));
});
test('Windows CI parses the exact elevated scripts without applying networking',{skip:process.platform!=='win32'},()=>{
  for(const action of ['apply','remove']){
    const encoded=Buffer.from(networkScript(plan,action),'utf8').toString('base64');
    const parser=`$s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); $t=$null; $e=$null; [System.Management.Automation.Language.Parser]::ParseInput($s,[ref]$t,[ref]$e)|Out-Null; if($e.Count){$e|Out-String|Write-Output; exit 1}`;
    execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(parser,'utf16le').toString('base64')],{encoding:'utf8'});
  }
});
test('port selection avoids occupied ports and rejects explicitly occupied ports',()=>{assert.equal(chooseLanPort(new Set([8443,8444])),8445);assert.equal(chooseLanPort(new Set(),9443),9443);assert.throws(()=>chooseLanPort(new Set([9443]),9443));assert.throws(()=>chooseLanPort(new Set(),8088));});
test('setup defaults to read-only plan, rejects duplicate options and backend port',()=>{
  assert.deepEqual(parseSetupOptions(['--peer',plan.peer]),{peer:plan.peer,port:null,apply:false});
  assert.equal(parseSetupOptions(['--peer',plan.peer,'--apply']).apply,true);
  for(const args of [[],['--peer',plan.peer,'--port','8088'],['--peer',plan.peer,'--peer',plan.peer],['--peer',plan.peer,'--bogus']])assert.throws(()=>parseSetupOptions(args));
});
test('Caddy config binds WSL only, has IP certificate fallback, loopback backend and no admin port',()=>{
  const config=caddyConfig('/home/user/setup',plan);assert.match(config,/default_sni 192\.168\.1\.156/);assert.match(config,/bind 172\.31\.92\.31/);assert.match(config,/reverse_proxy 127\.0\.0\.1:8088/);assert.match(config,/admin off/);assert.match(config,/protocols h1 h2/);
});
test('generated CA, encrypted invitation and actual TLS hostname checks',{skip:process.platform!=='linux'},async()=>{
  const work=mkdtempSync(path.join(tmpdir(),'gpl-lan-'));let server;
  try{
    makeCertificates(work,plan.listen);
    const ca=readFileSync(path.join(work,'ca.pem'),'utf8');
    const payload={bundle:{schemaVersion:1,publicOrigin:`https://${plan.listen}:8443`,workerToken:'b'.repeat(64)},ca,expiresAt:Date.now()+60000};
    const {code,envelope}=sealInvitation(payload);assert.equal(JSON.stringify(envelope).includes(payload.bundle.workerToken),false);assert.deepEqual(openInvitation(envelope,code),payload);
    assert.throws(()=>openInvitation(envelope,'c'.repeat(64)));assert.throws(()=>openInvitation({...envelope,tag:'0'.repeat(32)},code));assert.throws(()=>openInvitation(envelope,code,payload.expiresAt));
    server=https.createServer({key:readFileSync(path.join(work,'server-key.pem')),cert:readFileSync(path.join(work,'server-cert.pem'))},(_req,res)=>res.end('{"status":"ready"}'));
    server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;
    assert.equal(await probeLan(work,{...plan,wsl:'127.0.0.1',port}),true);
    assert.equal(await probeLan(work,{...plan,listen:'192.168.1.157',wsl:'127.0.0.1',port}),false);
  }finally{if(server)await new Promise(resolve=>server.close(resolve));rmSync(work,{recursive:true,force:true});}
});

test('join display name is opt-in, distinct from execution authorization; malformed options never prompt',async()=>{
  const {parseJoinOptions,joinInvitation}=await import('../src/cli/managed-lan-invite.mjs');
  assert.deepEqual(parseJoinOptions(['--invite','file']),{file:'file',start:false});
  assert.deepEqual(parseJoinOptions(['--invite','file','--name','GPU 01']),{file:'file',start:false,displayName:'GPU 01'});
  assert.deepEqual(parseJoinOptions(['--invite','file','--accept-assigned-work','--name','GPU 01']),{file:'file',start:true,displayName:'GPU 01'});
  for(const args of [['--name','GPU 01'],['--invite','file','--name'],['--invite','file','--name','a\n'],['--invite','file','--name','<img>'],['--invite','file','--name','a','--name','b'],['--invite','file','--accept-assigned-work','--accept-assigned-work']]){
    assert.throws(()=>parseJoinOptions(args));assert.equal(await joinInvitation(args,undefined,{log(){},error(){}}),2);
  }
  assert.equal(await joinInvitation(['--help'],undefined,{log:line=>assert.match(line,/--name NAME/),error(){}}),0);
});
