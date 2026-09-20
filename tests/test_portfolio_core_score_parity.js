"use strict";

const assert=require("assert");
const fs=require("fs");
const path=require("path");
const vm=require("vm");
const resolver=require("../canonical-score-resolver.js");

const root=path.join(__dirname,"..");
const portfolio=fs.readFileSync(path.join(root,"portfolio-v6.js"),"utf8");
const index=fs.readFileSync(path.join(root,"index.html"),"utf8");
const symbols=["0050","00830","00935"];

function item(symbol,{official=40,live=50,liveEligible=true}={}){
  return{ticker:symbol,market_state:"OPEN",official:{score:official+.25,display_score:official,trading_date:"2026-09-18",market_as_of:"2026-09-18T13:30:00+08:00",status:"FINALIZED",source_status:"FINALIZED_EOD"},live:{score:live+.75,display_score:live,trading_date:"2026-09-21",market_as_of:"2026-09-21T10:00:00+08:00",display_eligible:liveEligible,status:liveEligible?"LIVE_PROJECTED":"UNAVAILABLE",reason:liveEligible?null:"STALE_INTRADAY_SNAPSHOT"}};
}

function view(marketState="OPEN",options={}){
  return{target_date:"2026-09-21",market_state:marketState,items:Object.fromEntries(symbols.map((symbol,index)=>[symbol,item(symbol,{official:10+index,live:20+index,...options})]))};
}

const adapterSource=index.match(/function currentFormalCoreScoreForSymbol\([\s\S]*?\n\}/)?.[0]||"";
function radarFormalScore(testView,symbol){
  const sandbox={window:{HSCanonicalScoreResolver:resolver},LONG_RADAR_CODES:new Set([...symbols,"009815"]),LONG_RADAR_SCORED_CODES:new Set(symbols),taipeiToday:()=>testView.target_date,currentDualTrackCoreView:()=>testView};
  vm.runInNewContext(adapterSource,sandbox);
  return sandbox.currentFormalCoreScoreForSymbol(symbol,testView.target_date,new Date("2026-09-21T02:00:00Z"));
}
const portfolioBadgeScore=(testView,symbol)=>radarFormalScore(testView,symbol);

for(const symbol of symbols){
  const live=resolver.selectFormalCoreScore(view("OPEN"),symbol);
  assert.deepEqual(portfolioBadgeScore(view("OPEN"),symbol),live);
  assert.equal(live.available,true);assert.equal(live.source,"LIVE");assert.equal(live.display_score,20+symbols.indexOf(symbol));
  const finalized=resolver.selectFormalCoreScore(view("CLOSED"),symbol);
  assert.deepEqual(portfolioBadgeScore(view("CLOSED"),symbol),finalized);
  assert.equal(finalized.available,true);assert.equal(finalized.source,"FINALIZED");assert.equal(finalized.display_score,10+symbols.indexOf(symbol));
  const unavailable=resolver.selectFormalCoreScore(view("OPEN",{liveEligible:false}),symbol);
  assert.deepEqual(portfolioBadgeScore(view("OPEN",{liveEligible:false}),symbol),unavailable);
  assert.equal(unavailable.available,false);assert.equal(unavailable.display_score,null);
  const stale=resolver.selectFormalCoreScore(view("STALE"),symbol);
  assert.deepEqual(portfolioBadgeScore(view("STALE"),symbol),stale);
  assert.equal(stale.available,false);assert.equal(stale.reason,"SCORE_STATE_STALE");
}

for(const state of ["OPEN","CLOSED","STALE"]){
  const waitNative=portfolioBadgeScore(view(state),"009815");
  assert.equal(waitNative.available,false);assert.equal(waitNative.reason,"WAIT_NATIVE");assert.equal(waitNative.display_score,null);
}

const unsupported=portfolioBadgeScore(view("CLOSED"),"00635U");
assert.equal(unsupported.available,false);assert.equal(unsupported.reason,"UNSUPPORTED_SYMBOL");assert.equal(unsupported.display_score,null);

const radarBlock=portfolio.match(/function radarFor\(code\)[\s\S]*?\n  \}/)?.[0]||"";
assert.match(radarBlock,/HSFormalCoreScoreAdapter\?\.scoreFor/);
assert.doesNotMatch(radarBlock,/item\.formalScore|strategyDecisions\?\.long_term_core\?\.score|item\.score/);
assert.match(index,/function currentFormalCoreScoreForSymbol[\s\S]*?selectFormalCoreScore/);
assert.match(index,/LONG_RADAR_CODES\.has\(ticker\)&&!LONG_RADAR_SCORED_CODES\.has\(ticker\)[\s\S]*?reason:"WAIT_NATIVE"/);
assert.match(index,/function decisionCenterC4Rows[\s\S]*?selectFormalCoreScore/);
assert.match(index,/hs:formal-core-score-updated/);
assert.match(portfolio,/radar\?` <em>HS \$\{Number\.isFinite\(score\)\?number\(score,0\):"—"\}<\/em>`:""/);

console.log("PASS portfolio badge uses the shared Radar formal score selector");
console.log("PASS live/finalized parity for 0050, 00830, 00935");
console.log("PASS unavailable/stale and 009815 WAIT_NATIVE render HS —; unsupported 00635U renders no badge");
