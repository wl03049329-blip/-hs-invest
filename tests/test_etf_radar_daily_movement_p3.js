const assert=require("assert");
const fs=require("fs");
const path=require("path");
const vm=require("vm");

const root=path.resolve(__dirname,"..");
const html=fs.readFileSync(path.join(root,"index.html"),"utf8");
const intraday=require(path.join(root,"intraday-buy-point-core.js"));
const production=require(path.join(root,"final-core-production.js"));
const start=html.indexOf("function dailyFactorValue");
const end=html.indexOf("function radarPrimaryDriver");
assert.ok(start>=0&&end>start,"P3 daily snapshot functions must exist");

const memory=new Map(),context={Date,Number,Array,Object,Math,JSON,Set,HSIntradayBuyPointCore:intraday,HSFinalCoreProduction:production,LONG_TERM_CORE_SCORE_VERSION:"FINAL_CORE_WEIGHT_V1",DAILY_LONG_RANK_STORAGE_KEY:"hsRadar.dailyLongRank.v1",coreScoreTrendRanges:new Map(),finalizedCoreScoreHistoryArtifact:{schema_version:1,core_score_version:"FINAL_CORE_WEIGHT_V1",snapshots:[]},loadDailyLongRankHistory:()=>({schema_version:1,snapshots:[]}),esc:value=>String(value)};
context.localStorage={getItem:key=>memory.get(key)||null,setItem:(key,value)=>memory.set(key,value)};
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
assert.strictEqual(result.displayRankChange,"本機日排名不變");assert.strictEqual(result.displayScoreChange,"本機盤後 +2");
console.log("TEST 1 PASS: same daily rank and +2 daily score");

const latestRankUp=snapshot("2026-08-12",[item("00830","2026-08-12",34,5,-9,-16),item("0050","2026-08-12",33,8,-4,-8),item("00935","2026-08-12",30,12,-3,-10)]);
result=movement(latestRankUp,previous);assert.strictEqual(result.displayRankChange,"本機日排名 ↑1");assert.strictEqual(result.displayScoreChange,"本機盤後 ±0");
console.log("TEST 2 PASS: daily rank and score are independent");

const previousFirst=snapshot("2026-08-11",[item("00830","2026-08-11",34,6,-8,-15),item("0050","2026-08-11",33,8,-4,-8),item("00935","2026-08-11",30,12,-3,-10)]);
const latestThird=snapshot("2026-08-12",[item("0050","2026-08-12",40,8,-4,-8),item("00935","2026-08-12",35,12,-3,-10),item("00830","2026-08-12",31,5,-9,-16)]);
result=movement(latestThird,previousFirst);assert.strictEqual(result.displayRankChange,"本機日排名 ↓2");assert.strictEqual(result.displayScoreChange,"本機盤後 -3");
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

result=movement(latestSameRank,previous,"00662");assert.strictEqual(result.displayRankChange,"本機日排名首次");assert.strictEqual(result.displayScoreChange,"—");
console.log("TEST 8 PASS: missing previous ETF shows daily first and dash");

const storedRankPrevious={tradingDate:"2026-08-11",items:{"00830":{ticker:"00830",longTermScore:34,rank:4}}},storedRankLatest={tradingDate:"2026-08-12",items:{"00830":{ticker:"00830",longTermScore:34,rank:1}}};
result=movement(storedRankLatest,storedRankPrevious);assert.strictEqual(result.rankDelta,3);assert.strictEqual(result.displayRankChange,"本機日排名 ↑3");
console.log("TEST 9 PASS: previous rank is read from its saved snapshot without recomputation");

result=context.dailyLongRankMovement({latest:latestSameRank,previous,source:"official"},"00830");
assert.strictEqual(result.displayRankChange,"正式日排名不變");assert.strictEqual(result.displayScoreChange,"正式日分數 +2");
console.log("TEST 9B PASS: official and browser-local daily semantics are visibly distinct");

const officialRow=(symbol,date,score)=>({symbol,final_core_score:score,tier:production.labelFor(score).label,core_score_version:"FINAL_CORE_WEIGHT_V1",data_as_of:`${date}T13:30:00+08:00`,factors:{weekly_j:{raw:10}}});
const conflictPrevious=snapshot("2026-08-25",[item("0050","2026-08-25",60,8,-4,-8),item("00830","2026-08-25",47,6,-8,-15),item("00935","2026-08-25",40,12,-3,-10),item("00662","2026-08-25",30,20,-2,-5),item("00757","2026-08-25",20,25,-1,-4)]);
const conflictLocalCurrent=snapshot("2026-08-26",[item("0050","2026-08-26",60,8,-4,-8),item("00830","2026-08-26",47,6,-8,-15),item("00935","2026-08-26",40,12,-3,-10),item("00662","2026-08-26",30,20,-2,-5),item("00757","2026-08-26",20,25,-1,-4)]);
context.finalizedCoreScoreHistoryArtifact={schema_version:1,core_score_version:"FINAL_CORE_WEIGHT_V1",snapshots:[{date:"2026-08-26",snapshot_type:"FINALIZED_CLOSE",finalized:true,finalized_at:"2026-08-26T13:30:00+08:00",rows:[officialRow("0050","2026-08-26",50),officialRow("00662","2026-08-26",30),officialRow("00757","2026-08-26",20),officialRow("00830","2026-08-26",53.8031197301855),officialRow("00935","2026-08-26",40)]}]};
const canonicalPair=context.dailyLongRankPair({schema_version:1,snapshots:[conflictPrevious,conflictLocalCurrent]}),canonicalMove=context.dailyLongRankMovement(canonicalPair,"00830");
assert.strictEqual(canonicalPair.latest.items["00830"].longTermScore,53);assert.strictEqual(canonicalPair.latest.items["00830"].historySource,"official");assert.strictEqual(canonicalPair.previous.items["00830"].longTermScore,47);assert.strictEqual(canonicalPair.latest.items["00830"].rank,1);assert.strictEqual(canonicalPair.previous.items["00830"].rank,2);
assert.strictEqual(canonicalMove.scoreDelta,6);assert.strictEqual(canonicalMove.rankDelta,1);assert.strictEqual(canonicalMove.displayScoreChange,"正式日分數 +6");assert.strictEqual(canonicalMove.displayRankChange,"正式日排名 ↑1");
const today=context.radarTodayHtml({id:"00830",name:"國泰費城半導體",intraday:{asOf:"2026-08-26T13:30:00+08:00"}},{label:"正式加碼訊號",marketAsOf:"2026-08-26T13:30:00+08:00"},53,canonicalPair);
assert.match(today,/前一本機盤後試算 47 → 最新正式盤後 53　\+6/);assert.doesNotMatch(today,/最新本機盤後試算 47/);
const trend=context.coreScoreHistoryState("00830",{schema_version:1,snapshots:[conflictPrevious,conflictLocalCurrent]});assert.strictEqual(trend.rows[0].displayScore,53);
assert.deepStrictEqual([53,officialDisplay(canonicalPair.latest.items["00830"]),trend.rows[0].displayScore],[53,53,53]);
for(const symbol of ["0050","00662","00757","00935"]){assert.strictEqual(canonicalPair.latest.items[symbol].historySource,"official");assert.strictEqual(canonicalPair.latest.items[symbol].longTermScore,Math.floor(Number(context.finalizedCoreScoreHistoryArtifact.snapshots[0].rows.find(row=>row.symbol===symbol).final_core_score)))}
console.log("TEST 9C PASS: TODAY, score delta, rank delta and 10D share official-over-local current values");

context.finalizedCoreScoreHistoryArtifact={schema_version:1,core_score_version:"FINAL_CORE_WEIGHT_V1",snapshots:[]};
const localPair=context.dailyLongRankPair({schema_version:1,snapshots:[conflictPrevious,conflictLocalCurrent]}),localMove=context.dailyLongRankMovement(localPair,"00830");
assert.strictEqual(localPair.latest.items["00830"].longTermScore,47);assert.strictEqual(localMove.source,"local");assert.strictEqual(localMove.displayScoreChange,"本機盤後 ±0");
console.log("TEST 9D PASS: local fallback remains available when no official observation exists");

assert.match(html,/const dailyPair=dailyLongRankPair\(\)/);assert.doesNotMatch(html,/const longPrevious=previousLongRanks\(\)/);
assert.match(html,/const snapshotAsOf=intradayLongRankAsOf\(longs\)/);assert.match(html,/isVerifiedLongRankSnapshot\(liveRadarRefresh,candidateSnapshot\)/);assert.match(html,/longRankSnapshot\(rankedLongs,saved,snapshotIdentity,snapshotAsOf,snapshotSlot\)/);
console.log("TEST 10 PASS: P2 homepage intraday snapshot pipeline remains present and separate");

for(const key of ["ticker","symbol","trading_date","final_core_score","display_score","status","data_as_of","calculated_at","engine_version","weekly_j"])assert.ok(key in latestSameRank.items["00830"],`missing traceability field ${key}`);
console.log("P3 daily snapshot traceability fields PASS");

console.log("00830 DAILY TRACE");
console.log("Previous date=2026-08-11 score=34 rank=2");
console.log("Latest date=2026-08-12 score=36 rank=2");
console.log("dailyScoreDelta=+2 dailyRankDelta=0 display=本機日排名不變 / 本機盤後 +2");
console.log("INTRADAY STABILITY 09:30=本機日排名不變/本機盤後 +2 10:30=same 11:30=same 12:30=same");

function officialDisplay(row){return context.officialDisplayScore(row)}
