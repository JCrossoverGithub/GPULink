// Bounded, payload-free SSE invalidation channel. Not an event log or cursor.
export const signalFrame = kind => `event: ${kind}\ndata: 1\n\n`;
export function createSignalHub({initial=()=> 'ready',onCount=()=>{},maxClients=32,heartbeatMs=10000,changeIntervalMs=1000}={}) {
  const clients=new Set();
  let heartbeat=null,pending=null;
  function remove(res){
    if(!clients.delete(res))return;
    if(!clients.size){clearInterval(heartbeat);heartbeat=null;clearTimeout(pending);pending=null;}
    onCount(clients.size);
  }
  function write(res,kind){
    try{if(!res.destroyed&&!res.writableEnded&&res.write(signalFrame(kind)))return;}catch{/* discard broken stream */}
    remove(res);res.destroy();
  }
  function broadcast(kind){for(const res of clients)write(res,kind);}
  function add(res){
    if(clients.size>=maxClients)return false;
    res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store, no-transform','X-Accel-Buffering':'no'});
    clients.add(res);res.once('close',()=>remove(res));res.once('error',()=>remove(res));
    if(!heartbeat){heartbeat=setInterval(()=>broadcast('heartbeat'),heartbeatMs);heartbeat.unref?.();}
    write(res,initial());onCount(clients.size);return true;
  }
  function changed(){
    if(!clients.size||pending)return;
    pending=setTimeout(()=>{pending=null;broadcast('changed');},changeIntervalMs);pending.unref?.();
  }
  function close(){for(const res of [...clients]){remove(res);res.end();}}
  return {add,changed,broadcast,close,get size(){return clients.size;}};
}
