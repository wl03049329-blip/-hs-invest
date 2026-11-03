'use strict';
// TEST HARNESS ONLY. Never injected into published HTML or the production Worker.
// Direct protocol fault injection must not restart the outgoing Controller while
// its native replacement is waiting. Registration identity alone is insufficient.
async function waitForVerifiedController({expected,parent}){
 const sw=navigator.serviceWorker,r=await sw.getRegistration();if(!r)throw Error('TEST_REGISTRATION_MISSING');
 await r.update();
 return new Promise((resolve,reject)=>{
  let done=false,inflight=false;const watched=new Set(),ports=new Set(),ids=new WeakMap();let seq=0;
  const identity=w=>{if(!w)return null;if(!ids.has(w))ids.set(w,++seq);return{id:ids.get(w),state:w.state,script:w.scriptURL};};
  const log=event=>console.info('HS_TEST_NATIVE_HANDOFF',JSON.stringify({event,at:performance.now(),expected,parent,installing:identity(r.installing),waiting:identity(r.waiting),active:identity(r.active),controller:identity(sw.controller)}));
  function finish(error,value){if(done)return;done=true;clearTimeout(timer);r.removeEventListener('updatefound',inspect);sw.removeEventListener('controllerchange',inspect);for(const w of watched)w.removeEventListener('statechange',inspect);for(const p of ports)p.close();log(error?'REJECTED':'VERIFIED');error?reject(error):resolve(value);}
  function inspect(){if(done)return;for(const w of[r.installing,r.waiting,r.active,sw.controller])if(w&&!watched.has(w)){watched.add(w);w.addEventListener('statechange',inspect);}log('OBSERVE');const pending=[r.installing,r.waiting].some(w=>w&&w.state!=='redundant'),c=sw.controller;
   if(pending||!c||c!==r.active||c.state!=='activated'||inflight)return;
   inflight=true;const channel=new MessageChannel();ports.add(channel.port1);ports.add(channel.port2);channel.port1.onmessage=e=>{inflight=false;ports.delete(channel.port1);ports.delete(channel.port2);channel.port1.close();channel.port2.close();if(done)return;const s=e.data;
    if(c!==sw.controller||c!==r.active||c.state!=='activated'||[r.installing,r.waiting].some(w=>w&&w.state!=='redundant')){inspect();return;}
    if(s?.ok&&s.worker_build===expected&&s.active===parent&&s.worker_protocol==='HS_STABLE_HANDOFF_V2')finish(null,s);
   };try{c.postMessage({type:'HS_APP_STATUS'},[channel.port2]);}catch(e){finish(e);}
  }
  const timer=setTimeout(()=>finish(Error('TEST_NATIVE_CONTROLLER_HANDOFF_TIMEOUT')),25000);
  r.addEventListener('updatefound',inspect);sw.addEventListener('controllerchange',inspect);inspect();
 });
}
module.exports={waitForVerifiedController};
