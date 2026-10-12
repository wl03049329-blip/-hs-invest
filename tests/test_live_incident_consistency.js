"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const resolver = require("../canonical-score-resolver.js");
const adapter = require("../hs-live-source-adapter.js");
const decision = require("../hs-decision-layer-v1.js");
const symbols = ["0050", "00662", "00757", "00830", "00935"];
const version = "FINAL_CORE_WEIGHT_V1", date = "2026-10-12";
const now = new Date(`${date}T10:05:00+08:00`);
const finalized = day => ({date:day,snapshot_type:"FINALIZED_CLOSE",finalized:true,
  rows:symbols.map((symbol,index)=>({symbol,final_core_score:20+index+(day==="2026-10-08"?3:0),
    core_score_version:version,data_as_of:`${day}T13:30:00+08:00`,tier:"一般持有",factors:{}}))});
const history = {schema_version:1,core_score_version:version,snapshots:[finalized("2026-10-07"),finalized("2026-10-08")]};
const before = JSON.stringify(history);
const html = fs.readFileSync("index.html", "utf8");
const start = html.indexOf("function decisionCenterMarketLabel"), end = html.indexOf("function renderDecisionCenter",start);
const sandbox = {window:{HSDecisionLayerV1:decision,HSCanonicalScoreResolver:resolver},
  LONG_RADAR_SCORED_CODES:new Set(symbols),archivedIntradayCoreSnapshots:[],liveCanonicalCoreSnapshots:[],
  liveCoreSourceState:{source:"railway",status:"UNAVAILABLE",reason:"RAILWAY_HTTP_404"},
  finalizedCoreScoreHistoryArtifact:history,taipeiToday:()=>date,esc:String,
  homepageFinalDecision:()=>({label:"一般持有"}),currentFrontendLiveRenderState:()=>"API_UNAVAILABLE",
  officialC4HistoryViewModel:()=>new Map(symbols.map((symbol,index)=>[symbol,{rows:[{score:20+index},{score:23+index}]}]))};
vm.runInNewContext(html.slice(start,end),sandbox);
const longs=symbols.map(id=>({id,name:id}));
const officialRows=symbols.map((symbol,index)=>({symbol,score:23+index,displayScore:23+index,date:"2026-10-08",tier:"一般持有"}));
const view = (snapshots=[],time=now,tradingDayStatus="TRADING_DAY") => resolver.buildDualTrackView({
  finalizedArtifact:history,intradaySnapshots:snapshots,targetDate:date,scoreVersion:version,
  symbols,now:time,tradingDayStatus,maxAgeMinutes:10});
const unavailable = view();
assert.equal(unavailable.official_snapshot.trading_date,"2026-10-08","holiday/weekend must not invalidate the legitimate prior finalized baseline");
for(const row of sandbox.decisionCenterC4Rows(officialRows,longs,unavailable)){
  assert.equal(row.score,null);
  assert.equal(row.delta,null,"unavailable LIVE must not display an unrelated FINAL-to-FINAL delta");
  assert.equal(row.next,null,"no threshold decision without the selected verified score");
}
let cards=sandbox.decisionCenterC4Cards(officialRows,longs,unavailable);
assert.match(cards,/data-c4-source="UNAVAILABLE"/);
assert.doesNotMatch(cards,/data-c4-source="FINAL"/);
assert.match(cards,/HTTP 404/);
assert.match(cards,/已驗證正式 2026-10-08｜23\.0 分/);
assert.equal(sandbox.decisionCenterC4Rows(officialRows,longs,unavailable)[0].next,null,
  "independent EOD reference must not supply an invalid LIVE threshold");
console.log("PASS unavailable scores, deltas, thresholds, source labels and concrete outage reason stay consistent");

function payload(){return {status:"AVAILABLE",market_state:"OPEN",completeness:"5/5",c4_version:version,
  trading_date:date,as_of:`${date}T10:04:00+08:00`,tickers:{
    ...Object.fromEntries(symbols.map((symbol,index)=>[symbol,{status:"AVAILABLE",score:30.25+index,
      display_score:30+index,delta_vs_official:7.25,quote_as_of:`${date}T10:04:00+08:00`,freshness:"FRESH"}])),
    "009815":{status:"WAIT_NATIVE",freshness:"WAIT_NATIVE",score:null}}};}
const options={targetDate:date,scoreVersion:version,symbols,now};
for(const invalid of [null,undefined,"",false,NaN,Infinity]){
  for(const field of ["score","display_score"]){
    const p=payload();p.tickers["0050"][field]=invalid;
    assert.equal(adapter.railwayToCanonical(p,options).status,"UNAVAILABLE",`${field} ${String(invalid)} is not a verified score`);
  }
}
const good=adapter.railwayToCanonical(payload(),options);
assert.equal(good.status,"AVAILABLE");
let liveView=view(good.snapshots);
for(const row of sandbox.decisionCenterC4Rows(officialRows,longs,liveView)){
  assert.equal(row.useLive,true);
  assert.equal(row.delta,7.25);
  assert.ok(row.next);
}
assert.match(sandbox.decisionCenterC4Cards(officialRows,longs,liveView),/data-c4-source="LIVE"/);
console.log("PASS fresh complete 10/12 quotes use the unchanged 10/8 official baseline");

for(const mutate of [p=>{p.trading_date="2026-10-08"},p=>{p.completeness="4/5"},
  p=>{p.tickers["00830"].quote_as_of=`${date}T09:50:00+08:00`}]){
  const p=payload();mutate(p);const rejected=adapter.railwayToCanonical(p,options);
  assert.equal(rejected.status,"UNAVAILABLE");assert.equal(rejected.snapshots.length,0);
  for(const row of sandbox.decisionCenterC4Rows(officialRows,longs,view(rejected.snapshots))){assert.equal(row.score,null);assert.equal(row.delta,null);}
}
const missingDelta=payload();missingDelta.tickers["0050"].delta_vs_official=null;
assert.equal(adapter.railwayToCanonical(missingDelta,options).snapshots[0].items["0050"].delta_vs_previous_close,null);
for(const state of ["UNKNOWN","HOLIDAY"]){
  const v=view([],now,state);
  assert.equal(v.official_snapshot.trading_date,"2026-10-08");
  if(state==="UNKNOWN")for(const row of sandbox.decisionCenterC4Rows(officialRows,longs,v))assert.equal(row.delta,null);
}
const closed=view([],new Date(`${date}T15:00:00+08:00`));
for(const row of sandbox.decisionCenterC4Rows(officialRows,longs,closed)){
  assert.equal(row.useLive,false);assert.equal(row.score,23+symbols.indexOf(row.symbol));assert.equal(row.delta,3);
}
assert.equal(JSON.stringify(history),before,"no finalized score recomputation or mutation");
assert.match(sandbox.decisionCenterC4Cards(officialRows,longs,liveView),/data-c4-source="WAIT_NATIVE"/);
console.log("PASS source outage, stale/wrong-date/incomplete cache, holiday restoration, missing deltas and WAIT_NATIVE fail safely");
