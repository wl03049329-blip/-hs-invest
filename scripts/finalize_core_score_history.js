#!/usr/bin/env node
"use strict";

// Prospective-only publisher for immutable, official EOD Core Score snapshots.
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const buy=require("../buy-point-core.js"),core=require("../final-core-production.js");
const ROOT=path.resolve(__dirname,"..");
const OUTPUT=path.join(ROOT,"finalized-core-score-snapshots-v1.json");
const VERSION="FINAL_CORE_WEIGHT_V1", SCORED=Object.freeze(["0050","00662","00757","00830","00935"]), WAIT="009815";
const finite=value=>Number.isFinite(Number(value))?Number(value):null;
const date=value=>/^\d{4}-\d{2}-\d{2}$/.test(String(value||""))?String(value):"";
const read=(file,fallback)=>{try{return JSON.parse(fs.readFileSync(file,"utf8"))}catch{return fallback}};
const stable=value=>JSON.stringify(value);
const fail=message=>{throw new Error(`FINALIZED_CORE_HISTORY_REJECTED ${message}`)};
function factor(value,name){
  const raw=finite(value?.raw),score=finite(value?.score),weight=finite(value?.weight),contribution=finite(value?.contribution);
  if([raw,score,weight,contribution].some(v=>v===null)||score<0||score>100||weight<=0||contribution<0||contribution>100)fail(`invalid_${name}_factor`);
  if(Math.abs(contribution-score*weight/100)>1e-8)fail(`invalid_${name}_contribution`);
  return{raw,score,weight,contribution};
}
function rowFromDecision(symbol,decision,dataAsOf){
  const score=finite(decision?.coreScore),version=String(decision?.coreScoreVersion||"");
  if(score===null||score<0||score>100)fail(`invalid_score_${symbol}`);
  if(version!==VERSION)fail(`wrong_version_${symbol}`);
  const factors=decision?.coreFactors||{};
  return{symbol,final_core_score:score,tier:String(decision?.label||""),core_score_version:version,data_as_of:dataAsOf,
    factors:{weekly_j:factor(factors.weeklyJ,"weekly_j"),dd52:factor(factors.dd52,"dd52"),crash:factor(factors.crash,"crash")}};
}
function validateArtifact(artifact){
  if(!artifact||artifact.schema_version!==1||artifact.core_score_version!==VERSION||!Array.isArray(artifact.snapshots))fail("invalid_existing_artifact");
  const dates=new Set();
  for(const snapshot of artifact.snapshots){const d=date(snapshot?.date);if(!d||dates.has(d))fail("duplicate_existing_date");dates.add(d)}
}
function buildSnapshot(input){
  const d=date(input?.date),dataAsOf=String(input?.data_as_of||""),finalizedAt=String(input?.finalized_at||"");
  if(!d||!dataAsOf.startsWith(`${d}T`)||!finalizedAt||String(input?.snapshot_type)!=="FINALIZED_CLOSE"||input?.finalized!==true)fail("invalid_eod_envelope");
  const decisions=input?.decisions||{},rows=[];
  for(const symbol of SCORED){if(!decisions[symbol])fail(`missing_required_symbol_${symbol}`);rows.push(rowFromDecision(symbol,decisions[symbol],dataAsOf))}
  if(decisions["00631L"])fail("leverage_must_be_excluded");
  rows.push({symbol:WAIT,status:"WAIT_NATIVE",final_core_score:null,finalized:true,reason:"Native Core Score history is not mature; no proxy or synthetic score is published."});
  return{date:d,snapshot_type:"FINALIZED_CLOSE",finalized:true,finalized_at:finalizedAt,source:{status:"official_closing_data",data_as_of:dataAsOf,generated_at:finalizedAt},rows};
}
function append(artifact,input){
  validateArtifact(artifact);const snapshot=buildSnapshot(input),existing=artifact.snapshots.find(row=>row.date===snapshot.date);
  if(existing){if(stable(existing)!==stable(snapshot))fail("same_date_conflict");return{artifact,changed:false}}
  const snapshots=[...artifact.snapshots,snapshot].sort((a,b)=>a.date.localeCompare(b.date));
  return{artifact:{schema_version:1,core_score_version:VERSION,generated_at:snapshot.finalized_at,snapshots},changed:true};
}
function writeAtomic(file,value){const temp=`${file}.${process.pid}.tmp`;fs.writeFileSync(temp,`${JSON.stringify(value,null,2)}\n`);fs.renameSync(temp,file)}
function parse(argv){const out={};for(let i=2;i<argv.length;i+=1)if(argv[i].startsWith("--"))out[argv[i].slice(2)]=argv[++i];return out}
function clean(rows,cutoff){return(Array.isArray(rows)?rows:[]).map(row=>({date:date(row?.date),open:finite(row?.open),max:finite(row?.max??row?.high),min:finite(row?.min??row?.low),close:finite(row?.close),Trading_Volume:finite(row?.Trading_Volume??row?.volume)})).filter(row=>row.date&&row.date<=cutoff&&row.open>0&&row.max>0&&row.min>0&&row.close>0&&row.max>=row.min).sort((a,b)=>a.date.localeCompare(b.date))}
async function fetchDataset(dataset,symbol,start){const url=new URL("https://api.finmindtrade.com/api/v4/data");url.searchParams.set("dataset",dataset);url.searchParams.set("data_id",symbol);url.searchParams.set("start_date",start);const response=await fetch(url,{headers:process.env.FINMIND_TOKEN?{Authorization:`Bearer ${process.env.FINMIND_TOKEN}`}:{}});const payload=await response.json();if(!response.ok||Number(payload?.status)!==200||!Array.isArray(payload.data))fail(`official_history_input_unavailable_${symbol}`);return payload.data}
async function decisionAtClose(symbol,d){const start=`${Number(d.slice(0,4))-3}-01-01`,[prices,dividends,splits]=await Promise.all([fetchDataset("TaiwanStockPrice",symbol,start),fetchDataset("TaiwanStockDividendResult",symbol,start),fetchDataset("TaiwanStockSplitPrice",symbol,start)]);const rows=buy.adjustPriceHistory(clean(prices,d),[...dividends.filter(row=>date(row?.date)&&date(row.date)<=d).map(row=>({...row,kind:"distribution"})),...splits.filter(row=>date(row?.date)&&date(row.date)<=d).map(row=>({...row,kind:"split"}))]).rows;if(rows.at(-1)?.date!==d||rows.length<252)fail(`official_eod_history_not_ready_${symbol}`);const weekly=buy.weeklyKdj(rows).at(-1),high=Math.max(...rows.slice(-252).map(row=>finite(row.max)).filter(Number.isFinite)),dd52=high>0?(rows.at(-1).close/high-1)*100:null;return core.buildFinal({ticker:symbol,j:weekly?.j,k:weekly?.k,d:weekly?.d,dd52,rows,marketAsOf:`${d}T13:30:00+08:00`})}
async function inputFromOfficialCache(cache){const eod=cache?.official_eod_snapshot,d=date(eod?.date);if(!d||eod?.snapshot_type!=="OFFICIAL_CLOSE_INPUT"||eod?.source_status!=="official_closing_data"||!eod?.observed_at)fail("official_eod_snapshot_unavailable");for(const symbol of SCORED){if(date(eod?.items?.[symbol]?.date)!==d||String(eod?.items?.[symbol]?.quote_mode||"")!=="close")fail(`official_close_input_invalid_${symbol}`)}const decisions=Object.fromEntries(await Promise.all(SCORED.map(async symbol=>[symbol,await decisionAtClose(symbol,d)])));return{date:d,snapshot_type:"FINALIZED_CLOSE",finalized:true,finalized_at:`${d}T13:30:00+08:00`,data_as_of:`${d}T13:30:00+08:00`,decisions}}
async function main(){const args=parse(process.argv),inputPath=args.input?path.resolve(args.input):"",input=inputPath?read(inputPath,null):await inputFromOfficialCache(read(path.resolve(args.market||path.join(ROOT,"market-quotes.json")),null)),output=path.resolve(args.output||OUTPUT),result=append(read(output,{schema_version:1,core_score_version:VERSION,generated_at:null,snapshots:[]}),input);if(result.changed)writeAtomic(output,result.artifact);console.log(`FINALIZED_CORE_HISTORY ${result.changed?"published":"already_published"}`)}
module.exports={SCORED,VERSION,buildSnapshot,append};
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1});
