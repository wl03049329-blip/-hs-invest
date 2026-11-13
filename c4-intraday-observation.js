"use strict";
(() => {
  const symbols = ["0050","00757","00830","00935","00662","009815"];
  const sources = new Set(["MIS_Z","MIS_PZ","FUGLE_LAST_TRADE"]);
  const messages = {
    WAIT_NATIVE:"等待原生資料", SPLIT_SUSPENDED:"分割停牌／暫停更新",
    SPLIT_RESUMPTION_UNVERIFIED:"復牌資料待驗證", QUOTE_UNAVAILABLE:"報價未取得",
    QUOTE_STALE:"報價過期", QUOTE_SOURCE_INVALID:"報價來源待驗證",
    QUOTE_DATE_INVALID:"報價日期不符", QUOTE_TIME_INVALID:"報價時間不符",
    WAITING_FIRST_TRADE:"等待首筆成交", QUOTE_INCOMPLETE:"報價資料不完整",
    CALCULATION_FAILED:"觀察計算未完成", HISTORY_UNVERIFIED:"歷史基準待驗證",
    OFF_SESSION:"非觀察時段"
  };
  function validate(payload, now, day) {
    if (payload?.schema_version!==1 || payload.kind!=="INTRADAY_OBSERVATION" || payload.formal_eligible!==false
        || payload.score_version!=="FINAL_CORE_WEIGHT_V1" || payload.trading_date!==day) return null;
    return Object.fromEntries(symbols.map(symbol=>{
      const row=payload.items?.[symbol];
      if(symbol==="009815")return [symbol,{status:"WAIT_NATIVE"}];
      if(row?.status==="OBSERVED"){
        const quote=Date.parse(row.quote_as_of), calculated=Date.parse(payload.calculated_at);
        if(row.trading_date===day && typeof row.quote_as_of==="string" && row.quote_as_of.startsWith(day+"T")
           && sources.has(row.source) && typeof row.score==="number" && row.score>=0 && row.score<=100
           && quote<=calculated && calculated<=now && now-quote<=420000)
          return [symbol,{status:"OBSERVED",score:row.score,quote_as_of:row.quote_as_of}];
        return [symbol,{status:"QUOTE_STALE"}];
      }
      return [symbol,{status:Object.hasOwn(messages,row?.status)?row.status:"QUOTE_UNAVAILABLE"}];
    }));
  }
  if (typeof module==="object" && module.exports) {module.exports={validate};return;}
  const host=document.getElementById("hsIntradayObservation");
  if (!host) return;
  const tz={timeZone:"Asia/Taipei"};
  const dayOf=now=>new Intl.DateTimeFormat("en-CA",{...tz,year:"numeric",month:"2-digit",day:"2-digit"}).format(now);
  const clock=new Intl.DateTimeFormat("en-GB",{...tz,hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"});
  let inFlight=false, payload=null, enabled=false;
  function render(){
    const now=new Date(), rows=validate(payload,+now,dayOf(now));
    host.hidden=!enabled;
    if(!enabled)return;
    const heading=document.createElement("b");heading.textContent="盤中觀察｜非正式 FINAL";
    const list=document.createElement("ul");
    for(const symbol of symbols){
      const row=rows?.[symbol], li=document.createElement("li");
      const label=document.createElement("strong"); label.textContent=symbol;
      const value=document.createElement("span");
      value.textContent=row?.status==="OBSERVED"?row.score.toFixed(1)+" 分 · "+clock.format(new Date(row.quote_as_of)):messages[row?.status]||"報價未取得";
      li.append(label,value);list.append(li);
    }
    host.replaceChildren(heading,list);
  }
  async function refresh(){
    if(inFlight || document.visibilityState==="hidden" || !host.parentElement?.getClientRects().length)return;
    inFlight=true;
    const ctl=new AbortController(), timeout=setTimeout(()=>ctl.abort(),8000);
    try{
      const base=window.HSLiveSourceAdapter?.railwayEndpoint();
      if(!base)return;
      const r=await fetch(new URL("/api/intraday-observation",base),{cache:"no-store",signal:ctl.signal});
      if(!r.ok){payload=null;if(r.status===404)enabled=false;return;}
      const body=await r.json(), now=new Date();
      payload=validate(body,+now,dayOf(now))?body:null;
      if(payload)enabled=true;
    }catch{payload=null;}
    finally{clearTimeout(timeout);inFlight=false;render();}
  }
  void refresh();
  setInterval(()=>{render();void refresh();},30000);
  window.addEventListener("online",refresh);
  document.addEventListener("visibilitychange",refresh);
})();
