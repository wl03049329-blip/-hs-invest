(function (root, factory) {
  const api=factory(root?.localStorage);
  if(typeof module==="object"&&module.exports)module.exports=api;
  if(root)root.HSPersistenceCore=api;
})(typeof window!=="undefined"?window:globalThis,function(storage){
  "use strict";
  const PREFIX="hsRadar.";
  const MODEL_VERSION="HS Swing Radar V1.2.1 Beta Validated Frozen";
  const FORWARD_START_DATE="2026-08-08";
  const SCHEMA_VERSION=1;
  const EVENT_TRIGGER_TYPES=Object.freeze(["longTermScoreCrossed70","weeklyJBelow10","rankUp2","marginRatioBelow140","marginRatioBelow130","rebalanceOutsideBand","00631LPanicAbove80","00631LReversalAbove60"]);
  const LEGACY_KEYS=Object.freeze({
    hs_etf_watchlist_v1:"watchlist",
    hs_etf_radar_mode_v1:"radarMode",
    hs_buy_plan_mode_v1:"buyPlanMode",
    hs_long_rank_v1:"longRank",
    hs_chip_tab_v1:"chipTab",
    hs_custom_events:"customEvents",
    hs_alerts:"alerts",
    hs_etf_universe_cache_v1:"etfUniverseCache",
    hs_live_quote_proxy_v1:"liveQuoteProxy",
    hs_portfolio_v6:"portfolio.holdings",
    hs_portfolio_quotes_v1:"portfolio.quotes",
    hs_portfolio_auto_v1:"portfolio.autoRefresh",
    hs_portfolio_market_version_v1:"portfolio.marketVersion",
    finmind_token:"finmindToken"
  });
  const keys=Object.freeze({
    watchlist:PREFIX+"watchlist",radarMode:PREFIX+"radarMode",buyPlanMode:PREFIX+"buyPlanMode",
    longRank:PREFIX+"longRank",chipTab:PREFIX+"chipTab",customEvents:PREFIX+"customEvents",
    alerts:PREFIX+"alerts",etfUniverseCache:PREFIX+"etfUniverseCache",liveQuoteProxy:PREFIX+"liveQuoteProxy",
    holdings:PREFIX+"portfolio.holdings",quotes:PREFIX+"portfolio.quotes",portfolioAuto:PREFIX+"portfolio.autoRefresh",
    portfolioMarketVersion:PREFIX+"portfolio.marketVersion",portfolioRebalanceSettings:PREFIX+"portfolio.rebalanceSettings",finmindToken:PREFIX+"finmindToken",
    forwardTest:PREFIX+"forwardTest.v1.2.1",decisionLog:PREFIX+"decisionLog",events:PREFIX+"events",eventTriggers:PREFIX+"eventTriggers",migration:PREFIX+"migrationVersion"
  });
  const safeStorage=storage&&typeof storage.getItem==="function"?storage:null;
  const finite=value=>{if(value===null||value===undefined||value==="")return null;const number=Number(value);return Number.isFinite(number)?number:null};
  const safeDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(String(value||""))?String(value):"";
  function key(name){return PREFIX+String(name||"").replace(/^\.+|\.+$/g,"")}
  function getRaw(name,fallback=null){try{const value=safeStorage?.getItem(name);return value===null?fallback:value}catch{return fallback}}
  function setRaw(name,value){try{safeStorage?.setItem(name,String(value));return true}catch{return false}}
  function remove(name){try{safeStorage?.removeItem(name);return true}catch{return false}}
  function getJson(name,fallback){try{const value=JSON.parse(getRaw(name,"null"));return value===null?fallback:value}catch{return fallback}}
  function setJson(name,value){return setRaw(name,JSON.stringify(value))}
  function migrateLegacy(){
    if(!safeStorage)return{migrated:[],version:SCHEMA_VERSION};
    const migrated=[];
    for(const [oldName,newName] of Object.entries(LEGACY_KEYS)){
      const target=key(newName),oldValue=getRaw(oldName,null);
      if(getRaw(target,null)===null&&oldValue!==null){setRaw(target,oldValue);migrated.push({from:oldName,to:target});}
    }
    setRaw(keys.migration,SCHEMA_VERSION);
    return{migrated,version:SCHEMA_VERSION};
  }
  function tradeKey(symbol){return key(`tradeState.${String(symbol||"").toUpperCase()}`)}
  function loadTradeState(symbol){return getJson(tradeKey(symbol),{symbol:String(symbol||"").toUpperCase(),state:"CLOSED",position:0})}
  function saveTradeState(symbol,state){
    const normalizedSymbol=String(symbol||state?.symbol||"").toUpperCase(),tradeState=String(state?.state||"");
    if(!/^[0-9A-Z]{2,10}$/.test(normalizedSymbol))return false;
    if(!["ACCUMULATION","HOLDING","EXIT","CLOSED"].includes(tradeState))return false;
    const position=finite(state?.position);
    if(position===null||position<0||position>100)return false;
    const nonNegativeInteger=value=>Math.max(0,Math.floor(finite(value)??0));
    const normalized={tradeId:String(state?.tradeId||""),symbol:normalizedSymbol,state:tradeState,position,
      entryPrice:finite(state?.entryPrice),peakPrice:finite(state?.peakPrice),entryDate:safeDate(state?.entryDate),exitDate:safeDate(state?.exitDate),
      highestStage:nonNegativeInteger(state?.highestStage),lastExecutedStage:nonNegativeInteger(state?.lastExecutedStage),lastStageDate:safeDate(state?.lastStageDate),lastEntryPrice:finite(state?.lastEntryPrice),
      holdingDays:nonNegativeInteger(state?.holdingDays),belowMa200Days:nonNegativeInteger(state?.belowMa200Days),cooldownRemaining:nonNegativeInteger(state?.cooldownRemaining)};
    return setJson(tradeKey(normalized.symbol),normalized);
  }
  function forwardKey(record){return`${record.symbol}|${record.signalDate}|${record.stage}|${record.tradeId}`}
  function validateForwardRecord(raw){
    const symbol=String(raw?.symbol||"").toUpperCase(),signalDate=safeDate(raw?.signalDate),stage=Math.floor(finite(raw?.stage)??0),tradeId=String(raw?.tradeId||"");
    if(!/^[0-9A-Z]{2,10}$/.test(symbol)||!signalDate||signalDate<FORWARD_START_DATE||stage<1||!tradeId||raw?.provisional===true)return null;
    const score=finite(raw?.buyScore),rawScore=finite(raw?.rawScore),exit=finite(raw?.exitPressure),price=finite(raw?.signalPrice),position=finite(raw?.position);
    if(score===null||score<0||score>100||rawScore===null||rawScore<0||rawScore>100||exit===null||exit<0||exit>100||price===null||price<=0||position===null||position<0||position>100)return null;
    return{key:`${symbol}|${signalDate}|${stage}|${tradeId}`,symbol,signalDate,stage,tradeId,strategyType:String(raw.strategyType||""),modelVersion:MODEL_VERSION,buyScore:score,rawScore,exitPressure:exit,signalPrice:price,position,weeklyJ:finite(raw.weeklyJ),relativeStrength:finite(raw.relativeStrength),ma20:finite(raw.ma20),ma60:finite(raw.ma60),ma200:finite(raw.ma200),drawdown60:finite(raw.drawdown60),gate:raw.gate&&typeof raw.gate==="object"?raw.gate:{},marketStatus:String(raw.marketStatus||""),tradeState:String(raw.tradeState||"ACCUMULATION"),confidence:String(raw.confidence||"INSUFFICIENT"),outcomes:raw.outcomes&&typeof raw.outcomes==="object"?raw.outcomes:{},createdAt:String(raw.createdAt||new Date().toISOString())};
  }
  function appendForwardRecord(raw){
    const record=validateForwardRecord(raw);if(!record)return{ok:false,reason:"invalid_or_provisional"};
    const rows=getJson(keys.forwardTest,[]);if(!Array.isArray(rows))return{ok:false,reason:"invalid_store"};
    if(rows.some(item=>item?.key===record.key))return{ok:true,duplicate:true,record};
    rows.push(record);return setJson(keys.forwardTest,rows)?{ok:true,duplicate:false,record}:{ok:false,reason:"storage_failed"};
  }
  function listForwardRecords(){const rows=getJson(keys.forwardTest,[]);return Array.isArray(rows)?rows.map(validateForwardRecord).filter(Boolean):[]}
  function validateEvent(raw){
    const id=String(raw?.id||""),symbol=String(raw?.symbol||"").toUpperCase(),date=safeDate(raw?.date),type=String(raw?.type||""),severity=String(raw?.severity||"");
    if(!id||!date||!/^[0-9A-Z]{2,10}$/.test(symbol)||!["BUY_STAGE","EXIT_PRESSURE","MARKET_GATE","STRUCTURE_STOP","REBALANCE","DATA_WARNING"].includes(type)||!["low","medium","high","critical"].includes(severity))return null;
    return{id,symbol,date,type,severity,title:String(raw.title||"").slice(0,120),reason:String(raw.reason||"").slice(0,300),strategyVersion:MODEL_VERSION,acknowledged:raw.acknowledged===true};
  }
  function appendEvent(raw){const event=validateEvent(raw);if(!event)return{ok:false,reason:"invalid_event"};const rows=getJson(keys.events,[]);if(!Array.isArray(rows))return{ok:false,reason:"invalid_store"};if(rows.some(item=>item?.id===event.id))return{ok:true,duplicate:true,event};rows.push(event);return setJson(keys.events,rows)?{ok:true,duplicate:false,event}:{ok:false,reason:"storage_failed"}}
  function validateDecisionLog(raw){
    const date=safeDate(raw?.date),symbol=String(raw?.symbol||"").toUpperCase(),score=finite(raw?.score),before=finite(raw?.positionBefore),after=finite(raw?.positionAfter);
    if(!date||!/^[0-9A-Z]{2,10}$/.test(symbol)||score===null||score<0||score>100||before===null||after===null||before<0||before>100||after<0||after>100)return null;
    return{date,symbol,tradeId:String(raw.tradeId||""),strategy:String(raw.strategy||""),score,stage:Math.max(0,Math.floor(finite(raw.stage)??0)),positionBefore:before,positionAfter:after,action:String(raw.action||"").slice(0,40),reason:String(raw.reason||"").slice(0,300),userNote:String(raw.userNote||"").slice(0,300),createdAt:String(raw.createdAt||new Date().toISOString())};
  }
  function appendDecisionLog(raw){const entry=validateDecisionLog(raw);if(!entry)return{ok:false,reason:"invalid_decision"};const rows=getJson(keys.decisionLog,[]);if(!Array.isArray(rows))return{ok:false,reason:"invalid_store"};rows.push(entry);return setJson(keys.decisionLog,rows)?{ok:true,entry}:{ok:false,reason:"storage_failed"}}
  function validateAllocations(items){
    if(!Array.isArray(items))return{ok:false,total:null};
    const normalized=[];let total=0;
    for(const item of items){const symbol=String(item?.symbol||"").toUpperCase(),target=finite(item?.targetAllocation);if(!/^[0-9A-Z]{2,10}$/.test(symbol)||target===null||target<0||target>100)return{ok:false,total:null};total+=target;normalized.push({symbol,targetAllocation:target});}
    return{ok:total<=100,total:Number(total.toFixed(2)),items:normalized};
  }
  migrateLegacy();
  return Object.freeze({PREFIX,MODEL_VERSION,FORWARD_START_DATE,SCHEMA_VERSION,EVENT_TRIGGER_TYPES,LEGACY_KEYS,keys,key,getRaw,setRaw,remove,getJson,setJson,migrateLegacy,tradeKey,loadTradeState,saveTradeState,forwardKey,validateForwardRecord,appendForwardRecord,listForwardRecords,validateEvent,appendEvent,validateDecisionLog,appendDecisionLog,validateAllocations});
});
