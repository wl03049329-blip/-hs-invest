'use strict';
const assert=require('assert/strict'),vm=require('vm'),{waitForVerifiedController}=require('./stable_app_browser_handoff.cjs');
class Target{constructor(state){this.state=state;this.listeners=new Map();this.scriptURL='https://example.test/push-service-worker.js';}addEventListener(k,f){if(!this.listeners.has(k))this.listeners.set(k,new Set());this.listeners.get(k).add(f);}removeEventListener(k,f){this.listeners.get(k)?.delete(f);}emit(k){for(const f of [...this.listeners.get(k)||[]])f();}}
function setup(){const old=new Target('activated'),next=new Target('installed'),sw=new Target(),reg=new Target(),calls=[];Object.assign(reg,{installing:null,waiting:next,active:old,update:async()=>{calls.push('update');}});Object.assign(sw,{controller:old,getRegistration:async()=>reg});let expire;
 class Channel{constructor(){const p1={close(){},onmessage:null},p2={close(){},reply:data=>p1.onmessage?.({data})};this.port1=p1;this.port2=p2;}}
 const response={ok:true,active:'parent',worker_build:'next',worker_protocol:'HS_STABLE_HANDOFF_V2'};
 old.postMessage=()=>calls.push('OLD_MESSAGE');next.postMessage=(m,ports)=>{calls.push(m.type);queueMicrotask(()=>ports[0].reply(response));};
 const ctx={navigator:{serviceWorker:sw},MessageChannel:Channel,performance:{now:()=>1},console:{info(){}},setTimeout:(f,n)=>{assert.equal(n,25000);expire=f;return 1;},clearTimeout(){}};
 const run=vm.runInNewContext('('+waitForVerifiedController.toString()+')',ctx),start=()=>run({expected:'next',parent:'parent'}),activate=()=>{reg.waiting=null;reg.active=next;next.state='activated';sw.controller=next;sw.emit('controllerchange');};
 return{old,next,sw,reg,calls,response,start,activate,expire:()=>expire()};}
async function tick(){await new Promise(r=>setImmediate(r));}
(async()=>{let pass=0;
 const a=setup(),waiting=a.start();await tick();assert.deepEqual(a.calls,['update']);pass++;
 // Old harness would post ACTIVATE to sw.controller here, waking OLD_MESSAGE.
 // New precondition sends no message to the outgoing waiting-era Controller.
 a.reg.waiting=null;a.reg.active=a.next;a.next.state='activating';a.reg.emit('updatefound');await tick();assert.deepEqual(a.calls,['update']);pass++;
 a.sw.controller=a.next;a.sw.emit('controllerchange');await tick();assert.deepEqual(a.calls,['update']);pass++;
 a.next.state='activated';a.next.emit('statechange');const r=await waiting;assert.equal(r.worker_build,'next');assert.equal(r.active,'parent');assert.deepEqual(a.calls,['update','HS_APP_STATUS']);pass++;
 assert.equal(a.sw.listeners.get('controllerchange').size,0);assert.equal(a.next.listeners.get('statechange').size,0);pass++;
 for(const change of [{active:'wrong'},{worker_build:'old'},{ok:false},{worker_protocol:'unknown'}]){const b=setup();Object.assign(b.response,change);const p=b.start();await tick();b.activate();await tick();const rejected=assert.rejects(p,/TEST_NATIVE_CONTROLLER_HANDOFF_TIMEOUT/);b.expire();await rejected;pass++;}
 const c=setup(),timeout=c.start();await tick();const rejected=assert.rejects(timeout,/TEST_NATIVE_CONTROLLER_HANDOFF_TIMEOUT/);c.expire();await rejected;assert(!c.calls.includes('OLD_MESSAGE'));pass++;
 assert.equal(pass,10);console.log('Verified native Controller precondition: '+pass+'/10 PASS; no production code changed');
})().catch(e=>{console.error(e);process.exitCode=1;});
