const assert=require("assert");
const fs=require("fs");
const path=require("path");
const vm=require("vm");

const root=path.resolve(__dirname,"..");
const html=fs.readFileSync(path.join(root,"index.html"),"utf8");
const start=html.indexOf("function snapshotTradingDate");
const end=html.indexOf("function renderTodayHighlights");
assert.ok(start>=0&&end>start,"intraday rank snapshot functions must exist");

const context={
  Intl,Date,Number,Object,Array,Math,JSON,Set,
  displayScore:item=>Math.floor(item.raw),
  strategyDecisionFor:item=>({score:Math.floor(item.raw),coreScore:item.raw,stage:{label:"一般持有"},scoreStatus:"complete",coverage:100}),
  esc:String,fmt:String
};
vm.createContext(context);
vm.runInContext(html.slice(start,end),context);

const at=time=>new Date(`2026-08-18T${time}:00+08:00`);
const row=(id,raw,rank)=>({id,name:id,raw,j:20-rank,weekBias:-rank});
const rows=(scoreA,scoreB)=>[row("0050",scoreA,1),row("00830",scoreB,2)];
const finalized={schema_version:1,snapshots:[{snapshot_type:"FINALIZED_CLOSE",tradingDate:"2026-08-17",finalizedAt:"2026-08-17T05:30:00Z",items:{
  "0050":{rank:1,coreScore:50.2,longTermScore:50},"00830":{rank:2,coreScore:52.2,longTermScore:52}
}}]};

const current0930=context.createLongRankSnapshot(rows(50.7,52.8),"v0930",at("09:30"),"2026-08-18 09:30");
const baseline=context.comparisonLongRanks({},current0930,finalized);
assert.strictEqual(baseline.baseline_type,"FINALIZED_CLOSE");
assert.strictEqual(baseline.slot_time,"2026-08-17 13:30");
const delta0930=context.longRankChange(baseline.items["0050"],1,50.7);
assert.ok(Math.abs(delta0930.scoreDelta-0.5)<1e-9);
assert.strictEqual(delta0930.displayScoreChange,"分數 +0.5");
console.log("TEST A PASS: 09:30 compares with previous finalized close");

const rawDelta=context.longRankChange(baseline.items["00830"],2,52.8);
assert.ok(Math.abs(rawDelta.scoreDelta-0.6)<1e-9);
assert.strictEqual(rawDelta.displayScoreChange,"分數 +0.6");
console.log("TEST B PASS: raw Core Score delta is calculated before display flooring");

let saved=context.longRankSnapshot(rows(52.3,53.2),{},"v0930",at("09:30"),"2026-08-18 09:30");
const current1030=context.createLongRankSnapshot(rows(53.1,53.4),"v1030",at("10:30"),"2026-08-18 10:30");
let previous=context.comparisonLongRanks(saved,current1030,finalized);
assert.strictEqual(previous.slot_time,"2026-08-18 09:30");
assert.ok(Math.abs(context.longRankChange(previous.items["0050"],1,53.1).scoreDelta-0.8)<1e-9);
console.log("TEST C PASS: 10:30 compares with 09:30, not previous close");

saved=context.longRankSnapshot(rows(53.1,53.4),saved,"v1030",at("10:30"),"2026-08-18 10:30");
saved=context.longRankSnapshot(rows(53.5,53.8),saved,"v1130",at("11:30"),"2026-08-18 11:30");
assert.deepStrictEqual(JSON.parse(JSON.stringify(saved.snapshots.map(item=>item.snapshotTime))),["2026-08-18 09:30","2026-08-18 10:30","2026-08-18 11:30"]);
assert.strictEqual(saved.currentSlot,"11:30");
assert.strictEqual(saved.previousSuccessfulSlot,"10:30");
console.log("TEST E PASS: successful slot snapshots remain independently readable");

const without1030=context.longRankSnapshot(rows(52.3,53.2),{},"v0930",at("09:30"),"2026-08-18 09:30");
const current1130=context.createLongRankSnapshot(rows(53.5,53.8),"v1130",at("11:30"),"2026-08-18 11:30");
previous=context.comparisonLongRanks(without1030,current1130,finalized);
assert.strictEqual(previous.slot_time,"2026-08-18 09:30");
assert.strictEqual(without1030.snapshots.length,1);
assert.strictEqual(without1030.lastSuccessfulSnapshot,"2026-08-18 09:30");
console.log("TEST D/F PASS: a failed 10:30 writes nothing and 11:30 uses 09:30");

console.log("P0-D TEST A-F PASS");
