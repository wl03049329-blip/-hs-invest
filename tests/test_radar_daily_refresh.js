"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),vm=require("node:vm"),crypto=require("node:crypto"),{Source}=require("../radar-history-source"),C=require("../radar-history-core");
const symbols=["0050","00662","00757","00830","00935","009815"],actualStatus=require("../data/radar-history/status-v1.json");
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==="object"?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const sign=p=>{delete p.content_sha256;p.content_sha256=crypto.createHash("sha256").update(JSON.stringify(canonical(p))).digest("hex");return p};
const response=p=>({ok:true,status:200,json:async()=>structuredClone(p)});
const disk=url=>{const f=url.split("?")[0];return fs.existsSync(f)?response(JSON.parse(fs.readFileSync(f))):{ok:false,status:404}};
let groups=0;
(async()=>{
for(const symbol of symbols){
 const file="data/radar-history/"+(symbol==="009815"?"tpex":"twse")+"/"+symbol+".json",current=JSON.parse(fs.readFileSync(file));
 // Pin the genuine 10/14–16 evidence window, not the rolling production end.
 current.price=current.price.filter(r=>r.date<="2026-10-16");current.requested_end="2026-10-16";current.action_coverage.end="2026-10-16";sign(current);
 assert.equal(current.requested_end,"2026-10-16");assert.deepEqual(current.price.slice(-3).map(r=>r.date),["2026-10-14","2026-10-15","2026-10-16"]);
 const old=structuredClone(current);old.price=old.price.filter(r=>r.date<="2026-10-13");old.requested_end="2026-10-13";old.action_coverage.end="2026-10-13";sign(old);
 let published=old,fail=false,clock=Date.parse("2026-10-16T12:00:00Z"),requests=0,providerCalls=0;
 const source=new Source({now:()=>new Date(clock),savedFetcher:disk,fetcher:()=>{providerCalls++;throw Error("NO_FINMIND_OR_INTRADAY")},archiveFetcher:async(url,options)=>{
  assert.equal(options.cache,"no-store");assert.ok(url.includes("verified_at="));
  if(url.startsWith("data/radar-history/status")){
   const m=structuredClone(actualStatus);m.expected_completed_bar="2026-10-16";m.next_expected_trading_day="2026-10-19";m.price_cutoff="2026-10-16";m.symbols[symbol]={...m.symbols[symbol],latest_verified_date:published.requested_end,archive_sha256:published.content_sha256,status:published.requested_end==="2026-10-16"?"CURRENT":"STALE",reason:published.requested_end==="2026-10-16"?null:"OFFICIAL_SOURCE_DELAY"};
   return response(sign(m));
  }
  requests++;if(fail)return{ok:false,status:503};return response(published);
 }});
 const seed=await source.savedSource(symbol),dates=[...new Set([...(seed?.price||[]),...current.price].map(r=>r.date))].sort();
 let result=await source.year(symbol,2026,dates,"2026-10-16");assert.equal(result.rows.at(-1).time,"2026-10-13");assert.equal(result.sourceWarning,"TWSE_ARCHIVE_STALE");
 published=current;await source.year(symbol,2026,dates,"2026-10-16");assert.equal(requests,1,"cache is bounded, not a request per chart year");
 source.blockedUntil=clock+3600000;source.invalidate(symbol);assert.equal(source.blockedUntil,clock+3600000,"refresh never bypasses FinMind quota cooldown");
 result=await source.year(symbol,2026,dates,"2026-10-16");assert.equal(result.rows.at(-1).time,"2026-10-16");assert.equal(result.sourceWarning,null);
 assert.equal(result.expectedCompleted,"2026-10-16");assert.deepEqual(result.rows.slice(-3).map(r=>[r.time,r.close,r.volume]),current.price.slice(-3).map(r=>[r.date,r.close,r.Trading_Volume]));
 result=await source.year(symbol,2026,dates,"2026-10-15");assert.equal(result.rows.at(-1).time,"2026-10-15","18:00 view cutoff remains enforced independently");
 result=await source.year(symbol,2026,dates,"2026-10-18");assert.equal(result.expectedCompleted,"2026-10-16","weekend must not invent an expected trading bar");assert.equal(result.sourceWarning,null);
 result=await source.year(symbol,2026,dates,"2026-10-19");assert.equal(result.expectedCompleted,"2026-10-19");assert.equal(result.sourceWarning,"TWSE_ARCHIVE_STALE");
 published=old;source.invalidate(symbol);result=await source.year(symbol,2026,dates,"2026-10-16");assert.equal(result.rows.at(-1).time,"2026-10-16");assert.equal(result.sourceWarning,"VERIFIED_ARCHIVE_ROLLBACK");
 published=structuredClone(current);published.price.at(-4).Trading_Volume+=1;sign(published);source.invalidate(symbol);result=await source.year(symbol,2026,dates,"2026-10-16");assert.equal(result.sourceWarning,"VERIFIED_ARCHIVE_HISTORY_CONFLICT");
 published=structuredClone(current);published.content_sha256="bad";source.invalidate(symbol);result=await source.year(symbol,2026,dates,"2026-10-16");assert.equal(result.rows.at(-1).time,"2026-10-16");assert.equal(result.sourceWarning,"TWSE_ARCHIVE_INVALID");
 fail=true;source.invalidate(symbol);result=await source.year(symbol,2026,dates,"2026-10-16");assert.equal(result.sourceWarning,"TWSE_ARCHIVE_UNAVAILABLE");assert.equal(result.rows.at(-1).time,"2026-10-16");
 fail=false;published=current;const before=requests;clock+=300001;result=await source.year(symbol,2026,dates,"2026-10-16");assert.ok(requests>before);assert.equal(result.sourceWarning,null);assert.equal(providerCalls,0);
 console.log("PASS "+symbol+" refresh/TTL/failure retention/conflict/holiday/cutoff/raw OHLC and shares");groups++;
}
const text=fs.readFileSync("radar-history-view.js","utf8"),start=text.indexOf("function cutoff("),end=text.indexOf("\nfunction unmount",start),context={Intl,Date};vm.createContext(context);vm.runInContext(text.slice(start,end)+";this.cutoff=cutoff;",context);
assert.equal(context.cutoff(new Date("2026-10-16T09:59:59Z")),"2026-10-15");assert.equal(context.cutoff(new Date("2026-10-16T10:00:00Z")),"2026-10-16");
assert.match(text,/source\.invalidate\?\.\(symbol\)/);assert.match(text,/最新已驗證股價/);assert.match(text,/source\.priceCutoff!==s\.cutoff/);
const scoreBytes=fs.readFileSync("finalized-core-score-snapshots-v1.json"),P=require("../final-core-production"),artifact=JSON.parse(scoreBytes);
for(const symbol of symbols){
 const scores=C.scores(artifact,symbol,P,()=>true);
 for(const row of scores.rows)assert.equal(row.value,artifact.snapshots.find(s=>s.date===row.time).rows.find(r=>r.symbol===symbol).final_core_score);
 if(symbol==="009815")assert.equal(scores.rows.length,0);
}
assert.deepEqual(fs.readFileSync("finalized-core-score-snapshots-v1.json"),scoreBytes);
console.log("PASS Taipei 18:00 cutoff, refresh wiring, immutable C4 and WAIT_NATIVE");groups++;
console.log("Daily refresh: "+groups+"/"+groups+" groups PASS");
})().catch(e=>{console.error(e);process.exitCode=1});
