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

// WHY SCORE is presentation over the frozen factors, not a new formula.
assert.match(html,/function radarWhyScoreHtml\(x,decision\)/);
assert.match(html,/strategyBreakdownHtml\(x,"long_term_core"\)/);
assert.match(html,/function radarPrimaryDriver\(decision\)/);
assert.match(html,/weeklyJ:"Weekly J 低檔",dd52:"DD52 回撤深度",crash:"Crash 壓力"/);
assert.match(core,/weeklyJ[\s\S]{0,120}weight:30/);
assert.match(core,/dd52[\s\S]{0,120}weight:55/);
assert.match(core,/crash[\s\S]{0,120}weight:15/);

// SCORE TREND stays formal EOD only and cannot insert the intraday current score.
assert.match(html,/function radarScoreTrendHtml\(ticker,history=loadDailyLongRankHistory\(\)\)/);
assert.match(html,/if\(ticker==="009815"\)return.*WAIT_NATIVE；原生正式 Core Score 歷史尚未建立/s);
assert.match(html,/coreScoreHistoryState\(ticker,history\)/);
assert.match(html,/historyLabel=state\.source==="official"\?"正式盤後":"本機盤後試算"/);
assert.match(html,/本機盤後試算紀錄/);
assert.match(html,/盤中 Core 不納入此趨勢/);
assert.match(html,/if\(rows\.length>=Math\.max\(1,Math\.min\(10,Number\(limit\)\|\|10\)\)\)break/);
assert.match(html,/snapshotType&&snapshotType!=="FINALIZED_CLOSE"/);

// FEATURED diagnostics are on-demand and retain evaluator maturity / benchmark protections.
assert.match(html,/function featuredDiagnosticFor\(x\)/);
assert.match(html,/rows:x\.officialRows\|\|\[\]/);
assert.match(html,/benchmarkRows:benchmarkItem\?\.officialRows\|\|null/);
assert.match(html,/DIAGNOSTICS｜不參與 Core Score/);
assert.match(html,/d\.maturityState==="WAIT_NATIVE"/);
assert.doesNotMatch(html,/Generic Swing Score|genericSwingScore|MA284/);

// Detail order and responsive presentation hooks are available without changing My Watchlist mode.
const detailStart=html.indexOf("function buildRadarV2Card(");
const detailEnd=html.indexOf("function switchRadarDetailView",detailStart);
assert.ok(detailStart>=0&&detailEnd>detailStart,"ETF Radar V2 renderer must exist");
const longDetail=html.slice(detailStart,detailEnd);
assert.ok(longDetail.indexOf("radarTodayHtml")<longDetail.indexOf("radarWhyScoreHtml"));
assert.ok(longDetail.indexOf("radarWhyScoreHtml")<longDetail.indexOf("radarScoreTrendHtml"));
assert.ok(longDetail.indexOf("radarScoreTrendHtml")<longDetail.indexOf("radarMarketPositionHtml"));
assert.match(css,/\.radarV2Section\{/);
assert.match(css,/\.radarScoreTrend svg\{/);
assert.match(css,/\.radarMaGrid\{display:grid/);
assert.match(css,/@media\(max-width:430px\)\{\.radarV2Section/);

console.log("PASS ETF Radar V2 Phase 1 TODAY / WHY SCORE / 10D EOD trend / diagnostics-only guards");
