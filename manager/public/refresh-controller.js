// Single-flight snapshot refresh with a trailing refresh for changes received
// during a request. Polling remains active even with a healthy event stream.
export function createRefreshController({read,apply,now=()=>performance.now(),schedule=setTimeout,cancel=clearTimeout,minInterval=1000,pollInterval=5000}) {
  let timer=null,running=false,pending=false,stopped=false,lastStart=-Infinity;
  function arm(delay){if(timer!==null)cancel(timer);timer=schedule(()=>{timer=null;void run();},Math.max(0,delay));}
  function request(){
    if(stopped)return;
    pending=true;
    if(!running)arm(minInterval-(now()-lastStart));
  }
  async function run(){
    if(stopped||running)return;
    running=true;pending=false;lastStart=now();
    let value,error;
    try{value=await read();}catch(e){error=e||new Error('Snapshot unavailable');}
    finally{
      running=false;
      if(!stopped){
        try{apply(value,error);}finally{
          arm(pending?minInterval-(now()-lastStart):pollInterval);
        }
      }
    }
  }
  return {request,stop(){stopped=true;if(timer!==null)cancel(timer);timer=null;}};
}
