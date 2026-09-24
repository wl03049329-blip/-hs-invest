#!/usr/bin/env node
"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm"),{webcrypto}=require("node:crypto"),{TextEncoder}=require("node:util");
const root=path.resolve(__dirname,".."),html=fs.readFileSync(path.join(root,"index.html"),"utf8"),css=fs.readFileSync(path.join(root,"formal-black-gold.css"),"utf8");
const phase6=html.slice(html.indexOf("function radarHistoryPhase6State"),html.indexOf("function buildRadarV2Card"));
const official=html.slice(html.indexOf("function officialArtifactCoreScoreHistory"),html.indexOf("function localCoreScoreHistory"));
const next=html.slice(html.indexOf("function radarOverviewNextLevel"),html.indexOf("function radarOverviewScoreDelta"));
const validation=html.slice(html.indexOf("function stableResearchValue"),html.indexOf("function longOverviewCardHtml"));
assert.ok(phase6.startsWith("function")&&official.startsWith("function")&&next.startsWith("function")&&validation.startsWith("function"));
const contract=require(path.join(root,"hs-decision-layer-v1.js")),researchSymbols=["0050","00662","00830","00935","009815"],researchArtifacts=new Map(researchSymbols.map(symbol=>[symbol,JSON.parse(fs.readFileSync(path.join(root,"research/c4_historical",`${symbol}.json`),"utf8"))])),researchStatuses=new Map(researchSymbols.map(symbol=>[symbol,"READY"]));
const context={Number,Math,String,Map,Object,Array,TextEncoder,crypto:webcrypto,fetch:async()=>{throw Error("not used")},window:{HSDecisionLayerV1:contract},LONG_RADAR_CODES:new Set(["0050","00662","00757","00830","00935","009815"]),LONG_TERM_CORE_SCORE_VERSION:"FINAL_CORE_WEIGHT_V1",RADAR_RESEARCH_HISTORY_VERSION:"WEEKLY_J_PRODUCTION_LEGACY_V1",RADAR_SCORE_LEVEL_VERSION:"HS_C4_LEVELS_V2",RADAR_RESEARCH_HISTORY_SYMBOLS:researchSymbols,researchC4HistoryArtifacts:researchArtifacts,researchC4HistoryStatus:researchStatuses,HSFinalCoreProduction:require(path.join(root,"final-core-production.js")),isCompletedTradingDate:date=>/^\d{4}-\d{2}-\d{2}$/.test(date),esc:value=>String(value),finalizedCoreScoreHistoryArtifact:null,valuationDetailsHtml:()=>"",legacyComparisonHtml:()=>"",similarStatsHtml:()=>"",buyPlanHtml:()=>""};
vm.createContext(context);vm.runInContext(`${official}\n${next}\n${validation}\n${phase6}\nthis.api={state:radarHistoryPhase6State,render:radarHistoryPhase6Html,validate:validateResearchHistoryArtifact};`,context);

function officialFor(symbol,currentScore,currentDd52,previousScores=[35,41]){
  const scores=[...previousScores,currentScore],dates=scores.map((_,index)=>`2026-09-${String(16+index).padStart(2,"0")}`);
  return{schema_version:1,core_score_version:"FINAL_CORE_WEIGHT_V1",snapshots:scores.map((score,index)=>({date:dates[index],snapshot_type:"FINALIZED_CLOSE",finalized:true,rows:[{symbol,final_core_score:score,core_score_version:"FINAL_CORE_WEIGHT_V1",data_as_of:`${dates[index]}T13:30:00+08:00`,factors:{dd52:{raw:index===scores.length-1?currentDd52:-5}}}]}))};
}

(async()=>{
  for(const [symbol,count] of [["0050",5464],["00662",2252],["00830",1548],["00935",450],["009815",0]]){
    const artifact=researchArtifacts.get(symbol);assert.equal(artifact.records.length,count);assert.equal((await context.api.validate(symbol,artifact)).ok,true);
  }
  const original=researchArtifacts.get("00830"),tampered=JSON.parse(JSON.stringify(original));tampered.records[0].display_score+=1;
  assert.equal((await context.api.validate("00830",tampered)).reason,"INTEGRITY_FAILED");
  const parityMismatch=JSON.parse(JSON.stringify(original));parityMismatch.metadata.parity.mismatches.push({date:"2026-09-18"});
  assert.equal((await context.api.validate("00830",parityMismatch)).reason,"INTEGRITY_FAILED");
  const incompatible=JSON.parse(JSON.stringify(original));incompatible.metadata.weekly_j_version="WEEKLY_J_TW_TRADING_WEEK_V2";
  assert.equal((await context.api.validate("00830",incompatible)).reason,"VERSION_INCOMPATIBLE");

  const artifact=officialFor("00830",45,-21.28,[35,42]);context.finalizedCoreScoreHistoryArtifact=artifact;
  let state=context.api.state({id:"00830"},artifact,researchArtifacts,contract,researchStatuses);
  assert.equal(state.kind,"READY");assert.equal(state.size,1548);assert.equal(state.current.displayScore,45);assert.equal(state.current.dd52,-21.28);
  assert.equal(state.officialRows.length,3);assert.equal(state.lastEntry,"2026-09-18");assert.equal(state.streak,1);
  const expectedPercentile=Math.round(original.records.filter(row=>row.display_score<=45).length/original.records.length*100),expectedDepth=Math.round(original.records.filter(row=>Math.abs(Math.min(row.dd52_raw,0))<=21.28).length/original.records.length*100);
  assert.equal(state.percentile,expectedPercentile);assert.equal(state.dd52Percentile,expectedDepth);
  assert.equal(state.nextDays,original.records.filter(row=>row.display_score>=50).length);
  const rendered=context.api.render({id:"00830"});
  for(const copy of ['data-radar-history-phase="6.6"','data-radar-history-source="research-historical-v1"','data-radar-recent-source="finalized-close"',"歷史研究重建","正式盤後紀錄",`樣本 1,548 個交易日`,`P${expectedPercentile}`,`P${expectedDepth}`,"目前正式持續","最近一次正式進入"])assert.ok(rendered.includes(copy),copy);
  assert.match(rendered,/WEEKLY_J_PRODUCTION_LEGACY_V1/);assert.doesNotMatch(rendered,/歷史後續|勝率|平均報酬|建議買進/);

  assert.equal(context.api.state({id:"009815"},artifact,researchArtifacts,contract,researchStatuses).kind,"WAIT_NATIVE");assert.match(context.api.render({id:"009815"}),/歷史研究資料暫缺/);
  assert.equal(context.api.state({id:"00757"},artifact,researchArtifacts,contract,researchStatuses).kind,"RESEARCH_UNAVAILABLE");
  const incompatibleStatus=new Map(researchStatuses);incompatibleStatus.set("00830","VERSION_INCOMPATIBLE");assert.equal(context.api.state({id:"00830"},artifact,researchArtifacts,contract,incompatibleStatus).kind,"VERSION_INCOMPATIBLE");
  const missing=new Map(researchArtifacts);missing.delete("00830");assert.equal(context.api.state({id:"00830"},artifact,missing,contract,researchStatuses).kind,"RESEARCH_UNAVAILABLE");
  assert.equal(context.api.render({id:"00631L"}),"");
  const production=JSON.parse(fs.readFileSync(path.join(root,"finalized-core-score-snapshots-v1.json"),"utf8")),actual=[];
  for(const symbol of ["0050","00662","00830","00935"]){
    const value=context.api.state({id:symbol},production,researchArtifacts,contract,researchStatuses);
    assert.equal(value.kind,"READY",symbol);assert.equal(value.size,researchArtifacts.get(symbol).metadata.record_count);
    actual.push({symbol,sample:value.size,current:value.current.displayScore,percentile:value.percentile,levelRate:Number(value.levelRate.toFixed(1)),dd52Percentile:value.dd52Percentile});
  }
  assert.match(css,/\.radarHistoryP6Source\{/);assert.match(css,/@media\(max-width:390px\).*\.radarHistoryP6Source\{grid-template-columns:1fr\}/s);
assert.match(html,/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="formal-black-gold\.css(?:\?[^\"]*)?"[^>]*>/);assert.match(html,/20260920-live-archive-resilience-v1/);
  console.log(`PASS ETF Radar Phase 6.6 research history, finalized current state, integrity/version guards and responsive source labels; fixture 00830 P${expectedPercentile}/DD52 P${expectedDepth}`);
  console.log(JSON.stringify(actual));
})().catch(error=>{console.error(error);process.exitCode=1});
