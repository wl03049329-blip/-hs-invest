#!/usr/bin/env node
"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm"),{webcrypto}=require("node:crypto"),{TextEncoder}=require("node:util");
const root=path.resolve(__dirname,".."),html=fs.readFileSync(path.join(root,"index.html"),"utf8"),css=fs.readFileSync(path.join(root,"formal-black-gold.css"),"utf8");
const validation=html.slice(html.indexOf("function stableResearchValue"),html.indexOf("function longOverviewCardHtml"));
const outcomes=html.slice(html.indexOf("function radarOutcomeDd52Band"),html.indexOf("function detailAdvancedHtml"));
assert.ok(validation.startsWith("function")&&outcomes.startsWith("function"));
const contract=require(path.join(root,"hs-decision-layer-v1.js")),symbols=["0050","00662","00830","00935"],researchArtifacts=new Map(symbols.map(symbol=>[symbol,JSON.parse(fs.readFileSync(path.join(root,"research/c4_historical",`${symbol}.json`),"utf8"))])),outcomeArtifacts=new Map(symbols.map(symbol=>[symbol,JSON.parse(fs.readFileSync(path.join(root,"research/c4_outcomes/summary",`${symbol}.json`),"utf8"))])),outcomeStatuses=new Map([...symbols.map(symbol=>[symbol,"READY"]),["009815","WAIT_NATIVE"]]);
const indexArtifact=JSON.parse(fs.readFileSync(path.join(root,"research/c4_outcomes/index.json"),"utf8"));
function phase6(score=44,dd52=-19.67){
  const current=contract.STAGES.find(row=>score>=row.min),nextThreshold=contract.NEXT_THRESHOLDS.find(value=>value>score),nextStage=contract.STAGES.find(row=>row.min===nextThreshold);
  return{kind:"READY",current:{stage:current.stage,stageLabel:current.label,displayScore:score,dd52},next:{isMaxLevel:nextThreshold===undefined,nextThreshold,nextLabel:nextStage?.label||"最高級別"}};
}
const context={Number,Math,String,Map,Object,Array,TextEncoder,crypto:webcrypto,fetch:async()=>{throw Error("not used")},window:{HSDecisionLayerV1:contract},LONG_RADAR_CODES:new Set([...symbols,"009815"]),LONG_TERM_CORE_SCORE_VERSION:"FINAL_CORE_WEIGHT_V1",RADAR_RESEARCH_HISTORY_VERSION:"WEEKLY_J_PRODUCTION_LEGACY_V1",RADAR_SCORE_LEVEL_VERSION:"HS_C4_LEVELS_V2",RADAR_OUTCOME_STATUS:"RESEARCH_HISTORICAL_OUTCOME_V1",RADAR_OUTCOME_SYMBOLS:[...symbols,"009815"],RADAR_RESEARCH_HISTORY_SYMBOLS:[...symbols,"009815"],researchC4HistoryArtifacts:researchArtifacts,researchC4HistoryStatus:new Map(),researchC4OutcomeArtifacts:outcomeArtifacts,researchC4OutcomeStatus:outcomeStatuses,radarOutcomeModes:new Map(),LONG_RADAR_CODES:new Set([...symbols,"009815"]),esc:value=>String(value),radarHistoryPhase6State:x=>phase6(x?.score??44,x?.dd52??-19.67)};
vm.createContext(context);vm.runInContext(`${validation}\n${outcomes}\nthis.api={validateIndex:validateResearchOutcomeIndex,validate:validateResearchOutcomeArtifact,state:radarOutcomePhase7BState,render:radarOutcomePhase7BHtml,horizon:radarOutcomeHorizonHtml,band:radarOutcomeDd52Band};`,context);

(async()=>{
  assert.equal((await context.api.validateIndex(indexArtifact)).ok,true);
  for(const symbol of symbols){
    const entry=indexArtifact.etfs.find(row=>row.etf===symbol),checked=await context.api.validate(symbol,outcomeArtifacts.get(symbol),entry,researchArtifacts.get(symbol));
    assert.equal(checked.ok,true,symbol);assert.equal(checked.artifact.metadata.strategy_id,"FINAL_CORE_WEIGHT_V1");assert.equal(checked.artifact.metadata.forward_definition,"adjusted_close[t+N] / adjusted_close[t] - 1");
  }
  const tampered=structuredClone(outcomeArtifacts.get("00830"));tampered.summary.threshold_samples.SCORE_50_PLUS.horizons["5d"].median_return+=.01;
  assert.equal((await context.api.validate("00830",tampered,indexArtifact.etfs.find(row=>row.etf==="00830"),researchArtifacts.get("00830"))).reason,"INTEGRITY_FAILED");
  const incompatible=structuredClone(outcomeArtifacts.get("00830"));incompatible.metadata.weekly_j_version="WEEKLY_J_TW_TRADING_WEEK_V2";
  assert.equal((await context.api.validate("00830",incompatible,indexArtifact.etfs.find(row=>row.etf==="00830"),researchArtifacts.get("00830"))).reason,"VERSION_INCOMPATIBLE");

  let state=context.api.state({id:"00830"},"current",outcomeArtifacts,outcomeStatuses,phase6(44,-19.67));
  assert.equal(state.kind,"READY");assert.equal(state.sampleMode,"ENTRY");assert.equal(state.condition,"加碼條件浮現（40–44）");assert.equal(state.sample,outcomeArtifacts.get("00830").summary.level_entry_all.ADD_CONDITION);
  state=context.api.state({id:"00830"},"next",outcomeArtifacts,outcomeStatuses,phase6(44,-19.67));
  assert.equal(state.sampleMode,"DAILY_THRESHOLD");assert.equal(state.sample,outcomeArtifacts.get("00830").summary.threshold_samples.SCORE_45_PLUS);
  state=context.api.state({id:"00830"},"drawdown",outcomeArtifacts,outcomeStatuses,phase6(44,-19.67));
  assert.equal(state.sampleMode,"DAILY_DD52");assert.equal(state.band.id,"DD52_NEG15_TO_NEG20");assert.equal(state.sample,outcomeArtifacts.get("00830").summary.dd52_bands.DD52_NEG15_TO_NEG20);
  assert.equal(context.api.state({id:"0050"},"current",outcomeArtifacts,outcomeStatuses,phase6(29,-4)).kind,"GENERAL_NO_ENTRY");
  assert.equal(context.api.state({id:"0050"},"next",outcomeArtifacts,outcomeStatuses,phase6(29,-4)).sample,outcomeArtifacts.get("0050").summary.threshold_samples.SCORE_30_PLUS);
  for(const [score,stage,threshold] of [[39,"PULLBACK_SIGNAL",40],[44,"ADD_CONDITION",45],[49,"PROBE_ADD",50],[64,"FORMAL_ADD_SIGNAL",65],[69,"ACTIVE_ADD_SIGNAL",70],[79,"STRONG_ADD_SIGNAL",80],[89,"MAJOR_ADD_OPPORTUNITY",90]]){
    const currentState=context.api.state({id:"0050"},"current",outcomeArtifacts,outcomeStatuses,phase6(score,-8)),nextState=context.api.state({id:"0050"},"next",outcomeArtifacts,outcomeStatuses,phase6(score,-8));
    assert.equal(currentState.current.stage,stage);assert.equal(nextState.sample,outcomeArtifacts.get("0050").summary.threshold_samples[`SCORE_${threshold}_PLUS`]);
  }
  assert.equal(context.api.state({id:"0050"},"next",outcomeArtifacts,outcomeStatuses,phase6(90,-35)).kind,"MAX_LEVEL");
  assert.equal(context.api.state({id:"009815"},"current",outcomeArtifacts,outcomeStatuses,phase6()).kind,"WAIT_NATIVE");

  const rendered=context.api.render({id:"00830",score:44,dd52:-19.67});
  for(const copy of ["歷史後續表現","目前級別","下一級以上","相似回撤","歷史進入事件 N=","5日後","20日後","40日後","60日後","中位數","平均報酬","正報酬比例","查看分布","P25","P75","最佳","最差","RESEARCH_HISTORICAL_OUTCOME_V1".replace("RESEARCH_HISTORICAL_OUTCOME_V1","research-c4-outcomes")])assert.ok(rendered.includes(copy),copy);
  assert.doesNotMatch(rendered,/勝率|目標價|上漲機率/);assert.match(context.api.render({id:"009815"}),/歷史後續資料暫缺[\s\S]*原生研究歷史尚不足/);
  const independent={sample_count:7,median_return:.008,mean_return:.011,positive_rate:.56,p25:-.02,p75:.03,best_return:.092,worst_return:-.074};
  assert.match(context.api.horizon(5,independent),/非常小樣本/);assert.match(context.api.horizon(20,{...independent,sample_count:12}),/小樣本/);assert.match(context.api.horizon(40,{...independent,sample_count:0,median_return:null}),/樣本尚未成熟/);
  assert.match(context.api.horizon(60,independent),/中位數[\s\S]*\+0\.8%[\s\S]*平均報酬[\s\S]*\+1\.1%[\s\S]*正報酬比例[\s\S]*56\.0%/);

  assert.match(html,/data-radar-outcomes-phase="7b"/);assert.match(html,/function radarHistoricalResearchHtml[\s\S]*radarHistoryPhase6Html\(x\)[\s\S]*radarOutcomePhase7BHtml\(x\)/);assert.match(html,/20260919-radar-events-phase10/);
  assert.match(css,/\.radarOutcomeGrid\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);assert.ok(css.includes("@media(max-width:600px){.radarOutcomesPhase7B{padding:13px!important}.radarOutcomeGrid{grid-template-columns:1fr}"));assert.match(css,/\.radarOutcomeCard dl>div\{[^}]*grid-template-columns:minmax\(0,1fr\) auto/);
  console.log("PASS ETF Radar Phase 7B historical outcomes UI, artifact integrity/version guards, condition modes, sample maturity and responsive layout");
})().catch(error=>{console.error(error);process.exitCode=1});
