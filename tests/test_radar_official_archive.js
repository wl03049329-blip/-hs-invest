'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto');
const {Source}=require('../radar-history-source');
const response=p=>({ok:true,status:200,json:async()=>structuredClone(p)});
const read=async path=>fs.existsSync(path)?response(JSON.parse(fs.readFileSync(path))):{status:404};
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const sign=p=>{delete p.content_sha256;p.content_sha256=crypto.createHash('sha256').update(JSON.stringify(canonical(p))).digest('hex');return p;};
(async()=>{
  let calls=0;
  for(const symbol of ['0050','00662','00830','00935']){
    const a=new Source({savedFetcher:read,archiveFetcher:read,fetcher:()=>{calls++;throw Error('NETWORK_DISABLED');}});
    const seed=JSON.parse(fs.readFileSync('research/c4_historical/source/'+symbol+'.json'));
    const cal=await a.savedSessions(symbol,[]),result=await a.year(symbol,2026,cal.dates,'2026-10-13');
    assert.equal(result.rows.at(-1).time,'2026-10-13');assert.equal(result.sourceWarning,null);
    assert.equal(result.rows.filter(r=>r.source==='TWSE/STOCK_DAY').length,14);
    assert.equal(result.rows.find(r=>r.time==='2026-09-18').source,'FinMind/TaiwanStockPrice');
    assert.equal(result.rows.find(r=>r.time==='2026-09-18').close,seed.price.at(-1).close);
    assert.equal(cal.observedOnly,true); // Not a fabricated official trading calendar.
    const stale=await a.year(symbol,2026,cal.dates,'2026-10-14');assert.equal(stale.sourceWarning,'TWSE_ARCHIVE_STALE');
  }
  assert.equal(calls,0);
  const otc=new Source({savedFetcher:read,archiveFetcher:read,fetcher:()=>{throw Error('NETWORK_DISABLED');}});
  const otcCalendar=await otc.savedSessions('009815',[]),otcResult=await otc.year('009815',2026,otcCalendar.dates,'2026-10-13');
  assert.equal(otcResult.rows.length,171);assert.equal(otcResult.rows.at(-1).time,'2026-10-13');
  assert.equal(otcResult.rows.at(-1).volume,1658941);assert.equal(otcResult.rows.at(-1).source,'TPEx/dailyQuotes');
  assert.equal(otcResult.rows.filter(r=>r.source==='TPEx/dailyQuotes').length,14);
  assert.equal(otcResult.rows.find(r=>r.time==='2026-09-18').source,'FinMind/TaiwanStockPrice');
  const otcArchive=await otc.archive('009815');
  for(const damage of [p=>p.action_checks.pop(),p=>p.action_checks[0].matches.push(['unreviewed']),p=>p.overlap.volume_differences.push({difference:1}),p=>p.provider='TWSE/STOCK_DAY']){
    const p=structuredClone(otcArchive);damage(p);sign(p);
    const bad=new Source({savedFetcher:read,archiveFetcher:async()=>response(p)});
    await assert.rejects(()=>bad.archive('009815'));
  }
  const official=JSON.parse(fs.readFileSync('finalized-core-score-snapshots-v1.json'));
  for(const symbol of ['0050','00662','00757','00830','00935']){
    const a=new Source({savedFetcher:read,archiveFetcher:read,fetcher:()=>{throw Error('NETWORK_DISABLED');}});
    const cal=await a.savedSessions(symbol,[]),result=await a.year(symbol,2026,cal.dates,'2026-10-13');
    // This archive contract covers the verified 10/13 release, while the live
    // FINALIZED artifact legitimately grows on later trading days.
    const formal=official.snapshots.filter(s=>s.date<='2026-10-13'&&s.finalized&&s.rows.some(r=>r.symbol===symbol&&typeof r.final_core_score==='number')).map(s=>s.date);
    assert.equal(formal.length,32);assert.equal(formal.filter(d=>result.rows.some(r=>r.time===d)).length,32);
    if(symbol==='00757'){
      const p=await a.archive(symbol);assert.equal(p.price.length,1906);assert.equal(p.price[0].date,'2018-12-06');assert.equal(p.evidence.length,95);
      assert.equal(p.dividends.length,0);assert.equal(p.action_evidence.length,9);
    }
  }
  const original=JSON.parse(fs.readFileSync('data/radar-history/twse/0050.json'));
  for(const mutate of [p=>p.price[0].close=null,p=>p.base_source_sha256='bad',p=>p.price.push(p.price[0]),p=>p.price_type='ADJUSTED',p=>p.dividends.push({date:'2026-10-01',amount:null}),p=>p.action_coverage.end='2026-09-18']){
    const p=structuredClone(original);mutate(p);sign(p);
    await assert.rejects(()=>new Source({savedFetcher:read,archiveFetcher:async()=>response(p)}).archive('0050'),/TWSE_/);
  }
  const changed=structuredClone(original);changed.price[0].close+=1;
  await assert.rejects(()=>new Source({savedFetcher:read,archiveFetcher:async()=>response(changed)}).archive('0050'),/TWSE_ARCHIVE_INVALID/);
  const noArchive=new Source({archiveFetcher:async()=>({status:404}),savedFetcher:read});assert.equal(await noArchive.archive('009815'),null,'a genuinely absent archive remains unavailable, never invented');
  console.log('PASS official raw extension, unchanged seed, provenance/hash/conflict fail-closed, stale and missing archive, no FinMind calls');
})().catch(e=>{console.error(e);process.exitCode=1;});
