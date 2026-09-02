const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const html = fs.readFileSync("index.html", "utf8");
const css = fs.readFileSync("formal-black-gold.css", "utf8");
const decisionLayer = require("../hs-decision-layer-v1.js");
const radarBlock = html.slice(html.indexOf("function radarDecisionLayerFor"), html.indexOf("function detailAdvancedHtml"));
const cardBuilderStart = html.indexOf("function buildRadarV2Card");
const longCardStart = html.indexOf('if(mode==="long_term_core"){', cardBuilderStart);
const longCard = html.slice(longCardStart, html.indexOf('if(mode==="leveraged")', longCardStart));

// 1–2: the Radar has one adapter path and no financial decision implementation.
assert.match(radarBlock, /interpreter\.interpret\(buildHSTodayDecisionInput\(x\)\)/);
assert.doesNotMatch(radarBlock, /HSFinalCoreProduction\.buildFinal|computeCoreScore|calculateWeekly|buildIntradayRadarBatch/);
assert.doesNotMatch(radarBlock, /score\s*(?:>=|<=|>|<)\s*\d/);

// 3–8: formal Core remains first; Decision fields are rendered directly and compactly.
assert.match(longCard, /signalDetailHero[\s\S]*radarTodayHtml\(x,decision,score,dailyPair\)[\s\S]*radarDecisionSummaryHtml\(x\)/);
assert.match(radarBlock, /decision\.decision_label_zh/);
assert.match(radarBlock, /decision\.distance_to_next_stage/);
assert.match(radarBlock, /hsTodayDriverLabel\(decision\.primary_driver\)/);
assert.match(radarBlock, /hsTodayPosture\(decision\.capital_posture\)/);
assert.match(radarBlock, /decision\.explanation_text_zh/);
assert.doesNotMatch(radarBlock, /\d+\s*%/);
assert.match(css, /\.radarDecisionSummary\{/);

// 9–12: unavailable states are explicit and cannot become normal stages.
assert.match(radarBlock, /source_status!=="SUCCESS"\|\|!decision\.decision_stage/);
assert.match(radarBlock, /source_status==="WAIT_NATIVE"/);
assert.match(radarBlock, /source_status==="STALE"/);
assert.match(radarBlock, /資料尚未齊備[\s\S]*暫不提供決策摘要/);

// 13–16: 00631L branch and historical formal score paths remain separate.
assert.doesNotMatch(html.slice(html.indexOf('if(mode==="leveraged")'), html.indexOf('const s=x.swingDecision', html.indexOf('if(mode==="leveraged")'))), /radarDecisionSummaryHtml/);
assert.match(html, /leverageRadarDashboardHtml\(x\)/);
assert.match(html, /radarScoreTrendHtml\(x\.id\)/);
assert.match(html, /盤中 Core 不納入此趨勢/);
assert.match(html, /officialCount>=20[\s\S]*1M[\s\S]*officialCount>=60[\s\S]*3M/);

// 17: Homepage and Radar resolve exactly the same interpreter output for one canonical input.
const input = {symbol:"0050",score:58,sourceStatus:"SUCCESS",currentFactors:{weeklyJ:{contribution:18},dd52:{contribution:31},crash:{contribution:9}},baseline:{type:"FINALIZED_CLOSE",score:52,factors:{weeklyJ:{contribution:16},dd52:{contribution:27},crash:{contribution:9}}}};
const sandbox = {window:{HSDecisionLayerV1:decisionLayer}, strategyModeFor:x => x.id === "00631L" ? "leveraged" : "long_term_core", buildHSTodayDecisionInput:() => input};
vm.runInNewContext(radarBlock, sandbox);
assert.deepStrictEqual(JSON.parse(JSON.stringify(sandbox.radarDecisionLayerFor({id:"0050"}))), JSON.parse(JSON.stringify(decisionLayer.interpret(input))));
assert.strictEqual(sandbox.radarDecisionLayerFor({id:"00631L"}), null);

// 18–20: special swing products and mobile-safe presentation remain untouched.
assert.match(html, /mode==="swing00733"/);
assert.match(html, /mode==="swing006201"/);
assert.match(css, /@media\(max-width:430px\)\{\.radarDecisionSummary/);
console.log("ETF Radar Decision Layer Phase 4: PASS");
