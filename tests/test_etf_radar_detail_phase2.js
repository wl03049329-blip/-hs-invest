"use strict";

const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const root=path.resolve(__dirname,".."),html=fs.readFileSync(path.join(root,"index.html"),"utf8"),css=fs.readFileSync(path.join(root,"formal-black-gold.css"),"utf8"),decisionLayer=require("../hs-decision-layer-v1.js");
const phase1Start=html.indexOf("function radarOverviewRankBadgeHtml"),phase1End=html.indexOf("function dailyFactorValue",phase1Start),detailStart=html.indexOf("function radarDetailCoreStatusHtml"),detailEnd=html.indexOf("function radarPrimaryDriver",detailStart),cardStart=html.indexOf('if(mode==="long_term_core"){',html.indexOf("function buildRadarV2Card")),cardEnd=html.indexOf('if(mode==="leveraged")',cardStart);
assert.ok(phase1Start>=0&&phase1End>phase1Start&&detailStart>=0&&detailEnd>detailStart&&cardStart>=0&&cardEnd>cardStart);
const context={Number,Math,window:{HSDecisionLayerV1:decisionLayer},esc:value=>String(value),history:[],finalizedCoreScoreHistoryArtifact:{},officialArtifactCoreScoreHistory:(_artifact,_symbol,limit)=>context.history.slice(0,limit)};
vm.createContext(context);vm.runInContext(html.slice(phase1Start,phase1End)+"\n"+html.slice(detailStart,detailEnd),context);
const render=(score,previous)=>{context.history=score===null?[]:[{displayScore:score,status:decisionLayer.STAGES.find(row=>score>=row.min)?.label,tradingDate:"2026-09-23"},...(previous===null?[]:[{displayScore:previous,status:"前日級距",tradingDate:"2026-09-22"}])];return context.radarDetailCoreStatusHtml({id:"00830",name:"國泰費城半導體"},null,99,null,null,1)};
let output=render(45,49);
assert.match(output,/正式分數<\/small><b>45/);assert.match(output,/試探加碼/);assert.match(output,/49 → 45/);assert.match(output,/今日 -4 分/);assert.match(output,/正式加碼訊號（50 分）｜還差 5 分/);assert.doesNotMatch(output,/99/);
for(const [score,threshold,label,distance] of [[19,30,"回檔訊號出現",11],[29,30,"回檔訊號出現",1],[39,40,"加碼條件浮現",1],[44,45,"試探加碼",1],[49,50,"正式加碼訊號",1],[64,65,"積極加碼訊號",1],[69,70,"強力加碼訊號",1],[79,80,"重大加碼機會",1],[89,90,"歷史極端機會",1]]){output=render(score,score);assert.match(output,new RegExp(`${label}（${threshold} 分）｜還差 ${distance} 分`));assert.match(output,/今日持平/)}
assert.match(render(40,39),/今日 \+1 分/);assert.match(render(90,89),/已進入最高級距/);
assert.match(render(45,null),/歷史資料不足/);
output=render(null,49);assert.match(output,/資料暫缺/);assert.doesNotMatch(output,/試探加碼|正式加碼訊號|強力加碼訊號/);
const longCard=html.slice(cardStart,cardEnd);assert.match(longCard,/radarDetailCoreStatusHtml/);assert.doesNotMatch(longCard,/signalDetailHero|radarTodayHtml\(x,decision,score,dailyPair\)|detailGrandTotal/);assert.ok(longCard.indexOf("radarDetailCoreStatusHtml")<longCard.indexOf("radarScoreTrendHtml")&&longCard.indexOf("radarScoreTrendHtml")<longCard.indexOf("radarMarketPositionHtml"));
assert.match(html.slice(detailStart,detailEnd),/radarOverviewNextLevel\(hasScore\?latestScore:null\)/,"Next level must reuse the formal contract helper");
assert.match(css,/\.radarDetailDeck\.is-open \.signalCard\.is-selected>\.radarDetailSummary\{display:none!important\}/);assert.match(css,/\.radarDetailCoreStatus\{/);assert.match(css,/@media\(max-width:430px\)[\s\S]*\.radarDetailCoreFacts/);
assert.match(css,/\.radarDetailDeck\.is-open \.signalCard\.is-selected \.radarDecisionSummary \.radarDecisionLead>b\{display:none\}/);
console.log("PASS ETF Radar Detail Phase 1 information architecture, finalized delta, shared next-level helper and unavailable guards");
