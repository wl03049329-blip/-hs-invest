"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs");
const {append,inputFromOfficialEod,decisionAtClose,SCORED,validateSplitBasis}=require("../scripts/finalize_core_score_history.js");
const buy=require("../buy-point-core.js"),core=require("../final-core-production.js");
const sealed=require("../finalized-core-score-snapshots-v1.json");
async function test(proof){
  process.env.TZ="UTC";
  const {date,last_ohlc,resume_ohlc}=proof;
  const snapshots=sealed.snapshots.filter(s=>s.date<=last_ohlc.date);
  const archived={...sealed,snapshots,generated_at:snapshots.at(-1).finalized_at};
  const history=[];
  for(let i=280;i>0;i--){
    const t=new Date(Date.parse(last_ohlc.date)-i*86400000),p=110+(i%18)/2;
    if (![0,6].includes(t.getUTCDay())) history.push({date:t.toISOString().slice(0,10),open:p,max:p+1,min:p-1,close:p,Trading_Volume:1000});
  }
  for(let i=400;i>280;i--){
    const t=new Date(Date.parse(last_ohlc.date)-i*86400000);
    if (![0,6].includes(t.getUTCDay())) history.push({date:t.toISOString().slice(0,10),open:110,max:111,min:109,close:110,Trading_Volume:1000});
  }
  history.push(last_ohlc,resume_ohlc);
  history.sort((a,b)=>a.date.localeCompare(b.date));
  const split={date,before_price:proof.before_price,after_price:proof.after_price};
  let splits=[split];
  global.fetch=async url=>({ok:true,json:async()=>({status:200,data:
    url.searchParams.get("dataset")==="TaiwanStockPrice"?history:url.searchParams.get("dataset")==="TaiwanStockSplitPrice"?splits:[]})});
  const envelope={expected_date:date,source_date:date,snapshot_type:"OFFICIAL_EOD_MARKET",status:"READY",provider:"TEST_FIXTURE",
    fetched_at:date+"T15:00:00+08:00",source_type:"TWSE_OFFICIAL_RAW_DAILY_OHLC",
    items:Object.fromEntries(SCORED.map(symbol=>[symbol,{symbol,date,open:resume_ohlc.open,high:resume_ohlc.max,low:resume_ohlc.min,close:resume_ohlc.close}]))};
  const decide=(symbol,day)=>decisionAtClose(symbol,day,proof);
  await assert.rejects(inputFromOfficialEod({...envelope,items:{...envelope.items,"00662":null}},date,decide),/official_close_input_invalid/);
  const computed=await inputFromOfficialEod(envelope,date,decide);
  const adjusted=history.map(r=>r.date>=date?r:{...r,...Object.fromEntries(["open","max","min","close"].map(k=>[k,r[k]/5]))});
  const w=buy.weeklyKdj(adjusted).at(-1),dd52=(resume_ohlc.close/Math.max(...adjusted.slice(-252).map(r=>r.max))-1)*100;
  const expected=core.buildFinal({ticker:"00662",j:w.j,k:w.k,d:w.d,dd52,rows:adjusted,marketAsOf:date+"T13:30:00+08:00"});
  for(const k of ["weeklyJ","dd52","crash"]) assert.ok(Math.abs(expected.coreFactors[k].raw-computed.decisions["00662"].coreFactors[k].raw)<1e-8);
  const next=append(archived,computed).artifact;
  assert.deepEqual(next.snapshots.slice(0,-1),archived.snapshots);
  assert.equal(next.snapshots.at(-2).date,last_ohlc.date);
  assert.equal(next.snapshots.at(-1).date,date);
  assert.equal(next.snapshots.at(-1).rows.find(r=>r.symbol==="009815").status,"WAIT_NATIVE");
  splits=[split,split];
  await assert.rejects(inputFromOfficialEod(envelope,date,decide),/split_basis_unverified/);
  splits=[];
  await assert.rejects(inputFromOfficialEod(envelope,date,decide),/split_basis_unverified/);
  assert.throws(()=>validateSplitBasis(history.map(r=>r.date===last_ohlc.date?{...r,close:r.close/5}:r),[],[split],proof),/raw_split_anchor_conflict/);
  console.log("FINAL_SPLIT_E2E_PASS");
}
if(require.main===module) test(JSON.parse(fs.readFileSync(0,"utf8"))).catch(error=>{console.error(error);process.exitCode=1});
