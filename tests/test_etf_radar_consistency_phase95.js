"use strict";

const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");

const root=path.join(__dirname,"..");
const html=fs.readFileSync(path.join(root,"index.html"),"utf8");
const core=require(path.join(root,"final-core-production.js"));
const decision=require(path.join(root,"hs-decision-layer-v1.js"));
const expected=[
  [0,"GENERAL","一般持有"],
  [30,"PULLBACK_SIGNAL","回檔訊號出現"],
  [40,"ADD_CONDITION","加碼條件浮現"],
  [45,"PROBE_ADD","試探加碼"],
  [50,"FORMAL_ADD_SIGNAL","正式加碼訊號"],
  [65,"ACTIVE_ADD_SIGNAL","積極加碼訊號"],
  [70,"STRONG_ADD_SIGNAL","強力加碼訊號"],
  [80,"MAJOR_ADD_OPPORTUNITY","重大加碼機會"],
  [90,"HISTORICAL_EXTREME_OPPORTUNITY","歷史極端機會"]
];

assert.equal(core.SCORE_LEVEL_VERSION,"HS_C4_LEVELS_V2");
assert.deepEqual(decision.STAGES.map(({min,stage,label})=>[min,stage,label]),[...expected].reverse());
assert.deepEqual(decision.NEXT_THRESHOLDS,[30,40,45,50,65,70,80,90]);

const factors={weeklyJ:{contribution:1},dd52:{contribution:1},crash:{contribution:1}};
for(const [score,stage,label] of expected){
  assert.equal(core.labelFor(score).label,label);
  const result=decision.interpret({symbol:"00830",score,sourceStatus:"SUCCESS",currentFactors:factors,baseline:{type:"NONE"}});
  assert.equal(result.decision_stage,stage);
  assert.equal(result.decision_label_zh,label);
}
for(const [low,high] of [[29,30],[39,40],[44,45],[49,50],[64,65],[69,70],[79,80],[89,90]]){
  assert.notEqual(core.labelFor(low).stage,core.labelFor(high).stage);
  assert.equal(decision.interpret({symbol:"00830",score:low,sourceStatus:"SUCCESS",currentFactors:factors,baseline:{type:"NONE"}}).distance_to_next_stage,1);
}

assert.match(html,/data-radar-consistency-phase="9\.5"/);
assert.match(html,/20260919-radar-events-phase10/);
assert.match(html,/function radarOverviewNextLevel[\s\S]*contract\?\.NEXT_THRESHOLDS/);
assert.match(html,/function radarFocusStageFor[\s\S]*contract\?\.STAGES/);
assert.match(html,/function radarHistoryPhase6State[\s\S]*contract\?\.STAGES/);
assert.match(html,/function radarOutcomePhase7BState[\s\S]*window\.HSDecisionLayerV1\.STAGES/);
assert.doesNotMatch(html,/const\s+(?:SCORE_LEVELS|RADAR_LEVELS|LEVEL_MAP|THRESHOLD_MAP)\s*=/);

const artifact=JSON.parse(fs.readFileSync(path.join(root,"finalized-core-score-snapshots-v1.json"),"utf8"));
const snapshots=artifact.snapshots.filter(row=>row.snapshot_type==="FINALIZED_CLOSE"&&row.finalized===true).sort((a,b)=>String(b.date).localeCompare(String(a.date)));
const current=snapshots.map(snapshot=>({snapshot,row:(snapshot.rows||[]).find(row=>row.symbol==="00830")})).find(item=>Number.isFinite(item.row?.final_core_score));
assert(current);
const displayScore=Math.floor(current.row.final_core_score),level=core.labelFor(displayScore),decisionLevel=decision.interpret({symbol:"00830",score:displayScore,sourceStatus:"SUCCESS",currentFactors:factors,baseline:{type:"NONE"}});
assert.equal(level.label,decisionLevel.decision_label_zh);
assert.equal(current.row.tier,level.label);
const nextLevel=decision.STAGES.find(row=>row.stage===decisionLevel.next_stage);
assert.equal(nextLevel.min,40);
assert.equal(nextLevel.label,"加碼條件浮現");
assert.equal(decisionLevel.distance_to_next_stage,1);

const research=JSON.parse(fs.readFileSync(path.join(root,"research","c4_historical","00830.json"),"utf8"));
const scores=research.records.map(row=>Number(row.display_score)).filter(Number.isFinite);
const percentile=Math.round(scores.filter(score=>score<=displayScore).length/scores.length*100);
assert(Number.isInteger(percentile));
const researchCurrent=research.records.at(-1);
assert.equal(researchCurrent.date,current.snapshot.date);
assert.equal(researchCurrent.display_score,displayScore);
assert.equal(researchCurrent.level,level.label);
assert(Math.abs(researchCurrent.dd52_raw-current.row.factors.dd52.raw)<1e-9);
const outcomes=JSON.parse(fs.readFileSync(path.join(root,"research","c4_outcomes","summary","00830.json"),"utf8"));
const entry20=outcomes.summary.level_entry_all[level.stage].horizons["20d"];
assert(Number.isFinite(entry20.median_return));
assert.equal(entry20.sample_count,31);
assert.match(html,/radarOverviewResearchSummary[\s\S]*phase6State\.percentile/);
assert.match(html,/radarTodayFocusState[\s\S]*radarFocusHistoricalPercentile/);
assert.match(html,/radarOverviewResearchSummary[\s\S]*artifact\.summary\.level_entry_all[\s\S]*sample\?\.horizons\?\.\["20d"\]/);

for(const copy of ["週 J 值","52週回檔","20日急跌因子","距52週高點","歷史回撤深度","D = 正式交易日","事件樣本","交易日樣本"])assert.ok(html.includes(copy),copy);
for(const stale of ["小額加碼","正式分批","深跌加碼","回檔觀察","小額加碼區"])assert.equal(html.includes(stale),false,stale);

console.log(`Phase 9.5 consistency guards PASS: 00830 score ${displayScore}, ${level.label}, next 40/1, DD52 ${current.row.factors.dd52.raw.toFixed(2)}%, historical P${percentile}, 20D median ${(entry20.median_return*100).toFixed(1)}%, event N=${entry20.sample_count}`);
