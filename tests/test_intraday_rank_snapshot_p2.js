const assert=require("assert");
const fs=require("fs");
const path=require("path");
const vm=require("vm");

const root=path.resolve(__dirname,"..");
const html=fs.readFileSync(path.join(root,"index.html"),"utf8");
const start=html.indexOf("function snapshotTradingDate");
const end=html.indexOf("function renderTodayHighlights");
assert.ok(start>=0&&end>start,"P2 snapshot functions must exist");

const memory=new Map();
const context={
  Intl,Date,Number,Object,Array,Math,JSON,Set,
  LONG_RANK_STORAGE_KEY:"hs-test-long-rank",
  localStorage:{getItem:key=>memory.get(key)||null,setItem:(key,value)=>memory.set(key,value)},
  displayScore:item=>item.score,
  strategyDecisionFor:item=>({score:item.score,stage:{label:"開始觀察"},scoreStatus:"complete",coverage:100}),
  esc:value=>String(value),fmt:value=>String(value)
};
vm.createContext(context);
vm.runInContext(html.slice(start,end),context);

const at=time=>new Date(`2026-08-12T${time}:00+08:00`);
const etf=(id,score,j,bias)=>({id,name:id,score,j,weekBias:bias});
const snapshot=(rows,time,stored={})=>context.longRankSnapshot(rows,stored,`v-${time}`,at(time));
const current=(rows,time)=>context.createLongRankSnapshot(rows,`v-${time}`,at(time));
const compare=(stored,rows,time)=>context.comparisonLongRanks(stored,current(rows,time));

const rows0930=[etf("0050",40,8,-5),etf("00830",34,6,-8),etf("00935",30,10,-4)];
const saved0930=snapshot(rows0930,"09:30");
const first=context.longRankChange(compare({},rows0930,"09:30").items?.["00830"],2,34);
assert.deepStrictEqual(JSON.parse(JSON.stringify(first)),{rankDelta:null,scoreDelta:null,displayRankChange:"本日首次",displayScoreChange:"—"});
console.log("TEST 1 PASS: 09:30 first snapshot shows first-of-day and dash");

const rows1030=[etf("0050",40,8,-5),etf("00830",36,5,-9),etf("00935",30,10,-4)];
const sameRank=context.longRankChange(saved0930.snapshots[0].items["0050"],1,42);
assert.strictEqual(sameRank.displayRankChange,"排名不變");assert.strictEqual(sameRank.displayScoreChange,"分數 +2");
console.log("TEST 2 PASS: unchanged rank and +2 score are independent");

const rankOnly=context.longRankChange(saved0930.snapshots[0].items["00830"],1,34);
assert.strictEqual(rankOnly.displayRankChange,"↑1");assert.strictEqual(rankOnly.displayScoreChange,"分數 ±0");
console.log("TEST 3 PASS: rank rises while score remains unchanged");

const down=context.longRankChange({rank:1,longTermScore:34},3,31);
assert.strictEqual(down.displayRankChange,"↓2");assert.strictEqual(down.displayScoreChange,"分數 -3");
console.log("TEST 4 PASS: rank and score declines render correctly");

const rows1130=[etf("0050",39,8,-5),etf("00830",35,4,-10),etf("00935",30,10,-4)];
const saved1130=snapshot(rows1130,"11:30",saved0930);
const previousAt1130=compare(saved1130,[etf("00830",35,4,-10)],"11:30");
assert.strictEqual(previousAt1130.slot_time,"2026-08-12 09:30");
console.log("TEST 5 PASS: missing 10:30 falls back to previous successful 09:30");

const missing=context.longRankChange(previousAt1130.items["00662"],4,33);
assert.strictEqual(missing.displayRankChange,"本日首次");assert.strictEqual(missing.displayScoreChange,"—");
assert.strictEqual(context.longRankChange({rank:null,longTermScore:null},4,33).displayRankChange,"本日首次");
console.log("TEST 6 PASS: ETF absent from previous snapshot shows first-of-day");

memory.set(context.LONG_RANK_STORAGE_KEY,JSON.stringify(saved1130));
const reloaded=JSON.parse(context.localStorage.getItem(context.LONG_RANK_STORAGE_KEY));
assert.strictEqual(reloaded.snapshots.length,2);assert.strictEqual(compare(reloaded,[etf("00830",35,4,-10)],"11:30").slot_time,"2026-08-12 09:30");
console.log("TEST 7 PASS: same-day snapshot history survives reload");

const nextDayRows=[etf("00830",35,4,-10)];
assert.deepStrictEqual(JSON.parse(JSON.stringify(compare(saved1130,nextDayRows,"09:30"))),{});
assert.deepStrictEqual(JSON.parse(JSON.stringify(compare({schema_version:2,slot_time:"2026-08-11 13:30",items:saved0930.snapshots[0].items},nextDayRows,"09:30"))),{});
console.log("TEST 8 PASS: next-day 09:30 never compares with prior trading day");

const older=snapshot(rows1030,"10:30",saved0930);
const newer=snapshot(rows1030,"10:39",older);
assert.strictEqual(newer.snapshots.length,2);assert.strictEqual(newer.snapshots[1].snapshotTime,"2026-08-12 10:30");
assert.ok(new Date(newer.snapshots[1].marketAsOf)>new Date(older.snapshots[1].marketAsOf));
const rejected=context.longRankSnapshot(rows1030,newer,"v-old",at("10:31"));
assert.strictEqual(rejected.snapshots[1].marketAsOf,newer.snapshots[1].marketAsOf);
console.log("TEST 9 PASS: P1 marketAsOf selects the slot and older quotes cannot overwrite it");

assert.match(html,/weeklyJ:Number\.isFinite\(item\.j\)\?item\.j:null/);
assert.match(html,/Bias40W:Number\.isFinite\(item\.weekBias\)\?item\.weekBias:null/);
assert.match(html,/longTermScore:Number\.isFinite\(score\)\?score:null/);
assert.doesNotMatch(html,/scoreMovement[^>]+style="display:none !important"/);
assert.match(fs.readFileSync(path.join(root,"formal-black-gold.css"),"utf8"),/#homeEtfBrief \.scoreMovement:before\{content:none\}/);
console.log("P2 snapshot fields and score movement UI PASS");

const saved1030=snapshot(rows1030,"10:30",saved0930);
const savedTrace1130=snapshot(rows1130,"11:30",saved1030);
const trace1030=context.longRankChange(compare(saved1030,rows1030,"10:30").items["00830"],2,36);
const trace1130Previous=compare(savedTrace1130,rows1130,"11:30"),trace1130=context.longRankChange(trace1130Previous.items["00830"],2,35);
assert.deepStrictEqual(JSON.parse(JSON.stringify(trace1030)),{rankDelta:0,scoreDelta:2,displayRankChange:"排名不變",displayScoreChange:"分數 +2"});
assert.deepStrictEqual(JSON.parse(JSON.stringify(trace1130)),{rankDelta:0,scoreDelta:-1,displayRankChange:"排名不變",displayScoreChange:"分數 -1"});
console.log("00830 TRACE");
console.log("09:30 score=34 rank=2 previousSnapshot=none displayRankChange=本日首次 displayScoreChange=—");
console.log("10:30 score=36 rank=2 previousSnapshotTime=09:30 previousScore=34 previousRank=2 scoreDelta=+2 rankDelta=0 displayRankChange=排名不變 displayScoreChange=分數 +2");
console.log("11:30 score=35 rank=2 previousSnapshotTime=10:30 previousScore=36 previousRank=2 scoreDelta=-1 rankDelta=0 displayRankChange=排名不變 displayScoreChange=分數 -1");
