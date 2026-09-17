"use strict";

(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  if(root)root.HSLiveSourceAdapter=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  const DEFAULT_SOURCE="railway";
  const DEFAULT_RAILWAY_URL="https://hs-invest-production.up.railway.app/api/live-scores";
  const VALID_SOURCES=new Set(["legacy","railway"]);
  const VALID_FRESHNESS=new Set(["FRESH","DELAYED"]);

  function selectedSource({globalObject=typeof globalThis!=="undefined"?globalThis:null,documentObject=typeof document!=="undefined"?document:null}={}){
    const configured=String(globalObject?.HS_LIVE_SOURCE||documentObject?.querySelector?.('meta[name="hs-live-source"]')?.content||DEFAULT_SOURCE).trim().toLowerCase();
    return VALID_SOURCES.has(configured)?configured:DEFAULT_SOURCE;
  }

  function railwayEndpoint({globalObject=typeof globalThis!=="undefined"?globalThis:null,documentObject=typeof document!=="undefined"?document:null}={}){
    return String(globalObject?.HS_LIVE_RAILWAY_URL||documentObject?.querySelector?.('meta[name="hs-live-railway-url"]')?.content||DEFAULT_RAILWAY_URL).trim();
  }

  function slotAt(value){
    const date=new Date(value);
    if(!Number.isFinite(date.getTime()))return"";
    const parts=Object.fromEntries(new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Taipei",hour:"2-digit",minute:"2-digit",hour12:false}).formatToParts(date).map(part=>[part.type,part.value]));
    return`${parts.hour}:${parts.minute}`;
  }

  function unavailable(reason,payload=null,diagnostics={}){
    return{source:"railway",status:"UNAVAILABLE",reason:String(reason||"RAILWAY_SOURCE_UNAVAILABLE"),snapshots:[],market_state:String(payload?.market_state||"UNAVAILABLE"),trading_date:String(payload?.trading_date||""),diagnostics:{...diagnostics}};
  }

  function railwayToCanonical(payload,{targetDate,scoreVersion,symbols,now=new Date(),maxAgeSeconds=600}={}){
    const expected=[...(symbols||[])].map(String),nowMs=(now instanceof Date?now:new Date(now)).getTime();
    if(!payload||payload.status!=="AVAILABLE"||payload.market_state!=="OPEN"||payload.completeness!=="5/5")return unavailable(payload?.diagnostic_reason||"RAILWAY_UNAVAILABLE",payload,{api_live_snapshot_count:0,freshness_check:"REJECTED",reject_reason:String(payload?.diagnostic_reason||"RAILWAY_UNAVAILABLE")});
    if(payload.c4_version!==scoreVersion)return unavailable("C4_VERSION_MISMATCH",payload);
    const tradingDate=String(payload.trading_date||""),asOf=String(payload.as_of||"");
    if(tradingDate!==targetDate||!asOf.startsWith(`${tradingDate}T`)||!Number.isFinite(nowMs))return unavailable("TRADING_DATE_MISMATCH",payload);
    const items={};
    for(const symbol of expected){
      const row=payload?.tickers?.[symbol],score=Number(row?.score),displayScore=Number(row?.display_score),quoteAsOf=String(row?.quote_as_of||""),quoteMs=Date.parse(quoteAsOf),ageSeconds=(nowMs-quoteMs)/1000;
      if(row?.status!=="AVAILABLE"||!Number.isFinite(score)||score<0||score>100||!Number.isFinite(displayScore))return unavailable(`INVALID_SCORE:${symbol}`,payload,{api_live_snapshot_count:1,freshness_check:"REJECTED",reject_reason:"INVALID_SCORE",symbol});
      if(!quoteAsOf.startsWith(`${tradingDate}T`)||!Number.isFinite(quoteMs)||ageSeconds<0||ageSeconds>maxAgeSeconds||!VALID_FRESHNESS.has(String(row?.freshness||"")))return unavailable(`QUOTE_NOT_CURRENT:${symbol}`,payload,{api_live_snapshot_count:1,freshness_check:"REJECTED",reject_reason:ageSeconds>maxAgeSeconds?"QUOTE_TOO_OLD":ageSeconds<0?"QUOTE_IN_FUTURE":"QUOTE_NOT_CURRENT",symbol,quote_age_sec:Number.isFinite(ageSeconds)?Math.round(ageSeconds):null,threshold_sec:maxAgeSeconds});
      items[symbol]={status:"SUCCESS",score,display_score:displayScore,delta_vs_previous_close:Number.isFinite(Number(row.delta_vs_official))?Number(row.delta_vs_official):null,market_as_of:quoteAsOf,freshness:String(row.freshness),quote_source:String(row.quote_source||""),score_version:scoreVersion,trading_date:tradingDate,calculated_at:String(payload.calculated_at||asOf)};
    }
    const wait=payload?.tickers?.["009815"];
    if(wait?.status!=="WAIT_NATIVE"||wait?.freshness!=="WAIT_NATIVE")return unavailable("WAIT_NATIVE_CONTRACT_MISMATCH",payload);
    const snapshot={schema_version:1,snapshot_type:"INTRADAY_CORE",status:"SUCCESS",source_status:"RAILWAY_LIVE_PROJECTED",trading_date:tradingDate,slot:slotAt(asOf),market_as_of:asOf,captured_at:asOf,calculated_at:String(payload.calculated_at||asOf),score_version:scoreVersion,source_completeness:"5/5",items};
    if(!/^\d{2}:\d{2}$/.test(snapshot.slot))return unavailable("INVALID_AS_OF",payload);
    const ages=expected.map(symbol=>(nowMs-Date.parse(items[symbol].market_as_of))/1000).filter(Number.isFinite);
    return{source:"railway",status:"AVAILABLE",reason:null,snapshots:[snapshot],market_state:"OPEN",trading_date:tradingDate,diagnostics:{api_live_snapshot_count:1,api_latest_snapshot_time:asOf,freshness_check:"ACCEPTED",reject_reason:null,maximum_quote_age_sec:ages.length?Math.round(Math.max(...ages)):null,threshold_sec:maxAgeSeconds}};
  }

  async function loadRailway({fetchImpl=typeof fetch!=="undefined"?fetch:null,endpoint=DEFAULT_RAILWAY_URL,signal,targetDate,scoreVersion,symbols,now=new Date(),timeoutMs=10000}={}){
    if(typeof fetchImpl!=="function")throw new Error("FETCH_UNAVAILABLE");
    const controller=new AbortController(),abort=()=>controller.abort(signal?.reason),timer=setTimeout(()=>controller.abort(new Error("RAILWAY_TIMEOUT")),timeoutMs);
    if(signal?.aborted)abort();else signal?.addEventListener?.("abort",abort,{once:true});
    const requestStart=Date.now(),requestStartTime=new Date(requestStart).toISOString();
    try{
      const response=await fetchImpl(endpoint,{cache:"no-store",signal:controller.signal,headers:{Accept:"application/json","Cache-Control":"no-cache"}});
      if(!response?.ok){const error=new Error(`RAILWAY_HTTP_${response?.status||0}`);error.httpStatus=Number(response?.status||0);throw error}
      const result=railwayToCanonical(await response.json(),{targetDate,scoreVersion,symbols,now});
      return{...result,diagnostics:{...(result.diagnostics||{}),request_start_time:requestStartTime,request_end_time:new Date().toISOString(),api_fetch_status:Number(response.status||200),api_fetch_ms:Date.now()-requestStart}};
    }catch(error){
      error.liveDiagnostics={request_start_time:requestStartTime,request_end_time:new Date().toISOString(),api_fetch_status:Number(error?.httpStatus||0),api_fetch_ms:Date.now()-requestStart};
      throw error;
    }finally{
      clearTimeout(timer);signal?.removeEventListener?.("abort",abort);
    }
  }

  function isTaipeiLiveWindow(now=new Date()){
    const date=now instanceof Date?now:new Date(now);
    if(!Number.isFinite(date.getTime()))return false;
    const parts=Object.fromEntries(new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Taipei",weekday:"short",hour:"2-digit",minute:"2-digit",hour12:false}).formatToParts(date).map(part=>[part.type,part.value]));
    const minutes=Number(parts.hour)*60+Number(parts.minute);
    return !["Sat","Sun"].includes(parts.weekday)&&minutes>=8*60+55&&minutes<=13*60+40;
  }

  return Object.freeze({DEFAULT_SOURCE,DEFAULT_RAILWAY_URL,selectedSource,railwayEndpoint,railwayToCanonical,loadRailway,isTaipeiLiveWindow});
});
