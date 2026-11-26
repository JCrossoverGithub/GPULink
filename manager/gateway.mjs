import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {parseOperation,executeOperation} from './operations.mjs';
import {readFileSync,lstatSync,openSync,fstatSync,closeSync,constants} from 'node:fs';
import {parseEnv} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readSnapshot} from './snapshot.mjs';
import {createChangeFeed} from './change-feed.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const files=new Map([['/',['index.html','text/html; charset=utf-8']],['/manager.css',['manager.css','text/css; charset=utf-8']],['/manager.js',['manager.js','text/javascript; charset=utf-8']],['/refresh-controller.js',['refresh-controller.js','text/javascript; charset=utf-8']]]);
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
export function createManager(config,{monotonicNow=()=>performance.now()}={}){
  if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(config.origin))throw new Error('Loopback Core required');
  const assets=new Map([...files].map(([url,[file,type]])=>[url,{body:readFileSync(path.join(root,'public',file)),type}]));
  let inflight=null,last=null,lastAt=0,generation=0,operationInFlight=false;
  const controlToken=config.controls===true?randomBytes(32).toString('hex'):null;
  const invalidate=()=>{generation++;last=null;};
  const changes=createChangeFeed(config,invalidate);
  async function snapshot(){
    if(last&&monotonicNow()-lastAt<1000)return last;
    if(!inflight){
      const started=generation;
      const pending=readSnapshot(config).then(s=>{
        const value={...s,context:config.fixture===true?'isolated-test':'local-installation',...(controlToken?{controlToken}:{})};
        // An invalidation during a read must not restore the invalidated cache.
        if(started===generation){last=value;lastAt=monotonicNow();}
        return value;
      }).finally(()=>{if(inflight===pending)inflight=null;});
      inflight=pending;
    }
    return inflight;
  }
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cross-Origin-Resource-Policy','same-origin');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    const send=(code,body,type='application/json; charset=utf-8')=>{res.writeHead(code,{'Content-Type':type});res.end(body);};
    const host=`127.0.0.1:${server.address()?.port}`,origin='http://'+host;
    if(req.headers.host!==host||(req.headers.origin&&req.headers.origin!==origin)||['cross-site','same-site'].includes(req.headers['sec-fetch-site']))return send(403,'{"error":"forbidden"}');
    if(req.method==='POST'&&req.url==='/api/operation'&&controlToken){
      const result=(code,outcome)=>send(code,JSON.stringify({outcome}));
      if(req.headers.origin!==origin||req.headers['sec-fetch-site']!=='same-origin'||req.headers['x-gpulink-control']!==controlToken)return result(403,'forbidden');
      if(req.headers['content-type']!=='application/json'||!/^\d+$/.test(req.headers['content-length']||'')||Number(req.headers['content-length'])>2048||req.headers['transfer-encoding'])return result(400,'invalid-request');
      if(operationInFlight)return result(409,'busy');
      operationInFlight=true;
      const timer=setTimeout(()=>req.destroy(),3000);timer.unref?.();
      let dispatchStarted=false;
      try{
        const chunks=[];let size=0;
        for await(const chunk of req){size+=chunk.length;if(size>2048)return result(400,'invalid-request');chunks.push(chunk);}
        clearTimeout(timer);
        let operation;try{operation=parseOperation(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{}
        if(!operation)return result(400,'invalid-request');
        invalidate();
        dispatchStarted=true;
        const answer=await executeOperation(config,operation);
        return result(answer.status,answer.outcome);
      }catch{if(!res.destroyed)return result(dispatchStarted?502:400,dispatchStarted?'uncertain':'invalid-request');}
      finally{if(dispatchStarted){invalidate();inflight=null;}clearTimeout(timer);operationInFlight=false;}
      return;
    }
    if(req.method!=='GET')return send(405,'{"error":"read_only"}');
    if(req.url==='/api/snapshot'){
      // Browser cannot choose a Core route or supply credentials. Same-origin JSON only.
      if(req.headers['x-gpulink-manager']!=='snapshot-v1')return send(403,'{"error":"forbidden"}');
      try{return send(200,JSON.stringify(await snapshot()));}catch{return send(503,'{"error":"core_unavailable_or_invalid"}');}
    }
    if(req.url==='/api/changes'){
      // Native EventSource cannot set a custom header. Require same-origin
      // browser metadata, or the existing explicit local API header for tools.
      if(req.headers['sec-fetch-site']!=='same-origin'&&req.headers['x-gpulink-manager']!=='snapshot-v1')return send(403,'{"error":"forbidden"}');
      if(!changes.add(res))return send(503,'{"error":"changes_unavailable"}');
      return;
    }
    const asset=assets.get(req.url);if(asset)return send(200,asset.body,asset.type);
    return send(404,'{"error":"not_found"}');
  });
  server.closeEventStreams=()=>changes.close();
  server.on('close',server.closeEventStreams);
  server.requestTimeout=8000;server.headersTimeout=5000;server.maxHeadersCount=40;return server;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(![4,5].includes(process.argv.length)||process.argv[2]!=='--config-dir'||(process.argv.length===5&&process.argv[4]!=='--enable-controls'))throw new Error('Usage: node manager/gateway.mjs --config-dir DIRECTORY [--enable-controls]');
    const config={...loadProfile(process.argv[3]),controls:process.argv[4]==='--enable-controls'};const server=createManager(config);
    server.on('error',()=>{console.error('Manager could not listen. No other service was stopped.');process.exitCode=1;});
    server.listen(0,'127.0.0.1',()=>console.log(`GPULink Manager (${config.controls?'operator controls enabled':'read-only'})\nhttp://127.0.0.1:${server.address().port}/\nCtrl+C to close manager only.`));
    for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{server.closeEventStreams();server.close();server.closeAllConnections();});
  }catch(e){console.error('Manager startup refused: '+(e.message?.startsWith('Usage:')?e.message:'Invalid or inaccessible private loopback installation.'));process.exitCode=1;}
}
