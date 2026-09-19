"use strict";

const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const root=path.resolve(__dirname,".."),html=fs.readFileSync(path.join(root,"index.html"),"utf8"),css=fs.readFileSync(path.join(root,"formal-black-gold.css"),"utf8"),decisionLayer=require("../hs-decision-layer-v1.js");
const helperStart=html.indexOf("function radarOverviewRankBadgeHtml"),helperEnd=html.indexOf("function dailyFactorValue",helperStart),cardStart=html.indexOf("function longOverviewCardHtml"),cardEnd=html.indexOf("function scoreFactorValue",cardStart);
assert.ok(helperStart>=0&&helperEnd>helperStart,"overview-only helper block must exist");
assert.ok(cardStart>=0&&cardEnd>cardStart,"overview renderer must exist");
const context={window:{HSDecisionLayerV1:decisionLayer}};vm.createContext(context);vm.runInContext(html.slice(helperStart,helperEnd),context);

for(const [score,threshold,label,distance] of [[45,50,"正式加碼訊號",5],[19,30,"回檔訊號出現",11],[29,30,"回檔訊號出現",1],[39,40,"加碼條件浮現",1],[40,45,"試探加碼",5],[44,45,"試探加碼",1],[49,50,"正式加碼訊號",1],[64,65,"積極加碼訊號",1],[69,70,"強力加碼訊號",1],[79,80,"重大加碼機會",1],[89,90,"歷史極端機會",1]]){
  const result=context.radarOverviewNextLevel(score);
  assert.equal(result.nextThreshold,threshold,`score ${score} threshold`);assert.equal(result.nextLabel,label,`score ${score} label`);assert.equal(result.distance,distance,`score ${score} distance`);
}
assert.equal(context.radarOverviewNextLevel(90).isMaxLevel,true);assert.equal(context.radarOverviewNextLevel(100).isMaxLevel,true);
assert.equal(context.radarOverviewNextLevel(null).available,false);assert.equal(context.radarOverviewNextLevel(undefined).available,false);
assert.deepEqual({...context.radarOverviewScoreDelta(2)},{label:"▲2 今日",tone:"is-up"});
assert.deepEqual({...context.radarOverviewScoreDelta(-2.4)},{label:"▼2.4 今日",tone:"is-down"});
assert.deepEqual({...context.radarOverviewScoreDelta(0)},{label:"±0 今日",tone:"is-flat"});

const overview=html.slice(cardStart,cardEnd);
assert.match(overview,/data-open-radar-detail=/,"whole-card detail navigation remains intact");
assert.match(overview,/radarLongIdentityRow/);assert.match(overview,/radarLongScoreRow/);assert.match(overview,/radarOverviewFactors/);
assert.ok(overview.indexOf("DD52")<overview.indexOf("Weekly J")&&overview.indexOf("Weekly J")<overview.indexOf("Crash 20D"),"factor order follows 55/30/15 importance");
assert.match(overview,/Number\.isFinite\(crash\)\?fmt\(crash\)\+"%":"—"/,"missing Crash renders an em dash without recomputation");
assert.doesNotMatch(overview,/歷史觸發約|historicalTriggerText|正式日排名|decision\?\.cta\?\.detail|stage\?\.recommendation/);
assert.doesNotMatch(overview,/<small>正式訊號<\/small>|<small>當日漲跌<\/small>/);
assert.match(css,/#radarOverview \.radarLongCard/);assert.match(css,/#radarOverview \.radarOverviewFactors\{grid-template-columns:repeat\(3/);assert.match(css,/#radarOverview \.radarRangeTrack\{height:4px/);
assert.match(css,/@media\(max-width:430px\)[\s\S]*#radarOverview \.radarLongCard/);

console.log("PASS ETF Radar overview Phase 1 compact cards, next-level display, factor strip and preserved detail navigation");
