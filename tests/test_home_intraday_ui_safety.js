"use strict";

const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");
const html=fs.readFileSync("index.html","utf8");
const css=fs.readFileSync("formal-black-gold.css","utf8");
const start=html.indexOf("const HS_DASHBOARD_C4_SYMBOLS=");
const end=html.indexOf("function selectDecisionCenterLiveMove",start);
assert.ok(start>0&&end>start);
const sandbox={
  window:{HSLiveDiagnostics:{messageFor:()=>"盤中資料同步中"}},
  archivedIntradayCoreSnapshots:[],liveCanonicalCoreSnapshots:[],
  homeC4SortMode:"score",taipeiToday:()=>"2026-09-21",
  decisionCenterEffectiveMarketState:()=>"OPEN",
  currentFrontendLiveRenderState:()=>"LIVE_ACTIVE",
  esc:value=>String(value),
};
vm.createContext(sandbox);
vm.runInContext(html.slice(start,end),sandbox);

assert.equal(sandbox.homeC4DisplayNumber(31.35),"31.4");
assert.equal(sandbox.homeC4DisplayNumber(1),"1.0");
assert.equal(sandbox.homeC4DisplayNumber(null),"—");
assert.equal(sandbox.homeC4ClockText("2026-09-21T10:05:27+08:00"),"10:05");
for(const time of ["09:05","10:55","13:25"])
  assert.equal(sandbox.homeC4ClockText(`2026-09-21T${time}:27+08:00`),time);
console.log("PASS: one-decimal presentation and HH:mm formatter");

const ranking=[
  {symbol:"A",rawScore:29.94,score:29.9},
  {symbol:"B",rawScore:29.91,score:29.9},
  {symbol:"Z",rawScore:null,score:"—"},
  {symbol:"C",rawScore:39.96,score:40.0},
  {symbol:"D",rawScore:39.96,score:40.0},
  {symbol:"Y",rawScore:undefined,score:"—"},
];
assert.deepEqual(Array.from(sandbox.sortDecisionCenterC4Rows(ranking,"score"),row=>row.symbol),["C","D","A","B","Y","Z"]);
assert.equal(sandbox.homeC4DisplayNumber(39.96),"40.0");
console.log("PASS: raw-score ordering, invalid-last and existing symbol tie-breaker");

const rawTime="2026-09-21T10:05:27+08:00";
const chart=sandbox.homeC4Sparkline([{score:30,rawScore:30.8,asOf:"2026-09-21T09:05:00+08:00"},{score:31,rawScore:31.35,asOf:rawTime}],"00830","", "2026-09-21");
assert.match(chart,/更新 10:05/);
assert.match(chart,/datetime="2026-09-21T10:05:27\+08:00"/);
assert.match(chart,/hsC4SparklineChart[\s\S]*hsC4SparklineMeta/);
assert.doesNotMatch(chart,/更新 2026-/);
console.log("PASS: chart footer is separate and preserves the raw timestamp");

sandbox.decisionCenterC4Rows=()=>[{
  symbol:"00830",name:"國泰費城半導體",rawScore:31.35,score:31,
  delta:-7.7,tier:"回檔訊號出現",useLive:true,trajectoryDate:"2026-09-21",
  series:[{score:30,rawScore:30.8,asOf:"2026-09-21T09:05:00+08:00"},{score:31,rawScore:31.35,asOf:rawTime}],
  next:{highest:false,nextThreshold:40,nextLabel:"加碼條件浮現",distance:8.65},
}];
const card=sandbox.decisionCenterC4Cards([],[],{target_date:"2026-09-21"});
assert.match(card,/data-c4-source="LIVE"/);
assert.match(card,/<b>31\.4<\/b>/);
assert.match(card,/今日高<\/dt><dd>31\.4/);
assert.match(card,/今日低<\/dt><dd>30\.8/);
assert.match(card,/\-7\.7/);
assert.match(card,/下一級 40/);
assert.match(card,/加碼條件浮現｜還差 8\.7/);
assert.doesNotMatch(card,/<dt>門檻<\/dt>/);
assert.match(card,/WAIT_NATIVE/);
console.log("PASS: LIVE card displays raw decimals, integer threshold and WAIT_NATIVE unchanged");

sandbox.decisionCenterC4Rows=()=>[{
  symbol:"00830",name:"國泰費城半導體",rawScore:31.35,score:31,
  delta:-7.7,tier:"回檔訊號出現",useLive:false,trajectoryDate:"2026-09-21",
  series:[{score:31,rawScore:31.35,asOf:rawTime}],
  next:{highest:false,nextThreshold:40,nextLabel:"加碼條件浮現",distance:8.65},
}];
const closedCard=sandbox.decisionCenterC4Cards([],[],{target_date:"2026-09-21"});
assert.match(closedCard,/data-c4-source="FINAL"[\s\S]*<b>31\.0<\/b>/);
assert.match(closedCard,/今日高<\/dt><dd>31\.4/);
console.log("PASS: FINAL display remains canonical 31 while archived raw high is formatted separately");

for(const width of [375,390,393,430])assert.match(css,new RegExp(`@media\\(max-width:480px\\)[\\s\\S]*?min-width:4\\.5ch`),`${width}px safety styles present`);
assert.match(css,/#homeEtfBrief \.hsC4SparklineMeta>time\{[^}]*overflow:hidden/);
assert.match(css,/#homeEtfBrief \.hsDashboardC4Card\{[^}]*overflow:hidden/);
console.log("PASS: responsive CSS safety selectors present");

const archive=JSON.parse(fs.readFileSync("intraday-core-snapshots-v1.json","utf8"));
const today=archive.snapshots.filter(snapshot=>snapshot.status==="SUCCESS"&&snapshot.trading_date==="2026-09-21"&&snapshot.items?.["00830"]?.status==="SUCCESS");
assert.equal(today.length,54);
assert.equal(today.at(-1).items["00830"].score,31.35);
assert.equal(today.at(-1).items["00830"].market_as_of,"2026-09-21T13:29:56+08:00");
console.log("PASS: 9/21 golden archived trajectory remains 54, 31.35, 13:29:56");
