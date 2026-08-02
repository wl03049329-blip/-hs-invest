(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  root.HSInstitutionalFlowCore=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";
  const CATEGORY_MAPPING=Object.freeze({
    foreign:{label:"外資",components:["Foreign_Investor","Foreign_Dealer_Self"],rule:"sum_components"},
    trust:{label:"投信",components:["Investment_Trust"],rule:"sum_components"},
    dealer:{label:"自營商",totalAlias:"Dealer",components:["Dealer_self","Dealer_Hedging"],rule:"prefer_total_else_components"}
  });
  const finite=value=>typeof value==="number"&&Number.isFinite(value);
  const validDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(value||"");

  function rowNet(row){
    const buy=Number(row?.buy),sell=Number(row?.sell);
    return finite(buy)&&finite(sell)?buy-sell:null;
  }

  function aggregateByDate(rows){
    const map=new Map();
    for(const row of Array.isArray(rows)?rows:[]){
      if(!validDate(row?.date)||typeof row?.name!=="string")continue;
      const net=rowNet(row);if(!finite(net))continue;
      const day=map.get(row.date)||new Map();
      day.set(row.name,(day.get(row.name)||0)+net);
      map.set(row.date,day);
    }
    return map;
  }

  function categoryNet(day,mapping){
    if(!(day instanceof Map))return null;
    if(mapping.rule==="prefer_total_else_components"&&day.has(mapping.totalAlias))return day.get(mapping.totalAlias);
    const present=mapping.components.filter(name=>day.has(name));
    if(!present.length)return null;
    return present.reduce((total,name)=>total+day.get(name),0);
  }

  function sumPeriod(daily,dates,key){
    const values=dates.map(date=>daily.get(date)?.[key]).filter(finite);
    return values.length===dates.length?values.reduce((a,b)=>a+b,0):null;
  }

  function build(rows){
    const raw=aggregateByDate(rows),daily=new Map();
    for(const [date,day] of raw){
      const item={};
      for(const [key,mapping] of Object.entries(CATEGORY_MAPPING))item[key]=categoryNet(day,mapping);
      if(Object.values(item).every(finite)){
        item.total=item.foreign+item.trust+item.dealer;
        daily.set(date,item);
      }
    }
    const dates=[...daily.keys()].sort();
    if(!dates.length)return null;
    const latest=dates.at(-1),last5=dates.slice(-5),last20=dates.slice(-20);
    const result={date:latest,periods:{five:last5.length,twenty:last20.length},mapping:CATEGORY_MAPPING};
    for(const key of ["foreign","trust","dealer","total"]){
      result[key]={today:daily.get(latest)[key],five:sumPeriod(daily,last5,key),twenty:sumPeriod(daily,last20,key)};
    }
    return result;
  }

  function direction(value){return !finite(value)?"資料暫缺":value>0?"買超":value<0?"賣超":"近乎持平";}
  function trendText(flow){
    if(!flow)return"法人資料尚未更新。";
    const x=flow.total;
    if(![x.today,x.five,x.twenty].every(finite))return"法人累計資料不完整，暫不解讀趨勢。";
    const today=direction(x.today),five=direction(x.five),twenty=direction(x.twenty);
    if(today===five&&five===twenty)return`三大法人今日、近5日與近${flow.periods.twenty}個交易日皆為${today}，資金方向相對一致。`;
    if(today!==twenty)return`三大法人今日${today}，但近${flow.periods.twenty}個交易日仍為${twenty}，短線與月內方向不同。`;
    return`三大法人今日${today}、近5日${five}、近${flow.periods.twenty}個交易日${twenty}，資金方向仍有分歧。`;
  }

  return{CATEGORY_MAPPING,rowNet,aggregateByDate,categoryNet,build,direction,trendText};
});
