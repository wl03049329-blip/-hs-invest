"use strict";

const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");
const decision=require("../hs-decision-layer-v1.js");

const html=fs.readFileSync("index.html","utf8"),css=fs.readFileSync("formal-black-gold.css","utf8"),symbols=["0050","00662","00757","00830","00935"];
const start=html.indexOf("function decisionCenterMarketLabel"),end=html.indexOf("function renderDecisionCenter",start),source=html.slice(start,end);
assert.ok(start>0&&end>start,"Decision Center selectors must be testable in isolation");
const sandbox={window:{HSDecisionLayerV1:decision},LONG_RADAR_SCORED_CODES:new Set(symbols),homepageFinalDecision:item=>item?.decision||null};
vm.runInNewContext(source,sandbox);
const rows=[{symbol:"0050",score:44.2,displayScore:44,tier:"回檔觀察"},{symbol:"00662",score:49.6,displayScore:49,tier:"回檔觀察"},{symbol:"00757",score:41,displayScore:41,tier:"回檔觀察"},{symbol:"00830",score:53.8,displayScore:53,tier:"小額加碼"},{symbol:"00935",score:39,displayScore:39,tier:"一般持有"}];

assert.equal(sandbox.selectDecisionCenterHighest(rows).symbol,"00830");
const officialItems=Object.fromEntries([...symbols,"009815","00878"].map((symbol,index)=>[symbol,{official:{status:"FINALIZED",score:40+index,display_score:40+index,trading_date:"2026-09-04"}}]));
const formalRows=sandbox.decisionCenterOfficialRows({items:officialItems},[...symbols,"009815","00878"].map(id=>({id,decision:{label:"一般持有"}})));
assert.deepEqual(Array.from(formalRows,row=>row.symbol),symbols);
console.log("A PASS: highest selector consumes formal Official rows only; LIVE is absent from the path");

let opportunity=sandbox.selectDecisionCenterOpportunity(rows,decision);
assert.equal(opportunity.symbol,"00662");assert.ok(Math.abs(opportunity.distance-.4)<1e-9);assert.equal(opportunity.nextThreshold,50);assert.equal(opportunity.nextLabel,"小額加碼");
console.log("B PASS: opportunity distance uses raw Official 49.6, not display-floor 49");

const dualTrack=state=>({market_state:state,items:Object.fromEntries(symbols.map((ticker,index)=>[ticker,{ticker,official:{display_score:40+index},live:{display_eligible:true,display_score:45+index,delta_vs_official:ticker==="00662"?-7:index}}]))});
let live=sandbox.selectDecisionCenterLiveMove(dualTrack("OPEN"));assert.equal(live.status,"READY");assert.equal(live.item.ticker,"00662");
console.log("C PASS: OPEN selects the largest absolute eligible LIVE delta");
for(const state of ["CLOSED","HOLIDAY"]){live=sandbox.selectDecisionCenterLiveMove(dualTrack(state));assert.equal(live.status,"OFF_SESSION");assert.equal(live.item,null)}
console.log("D/E PASS: CLOSED and HOLIDAY never present old LIVE as current");
const stale=dualTrack("OPEN");stale.items["00662"].live.display_eligible=false;live=sandbox.selectDecisionCenterLiveMove(stale);assert.notEqual(live.item?.ticker,"00662");
console.log("F PASS: stale/ineligible LIVE is excluded");

assert.deepEqual([...sandbox.LONG_RADAR_SCORED_CODES],symbols);assert.equal(sandbox.LONG_RADAR_SCORED_CODES.has("009815"),false);assert.equal(sandbox.LONG_RADAR_SCORED_CODES.has("00878"),false);
console.log("G/H PASS: 009815 and AD_HOC remain outside Formal ranking and opportunity selection");

assert.equal(JSON.stringify(sandbox.decisionCenterLeverageSummary({status:"STANDBY",available:true,trigger:false})),JSON.stringify({label:"等待訊號",detail:"正式狀態 STANDBY",healthy:true}));
assert.doesNotMatch(source,/evaluateCrashVelocity|HS_LEVERAGE_C_V1|2\.033335/);
console.log("I PASS: 00631L summary only translates an existing production result");

assert.doesNotMatch(source,/buildFinal|buildAdHocScore|calculateCanonicalCore|computeCoreScore|localStorage|sessionStorage|fetch\(|\.setItem\(/);
console.log("J/K/L PASS: no C4 recomputation, browser truth, write path or protected mutation");

for(const state of ["PREMARKET","OPEN","CLOSED","HOLIDAY","STALE"])assert.ok(sandbox.decisionCenterMarketLabel(state));
for(const text of ["今日核心決策","目前分數","C4 今日盤中追蹤","市場情緒快覽","00631L 槓桿戰術","資料狀態"])assert.ok(html.includes(text));
assert.match(css,/\.hsCoreDecisionHero\{[^}]*display:grid/);assert.match(css,/@media\(max-width:430px\)[\s\S]*?\.hsDecisionStatusRail\{grid-template-columns:repeat\(2/);
console.log("PASS HS Decision Center Phase 2 summary and responsive contract");

for(const marker of ["今日核心決策","市場情緒快覽","C4 今日盤中追蹤","00631L 槓桿戰術雷達","hsDashboardC4Grid","hsDecisionStatusRail"])assert.ok(html.includes(marker),`${marker} must remain on the homepage`);
const order=["id=\"hsDecisionRoom\"","id=\"homeSentiment\"","id=\"homeEtfBrief\"","id=\"homeLeverageBrief\""].map(marker=>html.indexOf(marker));
assert.ok(order.every((value,index)=>value>0&&(index===0||value>order[index-1])),"homepage operations flow must be Hero -> Sentiment -> C4 -> 00631L");
assert.match(html,/function decisionCenterC4Rows[\s\S]*?selectDecisionCenterOpportunity\(\[\{symbol,score:rawScore\}\]\)/);
assert.match(html,/HS_DASHBOARD_C4_SYMBOLS=Object\.freeze\(\["0050","00662","00757","00830","00935","009815"\]\)/);
assert.match(html,/WAIT_NATIVE/);
assert.match(html,/不以替代值補算/);
assert.match(css,/\.hsDashboardC4Grid\{[^}]*grid-template-columns:repeat\(2/);
assert.match(css,/\.hsDashboardC4Card\.is-leader\{grid-column:1\/-1/);
assert.match(html,/data-home-c4-sort="score"/);assert.match(html,/data-home-c4-sort="change"/);assert.match(html,/data-home-c4-sort="threshold"/);
assert.match(html,/今日盤中軌跡尚未累積/);
assert.doesNotMatch(html,/id="homeSwingBrief"/);
assert.doesNotMatch(source,/calculateFinalCore|buildFinal\(|buildAdHocScore\(|evaluateCrashVelocity|localStorage|sessionStorage|\.setItem\(/);
console.log("PASS HS mockup dashboard is responsive, six-symbol and presentation-only");
