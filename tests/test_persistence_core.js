const assert=require("assert");
const core=require("../persistence-core");

assert.strictEqual(core.key("watchlist"),"hsRadar.watchlist");
assert.strictEqual(core.FORWARD_START_DATE,"2026-08-08");

const valid=core.validateForwardRecord({symbol:"00733",signalDate:"2026-08-08",stage:1,tradeId:"00733-20260808",strategyType:"swing00733",buyScore:75,exitPressure:22,signalPrice:48.5,tradeState:"ACCUMULATION",confidence:"HIGH"});
assert.ok(valid);
assert.strictEqual(valid.key,"00733|2026-08-08|1|00733-20260808");
assert.strictEqual(valid.modelVersion,"HS Swing Radar V1.2.1 Beta Validated Frozen");
assert.strictEqual(core.validateForwardRecord({...valid,signalDate:"2026-08-07"}),null);
assert.strictEqual(core.validateForwardRecord({...valid,provisional:true}),null);
assert.strictEqual(core.validateForwardRecord({...valid,buyScore:NaN}),null);

assert.deepStrictEqual(core.validateAllocations([{symbol:"00733",targetAllocation:35},{symbol:"006201",targetAllocation:25}]),{ok:true,total:60,items:[{symbol:"00733",targetAllocation:35},{symbol:"006201",targetAllocation:25}]});
assert.strictEqual(core.validateAllocations([{symbol:"00733",targetAllocation:80},{symbol:"006201",targetAllocation:30}]).ok,false);

console.log("PASS namespaced persistence, forward-test validation and allocation guard");
