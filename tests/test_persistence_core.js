const assert=require("assert");
const fs=require("fs");
const vm=require("vm");
const core=require("../persistence-core");

assert.strictEqual(core.key("watchlist"),"hsRadar.watchlist");
assert.strictEqual(core.FORWARD_START_DATE,"2026-08-08");
assert.strictEqual(core.keys.portfolioRebalanceSettings,"hsRadar.portfolio.rebalanceSettings");
assert.ok(core.EVENT_TRIGGER_TYPES.includes("rebalanceOutsideBand"));
assert.ok(core.EVENT_TRIGGER_TYPES.includes("00631LPanicAbove80"));

const valid=core.validateForwardRecord({symbol:"00733",signalDate:"2026-08-08",stage:1,tradeId:"00733-20260808",strategyType:"swing00733",buyScore:75,rawScore:82,exitPressure:22,signalPrice:48.5,position:20,weeklyJ:9,relativeStrength:4.2,ma20:47,ma60:45,ma200:40,drawdown60:-8,gate:{setupGate:{passed:true}},marketStatus:"PASS",tradeState:"ACCUMULATION",confidence:"HIGH"});
assert.ok(valid);
assert.strictEqual(valid.key,"00733|2026-08-08|1|00733-20260808");
assert.strictEqual(valid.modelVersion,"HS Swing Radar V1.2.1 Beta Validated Frozen");
assert.strictEqual(core.validateForwardRecord({...valid,signalDate:"2026-08-07"}),null);
assert.strictEqual(core.validateForwardRecord({...valid,provisional:true}),null);
assert.strictEqual(core.validateForwardRecord({...valid,buyScore:NaN}),null);
assert.strictEqual(core.validateForwardRecord({...valid,rawScore:Infinity}),null);
assert.strictEqual(core.validateForwardRecord({...valid,exitPressure:101}),null);
assert.strictEqual(core.validateForwardRecord({...valid,exitPressure:-1}),null);
assert.strictEqual(core.validateForwardRecord({...valid,position:101}),null);
assert.strictEqual(core.validateForwardRecord({...valid,position:-1}),null);
assert.strictEqual(valid.rawScore,82);
assert.strictEqual(valid.position,20);

assert.ok(core.validateEvent({id:"00733-2026-08-08-stage1",symbol:"00733",date:"2026-08-08",type:"BUY_STAGE",severity:"medium",title:"Stage 1",reason:"Setup Gate 通過"}));
assert.strictEqual(core.validateEvent({id:"bad",symbol:"00733",date:"2026-08-08",type:"UNKNOWN",severity:"medium"}),null);
assert.ok(core.validateDecisionLog({date:"2026-08-08",symbol:"00733",tradeId:"t1",strategy:"swing00733",score:75,stage:1,positionBefore:0,positionAfter:20,action:"觀察",reason:"正式訊號"}));
assert.strictEqual(core.validateDecisionLog({date:"2026-08-08",symbol:"00733",score:75,positionBefore:0,positionAfter:101}),null);

assert.deepStrictEqual(core.validateAllocations([{symbol:"00733",targetAllocation:35},{symbol:"006201",targetAllocation:25}]),{ok:true,total:60,items:[{symbol:"00733",targetAllocation:35},{symbol:"006201",targetAllocation:25}]});
assert.strictEqual(core.validateAllocations([{symbol:"00733",targetAllocation:80},{symbol:"006201",targetAllocation:30}]).ok,false);

const memory=new Map();
const storage={getItem:key=>memory.has(key)?memory.get(key):null,setItem:(key,value)=>memory.set(key,String(value)),removeItem:key=>memory.delete(key)};
function bootPersistence(){
  const context=vm.createContext({localStorage:storage});
  vm.runInContext(fs.readFileSync(require.resolve("../persistence-core"),"utf8"),context);
  return context.HSPersistenceCore;
}
const firstBoot=bootPersistence();
assert.strictEqual(firstBoot.saveTradeState("00733",{state:"ACCUMULATION",position:20,entryPrice:NaN,peakPrice:50,entryDate:"2026-08-08",holdingDays:2}),true);
firstBoot.setJson(firstBoot.keys.holdings,[{code:"0050",shares:1000,averageCost:60}]);
firstBoot.setJson(firstBoot.key("settings"),{buyPlanMode:"balanced"});
firstBoot.setJson(firstBoot.key("cache"),{updatedAt:"2026-08-08T01:30:00Z"});
assert.strictEqual(firstBoot.appendForwardRecord(valid).duplicate,false);
assert.strictEqual(firstBoot.appendForwardRecord(valid).duplicate,true);
assert.strictEqual(firstBoot.appendDecisionLog({date:"2026-08-08",symbol:"00733",tradeId:"t1",strategy:"swing00733",score:75,stage:1,positionBefore:0,positionAfter:20,action:"觀察",reason:"正式訊號"}).ok,true);
const secondBoot=bootPersistence();
assert.strictEqual(secondBoot.loadTradeState("00733").position,20);
assert.strictEqual(secondBoot.loadTradeState("00733").entryPrice,null);
assert.strictEqual(secondBoot.getJson(secondBoot.keys.holdings,[]).length,1);
assert.strictEqual(secondBoot.getJson(secondBoot.key("settings"),{}).buyPlanMode,"balanced");
assert.strictEqual(secondBoot.getJson(secondBoot.key("cache"),{}).updatedAt,"2026-08-08T01:30:00Z");
assert.strictEqual(secondBoot.listForwardRecords().length,1);
assert.strictEqual(secondBoot.getJson(secondBoot.keys.decisionLog,[]).length,1);
for(const value of memory.values())assert.doesNotMatch(value,/NaN|Infinity|undefined/);

console.log("PASS namespaced persistence, forward-test validation and allocation guard");
