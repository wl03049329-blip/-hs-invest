"use strict";

const assert=require("node:assert/strict");
const fs=require("node:fs");
const resolver=require("../canonical-score-resolver.js");

const version="FINAL_CORE_WEIGHT_V1";
const symbols=["0050","00662","00757","00830","00935"];
const targetDate="2026-09-07";
const openNow=new Date("2026-09-07T02:40:00Z"); // 10:40 Asia/Taipei

function finalized(date="2026-09-04",score=43.12){
  return{schema_version:1,core_score_version:version,snapshots:[{date,snapshot_type:"FINALIZED_CLOSE",finalized:true,finalized_at:`${date}T13:30:00+08:00`,source:{data_as_of:`${date}T13:30:00+08:00`},rows:symbols.map((symbol,index)=>({symbol,final_core_score:symbol==="00830"?score:40+index,tier:"一般持有",core_score_version:version,data_as_of:`${date}T13:30:00+08:00`,factors:{weekly_j:{raw:20},dd52:{raw:-10},crash:{raw:-4}}}))}]};
}
function intraday({date=targetDate,slot="10:30",score=48.31,rowVersion=version,asOf=`${targetDate}T10:30:00+08:00`,freshness="FRESH",remove=null}={}){
  const items=Object.fromEntries(symbols.map((symbol,index)=>[symbol,{symbol,status:"SUCCESS",score:symbol==="00830"?score:44+index,display_score:Math.floor(symbol==="00830"?score:44+index),score_version:rowVersion,trading_date:date,slot,market_as_of:asOf,freshness,components:{},core_factors:{}}]));
  if(remove)delete items[remove];
  return{schema_version:1,snapshot_type:"INTRADAY_CORE",status:"SUCCESS",trading_date:date,slot,items};
}
function view(options={}){
  return resolver.buildDualTrackView({finalizedArtifact:finalized(),intradaySnapshots:[intraday(options)],targetDate,scoreVersion:version,symbols:new Set(symbols),now:openNow,tradingDayStatus:"TRADING_DAY",maxAgeMinutes:75});
}

let result=view(),item=result.items["00830"];
assert.equal(result.primary,"official");
assert.equal(item.primary,"official");
assert.equal(item.official.score,43.12);
assert.equal(item.live.score,48.31);
assert.ok(Math.abs(item.live.delta_vs_official-5.19)<1e-9);
assert.equal(item.live.display_eligible,true);
console.log("A PASS: OFFICIAL 43 remains primary while LIVE PROJECTED 48 is secondary");

assert.equal(result.official_snapshot.items["00830"].score,43.12);
assert.equal(result.live_snapshot.items["00830"].score,48.31);
console.log("B PASS: newer LIVE cannot overwrite FINALIZED");

result=resolver.buildDualTrackView({finalizedArtifact:finalized(),intradaySnapshots:[intraday()],targetDate,scoreVersion:version,symbols,now:new Date("2026-09-07T04:00:00Z"),tradingDayStatus:"TRADING_DAY",maxAgeMinutes:75});
assert.equal(result.market_state,"STALE");
assert.equal(result.items["00830"].live.display_eligible,false);
assert.equal(result.items["00830"].live.reason,"STALE_INTRADAY_SNAPSHOT");
console.log("C PASS: stale LIVE is display-ineligible");

result=resolver.buildDualTrackView({finalizedArtifact:finalized(),intradaySnapshots:[intraday({date:"2026-09-04",asOf:"2026-09-04T13:30:00+08:00"})],targetDate,scoreVersion:version,symbols,now:openNow,tradingDayStatus:"TRADING_DAY"});
assert.equal(result.items["00830"].live.reason,"NO_CURRENT_DAY_INTRADAY");
assert.equal(result.items["00830"].live.display_eligible,false);
console.log("D PASS: prior-day intraday cannot appear as today's LIVE");

result=view({asOf:"2026-09-07T10:41:00+08:00"});
assert.equal(result.items["00830"].live.reason,"FUTURE_AS_OF");
console.log("E PASS: future market_as_of fails closed");

result=view({rowVersion:"OLD"});
assert.equal(result.items["00830"].live.reason,"VERSION_MISMATCH");
console.log("F PASS: incompatible C4 version fails closed");

result=view({remove:"0050"});
assert.equal(result.items["00830"].live.reason,"INCOMPLETE_INTRADAY");
console.log("G PASS: incomplete five-symbol snapshot fails closed");

result=resolver.buildDualTrackView({finalizedArtifact:finalized(targetDate),intradaySnapshots:[intraday()],targetDate,scoreVersion:version,symbols,now:new Date("2026-09-07T06:00:00Z"),tradingDayStatus:"TRADING_DAY"});
assert.equal(result.market_state,"CLOSED");
assert.equal(result.items["00830"].official.status,"FINALIZED");
assert.equal(result.items["00830"].live.display_eligible,false);
assert.equal(result.items["00830"].live.reason,"MARKET_CLOSED");
console.log("H PASS: CLOSED keeps Official and suppresses current LIVE");

result=resolver.buildDualTrackView({finalizedArtifact:finalized(),intradaySnapshots:[],targetDate:"2026-09-06",scoreVersion:version,symbols,now:new Date("2026-09-06T02:00:00Z"),tradingDayStatus:"HOLIDAY"});
assert.equal(result.market_state,"HOLIDAY");
assert.equal(result.items["00830"].live.reason,"MARKET_HOLIDAY");
console.log("I PASS: HOLIDAY cannot create fake LIVE");

const repeated=view();
assert.deepEqual(repeated,result=view());
assert.equal(JSON.stringify(repeated).includes("localStorage"),false);
console.log("J PASS: selector is deterministic and independent of localStorage/reload state");

assert.equal(resolver.resolveMarketState({targetDate,now:new Date("2026-09-07T00:30:00Z"),tradingDayStatus:"TRADING_DAY"}),"PREMARKET");
assert.equal(resolver.resolveMarketState({targetDate,now:openNow,tradingDayStatus:"UNKNOWN"}),"STALE");
console.log("K PASS: market state is Taipei-aware and unknown trading days fail closed");

const html=fs.readFileSync("index.html","utf8"),dualTrackBlock=html.slice(html.indexOf("function currentDualTrackCoreView"),html.indexOf("async function loadCanonicalCoreLedger"));
assert.match(dualTrackBlock,/buildDualTrackView/);
assert.doesNotMatch(dualTrackBlock,/localStorage|buildFinal|buildAdHocScore|calculateCanonicalCore|fetch\(/);
assert.match(html,/function currentCanonicalCoreSnapshot[\s\S]*?resolveFinalOnly/);
assert.match(html,/正式分數 <i>OFFICIAL<\/i>/);
assert.match(html,/盤中預估 <i>LIVE PROJECTED<\/i>/);
assert.match(html,/盤中參考/);
console.log("L PASS: homepage dual track is display-only; FINAL-only authority remains intact");
