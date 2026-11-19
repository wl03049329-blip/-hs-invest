'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),L=require('../lradar-local'),R=require('../lradar-core');
test('unknown history, rights flags and corrupted base never pass',async()=>{
 await assert.rejects(L.verify({schema:'HS_00631L_PERSONAL_BACKUP_V1',base:{scope:'PERSONAL_NONCOMMERCIAL_ONLY',rows:[]},extension:[]}),/PRIVATE_BASE_HASH_OR_RIGHTS/);
 await assert.rejects(L.verify({schema:'WRONG'}),/PRIVATE_SCHEMA/);
 await assert.rejects(L.importText('x'.repeat(2_000_001)),/PRIVATE_FILE_SIZE/);
});
test('personal storage cannot upload or read financial storage',()=>{
 const src=fs.readFileSync('lradar-local.js','utf8');for(const call of ['.sendBeacon(','.send(','localStorage.','sessionStorage.','hsPersonal','Ledger','Authorization'])assert.ok(!src.includes(call));
 assert.equal(src.match(/fetch\(/g)?.length,1);assert.ok(src.includes("method:'GET',mode:'cors',credentials:'omit'"));assert.ok(src.includes("redirect:'error'"));
 assert.equal(L.DB,'hs.research.00631l.personal.v1');
 assert.equal(R.thresholdVersion,'P80_P95_CLOSE_FIXED_20201231_V1');
 assert.ok(fs.readFileSync('lc4-research.js','utf8').includes('&&!(d.personal&&personalError)'));
});
test('actual private bootstrap, split, all metrics and daily join',{skip:!process.env.HS_PRIVATE_INPUT},async()=>{
 const p=await L.verify(JSON.parse(fs.readFileSync(process.env.HS_PRIVATE_INPUT,'utf8'))),all=L.rows(p),d=L.summary(p,240);
 assert.equal(all.length,2935);assert.equal(all[0][0],'2014-10-31');assert.equal(d.asof,'2026-11-19');assert.equal(d.close,24.57);
 assert.equal(new Map(all).get('2026-03-24'),443.15/22);assert.equal(new Map(all).get('2026-03-31'),19.26);
 assert.ok(all.every(r=>r[0]<'2026-03-25'||r[0]>='2026-03-31'));
 for(const n of [3,5,10])assert.equal(d.recent[n],100*(all.at(-1)[1]/all.at(-1-n)[1]-1));
 for(const n of R.periods)assert.ok(L.summary(p,n).depth);for(const v of Object.values(d.performance))assert.ok(Number.isFinite(v.change));
 const source={schema:'HS_00631L_OPEN_CLOSE_V1',symbol:'00631L',price_basis:'TWSE_RAW_CLOSE',trading_date:'2026-11-20',close_twd:'25.00',comparison_twd:'24.57',captured_at:'2026-11-20T12:00:00Z',observed_sessions:['2026-11-19','2026-11-20'],source:'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',source_attribution:'臺灣證券交易所',dataset:'https://data.gov.tw/dataset/11549',license:'https://data.gov.tw/license',session_source:'https://openapi.twse.com.tw/v1/exchangeReport/FMTQIK',session_dataset:'https://data.gov.tw/dataset/11672',response_sha256:'a'.repeat(64),session_sha256:'b'.repeat(64)};
 // Synthetic next-day price is TEST ONLY, never an artifact or live result.
 const merged=L.merge(p,[source]);await L.verify(merged,'2026-11-20',Date.parse('2026-11-20T13:00:00Z'));
 assert.throws(()=>L.reconcile(merged,[],null),/NEEDS_PUBLIC_CHECK/);
 L.reconcile(merged,[source],null);L.reconcile(merged,[],merged);
 assert.throws(()=>L.reconcile(merged,[{...source,close_twd:'25.01'}],null),/NEEDS_PUBLIC_CHECK/);
 assert.equal(L.merge(merged,[source]).extension.length,1);
 assert.throws(()=>L.merge(p,[{...source,comparison_twd:'1.00'}]),/PRICE/);
 assert.throws(()=>L.merge(p,[{...source,observed_sessions:['2026-11-18','2026-11-20']}]),/GAP/);
 assert.throws(()=>L.merge(p,[{...source,trading_date:'2026-11-19',close_twd:'1.00'}]),/OVERLAP/);
 const bad=structuredClone(p);bad.base.rows[0][1]*=22;await assert.rejects(L.verify(bad),/HASH/);
});
