"use strict";
const assert=require("node:assert/strict"),publisher=require("../scripts/finalize_core_score_history.js"),core=require("../final-core-production.js");
const base=()=>({schema_version:1,core_score_version:publisher.VERSION,generated_at:null,snapshots:[]});
const decision=(score=50)=>({coreScore:score,label:core.labelFor(score).label,coreScoreVersion:publisher.VERSION,coreFactors:{weeklyJ:{raw:score,score,weight:30,contribution:score*.30},dd52:{raw:-score,score,weight:55,contribution:score*.55},crash:{raw:-score,score,weight:15,contribution:score*.15}}});
const frozenDecision=(coreScore,weeklyRaw,weeklyScore,dd52Raw,dd52Score,crashRaw,crashScore)=>({coreScore,label:core.labelFor(coreScore).label,coreScoreVersion:publisher.VERSION,coreFactors:{weeklyJ:{raw:weeklyRaw,score:weeklyScore,weight:30,contribution:weeklyScore*.30},dd52:{raw:dd52Raw,score:dd52Score,weight:55,contribution:dd52Score*.55},crash:{raw:crashRaw,score:crashScore,weight:15,contribution:crashScore*.15}}});
// Captured once from the production finalizer's adjusted/restored FinMind path.
// This deterministic fixture proves the 2026-08-25 evidence without network access or artifact writes.
const replayDecisions={
  "0050":frozenDecision(12.1,71.35467780101311,0,-6.469016814205631,22,-2.1555763823805085,0),
  "00662":frozenDecision(6.6,62.07431996196743,0,-3.7096774193548288,12,-3.398058252427172,0),
  "00757":frozenDecision(6.6,83.20097351118784,0,-3.5827186512118026,12,-3.5149384885764468,0),
  "00830":frozenDecision(47.16939291736931,21.936623209008644,33,-19.52054794520548,65,-7.532321528948849,10.129286115795395),
  "00935":frozenDecision(25.951694915254233,53.04130832791709,0,-14.18711656441718,47,-5.1694915254237195,0.6779661016948779)
};
const input=(date="2026-08-25",decisions=replayDecisions)=>({date,snapshot_type:"FINALIZED_CLOSE",finalized:true,finalized_at:`${date}T13:30:00+08:00`,data_as_of:`${date}T13:30:00+08:00`,decisions});
const cache=date=>({official_eod_snapshot:{snapshot_type:"OFFICIAL_CLOSE_INPUT",date,observed_at:`${date}T14:10:00+08:00`,source_status:"official_closing_data",items:Object.fromEntries(publisher.SCORED.map(symbol=>[symbol,{date,quote_mode:"close"}]))}});

(async()=>{
  let result=publisher.append(base(),input());
  assert.deepEqual(result.artifact.snapshots[0].rows.map(row=>row.symbol),[...publisher.SCORED,"009815"]);
  assert.equal(Math.floor(result.artifact.snapshots[0].rows.find(row=>row.symbol==="00935").final_core_score),25);
  assert.equal(result.artifact.snapshots[0].rows.at(-1).status,"WAIT_NATIVE");
  console.log("PASS deterministic 2026-08-25 replay publishes five eligible ETFs and WAIT_NATIVE");

  result=publisher.append(result.artifact,input());assert.equal(result.changed,false);assert.equal(result.artifact.snapshots.length,1);
  console.log("PASS same-date retry is idempotent");

  const conflict=input();conflict.decisions["0050"]=decision(22);assert.throws(()=>publisher.append(result.artifact,conflict),/same_date_conflict/);
  assert.throws(()=>publisher.append(result.artifact,input("2026-08-24")),/stale_date_backfill/);
  console.log("PASS same-date conflict and stale historical backfill are rejected");

  for(const mutate of [x=>x.decisions["0050"].coreScore=101,x=>delete x.decisions["0050"].coreFactors.crash,x=>x.decisions["0050"].coreScoreVersion="WRONG",x=>x.decisions["0050"].coreFactors.weeklyJ.weight=31,x=>x.decisions["0050"].label="WRONG",x=>x.snapshot_type="INTRADAY_CORE",x=>x.data_as_of="2026-08-23T13:30:00+08:00",x=>x.decisions["00631L"]=decision()]){const bad=input("2026-08-26");mutate(bad);assert.throws(()=>publisher.append(base(),bad),/FINALIZED_CORE_HISTORY_REJECTED/)}
  console.log("PASS score/factor/30-55-15/version/tier/as-of/leverage guards");

  let providerCalls=0,provider=async symbol=>{providerCalls+=1;return replayDecisions[symbol]};
  await assert.rejects(()=>publisher.inputFromOfficialCache(cache("2026-08-24"),"2026-08-25",provider),error=>error instanceof publisher.SourceNotReady&&/before_expected/.test(error.message));
  assert.equal(providerCalls,0);console.log("PASS SOURCE_NOT_READY keeps previous official date unpublished");

  const ready=await publisher.inputFromOfficialCache(cache("2026-08-25"),"2026-08-25",provider);
  assert.equal(providerCalls,5);assert.equal(ready.date,"2026-08-25");assert.equal(Math.floor(ready.decisions["00935"].coreScore),25);
  console.log("PASS later retry publishes only after source date equals expected date");

  await assert.rejects(()=>publisher.inputFromOfficialCache(cache("2026-08-26"),"2026-08-25",provider),/look_ahead/);
  assert.equal(providerCalls,5);console.log("PASS future source date is rejected before any score calculation");

  await assert.rejects(()=>publisher.inputFromOfficialCache(cache("2026-08-25"),"",provider),/missing_expected_trading_date/);
  console.log("PASS expected trading date is mandatory");
})().catch(error=>{console.error(error);process.exitCode=1});
