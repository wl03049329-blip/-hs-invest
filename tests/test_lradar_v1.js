"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs");
const core=require("../lradar-core"),research=require("../scripts/research_lradar_v1.cjs");
const bundle=research.read(),results=research.run(bundle),published=require("../research/hs_lradar/results-v1.json");
assert.deepEqual(JSON.parse(JSON.stringify(results)),published);
assert.equal(results.decision,"NO-GO");
for(const now of ["2026-11-13T08:59:00+08:00","2026-11-13T09:10:00+08:00","2026-11-13T14:00:00+08:00","2026-11-14T10:00:00+08:00"]){
 const s=core.unavailable({now,price:100,source_timestamp:"2026-11-12T13:30:00+08:00",entry_authorized:true});
 assert.equal(s.research_state,"DATA_UNAVAILABLE");assert.equal(s.market_date,null);assert.equal(s.price_asof,null);
 assert.equal(s.source_timestamp,null);assert.equal(s.evaluated_at,null);assert.equal(s.entry_authorized,false);assert.equal(s.financial_writer,false);assert.equal(s.research_only,true);
}
const rows=bundle.history.histories["00631L"];
assert.throws(()=>research.checkSplit(rows.map(r=>r.date==="2026-03-24"?{...r,close:r.close/22}:r)),/SPLIT_OR_HALT/);
assert.throws(()=>research.checkSplit([...rows,{date:"2026-03-26"}]),/SPLIT_OR_HALT/);
assert.throws(()=>core.describe(rows.slice(0,5)),/UNVERIFIED/);
assert.throws(()=>core.describe([...rows.slice(0,-1),{...rows.at(-1),close:0}]),/UNVERIFIED/);
assert.throws(()=>core.describe([...rows,rows.at(-1)]),/UNVERIFIED/);
assert.throws(()=>core.describe([{...rows[0],date:"2014-02-30"},...rows.slice(1)]),/UNVERIFIED/);
assert.ok(results.events.every((e,i)=>!i||e.i-results.events[i-1].i>=12));
for(const [year,t] of Object.entries(results.thresholds))assert.ok(t.cutoff<year+"-01-01");
for(const h of [1,3,5,10]){const p=results.results[h];assert.equal(p.mature+p.pending,results.events.length);assert.equal(p.byCost[0.005].confirmed.n,14);assert.ok(p.byCost[0.005].confirmed.ci.mean[0]<0);}
const revised=structuredClone(bundle);
for(const r of revised.history.histories["00631L"])if(r.date>"2026-04-01")for(const k of ["open","high","low","close"])r[k]*=1.1;
assert.deepEqual(research.run(revised).thresholds,results.thresholds);
const html=fs.readFileSync("index.html","utf8"),coreSource=fs.readFileSync("lradar-core.js","utf8");
assert.match(html,/class="lradar-home" data-state="DATA_UNAVAILABLE"/);
assert.doesNotMatch(coreSource,/localStorage|indexedDB|FINAL_CORE_WEIGHT|fetch\(/);
console.log("PASS fixed output, chronological calibration, split and no authorization across market times");
