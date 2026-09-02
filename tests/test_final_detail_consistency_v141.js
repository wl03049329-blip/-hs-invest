"use strict";

const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const resolver=require("../canonical-score-resolver.js");
const decision=require("../hs-decision-layer-v1.js");

const root=path.join(__dirname,"..");
const html=fs.readFileSync(path.join(root,"index.html"),"utf8");
const artifact=JSON.parse(fs.readFileSync(path.join(root,"finalized-core-score-snapshots-v1.json"),"utf8"));
const symbols=["0050","00662","00757","00830","00935"];
const version="FINAL_CORE_WEIGHT_V1";

for(const [score,stage,label] of [[49,"PULLBACK_WATCH","回檔觀察"],[50,"SMALL_ADD","小額加碼"],[62,"SMALL_ADD","小額加碼"],[64,"SMALL_ADD","小額加碼"],[65,"FORMAL_SCALE_IN","正式分批"],[69,"FORMAL_SCALE_IN","正式分批"],[70,"DEEP_PULLBACK_ADD","深跌加碼"]]){
  const result=decision.interpret({symbol:"00830",score,sourceStatus:"SUCCESS",asOf:"2026-09-02T13:30:00+08:00",currentFactors:{},baseline:{type:"NONE"}});
  assert.deepEqual([result.decision_stage,result.decision_label_zh],[stage,label]);
}
console.log("PASS 1 frozen 49/50/62/64/65/69/70 bucket boundaries");

const current=resolver.resolveFinalOnly({finalizedArtifact:artifact,targetDate:"2026-09-02",scoreVersion:version,symbols:new Set(symbols)});
const row=current.items["00830"];
assert.equal(current.trading_date,"2026-09-02");
assert.equal(row.display_score,62);
assert.deepEqual(row.components,{weekly_j:{value:16.129037625241054,state:"positive"},dd52:{value:-22.064579256360073,state:"strong"},crash:{value:-10.455311973018544,state:"strong"}});
console.log("PASS 2 FINAL resolver exposes authoritative component presentation");

const presentationStart=html.indexOf("function finalDecisionPresentation"),presentationEnd=html.indexOf("function applyCanonicalCoreSnapshot",presentationStart);
const driverStart=html.indexOf("function hsLiveDriverSummary"),driverEnd=html.indexOf("function hsLiveTimeline",driverStart);
const context={Number,Math,Set,window:{HSDecisionLayerV1:decision},LONG_RADAR_SCORED_CODES:new Set(symbols),LONG_TERM_CORE_SCORE_VERSION:version,hsTodayFactorAdapter:factors=>({weeklyJ:factors?.weeklyJ||factors?.weekly_j||null,dd52:factors?.dd52||null,crash:factors?.crash||null}),esc:value=>String(value)};
vm.createContext(context);vm.runInContext(`${html.slice(presentationStart,presentationEnd)}\n${html.slice(driverStart,driverEnd)}`,context);
const item={id:"00830",intraday:{canonical:row}};
const interpreted=context.finalDecisionPresentation(item,row);
assert.deepEqual([interpreted.score,interpreted.decision_stage,interpreted.decision_label_zh,interpreted.distance_to_next_stage,interpreted.next_stage],[62,"SMALL_ADD","小額加碼",3,"FORMAL_SCALE_IN"]);
assert.equal(context.finalDecisionBadgeLabel(interpreted),"小額加碼訊號");
const drivers=context.hsLiveDriverSummary(row);
assert.match(drivers,/週線位置<\/b><i>中性偏多/);
assert.match(drivers,/回檔程度<\/b><i>偏強/);
assert.match(drivers,/急跌訊號<\/b><i>偏強/);
assert.doesNotMatch(drivers,/資料不足/);
console.log("PASS 3 score, badge, summary, distance and drivers share 2026-09-02 FINAL");

const missing={...row,components:{weekly_j:{value:null,state:"unavailable"},dd52:{value:null,state:"unavailable"},crash:{value:null,state:"unavailable"}}};
assert.match(context.hsLiveDriverSummary(missing),/資料不足/);
console.log("PASS 4 actual missing FINAL detail remains unavailable");

assert.match(html,/resolveFinalOnly\(\{finalizedArtifact:finalizedCoreScoreHistoryArtifact/);
assert.doesNotMatch(html.match(/function currentCanonicalCoreSnapshot[\s\S]*?\n\}/)?.[0]||"",/intradaySnapshots|localStorage/);
assert.match(html,/009815 目前維持 WAIT_NATIVE/);
assert.match(html,/00631L · HS LEVERAGE/);
console.log("PASS 5 intraday authority disabled; WAIT_NATIVE and HS LEVERAGE unchanged");

for(const [symbol,score,label] of [["0050",7,"一般持有"],["00662",9,"一般持有"],["00757",5,"一般持有"],["00830",62,"小額加碼"],["00935",20,"一般持有"]]){
  const actual=current.items[symbol];assert.equal(actual.display_score,score);
  const result=decision.interpret({symbol,score:actual.display_score,sourceStatus:"SUCCESS",asOf:actual.market_as_of,currentFactors:actual.core_factors,baseline:{type:"NONE"}});
  assert.equal(result.decision_label_zh,label);
}
console.log("PASS 6 all eligible FINAL symbols use one Decision Layer bucket resolver");

assert.doesNotMatch(html,/function hsLiveNextTier/);
assert.match(html,/decision=mode==="long_term_core"\?\(homepageFinalDecision\(x\)\|\|strategyDecisionFor\(x,mode\)\)/);
console.log("PASS 7 duplicated homepage/detail threshold selection removed");
