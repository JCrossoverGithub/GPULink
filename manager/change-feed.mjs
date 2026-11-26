import http from 'node:http';
import {createSignalHub,signalFrame} from '../src/shared/change-signals.mjs';

// One fixed upstream, only while browsers subscribe. No forwarding of raw
// upstream bytes, credentials, event IDs, URLs, or event payloads.
export function createChangeFeed(config,invalidate,{retryMs=2000,idleMs=25000}={}) {
  let request=null,retry=null,connected=false,closed=false;
  const hub=createSignalHub({initial:()=>connected?'ready':'fallback',onCount:count=>{
    if(!count)stop();else if(!request&&!retry&&!closed)start();
  }});
  const frames=new Map(['ready','changed','heartbeat'].map(k=>[signalFrame(k),k]));
  function stop(){clearTimeout(retry);retry=null;const r=request;request=null;connected=false;r?.destroy();}
  function start(){
    if(closed||!hub.size||request)return;
    const req=http.get(config.origin+'/v1/admin/operational-changes',{headers:{Authorization:'Bearer '+config.adminToken,Accept:'text/event-stream'}},res=>{
      if(request!==req){res.destroy();return;}
      if(res.statusCode!==200||res.headers['content-type']?.split(';')[0]!=='text/event-stream'){res.destroy();fail();return;}
      let buffer='',ready=false;
      res.setEncoding('utf8');
      res.on('data',chunk=>{
        if(request!==req)return;
        buffer+=chunk;
        // A well-formed channel carries only a few dozen bytes per message.
        if(buffer.length>4096){fail();return;}
        let end;
        while((end=buffer.indexOf('\n\n'))>=0){
          const frame=buffer.slice(0,end+2);buffer=buffer.slice(end+2);
          const kind=frames.get(frame);
          if(!kind||(!ready&&kind!=='ready')||(ready&&kind==='ready')){fail();return;}
          if(kind==='ready'){ready=true;connected=true;invalidate();hub.broadcast('ready');}
          else if(kind==='changed'){invalidate();hub.broadcast('changed');}
        }
      });
      res.once('end',fail);res.once('error',fail);res.once('close',fail);
    });
    request=req;
    function fail(){
      if(request!==req)return;
      request=null;req.destroy();connected=false;invalidate();
      if(!closed&&hub.size&&!retry){retry=setTimeout(()=>{retry=null;start();},retryMs);retry.unref?.();}
      hub.broadcast('fallback');
    }
    req.setTimeout(idleMs,fail);req.once('error',fail);
  }
  return {add:res=>hub.add(res),close(){closed=true;stop();hub.close();}};
}
