const assert=require("node:assert/strict");
const policy=require("../personal-capital-policy-core.js");
let passed=0;
function test(name,fn){fn();passed++;process.stdout.write(`PASS ${name}\n`);}
function ready({symbol="0050",actual=60,target=60,score=65,...rest}={}){
  return{version:"PERSONAL_CAPITAL_INPUT_V1",symbol,eligibility:"READY",reasons:[],portfolio:{actualWeightPct:actual,targetAllocationPct:target},radar:{score,stage:{key:"add"}},freshness:{portfolio:"CURRENT",radar:"CURRENT"},asOf:{portfolioDate:"2026-08-21",radarDate:"2026-08-21",decisionMode:"FORMAL",aligned:true},...rest};
}
test("allocation boundaries are frozen",()=>{
  assert.equal(policy.allocationState(-3.1),"OVERWEIGHT");assert.equal(policy.allocationState(-3),"OVERWEIGHT");assert.equal(policy.allocationState(-2.9),"ON_TARGET");
  assert.equal(policy.allocationState(2),"ON_TARGET");assert.equal(policy.allocationState(2.1),"UNDERWEIGHT");assert.equal(policy.allocationState(5),"UNDERWEIGHT");assert.equal(policy.allocationState(5.1),"DEEPLY_UNDERWEIGHT");
});
test("score buckets preserve all boundaries",()=>{
  [[39,"NORMAL"],[40,"WATCH"],[49,"WATCH"],[50,"SMALL_ADD"],[64,"SMALL_ADD"],[65,"FORMAL_ADD"],[69,"FORMAL_ADD"],[70,"DEEP_ADD"],[79,"DEEP_ADD"],[80,"RARE"],[89,"RARE"],[90,"EXTREME"],[100,"EXTREME"]].forEach(([score,bucket])=>assert.equal(policy.scoreBucket(score),bucket));
});
test("capital action matrix",()=>{
  [["OVERWEIGHT",95,"DO_NOT_ADD"],["ON_TARGET",30,"HOLD"],["ON_TARGET",65,"ALLOW_ADD"],["UNDERWEIGHT",30,"WAIT"],["UNDERWEIGHT",45,"WATCH"],["UNDERWEIGHT",55,"ALLOW_ADD"],["UNDERWEIGHT",68,"PRIORITY_ADD"],["DEEPLY_UNDERWEIGHT",30,"WAIT"],["DEEPLY_UNDERWEIGHT",45,"WATCH"],["DEEPLY_UNDERWEIGHT",55,"PRIORITY_ADD"],["DEEPLY_UNDERWEIGHT",70,"HIGH_PRIORITY_ADD"]].forEach(([state,score,action])=>assert.equal(policy.actionFor(state,score),action));
});
test("evaluates a valid normalized input without capital amount",()=>{
  const result=policy.evaluate(ready({actual:54,target:60,score:55}));
  assert.equal(result.status,"READY");assert.equal(result.action,"PRIORITY_ADD");assert.deepEqual(result.rationaleCodes,["PORTFOLIO_DEEPLY_UNDERWEIGHT","MARKET_SMALL_ADD"]);
  assert.equal(Object.hasOwn(result,"amount"),false);
});
test("input layer failures and missing freshness cannot bypass policy",()=>{
  assert.equal(policy.evaluate({...ready(),eligibility:"DATA_UNAVAILABLE",reasons:["RADAR_STALE"]}).action,"DATA_UNAVAILABLE");
  assert.equal(policy.evaluate(ready({freshness:{portfolio:"STALE",radar:"CURRENT"}})).action,"DATA_UNAVAILABLE");
  assert.equal(policy.evaluate(ready({asOf:{aligned:false}})).action,"DATA_UNAVAILABLE");
});
test("missing target and invalid actual weight fail closed",()=>{
  assert.equal(policy.evaluate(ready({target:null})).action,"DATA_UNAVAILABLE");
  assert.equal(policy.evaluate(ready({actual:101})).action,"DATA_UNAVAILABLE");
});
test("invalid scores fail closed without clamping",()=>{
  [null,NaN,101,-1].forEach(score=>assert.equal(policy.evaluate(ready({score})).action,"DATA_UNAVAILABLE"));
});
test("out of scope symbols cannot enter policy",()=>["00631L","006201","00733","00757"].forEach(symbol=>{
  const result=policy.evaluate(ready({symbol}));assert.equal(result.action,"DATA_UNAVAILABLE");assert.ok(result.rationaleCodes.includes("SYMBOL_OUT_OF_SCOPE"));
}));
test("009815 valid READY input evaluates while insufficient input does not",()=>{
  assert.equal(policy.evaluate(ready({symbol:"009815",score:70})).status,"READY");
  assert.equal(policy.evaluate({...ready({symbol:"009815"}),eligibility:"DATA_UNAVAILABLE",reasons:["RADAR_COVERAGE_INSUFFICIENT"]}).status,"DATA_UNAVAILABLE");
});
process.stdout.write(`PASS ${passed} focused personal-capital policy tests\n`);
