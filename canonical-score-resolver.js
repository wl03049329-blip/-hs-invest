"use strict";

(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  if(root)root.HSCanonicalScoreResolver=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  const validDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(String(value||""));
  const finiteScore=value=>Number.isFinite(Number(value))&&Number(value)>=0&&Number(value)<=100;
  const boundedDate=(value,targetDate)=>validDate(value)&&validDate(targetDate)&&value<=targetDate;
  const finiteRaw=value=>value===null||value===undefined||value===""?null:(Number.isFinite(Number(value))?Number(value):null);
  const snapshotMarketAsOf=snapshot=>{
    const direct=String(snapshot?.market_as_of||"");
    const rows=Object.values(snapshot?.items||{}).map(row=>String(row?.market_as_of||"")).filter(Boolean);
    return [...rows,direct].filter(Boolean).sort().at(-1)||"";
  };
  const MARKET_STATES=Object.freeze({PREMARKET:"PREMARKET",OPEN:"OPEN",CLOSED:"CLOSED",HOLIDAY:"HOLIDAY",STALE:"STALE"});
  const LIVE_REASONS=Object.freeze({
    NO_CURRENT_DAY_INTRADAY:"NO_CURRENT_DAY_INTRADAY",INCOMPLETE_INTRADAY:"INCOMPLETE_INTRADAY",
    VERSION_MISMATCH:"VERSION_MISMATCH",FUTURE_AS_OF:"FUTURE_AS_OF",STALE_INTRADAY_SNAPSHOT:"STALE_INTRADAY_SNAPSHOT",
    PREMARKET:"MARKET_PREMARKET",CLOSED:"MARKET_CLOSED",HOLIDAY:"MARKET_HOLIDAY",UNKNOWN_TRADING_DAY:"TRADING_DAY_UNCONFIRMED"
  });

  function taipeiClock(now){
    const date=now instanceof Date?now:new Date(now),valid=Number.isFinite(date.getTime());
    if(!valid)return null;
    const parts=Object.fromEntries(new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Taipei",weekday:"short",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false}).formatToParts(date).map(part=>[part.type,part.value]));
    return{date:`${parts.year}-${parts.month}-${parts.day}`,weekday:parts.weekday,minutes:Number(parts.hour)*60+Number(parts.minute)};
  }

  function componentState(key,value){
    const raw=finiteRaw(value);if(raw===null)return"unavailable";
    if(key==="weekly_j")return raw<0?"strong":raw<20?"positive":raw<50?"neutral":"weak";
    if(key==="dd52")return raw<=-20?"strong":raw<=-10?"positive":raw<=-5?"neutral":"weak";
    return raw<=-10?"strong":raw<=-5?"positive":raw<0?"neutral":"weak";
  }

  function normalizeFinalizedSnapshot(snapshot,{scoreVersion,symbols,targetDate}){
    const date=String(snapshot?.date||""),expected=[...(symbols||[])];
    if(!boundedDate(date,targetDate)||snapshot?.snapshot_type!=="FINALIZED_CLOSE"||snapshot?.finalized!==true)return null;
    const rows=Array.isArray(snapshot?.rows)?snapshot.rows:[],items={};
    for(const symbol of expected){
      const row=rows.find(item=>String(item?.symbol||"")===symbol),score=Number(row?.final_core_score),dataAsOf=String(row?.data_as_of||snapshot?.source?.data_as_of||"");
      if(!row||row.status==="WAIT_NATIVE"||!finiteScore(score)||row.core_score_version!==scoreVersion||!dataAsOf.startsWith(`${date}T`))return null;
      const factors=row.factors||{};
      const weeklyJ=finiteRaw(factors?.weekly_j?.raw),dd52=finiteRaw(factors?.dd52?.raw),crash=finiteRaw(factors?.crash?.raw);
      items[symbol]={status:"SUCCESS",source_status:"FINALIZED_EOD",score,display_score:Math.floor(score),score_version:row.core_score_version,trading_date:date,weekly_j:weeklyJ,dd52,components:{weekly_j:{value:weeklyJ,state:componentState("weekly_j",weeklyJ)},dd52:{value:dd52,state:componentState("dd52",dd52)},crash:{value:crash,state:componentState("crash",crash)}},core_factors:{weeklyJ:factors.weekly_j||{},dd52:factors.dd52||{},crash:factors.crash||{}},tier:String(row.tier||""),market_as_of:dataAsOf,calculated_at:String(snapshot.finalized_at||dataAsOf)};
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

  function resolveMarketState({targetDate,now=new Date(),tradingDayStatus="UNKNOWN",finalizedSnapshot=null,intradaySnapshots=[]}={}){
    const clock=taipeiClock(now),status=String(tradingDayStatus||"UNKNOWN").toUpperCase();
    if(!clock||!validDate(targetDate)||clock.date!==targetDate)return MARKET_STATES.STALE;
    if(status==="HOLIDAY"||status==="NO_TRADING_DAY"||["Sat","Sun"].includes(clock.weekday))return MARKET_STATES.HOLIDAY;
    const finalizedToday=finalizedSnapshot?.source_status==="FINALIZED_EOD"&&finalizedSnapshot?.trading_date===targetDate;
    const intradayToday=(intradaySnapshots||[]).some(snapshot=>snapshot?.snapshot_type==="INTRADAY_CORE"&&snapshot?.status==="SUCCESS"&&snapshot?.trading_date===targetDate);
    const confirmed=status==="TRADING_DAY"||status==="READY"||finalizedToday||intradayToday;
    if(!confirmed)return MARKET_STATES.STALE;
    if(clock.minutes<9*60)return MARKET_STATES.PREMARKET;
    if(clock.minutes<=13*60+30&&!finalizedToday)return MARKET_STATES.OPEN;
    return MARKET_STATES.CLOSED;
  }

  function liveUnavailable(reason,marketState,snapshot=null){
    return{snapshot,display_eligible:false,status:"UNAVAILABLE",reason,freshness:reason===LIVE_REASONS.STALE_INTRADAY_SNAPSHOT?"STALE":"UNAVAILABLE",market_state:marketState};
  }

  function resolveLiveProjected({intradaySnapshots,targetDate,scoreVersion,symbols,now=new Date(),marketState=MARKET_STATES.STALE,maxAgeMinutes=15}={}){
    const expected=new Set(symbols||[]),rows=(intradaySnapshots||[]).filter(snapshot=>snapshot?.trading_date===targetDate&&snapshot?.status==="SUCCESS").sort((a,b)=>snapshotMarketAsOf(b).localeCompare(snapshotMarketAsOf(a))||String(b?.slot||"").localeCompare(String(a?.slot||""))),snapshot=rows[0]||null;
    if(marketState===MARKET_STATES.PREMARKET)return liveUnavailable(LIVE_REASONS.PREMARKET,marketState,snapshot);
    if(marketState===MARKET_STATES.CLOSED)return liveUnavailable(LIVE_REASONS.CLOSED,marketState,snapshot);
    if(marketState===MARKET_STATES.HOLIDAY)return liveUnavailable(LIVE_REASONS.HOLIDAY,marketState,snapshot);
    if(marketState!==MARKET_STATES.OPEN)return liveUnavailable(LIVE_REASONS.UNKNOWN_TRADING_DAY,marketState,snapshot);
    if(!snapshot)return liveUnavailable(LIVE_REASONS.NO_CURRENT_DAY_INTRADAY,marketState);
    if(snapshot?.schema_version!==1||snapshot?.snapshot_type!=="INTRADAY_CORE"||!/^[0-2]\d:[0-5]\d$/.test(String(snapshot?.slot||"")))return liveUnavailable(LIVE_REASONS.INCOMPLETE_INTRADAY,marketState,snapshot);
    for(const symbol of expected){
      const row=snapshot?.items?.[symbol];
      if(!row||row.status!=="SUCCESS"||!finiteScore(row.score)||String(row.market_as_of||"").startsWith(`${targetDate}T`)===false||!["FRESH","DELAYED"].includes(row.freshness))return liveUnavailable(LIVE_REASONS.INCOMPLETE_INTRADAY,marketState,snapshot);
      if(row.score_version!==scoreVersion)return liveUnavailable(LIVE_REASONS.VERSION_MISMATCH,marketState,snapshot);
    }
    const normalized=normalizeIntradaySnapshot(snapshot,{scoreVersion,symbols:expected,targetDate});
    if(!normalized)return liveUnavailable(LIVE_REASONS.INCOMPLETE_INTRADAY,marketState,snapshot);
    const nowMs=(now instanceof Date?now:new Date(now)).getTime(),asOfValues=[...expected].map(symbol=>Date.parse(String(normalized.items[symbol].market_as_of||"")));
    if(!Number.isFinite(nowMs)||asOfValues.some(value=>!Number.isFinite(value)))return liveUnavailable(LIVE_REASONS.INCOMPLETE_INTRADAY,marketState,snapshot);
    if(asOfValues.some(value=>value>nowMs))return liveUnavailable(LIVE_REASONS.FUTURE_AS_OF,marketState,snapshot);
    if(asOfValues.some(value=>nowMs-value>Number(maxAgeMinutes)*60000))return liveUnavailable(LIVE_REASONS.STALE_INTRADAY_SNAPSHOT,MARKET_STATES.STALE,snapshot);
    return{snapshot:normalized,display_eligible:true,status:"LIVE_PROJECTED",reason:null,freshness:"FRESH",market_state:marketState};
  }

  function buildDualTrackView({finalizedArtifact,intradaySnapshots,targetDate,scoreVersion,symbols,now=new Date(),tradingDayStatus="UNKNOWN",maxAgeMinutes=15}={}){
    const expected=new Set(symbols||[]),official=resolveFinalOnly({finalizedArtifact,targetDate,scoreVersion,symbols:expected});
    let marketState=resolveMarketState({targetDate,now,tradingDayStatus,finalizedSnapshot:official,intradaySnapshots});
    const liveResult=resolveLiveProjected({intradaySnapshots,targetDate,scoreVersion,symbols:expected,now,marketState,maxAgeMinutes});
    if(liveResult.reason===LIVE_REASONS.STALE_INTRADAY_SNAPSHOT)marketState=MARKET_STATES.STALE;
    const items={};
    for(const ticker of expected){
      const officialItem=official?.items?.[ticker]||null,liveItem=liveResult.display_eligible?liveResult.snapshot?.items?.[ticker]||null:null;
      const officialScore=finiteRaw(officialItem?.score),liveScore=finiteRaw(liveItem?.score);
      const rejectedItem=liveResult.snapshot?.items?.[ticker]||null;
      items[ticker]={ticker,score_version:scoreVersion,market_state:marketState,primary:"official",official:officialItem?{score:officialScore,display_score:Number(officialItem.display_score),trading_date:officialItem.trading_date,market_as_of:officialItem.market_as_of,status:"FINALIZED",source_status:"FINALIZED_EOD"}:null,live:liveItem?{score:liveScore,display_score:Number(liveItem.display_score),delta_vs_official:officialScore===null?null:liveScore-officialScore,trading_date:liveResult.snapshot.trading_date,slot:liveResult.snapshot.slot,market_as_of:liveItem.market_as_of,freshness:String(liveItem.freshness||"FRESH"),display_eligible:true,status:"LIVE_PROJECTED",reason:null}:{score:null,display_score:null,delta_vs_official:null,trading_date:String(liveResult.snapshot?.trading_date||targetDate),slot:String(liveResult.snapshot?.slot||""),market_as_of:String(rejectedItem?.market_as_of||""),freshness:liveResult.freshness,display_eligible:false,status:liveResult.status,reason:liveResult.reason}};
    }
    return{schema_version:1,score_version:scoreVersion,target_date:targetDate,market_state:marketState,primary:"official",official_snapshot:official,live_snapshot:liveResult.display_eligible?liveResult.snapshot:null,live_reason:liveResult.reason,items};
  }

  return Object.freeze({MARKET_STATES,LIVE_REASONS,snapshotMarketAsOf,normalizeFinalizedSnapshot,normalizeIntradaySnapshot,resolve,resolveFinalOnly,resolveMarketState,resolveLiveProjected,buildDualTrackView});
});
