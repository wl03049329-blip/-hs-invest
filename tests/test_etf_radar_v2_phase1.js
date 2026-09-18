"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");

const root=path.resolve(__dirname,"..");
const html=fs.readFileSync(path.join(root,"index.html"),"utf8");
const css=fs.readFileSync(path.join(root,"formal-black-gold.css"),"utf8");
const core=fs.readFileSync(path.join(root,"final-core-production.js"),"utf8");

// TODAY: current decision stays canonical/current; comparison stays finalized-close history.
assert.match(html,/function radarTodayHtml\(x,decision,score,dailyPair\)/);
assert.match(html,/const latest=dailyPair\?\.latest\?\.items\?\.\[x\.id\],previous=dailyPair\?\.previous\?\.items\?\.\[x\.id\]/);
assert.match(html,/sourceLabel=source==="official"\?"正式盤後":"本機盤後試算"/);
assert.match(html,/`\$\{sourceLabel\}比較：首次／—`/);
assert.match(html,/decision\?\.marketAsOf\|\|x\.intraday\?\.asOf/);

// WHY SCORE is finalized-only presentation over stored frozen contributions, not a new formula.
assert.match(html,/function radarWhyScoreHtml\(x,decision\)/);
assert.match(html,/function radarOfficialFactorPair\(ticker,artifact=/);
assert.match(html,/snapshot\?\.snapshot_type!=="FINALIZED_CLOSE"/);
assert.match(html,/snapshot\?\.finalized!==true/);
assert.match(html,/factor\.contribution-before\.contribution/);
assert.match(html,/目前分數主要來自/);
assert.match(html,/原始總分/);
assert.match(html,/今日分數變化/);
assert.match(core,/weeklyJ[\s\S]{0,120}weight:30/);
assert.match(core,/dd52[\s\S]{0,120}weight:55/);
assert.match(core,/crash[\s\S]{0,120}weight:15/);

// Phase 4 detail trend uses only finalized records; legacy local history stays isolated.
assert.match(html,/function radarScoreTrendHtml\(x\)/);
assert.match(html,/data-radar-trend-phase="4"/);
assert.match(html,/officialArtifactCoreScoreHistory\(artifact,x\?\.id,120\)/);
assert.match(html,/正式盤後資料暫缺；不以盤中或本機資料補值/);
assert.match(html,/if\(rows\.length>=Math\.max\(1,Math\.min\(10,Number\(limit\)\|\|10\)\)\)break/);
assert.match(html,/snapshotType&&snapshotType!=="FINALIZED_CLOSE"/);

// FEATURED diagnostics are on-demand and retain evaluator maturity / benchmark protections.
assert.match(html,/function featuredDiagnosticFor\(x,rows=x\.officialRows\|\|\[\],asOfDate=null\)/);
assert.match(html,/rows,benchmark,benchmarkRows/);
assert.match(html,/benchmarkItem\?\.officialRowsAdjusted===true/);
assert.match(html,/正式日線診斷｜不參與 Core Score/);
assert.match(html,/if\(x\?\.id==="009815"\)return\{kind:"WAIT_NATIVE"\}/);
assert.doesNotMatch(html,/Generic Swing Score|genericSwingScore|MA284/);

// Detail order and responsive presentation hooks are available without changing My Watchlist mode.
const detailStart=html.indexOf("function buildRadarV2Card(");
const detailEnd=html.indexOf("function switchRadarDetailView",detailStart);
assert.ok(detailStart>=0&&detailEnd>detailStart,"ETF Radar V2 renderer must exist");
const longDetail=html.slice(detailStart,detailEnd);
assert.ok(longDetail.indexOf("radarDetailCoreStatusHtml")<longDetail.indexOf("radarWhyScoreHtml"));
assert.ok(longDetail.indexOf("radarDetailCoreStatusHtml")<longDetail.indexOf("radarDecisionSummaryHtml"));
assert.ok(longDetail.indexOf("radarWhyScoreHtml")<longDetail.indexOf("radarScoreTrendHtml"));
assert.ok(longDetail.indexOf("radarScoreTrendHtml")<longDetail.indexOf("radarMarketPositionHtml"));
assert.match(css,/\.radarV2Section\{/);
assert.match(css,/\.radarScoreTrend svg\{/);
assert.match(css,/\.radarMarketP5MaRows\{display:grid/);
assert.match(css,/@media\(max-width:430px\)\{\.radarV2Section/);

console.log("PASS ETF Radar V2 Phase 1 TODAY / WHY SCORE / Phase 4 EOD trend / diagnostics-only guards");
