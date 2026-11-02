'use strict';
const assert=require('assert/strict'),fs=require('fs'),vm=require('vm'),cp=require('child_process');
const current=fs.readFileSync('portfolio-v3/personal-v3.js','utf8');
function requestExpression(source){
 const start=source.indexOf("fetch(new URL('finalized-core-score-snapshots-v1.json',base)");
 assert(start>0);const end=source.indexOf('.catch(()=>null)',start);
 assert(end>start);return source.slice(start,end+'.catch(()=>null)'.length);
}
async function run(source){
 let deadline=null,aborted=false,suppliedSignal=false;
 const box={URL,base:'https://example.invalid/-hs-invest/',AbortSignal:{timeout(ms){deadline=ms;return AbortSignal.timeout(5);}},
  fetch:async(_url,options)=>{suppliedSignal=!!options.signal;assert(options.signal,'C4_BODY_DEADLINE_REQUIRED');return{ok:true,json:()=>new Promise((_resolve,reject)=>{options.signal.addEventListener('abort',()=>{aborted=true;reject(Error('SYNTHETIC_STALLED_BODY_ABORT'));},{once:true});})};}};
 const result=await vm.runInNewContext(requestExpression(source),box);
 assert(suppliedSignal,'C4_BODY_DEADLINE_REQUIRED');assert.equal(deadline,15000,'unchanged bounded15s transport deadline');assert.equal(aborted,true);assert.equal(result,null,'optional C4 must settle unavailable, not hold all prices');
}
(async()=>{
 const old=cp.execFileSync('git',['show','50a071d50b6816700f5a24185218616458b55771:portfolio-v3/personal-v3.js'],{maxBuffer:8e6}).toString();
 await assert.rejects(()=>run(old),/C4_BODY_DEADLINE_REQUIRED/);console.log('PASS deterministic RED: accepted previous source lacked C4 response-body deadline');
 // Keep the test process alive until the synthetic deadline fires (native
 // AbortSignal.timeout intentionally does not retain the Node event loop).
 const keep=setInterval(()=>{},1000);try{await run(current);}finally{clearInterval(keep);}
 console.log('PASS GREEN: actual current C4 request body aborts and settles null without holding quote refresh');
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
