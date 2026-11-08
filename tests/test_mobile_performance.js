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
