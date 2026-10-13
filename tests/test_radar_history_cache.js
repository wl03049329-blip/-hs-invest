'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto');
const {Source}=require('../radar-history-source'),C=require('../radar-history-core');
const storage=()=>{const m=new Map();return{getItem:k=>m.get(k)||null,setItem:(k,v)=>m.set(k,v)};};
const stamp='2026-10-13T12:00:00Z',now=()=>new Date(stamp);
const row=(date,close=10)=>({date,stock_id:'0050',open:10,max:11,min:9,close,Trading_Volume:100});
const seed={symbol:'0050',provider:'FinMind',source_version:'FINMIND_AS_OF_ADJUSTED_OHLC_V1',requested_start:'2000-01-01',requested_end:'2026-09-18',fetched_at:'2026-09-18T18:10:00Z',price:[row('2025-10-13'),row('2026-09-18')],dividend:[]};
const response=data=>({ok:true,status:200,json:async()=>data});
const savedFetcher=async()=>response(structuredClone(seed));
(async()=>{
  let requests=[];
  const api=new Source({now,savedFetcher,fetcher:async url=>{const p=new URL(url).searchParams;requests.push(Object.fromEntries(p));return response({status:200,data:p.get('dataset')==='TaiwanStockPrice'?[row('2026-09-18'),row('2026-10-13')]:[]});}});
  const dates=['2025-10-13','2026-09-18','2026-10-13'];
  const old=await api.year('0050',2025,dates,'2026-10-13');
  assert.equal(requests.length,0);assert.equal(old.rows.length,1);assert.equal(old.rows[0].fetchedAt,seed.fetched_at);
  const latest=await api.year('0050',2026,dates,'2026-10-13');
  assert.equal(requests[0].start_date,'2026-09-18');assert.equal(latest.rows.length,2);assert.equal(latest.sourceWarning,null);
  console.log('PASS saved original history reused; only incremental overlap requested');
  const conflict=new Source({now,savedFetcher,fetcher:async()=>response({status:200,data:[row('2026-09-18',10.5),row('2026-10-13')]})});
  const rejected=await conflict.year('0050',2026,dates,'2026-10-13');
  assert.match(rejected.sourceWarning,/SOURCE_CONTINUITY_CONFLICT/);assert.deepEqual(rejected.rows.map(r=>r.time),['2026-09-18']);assert.equal(rejected.rows[0].close,10);
  console.log('PASS conflicting incremental history never overwrites or splices cached prices');
  for(const [tail,calendar,reason] of [[[row('2026-10-13')],dates,'SOURCE_CONTINUITY_ANCHOR_MISSING'],[[row('2026-09-18'),row('2026-10-13')],[...dates,'2026-10-12'],'SOURCE_CONTINUITY_GAP'],[[row('2026-09-18'),{...row('2026-10-13'),close:null}],dates,'SOURCE_INCREMENT_INVALID']]){
    const incomplete=new Source({now,savedFetcher,fetcher:async()=>response({status:200,data:tail})});
    const r=await incomplete.year('0050',2026,calendar,'2026-10-13');assert.equal(r.sourceWarning,reason);assert.deepEqual(r.rows.map(x=>x.time),['2026-09-18']);
  }
  console.log('PASS missing overlap, missing sessions and invalid incremental OHLC cannot extend saved history');
  const store=storage();let count=0;
  const opts={storage:store,now,fetcher:async()=>{count++;return response({status:200,data:[row('2025-10-13')]});}};
  const params={dataset:'TaiwanStockPrice',data_id:'0050',start_date:'2025-01-01',end_date:'2025-12-31'};
  await new Source(opts).query(params);await new Source(opts).query(params);assert.equal(count,1);
  assert.ok(!store.getItem('hsRadar.history.publicRawCache.v1').includes('Authorization'));
  console.log('PASS reload preserves bounded public raw cache without credentials');
  const blockedStore=storage();let blockedCount=0;
  const limited={storage:blockedStore,now,fetcher:async()=>{blockedCount++;return{ok:false,status:402};}};
  const blocked=new Source(limited);await assert.rejects(()=>blocked.query(params),/SOURCE_HTTP_402/);
  blocked.cache.clear();await assert.rejects(()=>blocked.query(params),/SOURCE_COOLDOWN/);
  await assert.rejects(()=>new Source(limited).query(params),/SOURCE_COOLDOWN/);assert.equal(blockedCount,1);
  console.log('PASS quota failure cannot be bypassed by retry or reload');
  const outage=new Source({now,savedFetcher,fetcher:async()=>({ok:false,status:402})});
  const partial=await outage.year('0050',2026,dates,'2026-10-13');
  assert.equal(partial.rows.length,1);assert.equal(partial.rows[0].time,'2026-09-18');assert.match(partial.sourceWarning,/402/);assert.equal(partial.dividendStatus,'UNAVAILABLE');
  console.log('PASS incomplete source retains old provenance, never marks current');
  const absent=new Source({now,savedFetcher:async()=>({ok:false,status:404}),fetcher:async()=>response({status:200,data:[]})});
  assert.equal((await absent.year('00757',2026,dates,'2026-10-13')).rows.length,0);
  console.log('PASS source lookup is symbol-generic; missing saved file is not a fake bar');
  const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
  for(const symbol of ['0050','00662','00830','00935','009815']){
    const p=JSON.parse(fs.readFileSync('research/c4_historical/source/'+symbol+'.json')),a=JSON.parse(fs.readFileSync('research/c4_historical/'+symbol+'.json'));
    assert.equal(crypto.createHash('sha256').update(JSON.stringify(canonical(p))).digest('hex'),a.metadata.provenance.source_ohlc_sha256);
    // Observed dates suffice for shape validation only, NOT proof of calendar completeness.
    const valid=C.prices(p.price,symbol,p.price.map(r=>r.date),p.requested_end,p.fetched_at);
    assert.equal(valid.invalid.length,0);assert.equal(valid.rows.length,p.price.length);
    if(symbol==='0050'){const expected=['2025-06-11','2025-06-12','2025-06-13','2025-06-16','2025-06-17'];assert.ok(expected.every(d=>!p.price.some(r=>r.date===d)));assert.equal(p.price.find(r=>r.date==='2025-06-10').close,188.65);assert.equal(p.price.find(r=>r.date==='2025-06-18').close,47.57);}
  }
  console.log('PASS five saved sources match pre-existing provenance hashes and raw OHLC shape; 0050 split gap retained');
  const malformed=new Source({now,savedFetcher:async()=>response({...seed,provider:'OTHER'})});
  await assert.rejects(()=>malformed.year('0050',2025,dates,'2026-10-13'),/SAVED_SOURCE_INVALID/);
  console.log('PASS unverified saved-provider schema fails closed');
  console.log('RESULT 9/9 cache/source groups PASS');
})().catch(e=>{console.error(e);process.exitCode=1;});
