'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync('index.html','utf8');
const start=html.indexOf('let lastPublishedFormalCoreView;');
const end=html.indexOf('function renderTop()',start);
assert.ok(start>=0&&end>start);
let events=0;
const context=vm.createContext({
  LONG_RADAR_SCORED_CODES:new Set(['0050','00830']),
  window:{HSCanonicalScoreResolver:{selectFormalCoreScore:(view,symbol)=>view[symbol]},dispatchEvent(e){assert.equal(e.type,'hs:formal-core-score-updated');events++;}},
  CustomEvent:class{constructor(type){this.type=type;}},
});
vm.runInContext(html.slice(start,end),context);
const base={available:true,score:71.01,status:'FINALIZED',trading_date:'2026-11-05',source:'FINALIZED'};
const send=row=>context.publishFormalCoreView({'0050':row});
send(base);send({...base});assert.equal(events,1,'same score view must not notify twice');
send({...base,trading_date:'2026-11-06'});assert.equal(events,2);
send({...base,score:71.02});assert.equal(events,3);
send({...base,status:'LIVE_PROJECTED',source:'LIVE'});assert.equal(events,4);
send({available:false,reason:'SCORE_STATE_STALE'});assert.equal(events,5);
console.log('PASS formal notification preserves score, date, source and fail-closed transitions');

// Test the actual transport orchestration with a source that ignores abort.
// Even if an old body arrives, it must neither decode nor touch the new view.
(async()=>{
 const s=fs.readFileSync('portfolio-v3/personal-v3.js','utf8');
 const a=s.indexOf(' let marketController=null;'),b=s.indexOf(" $('updatePrices').onclick=refresh;",a);
 assert.ok(a>=0&&b>a);
 const callbacks={},requests=[],events=[];
 let visible=true,decodes=0,validations=0,renders=0;
 const sandbox=vm.createContext({AbortController,AbortSignal,URL,Date,Set,queueMicrotask,Event,
  marketInFlight:null,portfolioRefreshPending:false,quoteSequence:0,historySource:null,
  cache:null,status:null,c4:null,quotes:null,base:'https://example.test/',
  portfolioVisible:()=>visible,render:()=>renders++,
  V:{closeQuotes:()=>{validations++;return new Map();},session:()=>null},
  dispatchEvent:e=>events.push(e.type),$:()=>({}),
  host:{addEventListener:(event,callback)=>{callbacks[event]=callback;},document:{addEventListener(){}}},
  fetch:(url,{signal})=>new Promise(resolve=>requests.push({url:String(url),signal,resolve})),
 });
 vm.runInContext(s.slice(a,b)+'\nthis.refreshTest=refresh;',sandbox);
 const original=sandbox.refreshTest();
 assert.equal(requests.length,2);
 assert.equal(await Promise.race([Promise.resolve(requests.length),original]),2);
 sandbox.refreshTest();assert.equal(requests.length,2,'same visible refresh is coalesced');
 visible=false;callbacks['hs:portfolio-hidden']();
 assert.ok(requests.every(r=>r.signal.aborted));
 visible=true;callbacks['hs:portfolio-visible']();
 const response=(data)=>({ok:true,json:async()=>{decodes++;return data;}});
 requests[0].resolve(response({generation:1}));
 requests[1].resolve(response({generation:1}));
 await original;await new Promise(setImmediate);
 assert.equal(decodes,0);assert.equal(validations,0);assert.equal(events.length,0);
 assert.equal(requests.length,4,'re-entry starts a fresh read');
 const final=sandbox.refreshTest();
 requests[2].resolve(response({generation:2}));
 requests[3].resolve(response({generation:2}));
 await final;await new Promise(setImmediate);
 assert.equal(decodes,2);assert.equal(sandbox.cache.generation,2);assert.equal(sandbox.c4.generation,2);
 assert.equal(validations,2);assert.ok(renders>0);
 console.log('PASS portfolio leaves cancel transport; stale bodies are not decoded; re-entry refreshes and preserves validation');
})().catch(error=>{console.error(error);process.exitCode=1;});
