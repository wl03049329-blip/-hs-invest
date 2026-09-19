#!/usr/bin/env node
"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const root=path.resolve(__dirname,".."),html=fs.readFileSync(path.join(root,"index.html"),"utf8"),css=fs.readFileSync(path.join(root,"formal-black-gold.css"),"utf8");
const buildStart=html.indexOf("function buildRadarV2Card"),longStart=html.indexOf('if(mode==="long_term_core"){',buildStart),longCard=html.slice(longStart,html.indexOf('if(mode==="leveraged")',longStart));
const research=html.slice(html.indexOf("function radarHistoricalResearchHtml"),html.indexOf("function buildRadarV2Card"));
const market=html.slice(html.indexOf("function radarMarketPositionHtml"),html.indexOf("// ETF Radar deliberately"));
const trend=html.slice(html.indexOf("function radarScoreTrendHtml"),html.indexOf("function featuredDiagnosticFor"));

assert.match(html,/data-radar-ux-phase="8\.5"/);
assert.match(html,/20260919-radar-focus-phase9/);
assert.ok(longCard.indexOf("radarDetailCoreStatusHtml")<longCard.indexOf("radarDecisionSummaryHtml"));
assert.ok(longCard.indexOf("radarDecisionSummaryHtml")<longCard.indexOf("radarDetailTrendSummaryHtml"));
assert.ok(longCard.indexOf("radarDetailTrendSummaryHtml")<longCard.indexOf("radarWhyScoreHtml"));
assert.ok(longCard.indexOf("radarWhyScoreHtml")<longCard.indexOf("radarScoreTrendHtml"));
assert.ok(longCard.indexOf("radarScoreTrendHtml")<longCard.indexOf("radarMarketPositionHtml"));
assert.ok(longCard.indexOf("radarMarketPositionHtml")<longCard.indexOf("detailAdvancedHtml"));
assert.doesNotMatch(longCard,/detailCoreMetrics|scoreReason/);

assert.match(research,/<details class="radarResearchHub" data-radar-research-hub><summary aria-expanded="false">/);
assert.match(research,/歷史位置 \$\{esc\(position\)\} · 20D \$\{esc\(outcome\)\} · \$\{esc\(sample\)\}/);
assert.ok(research.indexOf("radarHistoryPhase6Html(x)")<research.indexOf("radarOutcomePhase7BHtml(x)"));
assert.match(research,/radarHistoryPhase6Html\(x\)/);assert.match(research,/radarOutcomePhase7BHtml\(x\)/);

assert.match(market,/radarMarketP5Disclosure" open><summary aria-expanded="true"/);
assert.equal((market.match(/class="radarMarketP5Disclosure"/g)||[]).length,3);
assert.match(market,/動能與超賣/);assert.match(market,/止跌確認/);assert.match(market,/週 J · 週乖離 · RS/);
assert.match(trend,/近期趨勢與訊號/);assert.match(trend,/價格表現/);assert.match(trend,/近期跨級事件/);assert.match(trend,/距52週高點/);assert.match(trend,/距20日低點/);
assert.doesNotMatch(trend,/距60日高點/);

assert.match(html,/addEventListener\("toggle"[\s\S]*aria-expanded/);
assert.match(css,/\.radarResearchHub>summary\{[^}]*min-height:56px/);
assert.match(css,/@media\(max-width:430px\)[\s\S]*\.radarResearchHub>summary\{min-height:52px/);
assert.match(css,/\.radarMarketP5Disclosure>summary[^}]*min-height:52px/);
assert.match(css,/@media\(max-width:430px\)[\s\S]*\.radarMarketP5Disclosure>summary\{[^}]*min-height:50px/);
assert.match(css,/@media\(max-width:430px\)/);assert.match(css,/@media\(max-width:375px\)/);

console.log("PASS ETF Radar Phase 8.5 detail hierarchy, collapsed historical research, market accordions, accessibility and compact trend presentation");
