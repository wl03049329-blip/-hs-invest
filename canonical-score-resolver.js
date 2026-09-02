"use strict";

(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  if(root)root.HSCanonicalScoreResolver=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  const validDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(String(value||""));
  const finiteScore=value=>Number.isFinite(Number(value))&&Number(value)>=0&&Number(value)<=100;
  const boundedDate=(value,targetDate)=>validDate(value)&&validDate(targetDate)&&value<=targetDate;

  function normalizeFinalizedSnapshot(snapshot,{scoreVersion,symbols,targetDate}){
    const date=String(snapshot?.date||""),expected=[...(symbols||[])];
    if(!boundedDate(date,targetDate)||snapshot?.snapshot_type!=="FINALIZED_CLOSE"||snapshot?.finalized!==true)return null;
    const rows=Array.isArray(snapshot?.rows)?snapshot.rows:[],items={};
    for(const symbol of expected){
      const row=rows.find(item=>String(item?.symbol||"")===symbol),score=Number(row?.final_core_score),dataAsOf=String(row?.data_as_of||snapshot?.source?.data_as_of||"");
      if(!row||row.status==="WAIT_NATIVE"||!finiteScore(score)||row.core_score_version!==scoreVersion||!dataAsOf.startsWith(`${date}T`))return null;
      const factors=row.factors||{};
      items[symbol]={status:"SUCCESS",source_status:"FINALIZED_EOD",score,display_score:Math.floor(score),score_version:row.core_score_version,trading_date:date,weekly_j:Number(factors?.weekly_j?.raw),dd52:Number(factors?.dd52?.raw),core_factors:{weeklyJ:factors.weekly_j||{},dd52:factors.dd52||{},crash:factors.crash||{}},tier:String(row.tier||""),market_as_of:dataAsOf,calculated_at:String(snapshot.finalized_at||dataAsOf)};
    }
    return{schema_version:1,snapshot_type:"FINALIZED_CLOSE",status:"SUCCESS",source_status:"FINALIZED_EOD",trading_date:date,slot:"13:30",items,canonical_priority:2};
  }

  function normalizeIntradaySnapshot(snapshot,{scoreVersion,symbols,targetDate}){
    const date=String(snapshot?.trading_date||""),slot=String(snapshot?.slot||""),expected=[...(symbols||[])];
    if(!boundedDate(date,targetDate)||snapshot?.schema_version!==1||snapshot?.snapshot_type!=="INTRADAY_CORE"||snapshot?.status!=="SUCCESS"||!/^\d{2}:\d{2}$/.test(slot))return null;
    for(const symbol of expected){
      const row=snapshot?.items?.[symbol],score=Number(row?.score),asOf=String(row?.market_as_of||"");
      if(row?.status!=="SUCCESS"||!finiteScore(score)||!asOf.startsWith(`${date}T`))return null;
      if(row.score_version&&row.score_version!==scoreVersion)return null;
    }
    return{...snapshot,source_status:"INTRADAY_CANONICAL",canonical_priority:1};
  }

  function resolve({finalizedArtifact,intradaySnapshots,targetDate,scoreVersion,symbols}){
    if(!validDate(targetDate)||!scoreVersion||!(symbols instanceof Set||Array.isArray(symbols)))return null;
    const options={scoreVersion,symbols:new Set(symbols),targetDate},candidates=[];
    if(finalizedArtifact?.schema_version===1&&finalizedArtifact?.core_score_version===scoreVersion){
      for(const snapshot of finalizedArtifact.snapshots||[]){const normalized=normalizeFinalizedSnapshot(snapshot,options);if(normalized)candidates.push(normalized)}
    }
    for(const snapshot of intradaySnapshots||[]){const normalized=normalizeIntradaySnapshot(snapshot,options);if(normalized)candidates.push(normalized)}
    return candidates.sort((a,b)=>b.trading_date.localeCompare(a.trading_date)||b.canonical_priority-a.canonical_priority||String(b.slot).localeCompare(String(a.slot)))[0]||null;
  }

  function resolveFinalOnly({finalizedArtifact,targetDate,scoreVersion,symbols}){
    if(!validDate(targetDate)||!scoreVersion||!(symbols instanceof Set||Array.isArray(symbols)))return null;
    const options={scoreVersion,symbols:new Set(symbols),targetDate},candidates=[];
    if(finalizedArtifact?.schema_version===1&&finalizedArtifact?.core_score_version===scoreVersion){
      for(const snapshot of finalizedArtifact.snapshots||[]){const normalized=normalizeFinalizedSnapshot(snapshot,options);if(normalized)candidates.push(normalized)}
    }
    return candidates.sort((a,b)=>b.trading_date.localeCompare(a.trading_date))[0]||null;
  }

  return Object.freeze({normalizeFinalizedSnapshot,normalizeIntradaySnapshot,resolve,resolveFinalOnly});
});
