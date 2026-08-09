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
    portfolioMarketVersion:PREFIX+"portfolio.marketVersion",finmindToken:PREFIX+"finmindToken",
    forwardTest:PREFIX+"forwardTest.v1.2.1",migration:PREFIX+"migrationVersion"
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
    const normalized={...state,symbol:String(symbol||state?.symbol||"").toUpperCase()};
    if(!/^[0-9A-Z]{2,10}$/.test(normalized.symbol))return false;
    if(!["ACCUMULATION","HOLDING","EXIT","CLOSED"].includes(normalized.state))return false;
    const position=finite(normalized.position);
    if(position===null||position<0||position>100)return false;
    return setJson(tradeKey(normalized.symbol),normalized);
  }
  function forwardKey(record){return`${record.symbol}|${record.signalDate}|${record.stage}|${record.tradeId}`}
  function validateForwardRecord(raw){
    const symbol=String(raw?.symbol||"").toUpperCase(),signalDate=safeDate(raw?.signalDate),stage=Math.floor(finite(raw?.stage)??0),tradeId=String(raw?.tradeId||"");
    if(!/^[0-9A-Z]{2,10}$/.test(symbol)||!signalDate||signalDate<FORWARD_START_DATE||stage<1||!tradeId||raw?.provisional===true)return null;
    const score=finite(raw?.buyScore),exit=finite(raw?.exitPressure),price=finite(raw?.signalPrice);
    if(score===null||score<0||score>100||price===null||price<=0)return null;
    return{key:`${symbol}|${signalDate}|${stage}|${tradeId}`,symbol,signalDate,stage,tradeId,strategyType:String(raw.strategyType||""),modelVersion:MODEL_VERSION,buyScore:score,exitPressure:exit,signalPrice:price,tradeState:String(raw.tradeState||"ACCUMULATION"),confidence:String(raw.confidence||"INSUFFICIENT"),outcomes:raw.outcomes&&typeof raw.outcomes==="object"?raw.outcomes:{},createdAt:String(raw.createdAt||new Date().toISOString())};
  }
  function appendForwardRecord(raw){
    const record=validateForwardRecord(raw);if(!record)return{ok:false,reason:"invalid_or_provisional"};
    const rows=getJson(keys.forwardTest,[]);if(!Array.isArray(rows))return{ok:false,reason:"invalid_store"};
    if(rows.some(item=>item?.key===record.key))return{ok:true,duplicate:true,record};
    rows.push(record);return setJson(keys.forwardTest,rows)?{ok:true,duplicate:false,record}:{ok:false,reason:"storage_failed"};
  }
  function listForwardRecords(){const rows=getJson(keys.forwardTest,[]);return Array.isArray(rows)?rows.map(validateForwardRecord).filter(Boolean):[]}
  function validateAllocations(items){
    if(!Array.isArray(items))return{ok:false,total:null};
    const normalized=[];let total=0;
    for(const item of items){const symbol=String(item?.symbol||"").toUpperCase(),target=finite(item?.targetAllocation);if(!/^[0-9A-Z]{2,10}$/.test(symbol)||target===null||target<0||target>100)return{ok:false,total:null};total+=target;normalized.push({symbol,targetAllocation:target});}
    return{ok:total<=100,total:Number(total.toFixed(2)),items:normalized};
  }
  migrateLegacy();
  return Object.freeze({PREFIX,MODEL_VERSION,FORWARD_START_DATE,SCHEMA_VERSION,LEGACY_KEYS,keys,key,getRaw,setRaw,remove,getJson,setJson,migrateLegacy,tradeKey,loadTradeState,saveTradeState,forwardKey,validateForwardRecord,appendForwardRecord,listForwardRecords,validateAllocations});
});
