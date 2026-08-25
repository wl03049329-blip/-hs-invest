"use strict";
const assert=require("node:assert/strict"),publisher=require("../scripts/finalize_core_score_history.js");
const base={schema_version:1,core_score_version:publisher.VERSION,generated_at:null,snapshots:[]};
const decision=(score=50)=>({coreScore:score,label:"正式加碼訊號",coreScoreVersion:publisher.VERSION,coreFactors:{weeklyJ:{raw:1,score:60,weight:30,contribution:18},dd52:{raw:-10,score:50,weight:55,contribution:27.5},crash:{raw:-5,score:30,weight:15,contribution:4.5}}});
const input=(date="2026-08-24")=>({date,snapshot_type:"FINALIZED_CLOSE",finalized:true,finalized_at:`${date}T14:00:00+08:00`,data_as_of:`${date}T13:30:00+08:00`,decisions:Object.fromEntries(publisher.SCORED.map(symbol=>[symbol,decision()]))});
let result=publisher.append(base,input());assert.equal(result.artifact.snapshots.length,1);assert.deepEqual(result.artifact.snapshots[0].rows.map(row=>row.symbol),[...publisher.SCORED,"009815"]);
assert.equal(result.artifact.snapshots[0].rows.at(-1).final_core_score,null);console.log("PASS first append and 009815 status row");
result=publisher.append(result.artifact,input());assert.equal(result.changed,false);assert.equal(result.artifact.snapshots.length,1);console.log("PASS same-date retry is idempotent");
const conflict=input();conflict.decisions["0050"]=decision(51);assert.throws(()=>publisher.append(result.artifact,conflict),/same_date_conflict/);
result=publisher.append(result.artifact,input("2026-08-25"));assert.equal(result.artifact.snapshots.length,2);console.log("PASS conflict guard and next date append");
for(const mutate of [x=>x.decisions["0050"].coreScore=101,x=>delete x.decisions["0050"].coreFactors.crash,x=>x.decisions["0050"].coreScoreVersion="WRONG",x=>x.snapshot_type="INTRADAY_CORE",x=>x.data_as_of="2026-08-23T13:30:00+08:00",x=>x.decisions["00631L"]=decision()]){const bad=input("2026-08-26");mutate(bad);assert.throws(()=>publisher.append(base,bad),/FINALIZED_CORE_HISTORY_REJECTED/)}
console.log("PASS invalid score/factor/version/intraday/as-of/leverage rejection");
publisher.inputFromOfficialCache({}).then(
  ()=>{throw new Error("missing official close must not finalize")},
  error=>{assert.ok(error instanceof publisher.SourceNotReady);assert.match(error.message,/SOURCE_NOT_READY/);console.log("PASS EOD source-not-ready is an operational no-publish state")}
);
