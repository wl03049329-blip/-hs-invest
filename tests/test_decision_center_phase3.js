"use strict";

const assert=require("node:assert/strict");
const fs=require("node:fs");
const crypto=require("node:crypto");
const vm=require("node:vm");

const html=fs.readFileSync("index.html","utf8"),css=fs.readFileSync("formal-black-gold.css","utf8"),artifact=JSON.parse(fs.readFileSync("finalized-core-score-snapshots-v1.json","utf8"));
const symbols=["0050","00662","00757","00830","00935"],start=html.indexOf('const OFFICIAL_C4_CHANGE_KEYS='),end=html.indexOf("function longRankRow",start),source=html.slice(start,end);
assert.ok(start>0&&end>start,"official C4 attribution helper must remain isolated and testable");
const sandbox={LONG_RADAR_SCORED_CODES:new Set(symbols),LONG_TERM_CORE_SCORE_VERSION:"FINAL_CORE_WEIGHT_V1",isCompletedTradingDate:value=>/^\d{4}-\d{2}-\d{2}$/.test(String(value||"")),esc:String};
vm.runInNewContext(source,sandbox);

function row(symbol,score,contributions,version="FINAL_CORE_WEIGHT_V1"){return{symbol,final_core_score:score,core_score_version:version,data_as_of:"2026-09-04T13:30:00+08:00",factors:{weekly_j:{contribution:contributions[0]},dd52:{contribution:contributions[1]},crash:{contribution:contributions[2]}}};}
function snapshot(date,item,type="FINALIZED_CLOSE",finalized=true){return{date,snapshot_type:type,finalized,rows:[{...item,data_as_of:`${date}T13:30:00+08:00`}]};}
function fixture(rows){return{schema_version:1,core_score_version:"FINAL_CORE_WEIGHT_V1",snapshots:rows};}

let result=sandbox.officialC4ChangeAttribution("00830",fixture([snapshot("2026-09-03",row("00830",44,[10,30,4])),snapshot("2026-09-04",row("00830",50,[11,34,5]))]));
assert.equal(result.status,"READY");assert.equal(result.scoreDelta,6);assert.equal(result.componentDeltaSum,6);
console.log("A/C PASS: +6 official change reconciles exactly to stored component contributions");

result=sandbox.officialC4ChangeAttribution("00830",fixture([snapshot("2026-09-02",row("00830",99,[30,54,15]),"INTRADAY",true),snapshot("2026-09-03",row("00830",44,[10,30,4])),snapshot("2026-09-04",row("00830",50,[11,34,5]))]));
assert.equal(result.previous.date,"2026-09-03");assert.equal(result.latest.date,"2026-09-04");
console.log("B PASS: intraday observations cannot become latest or previous Official");

const driverCases=[
  ["dd52",[1,5,0],"距 52 週高點回撤擴大"],
  ["weekly_j",[6,1,0],"週線超賣程度增加"],
  ["crash",[0,1,6],"短期急跌程度增加"]
];
for(const [driver,deltas,reason] of driverCases){const previous=[10,20,5],latest=previous.map((value,index)=>value+deltas[index]);result=sandbox.officialC4ChangeAttribution("0050",fixture([snapshot("2026-09-03",row("0050",35,previous)),snapshot("2026-09-04",row("0050",35+deltas.reduce((a,b)=>a+b,0),latest))]));assert.equal(result.mainDriver,driver);assert.equal(result.mainReason,reason)}
console.log("D/E/F PASS: DD52, Weekly J and Crash can each be selected deterministically");

result=sandbox.officialC4ChangeAttribution("0050",fixture([snapshot("2026-09-03",row("0050",40,[10,25,5])),snapshot("2026-09-04",row("0050",34,[8,21,5]))]));
assert.equal(result.scoreDelta,-6);assert.match(result.mainReason,/減弱|收斂|減輕/);
console.log("G PASS: falling contribution produces falling-direction Chinese explanation");

result=sandbox.officialC4ChangeAttribution("0050",fixture([snapshot("2026-09-04",row("0050",34,[8,21,5]))]));assert.equal(result.status,"FIRST_RECORD");
console.log("H PASS: a single Finalized record has no fabricated baseline");

result=sandbox.officialC4ChangeAttribution("0050",fixture([snapshot("2026-09-03",row("0050",40,[10,25,5],"OLD_VERSION")),snapshot("2026-09-04",row("0050",34,[8,21,5]))]));assert.equal(result.status,"VERSION_MISMATCH");
console.log("I PASS: different score versions fail closed");

assert.equal(sandbox.officialC4ChangeAttribution("00878",artifact).status,"NON_FORMAL");assert.equal(sandbox.officialC4ChangeAttribution("009815",artifact).status,"NON_FORMAL");
console.log("J/K PASS: AD_HOC and 009815 stay outside Formal attribution");

assert.doesNotMatch(source,/buildFinal|buildAdHocScore|calculateCanonicalCore|computeCoreScore|localStorage|sessionStorage|fetch\(|setItem\(|intraday/i);
assert.doesNotMatch(html.slice(start,end),/00631L|HS_LEVERAGE/);
console.log("L/M PASS: 00631L untouched and no canonical C4 recomputation path exists");

const protectedFiles=["finalized-core-score-snapshots-v1.json","intraday-core-snapshots-v1.json","forward-action-policy-v1-ledger.json","forward-validation-ledger.json"].filter(fs.existsSync);
const before=Object.fromEntries(protectedFiles.map(file=>[file,crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")]));
for(const symbol of symbols){result=sandbox.officialC4ChangeAttribution(symbol,artifact);assert.equal(result.status,"READY",`${symbol} must have two comparable official records`);assert.equal(result.reconciled,true);assert.ok(Math.abs(result.componentDeltaSum-result.scoreDelta)<1e-6)}
const after=Object.fromEntries(protectedFiles.map(file=>[file,crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")]));assert.deepEqual(after,before);
console.log("N PASS: all eligible production records reconcile without protected mutation");

const latest=artifact.snapshots.at(-1),highest=[...latest.rows].filter(item=>symbols.includes(item.symbol)).sort((a,b)=>b.final_core_score-a.final_core_score)[0],actual=sandbox.officialC4ChangeAttribution(highest.symbol,artifact);
assert.equal(actual.status,"READY");assert.equal(actual.latest.score,highest.final_core_score);assert.equal(actual.mainDriver,"weekly_j");
console.log(`PRODUCTION PASS: ${highest.symbol} ${actual.previous.score.toFixed(4)} -> ${actual.latest.score.toFixed(4)} (${actual.scoreDelta.toFixed(4)}), main=${actual.mainDriver}`);

for(const text of ["較上次","主要原因","為什麼變？","分數變動來源","尚無前次正式紀錄可比較","模型版本不同，暫不比較"])assert.ok(html.includes(text));
assert.match(css,/\.hsC4ChangeCompact\{/);assert.match(css,/\.hsC4Why\{/);assert.match(css,/@media\(max-width:430px\)[\s\S]*?\.hsC4ScoreTransition/);
console.log("UI PASS: compact explanation, expandable details and mobile guards are present");
