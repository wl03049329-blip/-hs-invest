"use strict";

(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  if(root)root.HSLiveDiagnostics=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  const RENDER_MESSAGES=Object.freeze({
    BACKEND_NO_SNAPSHOT:"盤中資料尚未建立",
    API_UNAVAILABLE:"盤中資料連線異常",
    SNAPSHOT_STALE:"盤中行情暫時過期",
    FRONTEND_STATE_PENDING:"盤中資料同步中",
    MARKET_CLOSED:"今日盤中軌跡已封存",
    LIVE_ACTIVE:"盤中更新中",
  });

  function safeTime(value){
    const time=Date.parse(String(value||""));
    return Number.isFinite(time)?time:null;
  }
  function latestSnapshotTime(snapshots){
    return (Array.isArray(snapshots)?snapshots:[]).map(snapshot=>String(snapshot?.market_as_of||snapshot?.calculated_at||snapshot?.captured_at||""))
      .filter(value=>safeTime(value)!==null).sort((a,b)=>safeTime(b)-safeTime(a))[0]||null;
  }
  function normalizeBuildSha(value){
    const sha=String(value||"").trim();
    return /^[0-9a-f]{40}$/i.test(sha)?sha.toLowerCase():"LOCAL";
  }
  function archiveSummary(snapshots,tradingDate){
    const rows=Array.isArray(snapshots)?snapshots:[],date=String(tradingDate||"");
    const today=rows.filter(snapshot=>snapshot?.status==="SUCCESS"&&String(snapshot?.trading_date||"")===date);
    return Object.freeze({total:rows.length,today:today.length,archive_date:date,latest_today_snapshot_time:latestSnapshotTime(today)});
  }
  function diagnosticMarketState(value){
    const state=String(value||"UNAVAILABLE");
    return state==="CLOSED"||state==="HOLIDAY"?"MARKET_CLOSED":state;
  }
  function diagnosticRenderState({marketState,liveSnapshotCount=0,archivedTodaySnapshotCount=0,baseState="FRONTEND_STATE_PENDING"}={}){
    if(["CLOSED","HOLIDAY","MARKET_CLOSED"].includes(String(marketState||"")))return archivedTodaySnapshotCount>0?"FINAL_WITH_ARCHIVED_INTRADAY":"FINAL_ONLY_MARKET_CLOSED";
    return String(baseState||"FRONTEND_STATE_PENDING");
  }
  function sanitizeError(value){
    const text=String(value?.message||value||"UNKNOWN").replace(/https?:\/\/\S+/gi,"[URL]")
      .replace(/(?:token|authorization|api[_-]?key|x-api-key)\s*[:=]\s*\S+/gi,"credential=[REDACTED]");
    return text.slice(0,160);
  }
  function anomalyCode(state){
    if(state.api_live_snapshot_count>0&&state.store_live_snapshot_count===0)return"FRONTEND_STATE_NOT_UPDATED";
    if(state.api_live_snapshot_count>0&&state.store_live_snapshot_count>0&&!state.selected_snapshot_time)return"SOURCE_SELECTION_FAILED";
    if(state.api_live_snapshot_count>0&&state.selected_snapshot_time&&state.freshness_check==="ACCEPTED"&&state.render_state_after==="BACKEND_NO_SNAPSHOT")return"RENDER_DECISION_INCONSISTENT";
    if(state.received_new_snapshot==="YES"&&state.state_update_success==="YES"&&state.triggered_rerender==="NO")return"RERENDER_NOT_TRIGGERED";
    if(state.cache_or_service_worker_stale===true)return"CACHE_OR_SERVICE_WORKER_STALE";
    return null;
  }
  function createTelemetry({clock=()=>new Date(),maxEvents=120,base={}}={}){
    const events=[];
    let current={...base};
    function record(event,patch={}){
      const at=clock().toISOString(),next={...current,...patch,event,event_time:at};
      next.anomaly=anomalyCode(next);
      current=next;
      events.push(Object.freeze({...next}));
      if(events.length>maxEvents)events.splice(0,events.length-maxEvents);
      return snapshot();
    }
    function snapshot(){return Object.freeze({current:Object.freeze({...current}),events:Object.freeze(events.slice())})}
    return Object.freeze({record,snapshot});
  }
  function createRequestCoordinator(){
    let issued=0,applied=0,latestTime=null;
    return Object.freeze({
      begin(){issued+=1;return issued},
      canApply(sequence,snapshots,status){
        if(!Number.isInteger(sequence)||sequence<applied)return false;
        const candidate=latestSnapshotTime(snapshots);
        if(status==="AVAILABLE"&&candidate&&latestTime&&safeTime(candidate)<safeTime(latestTime))return false;
        return true;
      },
      applied(sequence,snapshots){
        applied=Math.max(applied,sequence);
        const candidate=latestSnapshotTime(snapshots);
        if(candidate&&(!latestTime||safeTime(candidate)>=safeTime(latestTime)))latestTime=candidate;
      },
      state(){return Object.freeze({issued,applied,latest_snapshot_time:latestTime})},
    });
  }
  function classifyRenderState({marketState,sourceStatus,transportError=false,pending=false,liveSnapshotCount=0,selectedSnapshotTime=null,freshnessCheck=null}={}){
    if(marketState==="CLOSED"||marketState==="HOLIDAY")return"MARKET_CLOSED";
    if(pending)return"FRONTEND_STATE_PENDING";
    if(transportError)return"API_UNAVAILABLE";
    if(freshnessCheck==="REJECTED")return"SNAPSHOT_STALE";
    if(marketState==="OPEN"&&sourceStatus==="AVAILABLE"&&liveSnapshotCount>0&&selectedSnapshotTime)return"LIVE_ACTIVE";
    return"BACKEND_NO_SNAPSHOT";
  }
  function messageFor(state){return RENDER_MESSAGES[state]||RENDER_MESSAGES.FRONTEND_STATE_PENDING}

  return Object.freeze({RENDER_MESSAGES,latestSnapshotTime,normalizeBuildSha,archiveSummary,diagnosticMarketState,diagnosticRenderState,sanitizeError,createTelemetry,createRequestCoordinator,classifyRenderState,messageFor});
});
