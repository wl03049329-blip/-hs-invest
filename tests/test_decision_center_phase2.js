"use strict";

const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");
const decision=require("../hs-decision-layer-v1.js");
const liveDiagnostics=require("../frontend-live-diagnostics.js");
const canonicalResolver=require("../canonical-score-resolver.js");

const html=fs.readFileSync("index.html","utf8"),css=fs.readFileSync("formal-black-gold.css","utf8"),symbols=["0050","00662","00757","00830","00935"];
const start=html.indexOf("function decisionCenterMarketLabel"),end=html.indexOf("function renderDecisionCenter",start),source=html.slice(start,end);
assert.ok(start>0&&end>start,"Decision Center selectors must be testable in isolation");
const sandbox={window:{HSDecisionLayerV1:decision,HSCanonicalScoreResolver:canonicalResolver},LONG_RADAR_SCORED_CODES:new Set(symbols),homepageFinalDecision:item=>item?.decision||null,archivedIntradayCoreSnapshots:[],liveCanonicalCoreSnapshots:[],taipeiToday:()=>"2026-09-17",esc:value=>String(value)};
vm.runInNewContext(source,sandbox);
const rows=[{symbol:"0050",score:44.2,displayScore:44,tier:"加碼條件浮現"},{symbol:"00662",score:49.6,displayScore:49,tier:"試探加碼"},{symbol:"00757",score:41,displayScore:41,tier:"加碼條件浮現"},{symbol:"00830",score:53.8,displayScore:53,tier:"正式加碼訊號"},{symbol:"00935",score:39,displayScore:39,tier:"回檔訊號出現"}];

assert.equal(sandbox.selectDecisionCenterHighest(rows).symbol,"00830");
const officialItems=Object.fromEntries([...symbols,"009815","00878"].map((symbol,index)=>[symbol,{official:{status:"FINALIZED",score:40+index,display_score:40+index,trading_date:"2026-09-04"}}]));
const formalRows=sandbox.decisionCenterOfficialRows({items:officialItems},[...symbols,"009815","00878"].map(id=>({id,decision:{label:"一般持有"}})));
assert.deepEqual(Array.from(formalRows,row=>row.symbol),symbols);
console.log("A PASS: highest selector consumes formal Official rows only; LIVE is absent from the path");

let opportunity=sandbox.selectDecisionCenterOpportunity(rows,decision);
assert.equal(opportunity.symbol,"00662");assert.ok(Math.abs(opportunity.distance-.4)<1e-9);assert.equal(opportunity.nextThreshold,50);assert.equal(opportunity.nextLabel,"正式加碼訊號");
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
assert.match(html,/系統不使用替代值估算/);
assert.match(html,/前日 FINAL/);
assert.match(html,/盤中狀態<\/dt><dd>\$\{esc\(emptyMessage\)\}/);
assert.match(html,/獨立策略｜不納入 C4 排名/);
assert.match(html,/市場情緒：\$\{esc\(overviewValue\)\}/);
assert.match(css,/\.hsDashboardC4Grid\{[^}]*grid-template-columns:repeat\(2/);
assert.match(css,/\.hsDashboardC4Card\.is-leader\{grid-column:1\/-1/);
assert.match(html,/data-home-c4-sort="score"/);assert.match(html,/data-home-c4-sort="change"/);assert.match(html,/data-home-c4-sort="threshold"/);
assert.equal(liveDiagnostics.messageFor("FRONTEND_STATE_PENDING"),"盤中資料同步中");
assert.equal(liveDiagnostics.messageFor("SNAPSHOT_STALE"),"盤中行情暫時過期");
assert.equal(liveDiagnostics.messageFor("MARKET_CLOSED"),"今日盤中軌跡已封存");
assert.doesNotMatch(html,/id="homeSwingBrief"/);
assert.doesNotMatch(source,/calculateFinalCore|buildFinal\(|buildAdHocScore\(|evaluateCrashVelocity|localStorage|sessionStorage|\.setItem\(/);
console.log("PASS HS mockup dashboard is responsive, six-symbol and presentation-only");

const archived=JSON.parse(fs.readFileSync("intraday-core-snapshots-v1.json","utf8")).snapshots;
sandbox.archivedIntradayCoreSnapshots=archived;
const previous=sandbox.homeC4PreviousSessionSummary("00830","2026-09-17");
assert.deepEqual(JSON.parse(JSON.stringify(previous)),{date:"2026-09-16",high:50,low:49,last:49});
assert.match(sandbox.homeC4PreviousSessionPanel(previous),/09\/16 盤中[\s\S]*高 50｜低 49｜末 49/);
assert.equal(sandbox.homeC4LatestPreviousSessionDate("2026-09-17"),"2026-09-16");
const mockSnapshot=(date,slot,score)=>({status:"SUCCESS",trading_date:date,market_as_of:`${date}T${slot}:00+08:00`,items:{"00830":{status:"SUCCESS",display_score:score,market_as_of:`${date}T${slot}:00+08:00`}}});
sandbox.archivedIntradayCoreSnapshots=[mockSnapshot("2026-09-13","13:30",45),mockSnapshot("2026-09-18","09:05",47),mockSnapshot("2026-09-18","13:30",48),mockSnapshot("2026-09-21","09:05",49)];
assert.equal(sandbox.homeC4PreviousSessionSummary("00830","2026-09-21").date,"2026-09-18","Monday premarket must use Friday's nearest stored trajectory");
assert.equal(sandbox.homeC4PreviousSessionSummary("00830","2026-09-17").date,"2026-09-13","missing prior-day snapshots must search backward to the nearest stored trajectory");
const archivedToday=[mockSnapshot("2026-09-18","09:05",47),mockSnapshot("2026-09-18","09:06",48)];
sandbox.archivedIntradayCoreSnapshots=archivedToday;
sandbox.finalizedCoreScoreHistoryArtifact={};
sandbox.officialC4HistoryViewModel=()=>new Map(symbols.map(symbol=>[symbol,{rows:[{score:38},{score:39}]}]));
const officialDayRows=symbols.map(symbol=>({symbol,score:39,displayScore:39,date:"2026-09-17",tier:"回檔訊號出現"}));
const longRows=symbols.map(id=>({id,name:id,decision:{label:"回檔訊號出現"}}));
const archivedRows=sandbox.decisionCenterC4Rows(officialDayRows,longRows,{target_date:"2026-09-18",market_state:"CLOSED",items:{}});
const archived00830=archivedRows.find(row=>row.symbol==="00830");
assert.equal(archived00830.officialDate,"2026-09-17");
assert.equal(archived00830.trajectoryDate,"2026-09-18");
assert.equal(archived00830.series.length,2);
assert.equal(archived00830.useLive,false,"archived trajectory must never be promoted to LIVE");
const liveItems=Object.fromEntries(symbols.map((symbol,index)=>[symbol,{live:{display_eligible:true,status:"LIVE_PROJECTED",trading_date:"2026-09-18",display_score:50+index,score:50.25+index,delta_vs_official:1,tier:"正式加碼訊號",market_as_of:"2026-09-18T09:10:00+08:00"}}]));
sandbox.currentFrontendLiveRenderState=()=>"LIVE_ACTIVE";
sandbox.decisionCenterDistanceText=value=>String(value);
sandbox.formatHomeQuoteTime=value=>String(value).slice(11,16);
sandbox.window.HSLiveDiagnostics={messageFor:()=>"盤中更新中"};
const liveHtml=sandbox.decisionCenterC4Cards(officialDayRows,longRows,{target_date:"2026-09-18",market_state:"OPEN",items:liveItems});
assert.match(liveHtml,/data-c4-source="LIVE"/);
assert.match(liveHtml,/<b>53\.3<\/b>/);
assert.match(liveHtml,/09:05[\s\S]*更新 09:10/);
assert.match(liveHtml,/data-c4-source="WAIT_NATIVE"/);
assert.match(source,/snapshot\?\.trading_date<targetDate/);
assert.match(source,/trackStarted=row\.series\.length>0&&row\.trajectoryDate===dualTrack\?\.target_date/);
assert.match(source,/homeC4Sparkline\(row\.series,row\.symbol,emptyMessage,row\.trajectoryDate\)/);
assert.match(source,/waitingPreviousDate[\s\S]*等待原生資料[\s\S]*WAIT_NATIVE/);
assert.match(html,/function applyLiveCoreState\(sequence/);
assert.match(html,/archiveAccepted[\s\S]*archivedIntradayCoreSnapshots=archivedSnapshots/);
console.log("PASS previous-session intraday summary uses the nearest stored trajectory, switches away during today's track and preserves WAIT_NATIVE");
