"use strict";

const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const root=path.resolve(__dirname,".."),html=fs.readFileSync(path.join(root,"index.html"),"utf8"),css=fs.readFileSync(path.join(root,"formal-black-gold.css"),"utf8"),decisionLayer=require("../hs-decision-layer-v1.js");
const phase1Start=html.indexOf("function radarOverviewRankBadgeHtml"),phase1End=html.indexOf("function dailyFactorValue",phase1Start),detailStart=html.indexOf("function radarDetailCoreStatusHtml"),detailEnd=html.indexOf("function radarPrimaryDriver",detailStart),cardStart=html.indexOf('if(mode==="long_term_core"){',html.indexOf("function buildRadarV2Card")),cardEnd=html.indexOf('if(mode==="leveraged")',cardStart);
assert.ok(phase1Start>=0&&phase1End>phase1Start&&detailStart>=0&&detailEnd>detailStart&&cardStart>=0&&cardEnd>cardStart);
const context={Number,Math,window:{HSDecisionLayerV1:decisionLayer},esc:value=>String(value),officialDisplayScore:row=>{const score=Number(row?.display_score??row?.final_core_score);return Number.isFinite(score)?Math.floor(score):null},finalDecisionBadgeLabel:presentation=>presentation?.decision_label_zh||"資料暫缺"};
vm.createContext(context);vm.runInContext(html.slice(phase1Start,phase1End)+"\n"+html.slice(detailStart,detailEnd),context);
const pair=(latest,previous)=>({latest:{items:{"00830":latest}},previous:{items:{"00830":previous}}}),render=(score,latest,previous,decisionStage="PROBE_ADD")=>context.radarDetailCoreStatusHtml({id:"00830",name:"國泰費城半導體",date:"2026-09-17"},{marketAsOf:"2026-09-17T13:30:00+08:00"},score,pair(latest,previous),{decision_stage:decisionStage,decision_label_zh:decisionLayer.STAGES.find(row=>score>=row.min)?.label},1);
let output=render(45,{display_score:45},{display_score:49});
assert.match(output,/45[\s\S]*CORE SCORE/);assert.match(output,/試探加碼/);assert.match(output,/49 → 45/);assert.match(output,/▼4/);assert.match(output,/下一級[\s\S]*50 正式加碼訊號/);assert.match(output,/距離[\s\S]*5 分/);
for(const [score,threshold,label,distance] of [[19,30,"回檔訊號出現",11],[29,30,"回檔訊號出現",1],[39,40,"加碼條件浮現",1],[44,45,"試探加碼",1],[49,50,"正式加碼訊號",1],[64,65,"積極加碼訊號",1],[69,70,"強力加碼訊號",1],[79,80,"重大加碼機會",1],[89,90,"歷史極端機會",1]]){output=render(score,{display_score:score},{display_score:score});assert.match(output,new RegExp(`${threshold} ${label}`));assert.match(output,new RegExp(`>${distance} 分<`))}
assert.match(render(90,{display_score:90},{display_score:89},"HISTORICAL_EXTREME_OPPORTUNITY"),/已進入最高級別/);
assert.match(render(45,{display_score:45},null),/最新正式變化[\s\S]*>—</);
output=render(null,null,{display_score:49},null);assert.match(output,/資料暫缺/);assert.doesNotMatch(output,/試探加碼|正式加碼訊號|強力加碼訊號/);
const longCard=html.slice(cardStart,cardEnd);assert.match(longCard,/radarDetailCoreStatusHtml/);assert.doesNotMatch(longCard,/signalDetailHero|radarTodayHtml\(x,decision,score,dailyPair\)|detailGrandTotal/);assert.ok(longCard.indexOf("radarDetailCoreStatusHtml")<longCard.indexOf("radarDecisionSummaryHtml")&&longCard.indexOf("radarDecisionSummaryHtml")<longCard.indexOf("radarWhyScoreHtml"));
assert.match(html.slice(detailStart,detailEnd),/radarOverviewNextLevel\(hasScore\?score:null\)/,"Phase 2 must reuse the Phase 1 next-level helper");
assert.match(css,/\.radarDetailDeck\.is-open \.signalCard\.is-selected>\.radarDetailSummary\{display:none!important\}/);assert.match(css,/\.radarDetailCoreStatus\{/);assert.match(css,/@media\(max-width:430px\)[\s\S]*\.radarDetailCoreFacts/);
assert.match(css,/\.radarDetailDeck\.is-open \.signalCard\.is-selected \.radarDecisionSummary \.radarDecisionLead>b\{display:none\}/,"the secondary decision section must not repeat the primary status label");
console.log("PASS ETF Radar Detail Phase 2 compact core status, official delta, shared next-level helper and unavailable guards");
