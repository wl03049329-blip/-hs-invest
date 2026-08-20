const assert=require("assert");
const fs=require("fs");
const path=require("path");
const vm=require("vm");

const root=path.resolve(__dirname,"..");
const html=fs.readFileSync(path.join(root,"index.html"),"utf8");
const start=html.indexOf("function snapshotTradingDate");
const end=html.indexOf("function renderTodayHighlights");
assert.ok(start>=0&&end>start,"intraday rank snapshot helpers must exist");
const context={
  Intl,Date,Number,Object,Array,Math,JSON,Set,
  LONG_RADAR_SCORED_CODES:new Set(["0050","00662","00757","00830","00935"]),
  displayScore:item=>item.raw,
  strategyDecisionFor:item=>({score:item.raw,coreScore:item.raw,stage:{label:"一般持有"},scoreStatus:"complete"}),
  esc:String,fmt:String
};
vm.createContext(context);vm.runInContext(html.slice(start,end),context);

const at=(day,time)=>new Date(`${day}T${time}:00+08:00`);
const row=(id,raw)=>({id,name:id,raw,j:20,weekBias:-3});
const rows=(score=32)=>[row("00830",score),row("0050",30),row("00662",29),row("00757",28),row("00935",27)];
const snapshot=(stored,day,time,score=32)=>context.longRankSnapshot(rows(score),stored,`legacy-${time}`,at(day,time),`${day} ${time}`);
const current=(day,time,score=32)=>context.createLongRankSnapshot(rows(score),"unused",at(day,time),`${day} ${time}`);
const refresh=(day,slot)=>({verified:true,status:"success",trading_date:day,slot});

// Tests 8–13: first-of-day and score/rank deltas use the previous successful slot.
const first=context.longRankChange(null,1,32);
assert.strictEqual(first.displayRankChange,"本日首次");assert.strictEqual(first.scoreDelta,null);
console.log("TEST 8 PASS: 09:30 first successful snapshot is first-of-day");
let saved=snapshot({},"2026-08-21","09:30");
let previous=context.comparisonLongRanks(saved,current("2026-08-21","10:30"));
let same=context.longRankChange(previous.items["00830"],1,32);
assert.strictEqual(previous.slot_time,"2026-08-21 09:30");assert.strictEqual(same.scoreDelta,0);assert.strictEqual(same.rankDelta,0);assert.strictEqual(same.displayScoreChange,"分數 ±0");assert.strictEqual(same.displayRankChange,"排名不變");
console.log("TEST 9 PASS: 10:30 compares with 09:30 and true zero renders as zero");
assert.strictEqual(context.longRankChange(previous.items["00830"],1,35).scoreDelta,3);
console.log("TEST 10 PASS: 32 to 35 is +3");
assert.strictEqual(context.longRankChange(previous.items["00830"],1,29).scoreDelta,-3);
console.log("TEST 11 PASS: 32 to 29 is -3");
assert.strictEqual(context.longRankChange({rank:3,coreScore:32},1,32).displayRankChange,"↑2");
console.log("TEST 12 PASS: rank 3 to 1 is +2");
assert.strictEqual(context.longRankChange({rank:1,coreScore:32},3,32).displayRankChange,"↓2");
console.log("TEST 13 PASS: rank 1 to 3 is -2");

// Test 14: an unsuccessful slot is absent, so the next verified slot falls back.
previous=context.comparisonLongRanks(saved,current("2026-08-21","11:30"));
assert.strictEqual(previous.slot_time,"2026-08-21 09:30");
console.log("TEST 14 PASS: 11:30 skips failed 10:30 and compares with 09:30");

// Test 15: serialized localStorage history survives a browser refresh.
saved=JSON.parse(JSON.stringify(saved));
previous=context.comparisonLongRanks(saved,current("2026-08-21","10:30"));
assert.strictEqual(previous.slot_time,"2026-08-21 09:30");
console.log("TEST 15 PASS: persisted 09:30 history survives reload");

// Test 16: a failed 10:30 cannot become a verified write identity.
const candidate1030=current("2026-08-21","10:30");
assert.strictEqual(context.isVerifiedLongRankSnapshot({verified:false,status:"failed",trading_date:"2026-08-21",slot:"10:30"},candidate1030),false);
assert.strictEqual(context.isVerifiedLongRankSnapshot(refresh("2026-08-21","09:30"),candidate1030),false);
assert.strictEqual(context.isVerifiedLongRankSnapshot(refresh("2026-08-21","10:30"),candidate1030),true);
console.log("TEST 16 PASS: only matching verified backend slot can be persisted");

// Test 17: a fresh trading date does not consume previous-day intraday history.
assert.deepStrictEqual(JSON.parse(JSON.stringify(context.comparisonLongRanks(saved,current("2026-08-22","09:30")))),{});
console.log("TEST 17 PASS: next trading day starts without an intraday baseline");

// Test 18: WAIT_NATIVE remains outside the active Core Score/rank universe.
assert.match(html,/LONG_RADAR_SCORED_CODES=new Set\(\["0050","00662","00757","00830","00935"\]\)/);
assert.doesNotMatch(html,/validateCoreBatch\(entries,\[\.\.\.LONG_RADAR_CODES\]/);
assert.match(html,/rankedLongs=longs\.filter\(item=>LONG_RADAR_SCORED_CODES\.has\(item\.id\)/);
console.log("TEST 18 PASS: 009815 is not included in intraday Core Score ranking");

const identity=context.longRankSnapshotIdentity(current("2026-08-21","10:30"));
assert.match(identity,/^2026-08-21\|10:30\|/);
console.log("FIXTURE PASS: backend slot identity projects to deterministic frontend history identity");
