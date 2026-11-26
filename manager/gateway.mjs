import http from 'node:http';
import {readFileSync,lstatSync,openSync,fstatSync,closeSync,constants} from 'node:fs';
import {parseEnv} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readSnapshot} from './snapshot.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const files=new Map([['/',['index.html','text/html; charset=utf-8']],['/manager.css',['manager.css','text/css; charset=utf-8']],['/manager.js',['manager.js','text/javascript; charset=utf-8']]]);
export function loadProfile(directory){
  if(process.platform!=='linux')throw new Error('This preview supports Linux and WSL only.');
  const dir=path.resolve(directory),d=lstatSync(dir);
  if(!d.isDirectory()||d.isSymbolicLink()||d.uid!==process.getuid()||(d.mode&0o077))throw new Error('Select an owned private installation directory.');
  const profile=(filename,key)=>{
    const fd=openSync(path.join(dir,filename),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{const st=fstatSync(fd);if(!st.isFile()||st.uid!==process.getuid()||(st.mode&0o077)||st.size>8192)throw new Error('Unsafe role profile.');
      const p=parseEnv(readFileSync(fd,'utf8'));
      if(Object.keys(p).sort().join(',')!==[key,'GPULINK_URL'].sort().join(',')||p.GPULINK_URL!=='http://127.0.0.1:8088'||!/^[a-f0-9]{64}$/.test(p[key]))throw new Error('Expected generated loopback role profile.');return p[key];
    }finally{closeSync(fd);}
  };
  const adminToken=profile('admin.env','GPULINK_ADMIN_TOKEN'),clientToken=profile('client.env','GPULINK_CLIENT_TOKEN');
  if(adminToken===clientToken)throw new Error('Role credentials must be distinct.');
  return {origin:'http://127.0.0.1:8088',adminToken,clientToken};
}
export function createManager(config){
  if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(config.origin))throw new Error('Loopback Core required');
  const assets=new Map([...files].map(([url,[file,type]])=>[url,{body:readFileSync(path.join(root,'public',file)),type}]));
  let inflight=null,last=null,lastAt=0;
  async function snapshot(){if(last&&Date.now()-lastAt<1000)return last;if(!inflight){inflight=readSnapshot(config).then(s=>{last={...s,context:config.fixture===true?'isolated-test':'local-installation'};lastAt=Date.now();return last;}).finally(()=>{inflight=null;});}return inflight;}
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cross-Origin-Resource-Policy','same-origin');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    const send=(code,body,type='application/json; charset=utf-8')=>{res.writeHead(code,{'Content-Type':type});res.end(body);};
    const host=`127.0.0.1:${server.address()?.port}`,origin='http://'+host;
    if(req.headers.host!==host||(req.headers.origin&&req.headers.origin!==origin)||['cross-site','same-site'].includes(req.headers['sec-fetch-site']))return send(403,'{"error":"forbidden"}');
    if(req.method!=='GET')return send(405,'{"error":"read_only"}');
    if(req.url==='/api/snapshot'){
      // Browser cannot choose a Core route or supply credentials. Same-origin JSON only.
      if(req.headers['x-gpulink-manager']!=='snapshot-v1')return send(403,'{"error":"forbidden"}');
      try{return send(200,JSON.stringify(await snapshot()));}catch{return send(503,'{"error":"core_unavailable_or_invalid"}');}
    }
    const asset=assets.get(req.url);if(asset)return send(200,asset.body,asset.type);
    return send(404,'{"error":"not_found"}');
  });
  server.requestTimeout=8000;server.headersTimeout=5000;server.maxHeadersCount=40;return server;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.argv.length!==4||process.argv[2]!=='--config-dir')throw new Error('Usage: node manager/gateway.mjs --config-dir DIRECTORY');
    const config=loadProfile(process.argv[3]);const server=createManager(config);
    server.on('error',()=>{console.error('Manager could not listen. No other service was stopped.');process.exitCode=1;});
    server.listen(0,'127.0.0.1',()=>console.log(`GPULink Manager — read-only\nhttp://127.0.0.1:${server.address().port}/\nCtrl+C to close manager only.`));
    for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{server.close();server.closeAllConnections();});
  }catch(e){console.error('Manager startup refused: '+(e.message?.startsWith('Usage:')?e.message:'Invalid or inaccessible private loopback installation.'));process.exitCode=1;}
}
