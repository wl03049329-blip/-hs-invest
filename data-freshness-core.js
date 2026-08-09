(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  root.HSDataFreshnessCore=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";
  const STATUS=Object.freeze({LATEST:"LATEST",STALE:"STALE",WAITING:"WAITING",FAILED:"FAILED",FALLBACK:"FALLBACK"});
  const LABELS=Object.freeze({LATEST:"最新資料",STALE:"資料可能過期",WAITING:"等待更新",FAILED:"更新失敗",FALLBACK:"沿用最後有效資料"});
  const DATE_RE=/^\d{4}-\d{2}-\d{2}$/;

  function taipeiDate(now=new Date()){
    const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Taipei",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(now);
    const map=Object.fromEntries(parts.map(part=>[part.type,part.value]));
    return `${map.year}-${map.month}-${map.day}`;
  }
  function tradingDayAge(dataDate,today=taipeiDate()){
    if(!DATE_RE.test(String(dataDate||""))||!DATE_RE.test(String(today||"")))return null;
    const start=new Date(`${dataDate}T12:00:00+08:00`),end=new Date(`${today}T12:00:00+08:00`);
    if(!Number.isFinite(start.getTime())||!Number.isFinite(end.getTime())||start>end)return null;
    let cursor=new Date(start),days=0;
    while(cursor<end){
      cursor.setUTCDate(cursor.getUTCDate()+1);
      const weekday=new Intl.DateTimeFormat("en-US",{timeZone:"Asia/Taipei",weekday:"short"}).format(cursor);
      if(["Mon","Tue","Wed","Thu","Fri"].includes(weekday))days++;
    }
    return days;
  }
  function validTimestamp(value,now=new Date()){
    const parsed=Date.parse(value||"");
    return Number.isFinite(parsed)&&parsed<=now.getTime()+6*3600000?new Date(parsed).toISOString():"";
  }
  function normalize(input={},options={}){
    const now=options.now instanceof Date?options.now:new Date(options.now||Date.now());
    const dataDate=DATE_RE.test(String(input.data_date||input.dataDate||""))?String(input.data_date||input.dataDate):"";
    const updatedAt=validTimestamp(input.updated_at||input.updatedAt,now);
    const source=String(input.source||input.source_name||input.sourceName||"").slice(0,160);
    const age=tradingDayAge(dataDate,taipeiDate(now));
    const maxAge=Number.isFinite(options.maxTradingDayAge)?options.maxTradingDayAge:3;
    let status=String(input.status||"").toUpperCase();
    if(!Object.values(STATUS).includes(status))status="";
    if(input.failed===true)status=STATUS.FAILED;
    else if(input.fallback===true)status=STATUS.FALLBACK;
    else if(!dataDate&&!updatedAt)status=STATUS.WAITING;
    else if(age===null||age>maxAge)status=STATUS.STALE;
    else status=STATUS.LATEST;
    return{value:input.value??null,data_date:dataDate,updated_at:updatedAt,source,status,confidence:input.confidence??null,trading_day_age:age};
  }
  function isNewerDataDate(next,previous){return DATE_RE.test(String(next||""))&&(!DATE_RE.test(String(previous||""))||String(next)>String(previous));}
  function label(status){return LABELS[status]||LABELS.WAITING;}
  return{STATUS,LABELS,taipeiDate,tradingDayAge,normalize,isNewerDataDate,label};
});
