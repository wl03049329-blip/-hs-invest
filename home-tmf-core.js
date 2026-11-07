"use strict";
(function(root,factory){
  if(typeof module==="object" && module.exports)module.exports=factory(require("./home-taiex-core"));
  else root.HSHomeTmf=factory(root.HSHomeTaiex);
})(globalThis,function(calendar){
  const key="hs.publicDisplay.tmf.v1", int=Number.isSafeInteger;
  const count=n=>int(n)&&n>=0;
  function observation(o,date){
    if(!o||o.date!==date||!o.months||!o.institutional||!int(o.net))return false;
    const months=Object.entries(o.months);
    if(months.length!==6||!months.every(([m,n])=>/^\d{4}(?:0[1-9]|1[0-2])$/.test(m)&&count(n)))return false;
    const total=months.reduce((a,[,n])=>a+n,0);
    if(!int(total)||!total||total!==o.market_open_interest)return false;
    if(Object.keys(o.institutional).length!==3)return false;
    const groups=["自營商","投信","外資及陸資"].map(k=>o.institutional[k]);
    if(!groups.every(p=>p&&count(p.long)&&count(p.short)&&int(p.net)&&p.long-p.short===p.net))return false;
    const long=groups.reduce((a,p)=>a+p.long,0),short=groups.reduce((a,p)=>a+p.short,0);
    if(long>total||short>total||short-long!==o.net)return false;
    return Array.isArray(o.evidence)&&o.evidence.length===2&&["futContractsDate","futDailyMarketReport"].every((path,i)=>{
      const e=o.evidence[i], query=new URLSearchParams({doQuery:"1",queryDate:date.replaceAll("-","/"),
        ...(i===0?{queryType:"1",commodityId:"TMF"}:{queryType:"2",commodity_id:"TMF",MarketCode:"0"})});
      return e?.url==="https://www.taifex.com.tw/cht/3/"+path+"?"+query&&typeof e.sha256==="string"&&/^[a-f0-9]{64}$/.test(e.sha256);
    });
  }
  function valid(x,now=Date.now()){
    if(!x||x.schema!=="HS_HOME_TMF_V1"||x.source!=="TAIFEX"||x.contract!=="TMF"||
      x.session!=="REGULAR"||x.validation!=="VERIFIED"||!calendar.day(x.trade_date)||
      !calendar.day(x.previous_trade_date)||x.previous_trade_date>=x.trade_date||!int(x.net)||!int(x.net_change)||
      typeof x.retrieved_at!=="string"||!Array.isArray(x.observations)||x.observations.length!==2)return false;
    const at=Date.parse(x.retrieved_at);
    if(!Number.isFinite(at)||new Date(at).toISOString()!==x.retrieved_at||at>now||at<Date.parse(x.trade_date+"T13:45:00+08:00"))return false;
    const [prev,current]=x.observations;
    return observation(prev,x.previous_trade_date)&&observation(current,x.trade_date)&&
      current.net===x.net&&current.net-prev.net===x.net_change;
  }
  function select(old,incoming,now=Date.now()){
    if(!valid(old,now))old=null;
    return valid(incoming,now)&&(!old||incoming.trade_date>old.trade_date)?incoming:old;
  }
  const fmt=new Intl.NumberFormat("zh-TW");
  const signed=n=>(n>0?"+":n<0?"−":"")+fmt.format(Math.abs(n));
  function view(x,now=Date.now()){
    if(!valid(x,now))return null;
    const d=x.net_change;
    return {value:signed(x.net)+" 口",change:(d>0?"▲ ":d<0?"▼ ":"")+"較前交易日 "+signed(d)+" 口",
      tone:d>0?"rise":d<0?"fall":"flat",date:x.trade_date};
  }
  return {key,valid,select,view};
});
