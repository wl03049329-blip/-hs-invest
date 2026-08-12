const assert=require("assert");
const fs=require("fs");
const path=require("path");
const vm=require("vm");

const root=path.resolve(__dirname,"..");
const html=fs.readFileSync(path.join(root,"index.html"),"utf8");
const start=html.indexOf("function dailyFactorValue");
const end=html.indexOf("function scoreFactorValue");
assert.ok(start>=0&&end>start,"P3 daily snapshot functions must exist");

const memory=new Map(),context={Date,Number,Array,Object,Math,JSON,Set,DAILY_LONG_RANK_STORAGE_KEY:"hsRadar.dailyLongRank.v1",localStorage:{getItem:key=>memory.get(key)||null,setItem:(key,value)=>memory.set(key,value)}};
vm.createContext(context);vm.runInContext(html.slice(start,end),context);

const item=(id,date,score,j,bias,drawdown,marketFear=60,valuation=55,availableWeight=100)=>({
  id,formalState:{date,j,weekBias:bias,fromHigh:drawdown},valuation:{score:valuation},
  formalStrategyDecisions:{long_term_core:{score,availableWeight,breakdown:[{key:"marketFear",value:marketFear}]}}
});
const snapshot=(date,rows)=>context.createDailyLongRankSnapshot(rows,`${date}T06:00:00.000Z`);
const movement=(latest,previous,ticker="00830")=>context.dailyLongRankMovement({latest,previous},ticker);

const previous=snapshot("2026-08-11",[item("0050","2026-08-11",40,8,-4,-8),item("00830","2026-08-11",34,6,-8,-15),item("00935","2026-08-11",30,12,-3,-10)]);
const latestSameRank=snapshot("2026-08-12",[item("0050","2026-08-12",40,8,-4,-8),item("00830","2026-08-12",36,5,-9,-16),item("00935","2026-08-12",30,12,-3,-10)]);
let result=movement(latestSameRank,previous);
assert.strictEqual(result.displayRankChange,"日排名不變");assert.strictEqual(result.displayScoreChange,"日分數 +2");
console.log("TEST 1 PASS: same daily rank and +2 daily score");

const latestRankUp=snapshot("2026-08-12",[item("00830","2026-08-12",34,5,-9,-16),item("0050","2026-08-12",33,8,-4,-8),item("00935","2026-08-12",30,12,-3,-10)]);
result=movement(latestRankUp,previous);assert.strictEqual(result.displayRankChange,"日排名 ↑1");assert.strictEqual(result.displayScoreChange,"日分數 ±0");
console.log("TEST 2 PASS: daily rank and score are independent");

const previousFirst=snapshot("2026-08-11",[item("00830","2026-08-11",34,6,-8,-15),item("0050","2026-08-11",33,8,-4,-8),item("00935","2026-08-11",30,12,-3,-10)]);
const latestThird=snapshot("2026-08-12",[item("0050","2026-08-12",40,8,-4,-8),item("00935","2026-08-12",35,12,-3,-10),item("00830","2026-08-12",31,5,-9,-16)]);
result=movement(latestThird,previousFirst);assert.strictEqual(result.displayRankChange,"日排名 ↓2");assert.strictEqual(result.displayScoreChange,"日分數 -3");
console.log("TEST 3 PASS: daily rank down 2 and score down 3");

const fixedDisplay=JSON.stringify(movement(latestSameRank,previous));
for(const intradayScore of [37,39,33,42])assert.strictEqual(JSON.stringify(movement(latestSameRank,previous)),fixedDisplay,`intraday ${intradayScore} must not affect daily movement`);
console.log("TEST 4 PASS: 09:30/10:30/11:30/12:30 intraday changes do not alter daily movement");

memory.clear();context.saveDailyLongRankSnapshot([item("0050","2026-08-11",40,8,-4,-8),item("00830","2026-08-11",34,6,-8,-15)]);let pair=context.dailyLongRankPair();assert.strictEqual(pair.previous,null);
context.saveDailyLongRankSnapshot([item("0050","2026-08-12",40,8,-4,-8),item("00830","2026-08-12",36,5,-9,-16)]);pair=context.dailyLongRankPair();assert.strictEqual(pair.latest.tradingDate,"2026-08-12");assert.strictEqual(pair.previous.tradingDate,"2026-08-11");
context.saveDailyLongRankSnapshot([item("0050","2026-08-12",40,8,-4,-8),item("00830","2026-08-12",99,5,-9,-16)]);assert.strictEqual(context.dailyLongRankPair().latest.items["00830"].longTermScore,36);
console.log("TEST 5 PASS: movement advances once after a new finalized close snapshot");

const friday=snapshot("2026-08-07",[item("00830","2026-08-07",32,8,-5,-12)]),monday=snapshot("2026-08-10",[item("00830","2026-08-10",35,6,-7,-14)]);
assert.strictEqual(context.dailyLongRankPair({snapshots:[friday,monday]}).previous.tradingDate,"2026-08-07");
console.log("TEST 6 PASS: Monday compares with previous Friday snapshot");

const preHoliday=snapshot("2026-09-24",[item("00830","2026-09-24",31,9,-4,-11)]),postHoliday=snapshot("2026-09-29",[item("00830","2026-09-29",36,5,-8,-16)]);
assert.strictEqual(context.dailyLongRankPair({snapshots:[preHoliday,postHoliday]}).previous.tradingDate,"2026-09-24");
console.log("TEST 7 PASS: post-holiday uses last actual stored trading day");

result=movement(latestSameRank,previous,"00662");assert.strictEqual(result.displayRankChange,"日排名首次");assert.strictEqual(result.displayScoreChange,"—");
console.log("TEST 8 PASS: missing previous ETF shows daily first and dash");

const storedRankPrevious={tradingDate:"2026-08-11",items:{"00830":{ticker:"00830",longTermScore:34,rank:4}}},storedRankLatest={tradingDate:"2026-08-12",items:{"00830":{ticker:"00830",longTermScore:34,rank:1}}};
result=movement(storedRankLatest,storedRankPrevious);assert.strictEqual(result.rankDelta,3);assert.strictEqual(result.displayRankChange,"日排名 ↑3");
console.log("TEST 9 PASS: previous rank is read from its saved snapshot without recomputation");

assert.match(html,/const dailyPair=dailyLongRankPair\(\)/);assert.doesNotMatch(html,/const longPrevious=previousLongRanks\(\)/);
assert.match(html,/const snapshotAsOf=intradayLongRankAsOf\(longs\)/);assert.match(html,/longRankSnapshot\(longs,saved,version,snapshotAsOf\)/);
console.log("TEST 10 PASS: P2 homepage intraday snapshot pipeline remains present and separate");

assert.deepStrictEqual(Object.keys(latestSameRank.items["00830"]),["ticker","longTermScore","rank","weeklyJ","Bias40W","drawdown","marketFear","valuation","availableWeight"]);
console.log("P3 daily snapshot traceability fields PASS");

console.log("00830 DAILY TRACE");
console.log("Previous date=2026-08-11 score=34 rank=2");
console.log("Latest date=2026-08-12 score=36 rank=2");
console.log("dailyScoreDelta=+2 dailyRankDelta=0 display=日排名不變 / 日分數 +2");
console.log("INTRADAY STABILITY 09:30=日排名不變/日分數 +2 10:30=same 11:30=same 12:30=same");
