"use strict";
const assert=require("node:assert/strict");
const decision=require("../hs-decision-layer-v1.js");
const core=require("../final-core-production.js");

const factors=(weeklyJ=10,dd52=20,crash=5)=>({weeklyJ:{contribution:weeklyJ},dd52:{contribution:dd52},crash:{contribution:crash}});
const input=(score,extra={})=>({symbol:"0050",score,sourceStatus:"SUCCESS",asOf:"2026-08-21T13:30:00+08:00",currentFactors:factors(),...extra});

assert.equal(decision.SCORE_LEVEL_VERSION,"HS_C4_LEVELS_V2");
assert.deepEqual(decision.STAGES,core.LABELS.map(({min,stage,label,action,posture})=>({min,stage,label,action,posture})));
for(const [score,stage,label,action] of [[0,"GENERAL","一般持有","NONE"],[29,"GENERAL","一般持有","NONE"],[30,"PULLBACK_SIGNAL","回檔訊號出現","WATCH"],[39,"PULLBACK_SIGNAL","回檔訊號出現","WATCH"],[40,"ADD_CONDITION","加碼條件浮現","WATCH"],[44,"ADD_CONDITION","加碼條件浮現","WATCH"],[45,"PROBE_ADD","試探加碼","OPTIONAL_SMALL_ADD"],[49,"PROBE_ADD","試探加碼","OPTIONAL_SMALL_ADD"],[50,"FORMAL_ADD_SIGNAL","正式加碼訊號","SCALE_IN"],[64,"FORMAL_ADD_SIGNAL","正式加碼訊號","SCALE_IN"],[65,"ACTIVE_ADD_SIGNAL","積極加碼訊號","SCALE_IN"],[69,"ACTIVE_ADD_SIGNAL","積極加碼訊號","SCALE_IN"],[70,"STRONG_ADD_SIGNAL","強力加碼訊號","HIGH_PRIORITY_ADD"],[79,"STRONG_ADD_SIGNAL","強力加碼訊號","HIGH_PRIORITY_ADD"],[80,"MAJOR_ADD_OPPORTUNITY","重大加碼機會","HIGH_PRIORITY_ADD"],[89,"MAJOR_ADD_OPPORTUNITY","重大加碼機會","HIGH_PRIORITY_ADD"],[90,"HISTORICAL_EXTREME_OPPORTUNITY","歷史極端機會","HIGH_PRIORITY_ADD"],[100,"HISTORICAL_EXTREME_OPPORTUNITY","歷史極端機會","HIGH_PRIORITY_ADD"]]){
  const result=decision.interpret(input(score));assert.deepEqual([result.decision_stage,result.decision_label_zh,result.action_required],[stage,label,action]);
}
for(const [score,distance,next] of [[29,1,"PULLBACK_SIGNAL"],[39,1,"ADD_CONDITION"],[44,1,"PROBE_ADD"],[49,1,"FORMAL_ADD_SIGNAL"],[64,1,"ACTIVE_ADD_SIGNAL"],[69,1,"STRONG_ADD_SIGNAL"],[79,1,"MAJOR_ADD_OPPORTUNITY"],[89,1,"HISTORICAL_EXTREME_OPPORTUNITY"]])assert.deepEqual([decision.interpret(input(score)).distance_to_next_stage,decision.interpret(input(score)).next_stage],[distance,next]);
assert.deepEqual([decision.interpret(input(90)).distance_to_next_stage,decision.interpret(input(90)).next_stage],[0,null]);
assert.deepEqual([decision.interpret(input(64.999)).score,decision.interpret(input(64.999)).distance_to_next_stage],[64,1]);

let result=decision.interpret(input(null,{sourceStatus:"FAIL_CLOSED"}));
assert.deepEqual([result.score,result.decision_stage,result.action_required,result.distance_to_next_stage,result.capital_posture,result.explanation_code],[null,null,"NONE",null,"PRESERVE_CASH","DATA_UNAVAILABLE"]);
result=decision.interpret(input(null,{symbol:"009815",sourceStatus:"WAIT_NATIVE"}));
assert.deepEqual([result.score,result.decision_stage,result.action_required,result.distance_to_next_stage,result.capital_posture,result.explanation_code],[null,null,"NONE",null,"PRESERVE_CASH","WAIT_NATIVE"]);
result=decision.interpret(input(58,{sourceStatus:"STALE"}));assert.deepEqual([result.score,result.decision_stage,result.source_status,result.action_required,result.explanation_code],[58,null,"STALE","NONE","STALE_SOURCE"]);

result=decision.interpret(input(58,{baseline:{type:"FINALIZED_CLOSE",score:52,factors:factors(8,15,4)}}));
assert.deepEqual([result.primary_driver,result.primary_driver_delta,result.today_score_delta,result.comparison_basis],["DD52",5,6,"FINALIZED_CLOSE"]);
assert.equal(result.explanation_code,"FORMAL_ADD_SIGNAL");
result=decision.interpret(input(65,{baseline:{type:"INTRADAY_SUCCESS",score:68,factors:factors(10,25,5)}}));
assert.deepEqual([result.primary_driver,result.primary_driver_delta,result.today_score_delta,result.comparison_basis],["DD52",-5,-3,"INTRADAY_SUCCESS"]);
assert.equal(result.explanation_code,"DRIVER_DOWN");
result=decision.interpret(input(58,{baseline:{type:"FINALIZED_CLOSE",score:52,factors:{weeklyJ:{contribution:8},dd52:{contribution:18}}}}));
assert.deepEqual([result.primary_driver,result.primary_driver_delta,result.explanation_code],[null,null,"DRIVER_UNAVAILABLE"]);
result=decision.interpret(input(58,{baseline:{type:"FINALIZED_CLOSE",score:52,factors:factors(8,18,3)}}));
assert.deepEqual([result.primary_driver,result.primary_driver_delta],["DD52",2]); // DD52 wins an exact 2-point tie.
result=decision.interpret(input(58,{baseline:{type:"NONE",score:52,factors:factors(8,15,4)}}));
assert.deepEqual([result.today_score_delta,result.comparison_basis,result.primary_driver],[null,"NONE",null]);

const immutable=input(58,{baseline:{type:"FINALIZED_CLOSE",score:52,factors:factors(8,15,4)}}),before=JSON.stringify(immutable);decision.interpret(immutable);assert.equal(JSON.stringify(immutable),before);
assert.throws(()=>decision.interpret(input(50,{symbol:"00631L"})),/EXCLUDED_SYMBOL/);
const formal={label:"正式加碼訊號",coreLabel:"正式加碼訊號",coreScoreVersion:"FINAL_CORE_WEIGHT_V1"};decision.interpret(input(58,{formal}));assert.deepEqual(formal,{label:"正式加碼訊號",coreLabel:"正式加碼訊號",coreScoreVersion:"FINAL_CORE_WEIGHT_V1"});
console.log("HS Decision Layer V1: PASS");
