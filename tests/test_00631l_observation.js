'use strict';
const assert=require('node:assert/strict'),R=require('../lradar-core');
const pointer=require('../data/lc4-research/latest.json'),seed=require('../data/lc4-research/'+pointer.path).history.histories['00631L'];
const make=rows=>({schema:'HS_00631L_CLOSE_OBSERVATION_V1',asof:rows.at(-1)[0],threshold_version:'P80_P95_CLOSE_FIXED_20201231_V1',training_end:'2020-12-31',history_sha256:'a'.repeat(64),verified_at:'2026-11-06T12:00:00Z',evidence:[0,1,2,3].map(()=>({url:'https://www.twse.com.tw/test',sha256:'b'.repeat(64)})),thresholds:Object.fromEntries(['speed',...R.periods].map(k=>[k,[5,10,500]])),rows});
const a=R.verify(make(seed.map(r=>[r.date,r.close]))),rows=a.rows;
assert.equal(R.monthsBack('2024-05-31',3),'2024-02-29');
assert.equal(R.monthsBack('2025-05-31',3),'2025-02-28');
const r=R.summary(a);
assert.equal(r.recent[5],100*(rows.at(-1)[1]/rows.at(-6)[1]-1));
assert.equal(r.returns[0].date,'2026-10-30');
assert.equal(r.returns[3].date,rows.findLast(r=>r[0]<='2025-12-31')[0]);
const fix=structuredClone(a);fix.rows.at(-1)[1]=fix.rows.at(-2)[1]=10000;
assert.equal(R.summary(fix,20).peaks[20].age,0);
for(const n of R.periods){const d=R.summary(a,n);assert.equal(d.depth.decline,-d.peaks[n].change);assert.equal(d.level,Math.max(d.speed.level,d.depth.level));}
const mismatch=structuredClone(a);mismatch.rows.at(-1)[1]=Number.NaN;assert.throws(()=>R.verify(mismatch));
const oldSchema=structuredClone(a);oldSchema.threshold_version='P80_P95_FIXED_20201231_V1';assert.throws(()=>R.verify(oldSchema));
const oldRow=structuredClone(a);oldRow.rows.at(-1).push(30,24);assert.throws(()=>R.verify(oldRow));
const flat=Array.from({length:250},(_,i)=>[new Date(Date.UTC(2021,0,i+1)).toISOString().slice(0,10),100]);
flat[220][1]=80;flat[221][1]=70;flat[225][1]=90;
const event=R.historical(make(flat),240,'speed')[0];
assert.equal(event.n,1);assert.equal(event.mean,100*(90/80-1));assert.equal(event.worst,100*(70/80-1));
const wrongOrder=structuredClone(a);wrongOrder.rows.at(-1)[0]=wrongOrder.rows.at(-2)[0];assert.throws(()=>R.verify(wrongOrder));
const slow=structuredClone(a);slow.thresholds.speed=[80,99,600];assert.ok(R.historical(slow,240,'speed').every(x=>x.n===0&&x.positive===null));
for(const p of R.periods){const stats=R.historical(a,p,'depth');assert.deepEqual(stats.map(x=>x.h),[5,10,20]);assert.ok(stats.every(x=>x.n>=10||x.positive===null));}
const dates=['2026-11-09','2026-11-10','2026-11-11','2026-11-12','2026-11-13','2026-11-16'];
const rec=dates.map((trading_date,i)=>({schema:'HS_00631L_OPEN_CLOSE_V1',symbol:'00631L',price_basis:'TWSE_RAW_CLOSE',
 trading_date,close_twd:(30-i*.1).toFixed(2),comparison_twd:i?(30-(i-1)*.1).toFixed(2):null,
 captured_at:trading_date+'T12:00:00Z',observed_sessions:dates.slice(0,i+1),
 source:'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',source_attribution:'臺灣證券交易所',
 dataset:'https://data.gov.tw/dataset/11549',license:'https://data.gov.tw/license',
 session_source:'https://openapi.twse.com.tw/v1/exchangeReport/FMTQIK',session_dataset:'https://data.gov.tw/dataset/11672',
 response_sha256:'a'.repeat(64),session_sha256:'b'.repeat(64)}));
const makeIndex=records=>({schema:'HS_00631L_OPEN_INDEX_V1',records});
const checked=R.verifyIndex(makeIndex(rec),'2026-11-16',Date.parse('2026-11-17'));
assert.equal(R.archiveSummary([],240).level,null);
assert.equal(R.archiveSummary(checked.slice(1),240).speed,null);
assert.ok(R.archiveSummary(checked,240).speed);
assert.equal(R.archiveSummary(checked,240).level,null);
assert.equal(R.archiveSummary(checked.filter((_,i)=>i!==3),240).speed,null);
assert.equal(R.archiveSummary([...checked.slice(0,5),{...checked[5],comparison_twd:'99.99'}],240).speed,null);
assert.throws(()=>R.verifyIndex(makeIndex([{...rec[0],license:'UNVERIFIED'}]),'2026-11-16',Date.parse('2026-11-17')));
assert.throws(()=>R.verifyIndex(makeIndex(rec),'2026-11-15',Date.parse('2026-11-17')));
module.exports={rec,makeIndex};
console.log('PASS 00631L dates, five periods, frozen gates, most recent peak, invalid data and sample suppression');
