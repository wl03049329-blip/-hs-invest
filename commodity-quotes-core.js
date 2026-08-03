(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  root.HSCommodityQuotesCore=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";
  const finite=value=>value===null||value===undefined||value===""?null:(Number.isFinite(Number(value))?Number(value):null);
  const iso=value=>{
    const time=Date.parse(String(value||""));
    return Number.isFinite(time)&&time<=Date.now()+6*3600000?new Date(time).toISOString():null;
  };
  function item(raw,key){
    if(!raw||typeof raw!=="object")return null;
    const price=finite(raw.price??raw.value),previousClose=finite(raw.previous_close),change=finite(raw.change),changePct=finite(raw.change_pct);
    const quoteTime=iso(raw.quote_time??raw.data_time),sourceDate=String(raw.source_date||quoteTime?.slice(0,10)||"");
    if(!(price>0)||!(previousClose>0)||change===null||changePct===null||Math.abs(changePct)>30||!quoteTime||!/^\d{4}-\d{2}-\d{2}$/.test(sourceDate))return null;
    const expected=key==="gold"?"黃金":"布蘭特原油";
    const open=finite(raw.open),high=finite(raw.high),low=finite(raw.low),volume=finite(raw.volume);
    if(high!==null&&low!==null&&high<low)return null;
    return{
      key,name:expected,symbol:String(raw.symbol||""),unit:String(raw.unit||"USD"),price,previousClose,change,changePct,
      open:open>0?open:null,high:high>0?high:null,low:low>0?low:null,volume:volume!==null&&volume>=0?volume:null,
      quoteTime,sourceDate,sourceName:String(raw.source_name||"未設定授權來源"),sourceUrl:String(raw.source_url||""),
      delayNote:String(raw.delay_note||"延遲行情｜僅供參考"),status:String(raw.status||"last_success")
    };
  }
  function validate(payload){
    if(!payload||typeof payload!=="object")return null;
    const updatedAt=iso(payload.updated_at),items={};
    for(const key of ["gold","brent"]){const value=item(payload.items?.[key],key);if(value)items[key]=value;}
    if(!updatedAt||Object.keys(items).length===0)return null;
    return{updatedAt,items,sourceStatus:payload.source_status&&typeof payload.source_status==="object"?payload.source_status:{}};
  }
  function stale(entry,now=new Date(),trading=true){
    if(!entry?.quoteTime)return true;
    const age=now.getTime()-Date.parse(entry.quoteTime);
    return !Number.isFinite(age)||(trading?age>3*60000:age>5*86400000);
  }
  return{validate,item,stale};
});
