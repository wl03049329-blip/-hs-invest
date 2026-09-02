"use strict";

const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const resolver=require("../canonical-score-resolver.js");

const root=path.join(__dirname,"..");
const html=fs.readFileSync(path.join(root,"index.html"),"utf8");
const version="FINAL_CORE_WEIGHT_V1";
const symbols=["0050","00662","00757","00830","00935"];
const factors={weekly_j:{raw:20},dd52:{raw:-10},crash:{raw:-4}};

function finalized(date,score=42,{ready=true,rowVersion=version}={}){
  return {date,snapshot_type:"FINALIZED_CLOSE",finalized:ready,finalized_at:`${date}T13:30:00+08:00`,source:{data_as_of:`${date}T13:30:00+08:00`},rows:symbols.map((symbol,index)=>({symbol,final_core_score:symbol==="00830"?score:20+index,tier:"一般持有",core_score_version:rowVersion,data_as_of:`${date}T13:30:00+08:00`,factors}))};
}

function artifact(snapshots,artifactVersion=version){return {schema_version:1,core_score_version:artifactVersion,snapshots};}
function finalOnly(snapshots,targetDate="2026-09-02",artifactVersion=version){return resolver.resolveFinalOnly({finalizedArtifact:artifact(snapshots,artifactVersion),targetDate,scoreVersion:version,symbols:new Set(symbols)});}

let current=finalOnly([finalized("2026-08-29",35),finalized("2026-09-01",48)]);
assert.equal(current.trading_date,"2026-09-01");
assert.equal(current.source_status,"FINALIZED_EOD");
assert.equal(current.items["00830"].display_score,48);
console.log("PASS 1 latest valid FINAL wins");

const intraday={schema_version:1,snapshot_type:"INTRADAY_CORE",status:"SUCCESS",trading_date:"2026-09-02",slot:"13:30",items:{}};
current=resolver.resolveFinalOnly({finalizedArtifact:artifact([finalized("2026-09-01",48)]),intradaySnapshots:[intraday],targetDate:"2026-09-02",scoreVersion:version,symbols:new Set(symbols)});
assert.equal(current.trading_date,"2026-09-01");
assert.equal(current.source_status,"FINALIZED_EOD");
console.log("PASS 2 newer legacy intraday is not a FINAL-only candidate");

assert.equal(resolver.resolveFinalOnly({finalizedArtifact:artifact([]),intradaySnapshots:[intraday],targetDate:"2026-09-02",scoreVersion:version,symbols}),null);
console.log("PASS 3 intraday-only state resolves unavailable");

assert.equal(finalOnly([]),null);
assert.equal(finalOnly([finalized("2026-09-01",48,{ready:false})]),null);
console.log("PASS 4 missing or non-finalized FINAL resolves unavailable");

assert.equal(finalOnly([finalized("2026-09-01",48,{rowVersion:"OLD"})]),null);
assert.equal(finalOnly([finalized("2026-09-03",48)]),null);
console.log("PASS 5 invalid scoreVersion and future date fail closed");

assert.match(html,/function currentCanonicalCoreSnapshot[\s\S]*?resolveFinalOnly\(\{finalizedArtifact:finalizedCoreScoreHistoryArtifact,targetDate,scoreVersion:LONG_TERM_CORE_SCORE_VERSION,symbols:LONG_RADAR_SCORED_CODES\}\)/);
assert.doesNotMatch(html.match(/function currentCanonicalCoreSnapshot[\s\S]*?\n\}/)?.[0]||"",/intradaySnapshots|localStorage|liveCanonicalCoreSnapshots/);
console.log("PASS 6 homepage resolver has no legacy or local current-score candidate");

assert.match(html,/function homepageFinalDecision[\s\S]*?scoreMode==="finalized_eod"[\s\S]*?source_status==="FINALIZED_EOD"[\s\S]*?score_version===LONG_TERM_CORE_SCORE_VERSION/);
assert.match(html,/目前尚無有效盤後正式 Core Score；不使用盤中或本機快取替代/);
assert.match(html,/盤後正式分數暫不可用/);
console.log("PASS 7 homepage requires canonical FINAL and exposes explicit unavailable");

const gateStart=html.indexOf("function homepageFinalDecision"),gateEnd=html.indexOf("function longRankRow",gateStart),gateContext={Number,Math,Set,LONG_RADAR_SCORED_CODES:new Set(symbols),LONG_TERM_CORE_SCORE_VERSION:version,strategyDecisionFor:item=>item?.strategyDecisions?.long_term_core||null};
require("node:vm").createContext(gateContext);require("node:vm").runInContext(html.slice(gateStart,gateEnd),gateContext);
const localItem={id:"00830",scoreMode:"formal",strategyDecisions:{long_term_core:{score:99,coreScore:99}}};
assert.equal(gateContext.homepageFinalDecision(localItem),null);
const finalRecord=current.items["00830"],finalItem={id:"00830",scoreMode:"finalized_eod",intraday:{canonical:finalRecord},strategyDecisions:{long_term_core:{score:48,coreScore:48}}};
assert.equal(gateContext.homepageFinalDecision(finalItem).coreScore,48);
assert.equal(gateContext.homepageFinalDecision({...finalItem,intraday:{canonical:{...finalRecord,score_version:"OLD"}}}),null);
console.log("PASS 7B local formal and invalid-version objects cannot cross the FINAL authority gate");

assert.match(html,/HS FINAL · 盤後正式長期加碼雷達/);
assert.match(html,/不使用舊盤中快照/);
assert.doesNotMatch(html.slice(html.indexOf('id="homeEtfBrief"'),html.indexOf('</section>',html.indexOf('id="homeEtfBrief"'))),/HS LIVE|盤中預估/);
console.log("PASS 8 homepage current-score status is FINAL-only");

assert.match(html,/const LONG_RADAR_SCORED_CODES=new Set\(\["0050","00662","00757","00830","00935"\]\)/);
assert.doesNotMatch(html.match(/const LONG_RADAR_SCORED_CODES[^\n]+/)?.[0]||"",/009815|00631L/);
assert.match(html,/009815 目前維持 WAIT_NATIVE/);
assert.match(html,/00631L · HS LEVERAGE/);
console.log("PASS 9 WAIT_NATIVE and 00631L isolation remain intact");

assert.match(html,/function officialCoreScoreHistory/);
assert.match(html,/盤中 Core 不納入此趨勢/);
assert.match(html,/Forward Shadow 驗證中/);
console.log("PASS 10 history and Forward Shadow remain separate from homepage selection");

for(const symbol of symbols){assert.equal(current?.items?.[symbol]?.status,"SUCCESS");assert(Number.isFinite(current.items[symbol].score));}
console.log("PASS 11 every eligible homepage FINAL score is finite and valid");

assert.match(html,/canonical-score-resolver\.js\?v=20260902-v14-final-only/);
console.log("PASS 12 resolver cache version identifies FINAL-only cutover");
