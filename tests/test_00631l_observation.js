'use strict';
const assert=require('node:assert/strict'),R=require('../lradar-core');
const pointer=require('../data/lc4-research/latest.json'),seed=require('../data/lc4-research/'+pointer.path).history.histories['00631L'];
const make=rows=>({schema:'HS_00631L_OBSERVATION_V1',asof:rows.at(-1)[0],threshold_version:'P80_P95_FIXED_20201231_V1',training_end:'2020-12-31',history_sha256:'a'.repeat(64),verified_at:'2026-11-06T12:00:00Z',evidence:[0,1,2,3].map(()=>({url:'https://www.twse.com.tw/test',sha256:'b'.repeat(64)})),thresholds:Object.fromEntries(['speed',...R.periods].map(k=>[k,[5,10,500]])),rows});
const a=R.verify(make(seed.map(r=>[r.date,r.close,r.high,r.low]))),rows=a.rows;
assert.equal(R.monthsBack('2024-05-31',3),'2024-02-29');
assert.equal(R.monthsBack('2025-05-31',3),'2025-02-28');
const r=R.summary(a);
assert.equal(r.recent[5],100*(rows.at(-1)[1]/rows.at(-6)[1]-1));
assert.equal(r.returns[0].date,'2026-10-30');
assert.equal(r.returns[3].date,rows.findLast(r=>r[0]<='2025-12-31')[0]);
const fix=structuredClone(a);fix.rows.at(-1)[2]=fix.rows.at(-2)[2]=10000;
assert.equal(R.summary(fix,20).peaks[20].age,0);
for(const n of R.periods){const d=R.summary(a,n);assert.equal(d.depth.decline,-d.peaks[n].change);assert.equal(d.level,Math.max(d.speed.level,d.depth.level));}
const mismatch=structuredClone(a);mismatch.rows.at(-1)[3]=Number.NaN;assert.throws(()=>R.verify(mismatch));
const wrongOrder=structuredClone(a);wrongOrder.rows.at(-1)[0]=wrongOrder.rows.at(-2)[0];assert.throws(()=>R.verify(wrongOrder));
const slow=structuredClone(a);slow.thresholds.speed=[80,99,600];assert.ok(R.historical(slow,240,'speed').every(x=>x.n===0&&x.positive===null));
for(const p of R.periods){const stats=R.historical(a,p,'depth');assert.deepEqual(stats.map(x=>x.h),[5,10,20]);assert.ok(stats.every(x=>x.n>=10||x.positive===null));}
console.log('PASS 00631L dates, five periods, frozen gates, most recent peak, invalid data and sample suppression');
