"use strict";

const assert=require("node:assert/strict");
const crypto=require("node:crypto");
const fs=require("node:fs");
const vm=require("node:vm");
const decision=require("../hs-decision-layer-v1.js");

const html=fs.readFileSync("index.html","utf8"),css=fs.readFileSync("formal-black-gold.css","utf8"),production=JSON.parse(fs.readFileSync("finalized-core-score-snapshots-v1.json","utf8")),symbols=["0050","00662","00757","00830","00935"];
const start=html.indexOf('const OFFICIAL_C4_TREND_DAYS='),end=html.indexOf("function longRankRow",start),source=html.slice(start,end);
assert.ok(start>0&&end>start,"official C4 trend helpers must remain testable in isolation");
const sandbox={window:{HSDecisionLayerV1:decision},LONG_RADAR_SCORED_CODES:new Set(symbols),LONG_TERM_CORE_SCORE_VERSION:"FINAL_CORE_WEIGHT_V1",officialC4HistoryCache:{artifact:null,bySymbol:null},officialC4TrendRanges:new Map(),finalizedCoreScoreHistoryArtifact:null,isCompletedTradingDate:value=>/^\d{4}-\d{2}-\d{2}$/.test(String(value||"")),officialC4Signed:value=>`${value>0?"+":""}${Number(value).toFixed(1)}`,esc:String};
vm.runInNewContext(source,sandbox);

function row(symbol,score,tier="一般持有",version="FINAL_CORE_WEIGHT_V1",mode=""){return{symbol,final_core_score:score,tier,core_score_version:version,mode,data_as_of:""};}
function snapshot(date,item,type="FINALIZED_CLOSE",finalized=true){return{date,snapshot_type:type,finalized,rows:[{...item,data_as_of:`${date}T13:30:00+08:00`}]};}
function artifact(snapshots){return{schema_version:1,core_score_version:"FINAL_CORE_WEIGHT_V1",snapshots};}
const official=artifact([
  snapshot("2025-08-01",row("00830",10)),snapshot("2026-05-01",row("00830",20)),snapshot("2026-08-01",row("00830",30)),snapshot("2026-08-20",row("00830",39)),snapshot("2026-08-21",row("00830",40,"回檔觀察")),snapshot("2026-08-25",row("00830",52,"小額加碼")),snapshot("2026-09-01",row("00830",66,"正式分批")),snapshot("2026-09-04",row("00830",50,"小額加碼")),
  snapshot("2026-09-03",row("00830",99,"極端機會"),"INTRADAY",true),snapshot("2026-09-04",row("00878",88,"罕見機會","FINAL_CORE_WEIGHT_V1","AD_HOC"))
]);

let series=sandbox.officialC4ComparableSeries("00830",official);
assert.equal(series.status,"READY");assert.equal(series.rows.length,8);assert.equal(series.rows.some(item=>item.score===99),false);
console.log("A/B PASS: trend reads legal FINALIZED_CLOSE only; intraday is excluded");
assert.equal(sandbox.officialC4ComparableSeries("00878",official).status,"UNAVAILABLE");
console.log("C PASS: AD_HOC/non-formal symbol is excluded");
assert.deepEqual(Array.from(series.rows,row=>row.date),["2025-08-01","2026-05-01","2026-08-01","2026-08-20","2026-08-21","2026-08-25","2026-09-01","2026-09-04"]);
console.log("D PASS: official dates are sorted ascending for rendering");

let state=sandbox.officialC4TrendState("00830","30D",official,"2026-09-04");assert.deepEqual(Array.from(state.rows,row=>row.date),["2026-08-20","2026-08-21","2026-08-25","2026-09-01","2026-09-04"]);
console.log("E PASS: 30D uses a calendar-period filter over stored observations");
state=sandbox.officialC4TrendState("00830","90D",official,"2026-09-04");assert.equal(state.rows.length,6);assert.equal(state.rows[0].date,"2026-08-01");
console.log("F PASS: 90D calendar window is correct");
state=sandbox.officialC4TrendState("00830","1Y",official,"2026-09-04");assert.equal(state.rows.length,7);assert.equal(state.rows.some(item=>item.date==="2025-08-01"),false);
console.log("G PASS: 1Y calendar window is correct");

state=sandbox.officialC4TrendState("00830","30D",official,"2026-09-04");assert.equal(state.high.score,66);assert.equal(state.high.date,"2026-09-01");assert.equal(state.low.score,39);assert.equal(state.low.date,"2026-08-20");assert.equal(state.change,11);
console.log("H PASS: high, low and change use raw Official scores");
assert.equal(state.crossings[50],"2026-08-25");assert.equal(state.crossings[65],"2026-09-01");
console.log("I PASS: latest upward threshold crossings are detected");
assert.notEqual(state.crossings[65],"2026-09-04");
console.log("J PASS: downward passage is not mislabeled as an upward crossing");

const mixed=artifact([...official.snapshots,snapshot("2026-07-31",row("00830",70,"深跌加碼","OLD_VERSION")),snapshot("2026-07-30",row("00830",80,"罕見機會","OLD_VERSION"))]);series=sandbox.officialC4ComparableSeries("00830",mixed);assert.equal(series.versionBoundary,true);assert.equal(series.rows.some(item=>item.version==="OLD_VERSION"),false);
console.log("K PASS: a version boundary truncates the comparable series with warning state");
assert.equal(state.rows.some(item=>item.score===0),false);assert.equal(state.rows.length,5);
console.log("L PASS: missing dates are neither generated nor filled with zero");
assert.equal(state.current.score,state.rows.at(-1).score);assert.equal(state.current.date,"2026-09-04");
console.log("M PASS: Official current equals the chart latest point");
assert.doesNotMatch(source,/buildFinal|buildAdHocScore|calculateCanonicalCore|computeCoreScore|localStorage|sessionStorage|fetch\(|setItem\(|LIVE_PROJECTED|intraday-core/i);
console.log("N PASS: trend path performs no C4 recomputation or browser fallback");

const protectedFiles=["finalized-core-score-snapshots-v1.json","intraday-core-snapshots-v1.json","forward-action-policy-v1-ledger.json","forward-validation-ledger.json"].filter(fs.existsSync),hashes=()=>Object.fromEntries(protectedFiles.map(file=>[file,crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")])),before=hashes();
for(const symbol of symbols){const current=production.snapshots.at(-1).rows.find(row=>row.symbol===symbol);state=sandbox.officialC4TrendState(symbol,"90D",production,current?.data_as_of?.slice(0,10));assert.equal(state.status,"READY",`${symbol} needs an Official trend`);assert.equal(state.current.score,current.final_core_score)}
assert.deepEqual(hashes(),before);
console.log("O PASS: all production Formal trends render without protected mutation");
assert.equal(sandbox.officialC4ComparableSeries("009815",production).status,"UNAVAILABLE");assert.doesNotMatch(source,/00631L|HS_LEVERAGE/);
console.log("P/Q PASS: 009815 WAIT_NATIVE remains outside the trend and 00631L is untouched");

const thresholds=sandbox.officialC4ThresholdContract();assert.deepEqual(Array.from(thresholds,row=>row.value),Array.from(decision.NEXT_THRESHOLDS.slice(0,4)));assert.equal(sandbox.officialC4TrendRanges.get("00830"),undefined);
for(const text of ["C4 正式趨勢","目前正式 C4","期間變化","最近跨過 50","最近跨過 65","只連接合法 FINALIZED_CLOSE"])assert.ok(html.includes(text));
assert.match(html,/data-official-c4-range/);assert.match(css,/\.hsC4TrendChart\{/);assert.match(css,/\.hsC4TrendTooltip\{/);assert.match(css,/@media\(max-width:430px\)[\s\S]*?\.hsC4TrendChart svg/);
console.log("UI PASS: default 90D, 30D/90D/1Y controls, fixed-scale SVG, tooltip and mobile guards exist");

const latest=production.snapshots.at(-1),highest=[...latest.rows].filter(item=>symbols.includes(item.symbol)).sort((a,b)=>b.final_core_score-a.final_core_score)[0],actual=sandbox.officialC4TrendState(highest.symbol,"90D",production,latest.date);
console.log(`PRODUCTION ${highest.symbol}: current=${actual.current.score.toFixed(4)} tier=${actual.current.tier} high=${actual.high.score.toFixed(4)}@${actual.high.date} low=${actual.low.score.toFixed(4)}@${actual.low.date} change=${actual.change.toFixed(4)} cross50=${actual.crossings[50]||"NONE"} cross65=${actual.crossings[65]||"NONE"}`);
