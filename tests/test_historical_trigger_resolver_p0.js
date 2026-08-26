const assert=require("assert");
const fs=require("fs");
const path=require("path");
const vm=require("vm");
const core=require("../final-core-production.js");

const html=fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8");
const helperStart=html.indexOf("function historicalTriggerRateForScore");
const helperEnd=html.indexOf("function dedicatedSwingStageRecommendation",helperStart);
assert(helperStart>=0&&helperEnd>helperStart,"shared historical trigger resolver must exist");

const context={window:{HSFinalCoreProduction:core}};
vm.createContext(context);
vm.runInContext(html.slice(helperStart,helperEnd),context);

assert.strictEqual(core.historicalTriggerForScore(53.8031197301855),9.04);
assert.strictEqual(context.historicalTriggerText(53.8031197301855),"歷史觸發約 9.04%");
assert.notStrictEqual(context.historicalTriggerText(53.8031197301855),"歷史觸發約 11.60%");

const boundaries=[
  [49.999,11.6],[50,9.04],[64.999,9.04],[65,3.62],[69.999,3.62],
  [70,2.8],[79.999,2.8],[80,1.32],[89.999,1.32],[90,.27]
];
for(const [score,expected] of boundaries)assert.strictEqual(core.historicalTriggerForScore(score),expected,`score ${score}`);

const applyBlock=html.slice(html.indexOf("function applyCanonicalCoreSnapshot"),html.indexOf("function hsLiveNextTier",html.indexOf("function applyCanonicalCoreSnapshot")));
assert.match(applyBlock,/classification=HSFinalCoreProduction\.labelFor\(Number\(record\.score\)\)/);
assert.match(applyBlock,/historicalTriggerRate:classification\.triggerRate/);

const canonicalBlock=html.slice(html.indexOf("function canonicalCoreItem"),html.indexOf("function validatedRadarRefresh"));
const ledger=JSON.parse(fs.readFileSync(path.join(__dirname,"..","intraday-core-snapshots-v1.json"),"utf8"));
const snapshot=ledger.snapshots.filter(row=>row?.items?.["00830"]).at(-1);
const symbols=["0050","00662","00757","00830","00935"];
const all=symbols.map(id=>({id,strategyDecisions:{long_term_core:{historicalTriggerRate:11.6}}}));
const canonicalContext={LONG_RADAR_SCORED_CODES:new Set(symbols),all,HSFinalCoreProduction:core,LONG_TERM_CORE_SCORE_VERSION:core.LONG_TERM_CORE_SCORE_VERSION,liveCanonicalCoreSnapshot:null};
vm.createContext(canonicalContext);
vm.runInContext(canonicalBlock,canonicalContext);
assert.strictEqual(canonicalContext.applyCanonicalCoreSnapshot(snapshot),true);
const current00830=all.find(item=>item.id==="00830").strategyDecisions.long_term_core;
assert.strictEqual(current00830.coreScore,53.8031197301855);
assert.strictEqual(current00830.coreScoreDisplay,53);
assert.strictEqual(current00830.historicalTriggerRate,9.04);
assert.strictEqual(current00830.label,"正式加碼訊號");

const overviewBlock=html.slice(html.indexOf("function longOverviewCardHtml"),html.indexOf("function scoreFactorValue"));
const sheetBlock=html.slice(html.indexOf("function openCoreScoreModal"),html.indexOf("function closeCoreScoreModal"));
const breakdownBlock=html.slice(html.indexOf("function strategyBreakdownHtml"),html.indexOf("function valuationDetailsHtml",html.indexOf("function strategyBreakdownHtml")));
assert.match(overviewBlock,/historicalTriggerText\(decision\?\.coreScore\)/);
assert.match(sheetBlock,/historicalTriggerText\(decision\.coreScore\)/);
assert.match(sheetBlock,/HSFinalCoreProduction\.LABELS/);
assert.match(breakdownBlock,/historicalTriggerText\(decision\.coreScore,\{compact:true\}\)/);
assert.doesNotMatch(sheetBlock,/\[50,64,"正式加碼訊號",9/);

for(const score of [9.35,6.6,6.6,23.1])assert.strictEqual(core.historicalTriggerForScore(score),null);
assert.deepStrictEqual(require("../backtest/long-term/final-core-score-v1.js").WEIGHTS,{weeklyJ:30,dd52:55,crash:15});

console.log("Historical trigger resolver P0: PASS");
