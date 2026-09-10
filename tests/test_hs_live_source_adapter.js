"use strict";

const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const adapter=require("../hs-live-source-adapter.js");
const resolver=require("../canonical-score-resolver.js");
const root=path.resolve(__dirname,"..");
const symbols=["0050","00662","00757","00830","00935"],date="2026-09-10",scoreVersion="FINAL_CORE_WEIGHT_V1",now=new Date("2026-09-10T02:07:00Z");

function payload(overrides={}){
  const tickers=Object.fromEntries(symbols.map((symbol,index)=>[symbol,{score:40.25+index,display_score:40+index,delta_vs_official:index/10,quote_as_of:`${date}T10:05:00+08:00`,freshness:index===1?"DELAYED":"FRESH",quote_source:index===1?"FUGLE_LAST_TRADE":"MIS_Z",status:"AVAILABLE"}]));
  tickers["009815"]={score:null,display_score:null,delta_vs_official:null,quote_as_of:null,freshness:"WAIT_NATIVE",quote_source:null,status:"WAIT_NATIVE"};
  return{schema_version:1,status:"AVAILABLE",market_state:"OPEN",trading_date:date,as_of:`${date}T10:05:00+08:00`,calculated_at:`${date}T10:05:05+08:00`,last_success_at:`${date}T10:05:05+08:00`,completeness:"5/5",diagnostic_reason:null,c4_version:scoreVersion,tickers,...overrides};
}

assert.equal(adapter.selectedSource({globalObject:{},documentObject:null}),"legacy");
assert.equal(adapter.selectedSource({globalObject:{HS_LIVE_SOURCE:"railway"},documentObject:null}),"railway");
console.log("A PASS: frontend source switch defaults to legacy and accepts explicit railway");

let result=adapter.railwayToCanonical(payload(),{targetDate:date,scoreVersion,symbols,now});
assert.equal(result.status,"AVAILABLE");
assert.equal(result.snapshots.length,1);
assert.equal(result.snapshots[0].items["00662"].freshness,"DELAYED");
assert.equal(result.snapshots[0].items["00662"].quote_source,"FUGLE_LAST_TRADE");
const liveView=resolver.buildDualTrackView({finalizedArtifact:{schema_version:1,core_score_version:scoreVersion,snapshots:[]},intradaySnapshots:result.snapshots,targetDate:date,scoreVersion,symbols,now,tradingDayStatus:"TRADING_DAY",maxAgeMinutes:10});
assert.equal(liveView.items["00662"].live.display_eligible,true);
assert.equal(liveView.items["00662"].live.freshness,"DELAYED");
console.log("B PASS: Railway AVAILABLE converts to one complete canonical-shaped LIVE projection");

result=adapter.railwayToCanonical(payload({status:"UNAVAILABLE",completeness:"0/5",diagnostic_reason:"INCOMPLETE_REQUIRED_QUOTES"}),{targetDate:date,scoreVersion,symbols,now});
assert.equal(result.status,"UNAVAILABLE");
assert.deepEqual(result.snapshots,[]);
console.log("C PASS: Railway UNAVAILABLE yields no live snapshot");

result=adapter.railwayToCanonical(payload({tickers:{...payload().tickers,"00830":{...payload().tickers["00830"],quote_as_of:`${date}T09:50:00+08:00`}}}),{targetDate:date,scoreVersion,symbols,now});
assert.equal(result.status,"UNAVAILABLE");
assert.deepEqual(result.snapshots,[]);
const html=fs.readFileSync(path.join(root,"index.html"),"utf8");
assert.match(html,/<meta name="hs-live-source" content="legacy"/);
assert.match(html,/liveCanonicalCoreSnapshots=\[\];[\s\S]*loadRailway/);
assert.doesNotMatch(html,/loadRailway[\s\S]{0,500}(?:intraday-core-snapshots-v1|latestCanonicalCoreSnapshot)/);
console.log("D PASS: stale Railway data fails closed and selected Railway path cannot retain/fallback to legacy snapshots");

const protectedFiles=["finalized-core-score-snapshots-v1.json","forward-shadow-ledger-v1.json","intraday-core-snapshots-v1.json"].filter(name=>fs.existsSync(path.join(root,name)));
assert.ok(protectedFiles.length>0);
assert.doesNotMatch(fs.readFileSync(path.join(root,"hs-live-source-adapter.js"),"utf8"),/writeFile|localStorage\.setItem|appendForward|FINALIZED_CLOSE/);
console.log("E PASS: frontend adapter is read-only and has no protected-artifact mutation path");
