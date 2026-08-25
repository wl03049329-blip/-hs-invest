#!/usr/bin/env node
"use strict";

// Prospective-only publisher for immutable, official EOD Core Score snapshots.
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const buy=require("../buy-point-core.js"),core=require("../final-core-production.js");
const ROOT=path.resolve(__dirname,"..");
const OUTPUT=path.join(ROOT,"finalized-core-score-snapshots-v1.json");
const VERSION="FINAL_CORE_WEIGHT_V1", SCORED=Object.freeze(["0050","00662","00757","00830","00935"]), WAIT="009815";
const WEIGHTS=Object.freeze({weekly_j:30,dd52:55,crash:15});
class SourceNotReady extends Error{constructor(message){super(message);this.name="SourceNotReady"}}
const finite=value=>Number.isFinite(Number(value))?Number(value):null;
const date=value=>/^\d{4}-\d{2}-\d{2}$/.test(String(value||""))?String(value):"";
const read=(file,fallback)=>{try{return JSON.parse(fs.readFileSync(file,"utf8"))}catch{return fallback}};
const stable=value=>JSON.stringify(value);
const fail=message=>{throw new Error(`FINALIZED_CORE_HISTORY_REJECTED ${message}`)};
const notReady=message=>{throw new SourceNotReady(`FINALIZED_CORE_HISTORY_SOURCE_NOT_READY ${message}`)};
function factor(value,name){
  const raw=finite(value?.raw),score=finite(value?.score),weight=finite(value?.weight),contribution=finite(value?.contribution);
  if([raw,score,weight,contribution].some(v=>v===null)||score<0||score>100||weight<=0||contribution<0||contribution>100)fail(`invalid_${name}_factor`);
  if(weight!==WEIGHTS[name])fail(`wrong_${name}_weight`);
  if(Math.abs(contribution-score*weight/100)>1e-8)fail(`invalid_${name}_contribution`);
  return{raw,score,weight,contribution};
}
function rowFromDecision(symbol,decision,dataAsOf){
  const score=finite(decision?.coreScore),version=String(decision?.coreScoreVersion||"");
  if(score===null||score<0||score>100)fail(`invalid_score_${symbol}`);
  if(version!==VERSION)fail(`wrong_version_${symbol}`);
  const factors=decision?.coreFactors||{},normalized={weekly_j:factor(factors.weeklyJ,"weekly_j"),dd52:factor(factors.dd52,"dd52"),crash:factor(factors.crash,"crash")};
  const total=Object.values(normalized).reduce((sum,item)=>sum+item.contribution,0);
  if(Math.abs(total-score)>1e-8)fail(`factor_total_mismatch_${symbol}`);
  const tier=String(decision?.label||"");if(tier!==core.labelFor(score).label)fail(`tier_mismatch_${symbol}`);
  return{symbol,final_core_score:score,tier,core_score_version:version,data_as_of:dataAsOf,factors:normalized};
}
function validateArtifact(artifact){
  if(!artifact||artifact.schema_version!==1||artifact.core_score_version!==VERSION||!Array.isArray(artifact.snapshots))fail("invalid_existing_artifact");
  const dates=new Set();
  for(const snapshot of artifact.snapshots){const d=date(snapshot?.date);if(!d||dates.has(d))fail("duplicate_existing_date");dates.add(d)}
}
function buildSnapshot(input){
  const d=date(input?.date),dataAsOf=String(input?.data_as_of||""),finalizedAt=String(input?.finalized_at||"");
  if(!d||!dataAsOf.startsWith(`${d}T`)||!finalizedAt||String(input?.snapshot_type)!=="FINALIZED_CLOSE"||input?.finalized!==true)fail("invalid_eod_envelope");
  const source=input?.source||{};
  if(!source.provider||source.source_type!=="TWSE_OFFICIAL_RAW_DAILY_OHLC"||date(source.source_date)!==d||!source.fetched_at||!Number.isFinite(Date.parse(source.fetched_at)))fail("invalid_eod_source_metadata");
  const decisions=input?.decisions||{},rows=[];
  for(const symbol of SCORED){if(!decisions[symbol])fail(`missing_required_symbol_${symbol}`);rows.push(rowFromDecision(symbol,decisions[symbol],dataAsOf))}
  if(decisions["00631L"])fail("leverage_must_be_excluded");
  rows.push({symbol:WAIT,status:"WAIT_NATIVE",final_core_score:null,finalized:true,reason:"Native Core Score history is not mature; no proxy or synthetic score is published."});
  return{date:d,snapshot_type:"FINALIZED_CLOSE",finalized:true,finalized_at:finalizedAt,source:{status:"official_closing_data",provider:String(source.provider),source_type:source.source_type,source_date:d,fetched_at:String(source.fetched_at),fallback_used:source.fallback_used===true,data_as_of:dataAsOf,generated_at:finalizedAt},rows};
}
function canonicalSnapshot(value){const source=value?.source||{};return{date:value?.date,snapshot_type:value?.snapshot_type,finalized:value?.finalized,finalized_at:value?.finalized_at,source:{status:source.status,source_type:source.source_type,source_date:source.source_date,data_as_of:source.data_as_of},rows:value?.rows}}
function append(artifact,input){
  validateArtifact(artifact);const snapshot=buildSnapshot(input),existing=artifact.snapshots.find(row=>row.date===snapshot.date);
  if(existing){if(stable(canonicalSnapshot(existing))!==stable(canonicalSnapshot(snapshot)))fail("same_date_conflict");return{artifact,changed:false}}
  const latest=artifact.snapshots.map(row=>date(row?.date)).filter(Boolean).sort().at(-1);
  if(latest&&snapshot.date<latest)fail(`stale_date_backfill_${snapshot.date}_before_${latest}`);
  const snapshots=[...artifact.snapshots,snapshot].sort((a,b)=>a.date.localeCompare(b.date));
  return{artifact:{schema_version:1,core_score_version:VERSION,generated_at:snapshot.finalized_at,snapshots},changed:true};
}
function writeAtomic(file,value){const temp=`${file}.${process.pid}.tmp`;fs.writeFileSync(temp,`${JSON.stringify(value,null,2)}\n`);fs.renameSync(temp,file)}
function parse(argv){const out={};for(let i=2;i<argv.length;i+=1)if(argv[i].startsWith("--"))out[argv[i].slice(2)]=argv[++i];return out}
function clean(rows,cutoff){return(Array.isArray(rows)?rows:[]).map(row=>({date:date(row?.date),open:finite(row?.open),max:finite(row?.max??row?.high),min:finite(row?.min??row?.low),close:finite(row?.close),Trading_Volume:finite(row?.Trading_Volume??row?.volume)})).filter(row=>row.date&&row.date<=cutoff&&row.open>0&&row.max>0&&row.min>0&&row.close>0&&row.max>=row.min).sort((a,b)=>a.date.localeCompare(b.date))}
async function fetchDataset(dataset,symbol,start){const url=new URL("https://api.finmindtrade.com/api/v4/data");url.searchParams.set("dataset",dataset);url.searchParams.set("data_id",symbol);url.searchParams.set("start_date",start);let response,payload;try{response=await fetch(url,{headers:process.env.FINMIND_TOKEN?{Authorization:`Bearer ${process.env.FINMIND_TOKEN}`}:{}});payload=await response.json()}catch(error){notReady(`official_history_fetch_failed_${symbol}_${dataset}_${error.message}`)}if(!response.ok||Number(payload?.status)!==200||!Array.isArray(payload.data))notReady(`official_history_input_unavailable_${symbol}_${dataset}`);return payload.data}
async function decisionAtClose(symbol,d){const start=`${Number(d.slice(0,4))-3}-01-01`,[prices,dividends,splits]=await Promise.all([fetchDataset("TaiwanStockPrice",symbol,start),fetchDataset("TaiwanStockDividendResult",symbol,start),fetchDataset("TaiwanStockSplitPrice",symbol,start)]);const rows=buy.adjustPriceHistory(clean(prices,d),[...dividends.filter(row=>date(row?.date)&&date(row.date)<=d).map(row=>({...row,kind:"distribution"})),...splits.filter(row=>date(row?.date)&&date(row.date)<=d).map(row=>({...row,kind:"split"}))]).rows;if(rows.at(-1)?.date!==d||rows.length<252)notReady(`official_eod_history_not_ready_${symbol}`);const weekly=buy.weeklyKdj(rows).at(-1),high=Math.max(...rows.slice(-252).map(row=>finite(row.max)).filter(Number.isFinite)),dd52=high>0?(rows.at(-1).close/high-1)*100:null;return{...core.buildFinal({ticker:symbol,j:weekly?.j,k:weekly?.k,d:weekly?.d,dd52,rows,marketAsOf:`${d}T13:30:00+08:00`}),source_close:rows.at(-1).close}}
async function inputFromOfficialEod(eod,expectedDate,decisionProvider=decisionAtClose){
  const expected=date(expectedDate);if(!expected)fail("missing_expected_trading_date");
  if(eod?.status==="NO_TRADING_DAY")notReady(`no_trading_day_${expected}`);
  if(eod?.status==="SOURCE_NOT_READY")notReady(`official_eod_source_not_ready_${expected}`);
  const d=date(eod?.source_date),fetchedAt=String(eod?.fetched_at||""),provider=String(eod?.provider||"");
  if(!d||eod?.snapshot_type!=="OFFICIAL_EOD_MARKET"||eod?.status!=="READY"||eod?.source_type!=="TWSE_OFFICIAL_RAW_DAILY_OHLC"||!provider||!fetchedAt||!Number.isFinite(Date.parse(fetchedAt)))notReady("official_eod_snapshot_unavailable");
  if(date(eod?.expected_date)!==expected)fail("eod_expected_date_mismatch");
  if(d<expected)notReady(`official_eod_date_${d}_before_expected_${expected}`);
  if(d>expected)fail(`look_ahead_official_eod_date_${d}_after_expected_${expected}`);
  for(const symbol of SCORED){const item=eod?.items?.[symbol],values=[item?.open,item?.high,item?.low,item?.close].map(finite);if(date(item?.date)!==d||String(item?.symbol||"")!==symbol||values.some(v=>v===null||v<=0)||values[1]<Math.max(values[0],values[2],values[3])||values[2]>Math.min(values[0],values[1],values[3]))notReady(`official_close_input_invalid_${symbol}`)}
  const decisions=Object.fromEntries(await Promise.all(SCORED.map(async symbol=>{const decision=await decisionProvider(symbol,d),officialClose=finite(eod.items[symbol].close),historyClose=finite(decision?.source_close);if(historyClose===null||Math.abs(historyClose-officialClose)>1e-6)fail(`official_history_close_conflict_${symbol}`);return[symbol,decision]})));
  return{date:d,snapshot_type:"FINALIZED_CLOSE",finalized:true,finalized_at:`${d}T13:30:00+08:00`,data_as_of:`${d}T13:30:00+08:00`,source:{provider,source_type:eod.source_type,source_date:d,fetched_at:fetchedAt,fallback_used:eod.fallback_used===true},decisions};
}
async function main(){
  const args=parse(process.argv),inputPath=args.input?path.resolve(args.input):"";
  const input=inputPath?read(inputPath,null):await inputFromOfficialEod(read(path.resolve(args.eod||path.join(ROOT,"official-eod-market.json")),null),args["expected-date"]);
  const output=path.resolve(args.output||OUTPUT),result=append(read(output,{schema_version:1,core_score_version:VERSION,generated_at:null,snapshots:[]}),input);
  if(result.changed)writeAtomic(output,result.artifact);console.log(`FINALIZED_CORE_HISTORY ${result.changed?"published":"already_published"}`);
}
module.exports={SCORED,VERSION,WEIGHTS,SourceNotReady,buildSnapshot,append,inputFromOfficialEod,decisionAtClose};
if(require.main===module)main().catch(error=>{if(error instanceof SourceNotReady){console.log(error.message);return}console.error(error.message);process.exitCode=1});
