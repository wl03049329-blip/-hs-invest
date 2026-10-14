'use strict';
const assert=require('node:assert/strict'),C=require('../radar-history-core'),P=require('../final-core-production'),fs=require('node:fs');
const dates=['2025-12-31','2026-01-02','2026-01-05','2026-01-06'];
const snapshots=dates.filter((_,i)=>i!==1).map((date,i)=>({date,finalized:true,snapshot_type:'FINALIZED_CLOSE',source:{status:'official_closing_data',provider:'TEST_ONLY'},rows:[{symbol:'0050',data_as_of:date+'T13:30:00+08:00',core_score_version:P.LONG_TERM_CORE_SCORE_VERSION,final_core_score:10+i,factors:{weekly_j:{raw:-40,weight:30,contribution:7.125},dd52:{raw:-8,weight:55,contribution:2.875},crash:{raw:0,weight:15,contribution:0}}}]}));
const artifact={schema_version:1,core_score_version:P.LONG_TERM_CORE_SCORE_VERSION,snapshots};
const before=JSON.stringify(artifact),score=C.scores(artifact,'0050',P,()=>true).rows;
assert.equal(JSON.stringify(artifact),before);
assert.equal(score[0].factors[0].contribution,7.125,'read saved contribution, never raw times weight');
assert.equal(score[0].factors[2].contribution,0,'real zero survives');
assert.equal(score[1].previousDate,'2025-12-31');
assert.equal(score[1].previousValue,10);assert.equal(score[1].delta,1);
assert.equal(score[0].previousValue,null);
const bad=structuredClone(artifact);delete bad.snapshots[0].rows[0].factors;
assert.ok(C.scores(bad,'0050',P,()=>true).rows[0].factors.every(f=>f.raw===null&&f.contribution===null&&f.weight===null));
for(const v of [null,undefined,'0',NaN,Infinity]){
  const a=structuredClone(artifact);a.snapshots[0].rows[0].factors.weekly_j.contribution=v;
  assert.equal(C.scores(a,'0050',P,()=>true).rows[0].factors[0].contribution,null);
}
const incompatible=structuredClone(artifact);incompatible.snapshots[0].rows[0].core_score_version='other';
assert.equal(C.scores(incompatible,'0050',P,()=>true).rows[0].previousDate,null);
const price=dates.map((time,i)=>({time,close:100+i,open:100+i,high:101+i,low:99+i}));
const axis=C.selectionDates(score,price);
assert.deepEqual(axis,dates,'price-only session not skipped; no holiday invented');
assert.equal(C.adjacent(axis,dates[0],-1),null);assert.equal(C.adjacent(axis,dates[3],1),null);
assert.equal(C.adjacent(axis,dates[0],1),'2026-01-02');
const gap=C.detail(dates[1],dates,score,price,[]);
assert.equal(gap.score,null);assert.equal(gap.price.close,101);
assert.equal(gap.previousPriceDate,'2025-12-31');assert.equal(gap.change,1);assert.equal(gap.returnPct,1);
const noPrice=C.detail(dates[2],dates,score,price.filter(p=>p.time!==dates[2]),[]);
assert.equal(noPrice.price,null);assert.equal(noPrice.change,null);
const next=C.detail(dates[3],dates,score,price.filter(p=>p.time!==dates[2]),[]);
assert.equal(next.previousPriceDate,'2026-01-02');assert.equal(next.change,2);
assert.deepEqual(C.segments(dates,score).map(s=>s.length),[1,2]);
const range={from:20.25,to:39.25};
assert.equal(C.revealRange(range,25,100),range,'in-range selection must not move viewport');
for(const index of [0,20,40,99]){
  const r=C.revealRange(range,index,100);assert.equal(r.to-r.from,19);
  assert.ok(r.from<=index&&r.to>=index);
  assert.equal(index<range.from?r.from:r.to,index,'minimum translation to edge');
}
assert.equal(C.revealRange(range,-1,100),range);
assert.equal(C.revealRange({from:2.27e-13,to:1812},0,1813).from,2.27e-13,'floating boundary does not jitter');
const real=require('../finalized-core-score-snapshots-v1.json');
let checked=0;
for(const symbol of ['0050','00662','00757','00830','00935']){
  for(const row of C.scores(real,symbol,P,()=>true).rows){
    const raw=real.snapshots.find(s=>s.date===row.time).rows.find(r=>r.symbol===symbol);
    assert.equal(row.value,raw.final_core_score);assert.equal(row.tier,P.labelFor(raw.final_core_score).label);
    for(const f of row.factors)for(const k of ['raw','weight','contribution'])assert.equal(f[k],raw.factors?.[f.key]?.[k]??null);
    checked++;
  }
}
assert.equal(C.scores(real,'009815',P,()=>true).rows.length,0);
console.log('PASS selection, gaps, previous records, saved factors, minimal pan, cross-year and '+checked+' real finalized rows');
