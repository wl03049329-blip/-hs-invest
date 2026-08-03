(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  root.HSLiveMarketCore=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";

  const TAIPEI_OFFSET_MS=8*60*60*1000;
  const finite=value=>{
    if(value===null||value===undefined||value==="")return null;
    const parsed=Number(String(value).replace(/,/g,"").replace(/%/g,""));
    return Number.isFinite(parsed)?parsed:null;
  };
  const positive=value=>{const parsed=finite(value);return parsed!==null&&parsed>0?parsed:null};
  const safeText=(value,max=80)=>String(value??"").replace(/[<>\x00-\x1f\x7f]/g,"").replace(/\s+/g," ").trim().slice(0,max);

  function taipeiParts(now=new Date()){
    const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Taipei",year:"numeric",month:"2-digit",day:"2-digit",weekday:"short",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).formatToParts(now);
    return Object.fromEntries(parts.map(part=>[part.type,part.value]));
  }

  function taipeiIso(dataDate,dataTime){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(String(dataDate||""))||!/^\d{2}:\d{2}(?::\d{2})?$/.test(String(dataTime||"")))return null;
    const suffix=String(dataTime).length===5?":00":"";
    const utc=Date.parse(`${dataDate}T${dataTime}${suffix}+08:00`);
    return Number.isFinite(utc)?new Date(utc).toISOString():null;
  }

  function quoteFreshness(quote,sessionKey,now=new Date()){
    const quoteAt=Date.parse(String(quote?.quoteTime||quote?.quote_time||""));
    if(!Number.isFinite(quoteAt))return{key:"unavailable",label:"資料暫時無法取得",ageSeconds:null,stale:true};
    const ageSeconds=Math.max(0,(now.getTime()-quoteAt)/1000);
    if(!["intraday","day","night"].includes(sessionKey))return{key:"closed",label:"最近正式收盤",ageSeconds,stale:false};
    if(ageSeconds<=60)return{key:"updating",label:"更新中",ageSeconds,stale:false};
    if(ageSeconds<=180)return{key:"delayed",label:"延遲行情",ageSeconds,stale:false};
    return{key:"stale",label:"資料過期",ageSeconds,stale:true};
  }

  function normalizeQuote(raw,key,defaults={}){
    if(!raw||typeof raw!=="object")return null;
    const price=positive(raw.price??raw.value??raw.close);
    const previousClose=positive(raw.previous_close??raw.previousClose??raw.reference_price);
    const dataDate=String(raw.data_date??raw.date??"");
    const dataTime=String(raw.data_time??raw.time??"");
    const quoteTimeValue=raw.quote_time??raw.quoteTime??taipeiIso(dataDate,dataTime);
    const quoteTime=Number.isFinite(Date.parse(String(quoteTimeValue||"")))?new Date(Date.parse(String(quoteTimeValue))).toISOString():null;
    if(price===null||previousClose===null||!quoteTime)return null;
    const change=finite(raw.change)??price-previousClose;
    const changePct=finite(raw.change_pct??raw.changePct)??change/previousClose*100;
    if(!Number.isFinite(change)||!Number.isFinite(changePct)||Math.abs(changePct)>50)return null;
    const open=positive(raw.open),high=positive(raw.high),low=positive(raw.low),volume=finite(raw.volume);
    if(high!==null&&low!==null&&high<low)return null;
    if(volume!==null&&volume<0)return null;
    return{
      key,
      name:safeText(raw.name||defaults.name||key),
      symbol:safeText(raw.symbol||defaults.symbol||key,24),
      value:price,price,previousClose,change,changePct,
      open,high,low,volume:volume===null?null:volume,
      dataDate:dataDate||quoteTime.slice(0,10),
      dataTime:dataTime||new Intl.DateTimeFormat("en-GB",{timeZone:"Asia/Taipei",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).format(new Date(quoteTime)),
      quoteTime,
      quoteMode:safeText(raw.quote_mode||raw.quoteMode||defaults.quoteMode||"delayed",24),
      session:safeText(raw.session||raw.source_session||defaults.session||"spot",24),
      sourceName:safeText(raw.source_name||raw.sourceName||defaults.sourceName||"",100),
      sourceUrl:safeText(raw.source_url||raw.source||defaults.sourceUrl||"",500),
      delayNote:safeText(raw.delay_note||raw.delayNote||defaults.delayNote||"延遲行情｜僅供參考",120),
      contractMonth:safeText(raw.contract_month||raw.contractMonth||"",12)
    };
  }

  function normalizeAuthorizedPayload(payload){
    if(!payload||typeof payload!=="object"||Array.isArray(payload))throw new Error("授權行情格式錯誤");
    const sourceName=safeText(payload.source_name||"授權行情 Proxy",100);
    const sourceUrl=safeText(payload.source_url||"",500);
    const defaults={sourceName,sourceUrl,quoteMode:"delayed"};
    const items={};
    for(const key of ["taiex","otc","tsmc","gold","brent"]){
      const item=normalizeQuote(payload.items?.[key],key,defaults);
      if(item)items[key]=item;
    }
    const etfs={};
    for(const [code,raw] of Object.entries(payload.etfs||{})){
      if(!/^\d{4,6}[A-Z]?$/.test(code))continue;
      const item=normalizeQuote(raw,code,defaults);
      if(item)etfs[code]=item;
    }
    const futures=normalizeFutures(payload.futures,defaults);
    if(!Object.keys(items).length&&!Object.keys(etfs).length&&!futures)throw new Error("授權行情沒有有效項目");
    return{updatedAt:new Date().toISOString(),sourceName,sourceUrl,items,etfs,futures};
  }

  function normalizeFutures(raw,defaults={}){
    if(!raw||typeof raw!=="object")return null;
    const current=normalizeQuote(raw.current,"tx_front",{...defaults,name:"台指期近月",session:raw.current?.session||raw.session});
    const day=normalizeQuote(raw.day,"tx_day",{...defaults,name:"台指期日盤",session:"day"});
    const night=normalizeQuote(raw.night,"tx_night",{...defaults,name:"台指期夜盤",session:"night"});
    const available=[current,day,night].filter(Boolean);
    if(!available.length)return null;
    const months=new Set(available.map(item=>item.contractMonth).filter(Boolean));
    if(months.size>1)throw new Error("台指期行情混用了不同契約月份");
    return{current,day,night,contractMonth:[...months][0]||safeText(raw.contract_month||"",12),authorizedIntraday:true,sourceName:defaults.sourceName||"授權行情 Proxy"};
  }

  function pollDelay({spotActive=false,commodityActive=true,futuresActive=false,failures=0,httpStatus=0}={}){
    if(httpStatus===429)return Math.min(15*60*1000,120000*2**Math.min(failures,3));
    if(failures>0)return Math.min(15*60*1000,30000*2**Math.min(failures,5));
    if(spotActive||futuresActive)return 20000;
    if(commodityActive)return 45000;
    return 15*60*1000;
  }

  function validProxyUrl(value,baseHref="https://example.com/"){
    const input=String(value||"").trim();
    if(!input)return"";
    try{
      const url=new URL(input,baseHref);
      if(url.protocol!=="https:"||url.username||url.password||url.search)return"";
      return url.href;
    }catch{return""}
  }

  return{finite,positive,taipeiParts,taipeiIso,quoteFreshness,normalizeQuote,normalizeAuthorizedPayload,normalizeFutures,pollDelay,validProxyUrl};
});
