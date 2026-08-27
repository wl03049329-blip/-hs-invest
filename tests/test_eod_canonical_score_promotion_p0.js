"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),resolver=require("../canonical-score-resolver.js");
const html=fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8"),version="FINAL_CORE_WEIGHT_V1",symbols=["0050","00662","00757","00830","00935"];
const factors=score=>({weekly_j:{raw:20,score,weight:30,contribution:score*.30},dd52:{raw:-20,score,weight:55,contribution:score*.55},crash:{raw:-6,score,weight:15,contribution:score*.15}});
const finalized=(date,score=42,ready=true)=>({date,snapshot_type:"FINALIZED_CLOSE",finalized:ready,finalized_at:`${date}T13:30:00+08:00`,source:{data_as_of:`${date}T13:30:00+08:00`},rows:symbols.map((symbol,index)=>({symbol,final_core_score:symbol==="00830"?score:10+index,tier:"一般持有",core_score_version:version,data_as_of:`${date}T13:30:00+08:00`,factors:factors(20)}))});
const intraday=(date,score=53,slot="13:30")=>({schema_version:1,snapshot_type:"INTRADAY_CORE",status:"SUCCESS",trading_date:date,slot,items:Object.fromEntries(symbols.map((symbol,index)=>[symbol,{status:"SUCCESS",score:symbol==="00830"?score:10+index,display_score:symbol==="00830"?score:10+index,score_version:version,market_as_of:`${date}T${slot}:00+08:00`}]))});
const resolve=(finals,intradays,target="2026-08-27")=>resolver.resolve({finalizedArtifact:{schema_version:1,core_score_version:version,snapshots:finals},intradaySnapshots:intradays,targetDate:target,scoreVersion:version,symbols:new Set(symbols)});

let current=resolve([finalized("2026-08-26",53),finalized("2026-08-27",42)],[intraday("2026-08-27",53)]);
assert.equal(current.source_status,"FINALIZED_EOD");assert.equal(current.items["00830"].display_score,42);assert.equal(current.trading_date,"2026-08-27");
assert.equal(current.items["00830"].core_factors.weeklyJ.contribution,6);assert.equal(current.items["00830"].core_factors.dd52.contribution,11);assert.equal(current.items["00830"].core_factors.crash.contribution,3);
for(const symbol of symbols)assert.equal(current.items[symbol].display_score,Math.floor(Number(finalized("2026-08-27",42).rows.find(row=>row.symbol===symbol).final_core_score)),`${symbol} cross-component canonical equality`);
console.log("PASS same-day finalized EOD wins for homepage/radar/rank/decision/latest trend input");

current=resolve([finalized("2026-08-26",53)],[intraday("2026-08-27",53)]);assert.equal(current.source_status,"INTRADAY_CANONICAL");assert.equal(current.items["00830"].display_score,53);
console.log("PASS same-day valid intraday wins when finalized EOD is absent");

current=resolve([finalized("2026-08-27",42,false)],[intraday("2026-08-27",53)]);assert.equal(current.source_status,"INTRADAY_CANONICAL");assert.equal(current.items["00830"].display_score,53);
console.log("PASS calculated but non-finalized EOD cannot be promoted");

current=resolve([finalized("2026-08-27",42)],[intraday("2026-08-26",53)]);assert.equal(current.source_status,"FINALIZED_EOD");assert.equal(current.items["00830"].display_score,42);
console.log("PASS stale previous-day intraday cannot override today's finalized EOD");

const reloadA=resolve([finalized("2026-08-27",42)],[intraday("2026-08-26",53)]),reloadB=resolve([finalized("2026-08-27",42)],[intraday("2026-08-26",53)]);assert.deepEqual(reloadA,reloadB);
assert.match(html,/function currentCanonicalCoreSnapshot/);assert.match(html,/const snapshotForRender=currentCanonicalCoreSnapshot\(taipeiToday\(\)\)/);assert.match(html,/const canonicalForHome=currentCanonicalCoreSnapshot\(taipeiToday\(\)\)/);assert.doesNotMatch(html,/canonicalForHome=liveCanonicalCoreSnapshot\|\|latestCanonicalCoreSnapshot/);
assert.match(html,/function canonicalScoreProductionInvariant/);assert.match(html,/latestTrend\.tradingDate===snapshot\.trading_date/);assert.match(html,/!canonicalScoreProductionInvariant\(snapshot\)/);
console.log("PASS reload/localStorage independence and both render paths share one resolver");
