const assert=require("assert");
const core=require("../persistence-core");

assert.strictEqual(core.key("watchlist"),"hsRadar.watchlist");
assert.strictEqual(core.FORWARD_START_DATE,"2026-08-08");

const valid=core.validateForwardRecord({symbol:"00733",signalDate:"2026-08-08",stage:1,tradeId:"00733-20260808",strategyType:"swing00733",buyScore:75,rawScore:82,exitPressure:22,signalPrice:48.5,position:20,weeklyJ:9,relativeStrength:4.2,ma20:47,ma60:45,ma200:40,drawdown60:-8,gate:{setupGate:{passed:true}},marketStatus:"PASS",tradeState:"ACCUMULATION",confidence:"HIGH"});
assert.ok(valid);
assert.strictEqual(valid.key,"00733|2026-08-08|1|00733-20260808");
assert.strictEqual(valid.modelVersion,"HS Swing Radar V1.2.1 Beta Validated Frozen");
assert.strictEqual(core.validateForwardRecord({...valid,signalDate:"2026-08-07"}),null);
assert.strictEqual(core.validateForwardRecord({...valid,provisional:true}),null);
assert.strictEqual(core.validateForwardRecord({...valid,buyScore:NaN}),null);
assert.strictEqual(valid.rawScore,82);
assert.strictEqual(valid.position,20);

assert.ok(core.validateEvent({id:"00733-2026-08-08-stage1",symbol:"00733",date:"2026-08-08",type:"BUY_STAGE",severity:"medium",title:"Stage 1",reason:"Setup Gate 通過"}));
assert.strictEqual(core.validateEvent({id:"bad",symbol:"00733",date:"2026-08-08",type:"UNKNOWN",severity:"medium"}),null);
assert.ok(core.validateDecisionLog({date:"2026-08-08",symbol:"00733",tradeId:"t1",strategy:"swing00733",score:75,stage:1,positionBefore:0,positionAfter:20,action:"觀察",reason:"正式訊號"}));
assert.strictEqual(core.validateDecisionLog({date:"2026-08-08",symbol:"00733",score:75,positionBefore:0,positionAfter:101}),null);

assert.deepStrictEqual(core.validateAllocations([{symbol:"00733",targetAllocation:35},{symbol:"006201",targetAllocation:25}]),{ok:true,total:60,items:[{symbol:"00733",targetAllocation:35},{symbol:"006201",targetAllocation:25}]});
assert.strictEqual(core.validateAllocations([{symbol:"00733",targetAllocation:80},{symbol:"006201",targetAllocation:30}]).ok,false);

console.log("PASS namespaced persistence, forward-test validation and allocation guard");
