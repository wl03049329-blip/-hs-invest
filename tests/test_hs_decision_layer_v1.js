"use strict";
const assert=require("node:assert/strict");
const decision=require("../hs-decision-layer-v1.js");

const factors=(weeklyJ=10,dd52=20,crash=5)=>({weeklyJ:{contribution:weeklyJ},dd52:{contribution:dd52},crash:{contribution:crash}});
const input=(score,extra={})=>({symbol:"0050",score,sourceStatus:"SUCCESS",asOf:"2026-08-21T13:30:00+08:00",currentFactors:factors(),...extra});

for(const [score,stage,label,action] of [[0,"GENERAL","一般持有","NONE"],[39,"GENERAL","一般持有","NONE"],[40,"PULLBACK_WATCH","回檔觀察","WATCH"],[49,"PULLBACK_WATCH","回檔觀察","WATCH"],[50,"SMALL_ADD","小額加碼","OPTIONAL_SMALL_ADD"],[64,"SMALL_ADD","小額加碼","OPTIONAL_SMALL_ADD"],[65,"FORMAL_SCALE_IN","正式分批","SCALE_IN"],[69,"FORMAL_SCALE_IN","正式分批","SCALE_IN"],[70,"DEEP_PULLBACK_ADD","深跌加碼","HIGH_PRIORITY_ADD"],[79,"DEEP_PULLBACK_ADD","深跌加碼","HIGH_PRIORITY_ADD"],[80,"RARE_OPPORTUNITY","罕見機會","HIGH_PRIORITY_ADD"],[89,"RARE_OPPORTUNITY","罕見機會","HIGH_PRIORITY_ADD"],[90,"EXTREME_REFERENCE","極端機會","HIGH_PRIORITY_ADD"],[100,"EXTREME_REFERENCE","極端機會","HIGH_PRIORITY_ADD"]]){
  const result=decision.interpret(input(score));assert.deepEqual([result.decision_stage,result.decision_label_zh,result.action_required],[stage,label,action]);
}
assert.deepEqual([decision.interpret(input(58)).distance_to_next_stage,decision.interpret(input(58)).next_stage],[7,"FORMAL_SCALE_IN"]);
assert.deepEqual([decision.interpret(input(68)).distance_to_next_stage,decision.interpret(input(68)).next_stage],[2,"DEEP_PULLBACK_ADD"]);
assert.deepEqual([decision.interpret(input(83)).distance_to_next_stage,decision.interpret(input(83)).next_stage],[7,"EXTREME_REFERENCE"]);
assert.deepEqual([decision.interpret(input(90)).distance_to_next_stage,decision.interpret(input(90)).next_stage],[0,null]);
assert.deepEqual([decision.interpret(input(64.999)).score,decision.interpret(input(64.999)).distance_to_next_stage],[64,1]);

let result=decision.interpret(input(null,{sourceStatus:"FAIL_CLOSED"}));
assert.deepEqual([result.score,result.decision_stage,result.action_required,result.distance_to_next_stage,result.capital_posture,result.explanation_code],[null,null,"NONE",null,"PRESERVE_CASH","DATA_UNAVAILABLE"]);
result=decision.interpret(input(null,{symbol:"009815",sourceStatus:"WAIT_NATIVE"}));
assert.deepEqual([result.score,result.decision_stage,result.action_required,result.distance_to_next_stage,result.capital_posture,result.explanation_code],[null,null,"NONE",null,"PRESERVE_CASH","WAIT_NATIVE"]);
result=decision.interpret(input(58,{sourceStatus:"STALE"}));assert.deepEqual([result.score,result.decision_stage,result.source_status,result.action_required,result.explanation_code],[58,null,"STALE","NONE","STALE_SOURCE"]);

result=decision.interpret(input(58,{baseline:{type:"FINALIZED_CLOSE",score:52,factors:factors(8,15,4)}}));
assert.deepEqual([result.primary_driver,result.primary_driver_delta,result.today_score_delta,result.comparison_basis],["DD52",5,6,"FINALIZED_CLOSE"]);
assert.equal(result.explanation_code,"SMALL_ADD_DRIVER_UP");
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
