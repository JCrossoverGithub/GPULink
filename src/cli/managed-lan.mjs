// Optional WSL2 NAT/LAN operator layer; does not change the Core protocol.
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { setTimeout as delay } from 'node:timers/promises';
import { defaultServerSetupDirectory, readServerSetup, runServerInit, runServerLifecycle } from './server-profile.mjs';
import { inspectManagedLocal } from './local-lifecycle.mjs';
import { discoverLan, discoverLanPort, validateNetwork, changeNetwork } from './managed-lan-windows.mjs';
import { exportInvitation } from './managed-lan-invite.mjs';

function cmd(bin,args,cwd) { return execFileSync(bin,args,{cwd,stdio:['ignore','pipe','pipe'],encoding:'utf8',timeout:120000}); }
function privateDirectory(dir) { const st=lstatSync(dir); if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.getuid()||(st.mode&0o077))throw new Error('Expected private owner-only managed LAN directory.'); }
function managedDirectory(dir) { const setup=readServerSetup(dir); const work=path.join(setup.directory,'managed-lan');privateDirectory(work);return {setup,work}; }
function readPlan(dir) { const {setup,work}=managedDirectory(dir);const file=path.join(work,'network.json');const st=lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid()||(st.mode&0o077)||st.size>2048)throw new Error('Unsafe network journal.');const plan=validateNetwork(JSON.parse(readFileSync(file,'utf8')));if(setup.publicOrigin!==`https://${plan.listen}:${plan.port}`)throw new Error('Network journal does not match installation origin.');return {plan,work,setup}; }
export function parseSetupOptions(args) {
  const opts={port:null,apply:false};const seen=new Set();
  while(args.length){const flag=args.shift();if(seen.has(flag))throw new Error('Duplicate setup option.');seen.add(flag);
    if(flag==='--apply'){opts.apply=true;continue;}
    if(!['--peer','--port','--caddy'].includes(flag)||!args.length||args[0].startsWith('--'))throw new Error('Invalid setup option.');
    const value=args.shift();if(flag==='--peer')opts.peer=value;else if(flag==='--port')opts.port=Number(value);else opts.caddy=path.resolve(value);
  }
  if(!opts.peer||(opts.port!==null&&(!Number.isSafeInteger(opts.port)||opts.port<1024||opts.port>65535||opts.port===8088)))throw new Error('Specify --peer PRIVATE_IPV4 and optionally --port (1024–65535, except 8088).');return opts;
}
export function makeCertificates(work,ip) {
  cmd('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','30','-subj','/CN=GPULink managed LAN CA','-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign','-keyout','ca-key.pem','-out','ca.pem'],work);
  cmd('openssl',['req','-new','-newkey','rsa:2048','-nodes','-subj',`/CN=${ip}`,'-keyout','server-key.pem','-out','server.csr'],work);
  writeFileSync(path.join(work,'server.ext'),`basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:${ip}\n`,{flag:'wx',mode:0o600});
  cmd('openssl',['x509','-req','-in','server.csr','-CA','ca.pem','-CAkey','ca-key.pem','-CAcreateserial','-days','7','-extfile','server.ext','-out','server-cert.pem'],work);
  cmd('openssl',['verify','-CAfile','ca.pem','-verify_ip',ip,'server-cert.pem'],work);
}
export function caddyConfig(work,n) {
  validateNetwork(n);if(!/^\/[A-Za-z0-9_./ -]+$/.test(work))throw new Error('Invalid managed path.');
  return `{\n admin off\n auto_https disable_redirects\n default_sni ${n.listen}\n servers {\n protocols h1 h2\n }\n}\nhttps://${n.listen}:${n.port} {\n bind ${n.wsl}\n tls ${JSON.stringify(path.join(work,'server-cert.pem'))} ${JSON.stringify(path.join(work,'server-key.pem'))}\n reverse_proxy 127.0.0.1:8088\n}\n`;
}
function acquireCaddy(work,explicit) {
  if(explicit){cmd(explicit,['version'],work);return explicit;}
  // Use an existing executable, otherwise fetch a distro package without root,
  // package scripts, system service or repository changes.
  try{cmd('caddy',['version'],work);return 'caddy';}catch{}
  cmd('apt',['download','caddy'],work);
  const files=readdirSync(work).filter(x=>/^caddy_[^/]+\.deb$/.test(x));if(files.length!==1)throw new Error('Expected one distro Caddy package.');
  cmd('dpkg-deb',['-x',files[0],'caddy-runtime'],work);
  const binary=path.join(work,'caddy-runtime','usr','bin','caddy');cmd(binary,['version'],work);return binary;
}
export function probeLan(work,n) {
  return new Promise(resolve=>{
    let settled=false, timer;const finish=v=>{if(!settled){settled=true;clearTimeout(timer);resolve(v);}};
    const req=https.get({hostname:n.wsl,port:n.port,path:'/readyz',headers:{Host:`${n.listen}:${n.port}`},ca:readFileSync(path.join(work,'ca.pem')),rejectUnauthorized:true,agent:false,checkServerIdentity:(_hostname,cert)=>checkServerIdentity(n.listen,cert)},res=>{
      let text='';res.setEncoding('utf8');res.on('data',c=>{text+=c;if(text.length>4096){finish(false);res.destroy();}});res.on('error',()=>finish(false));res.on('end',()=>{try{finish(res.statusCode===200&&JSON.parse(text).status==='ready');}catch{finish(false);}});
    });timer=setTimeout(()=>{finish(false);req.destroy();},2000);req.on('error',()=>finish(false));
  });
}
async function serve(opts,directory,output) {
  const n=validateNetwork({...discoverLan(opts.peer),port:discoverLanPort(opts.port),rule:`GPULink-LAN-${randomBytes(16).toString('hex')}`});
  const origin=`https://${n.listen}:${n.port}`;
  output.log(`Plan: ${origin} -> ${n.wsl}:${n.port} -> 127.0.0.1:8088; allow only peer ${n.peer}, Windows ${n.profile} profile. No global trust changes.`);
  if(!opts.apply){output.log('Read-only network plan; free-port choice is rechecked on apply. Add --apply to create a fresh installation, provision TLS/Caddy and request Windows administrator approval.');return 0;}
  if(!/^\/[A-Za-z0-9_./ -]+$/.test(directory))throw new Error('Managed LAN setup requires a simple Linux configuration path.');
  if(process.getuid()===0||Number(process.versions.node.split('.')[0])<24)throw new Error('Run as a non-root Linux user with Node.js 24+.');
  if(existsSync(directory))throw new Error('Choose a new configuration directory. Existing installations are not overwritten.');
  if(runServerInit(['--public-url',origin],directory,output))return 1;
  const work=path.join(directory,'managed-lan');mkdirSync(work,{mode:0o700});
  writeFileSync(path.join(work,'network.json'),JSON.stringify(n)+'\n',{flag:'wx',mode:0o600});
  let child, childEnded, started=false, networkAttempted=false, interrupted=false, failed=false;
  const signal=()=>{interrupted=true;if(child&&!childExited())child.kill('SIGTERM');};
  const childExited=()=>child&&(child.exitCode!==null||child.signalCode!==null);
  process.on('SIGINT',signal);process.on('SIGTERM',signal);
  try {
    const oldMask=process.umask(0o077);let caddy;
    try{makeCertificates(work,n.listen);caddy=acquireCaddy(work,opts.caddy);writeFileSync(path.join(work,'Caddyfile'),caddyConfig(work,n),{flag:'wx',mode:0o600});}finally{process.umask(oldMask);}
    if(interrupted)throw new Error('Setup interrupted.');
    const env={...process.env,XDG_DATA_HOME:path.join(work,'caddy-data'),XDG_CONFIG_HOME:path.join(work,'caddy-config')};
    execFileSync(caddy,['validate','--config',path.join(work,'Caddyfile'),'--adapter','caddyfile'],{cwd:work,env,stdio:'ignore',timeout:15000});
    if(await runServerLifecycle(['start'],directory,output))throw new Error('Managed backend did not start.');started=true;
    if(interrupted)throw new Error('Setup interrupted.');
    child=spawn(caddy,['run','--config',path.join(work,'Caddyfile'),'--adapter','caddyfile'],{cwd:work,env,stdio:['ignore','ignore','inherit']});
    let childFailed=false;childEnded=new Promise(resolve=>{child.once('error',()=>{childFailed=true;resolve();});child.once('exit',()=>resolve());});
    let ready=false;for(let i=0;i<15&&!interrupted&&!childFailed&&!childExited();i++){if(await probeLan(work,n)){ready=true;break;}await delay(300);}
    if(!ready||interrupted)throw new Error('Private TLS proxy did not become ready.');
    // Re-detect before privilege escalation; no stale WSL address is applied.
    const current=discoverLan(opts.peer);if(['listen','peer','wsl','index','profile'].some(k=>current[k]!==n[k]))throw new Error('Network changed during setup; no forwarding applied.');
    networkAttempted=true;output.log('Windows administrator approval requested for the displayed firewall and forwarding plan.');changeNetwork(n,'apply');
    if(interrupted)throw new Error('Setup interrupted.');
    output.log(`PASS: managed LAN ingress running at ${origin}. Local TLS readiness verified; confirm from peer using join.`);
    output.log('Keep this terminal open. In another terminal run gpulink with the same --config-dir and setup invite --output FILE. Drain/stop workers before Ctrl+C.');
    // If DHCP or WSL changes, close ingress rather than silently reconfigure.
    const watch=setInterval(()=>{try{const now=discoverLan(opts.peer);if(['listen','peer','wsl','index','profile'].some(k=>now[k]!==n[k]))throw new Error();}catch{failed=true;output.error('LAN changed or cannot be verified; closing managed ingress.');signal();}},30000);
    try{await childEnded;if(!interrupted)throw new Error('Caddy exited unexpectedly.');}finally{clearInterval(watch);}
  }catch(error){failed=true;output.error(`Managed setup failed: ${error.message.split('\n')[0]}`);}
  finally{
    if(child?.pid&&!childExited()){child.kill('SIGTERM');await Promise.race([childEnded,delay(3000)]);if(!childExited()){child.kill('SIGKILL');await childEnded;}}
    if(networkAttempted){try{output.log('Windows administrator approval requested to remove this installation’s networking rules.');changeNetwork(n,'remove');}catch{failed=true;output.error('Network cleanup incomplete. Run setup cleanup with this configuration directory.');}}
    if(started){try{const setup=readServerSetup(directory);if(await inspectManagedLocal(setup)==='ready'){if(await runServerLifecycle(['stop'],directory,output))failed=true;}else{failed=true;output.error('Backend ownership no longer verified. Inspect server status; no arbitrary process was stopped.');}}catch{failed=true;output.error('Backend cleanup incomplete; inspect server status.');}}
    process.off('SIGINT',signal);process.off('SIGTERM',signal);
  }
  output.log('Configuration and database retained.');return failed?1:0;
}
export async function runManagedSetup(args,directory,output=console) {
  const [action,...rest]=args;const dir=path.resolve(directory??defaultServerSetupDirectory());
  try{
    if(process.platform!=='linux')throw new Error('Managed LAN server setup requires WSL2 NAT.');
    if(action==='server')return await serve(parseSetupOptions(rest),dir,output);
    if(action==='invite'&&rest.length===2&&rest[0]==='--output'){
      const {setup,work,plan}=readPlan(dir);if(await inspectManagedLocal(setup)!=='ready'||!await probeLan(work,plan))throw new Error('Managed server and TLS ingress must be running.');exportInvitation(dir,rest[1],output);return 0;
    }
    if(action==='cleanup'&&rest.length===0){const {plan}=readPlan(dir);changeNetwork(plan,'remove');output.log('PASS: owned Windows forwarding and firewall removed or already absent. Backend/proxy processes are not stopped by this recovery command.');return 0;}
    output.error('Usage: gpulink setup server --peer PRIVATE_IPV4 [--port N] [--caddy PATH] [--apply] | setup invite --output FILE | setup cleanup');return 2;
  }catch(error){output.error(`Managed setup refused: ${error.message.split('\n')[0]}`);return 1;}
}
