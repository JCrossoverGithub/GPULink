import http from 'node:http';
import {createSignalHub,signalFrame} from '../src/shared/change-signals.mjs';

// One fixed upstream, only while browsers subscribe. No forwarding of raw
// upstream bytes, credentials, event IDs, URLs, or event payloads.
export function createChangeFeed(config,invalidate,{retryMs=2000,idleMs=25000}={}) {
  let request=null,retry=null,starting=null,connected=false,closed=false;
  const hub=createSignalHub({initial:()=>connected?'ready':'fallback',onCount:count=>{
    if(!count)stop();else if(!request&&!retry&&!starting&&!closed)start();
  }});
  const frames=new Map(['ready','changed','heartbeat'].map(k=>[signalFrame(k),k]));
  function stop(){starting=null;clearTimeout(retry);retry=null;const r=request;request=null;connected=false;r?.destroy();}
  function scheduleRetry(){if(!closed&&hub.size&&!retry){retry=setTimeout(()=>{retry=null;start();},retryMs);retry.unref?.();}}
  function start(){
    if(closed||!hub.size||request||starting)return;
    if(!config.assertCore){connect();return;}
    const attempt={};starting=attempt;
    Promise.resolve().then(()=>config.assertCore()).then(()=>{
      if(starting!==attempt)return;
      starting=null;if(!closed&&hub.size)connect();
    },()=>{
      if(starting!==attempt)return;
      starting=null;invalidate();hub.broadcast('fallback');scheduleRetry();
    });
  }
  function connect(){
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
      scheduleRetry();
      hub.broadcast('fallback');
    }
    req.setTimeout(idleMs,fail);req.once('error',fail);
  }
  return {add:res=>hub.add(res),close(){closed=true;stop();hub.close();}};
}
