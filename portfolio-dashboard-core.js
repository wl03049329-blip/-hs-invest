(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  root.HSPortfolioDashboardCore=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";

  const finite=value=>Number.isFinite(Number(value))?Number(value):null;
  const validDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(String(value||""))?String(value):"";

  function hero(rows=[]){
    const source=Array.isArray(rows)?rows:[];
    const complete=source.length>0&&source.every(row=>row?.quoteStatus==="current"&&finite(row.marketValue)!==null&&finite(row.totalCost)!==null&&finite(row.totalPnl)!==null&&finite(row.todayPnl)!==null&&finite(row.quote?.previousClose)>0);
    if(!complete)return{complete:false,todayPnl:null,todayRate:null,unrealizedPnl:null,unrealizedRate:null,stockMarketValue:null,remainingCostBasis:null};
    const stockMarketValue=source.reduce((sum,row)=>sum+finite(row.marketValue),0);
    const remainingCostBasis=source.reduce((sum,row)=>sum+finite(row.totalCost),0);
    const todayPnl=source.reduce((sum,row)=>sum+finite(row.todayPnl),0);
    const previousMarketValue=source.reduce((sum,row)=>sum+finite(row.shares)*finite(row.quote.previousClose),0);
    const unrealizedPnl=stockMarketValue-remainingCostBasis;
    return{complete:true,todayPnl,todayRate:previousMarketValue>0?todayPnl/previousMarketValue*100:null,unrealizedPnl,unrealizedRate:remainingCostBasis>0?unrealizedPnl/remainingCostBasis*100:null,stockMarketValue,remainingCostBasis};
  }

  function allocation(rows=[],visibleLimit=6){
    const source=(Array.isArray(rows)?rows:[]).map(row=>({code:String(row?.code||""),name:String(row?.name||row?.customName||row?.quote?.name||row?.code||""),value:finite(row?.marketValue)})).filter(row=>row.code&&row.value>0).sort((a,b)=>b.value-a.value||a.code.localeCompare(b.code));
    const total=source.reduce((sum,row)=>sum+row.value,0);
    if(!total)return[];
    const direct=source.length>visibleLimit?source.slice(0,visibleLimit-1):source;
    const output=direct.map(row=>({...row,weight:row.value/total*100,members:[row.code]}));
    if(source.length>visibleLimit){const rest=source.slice(visibleLimit-1),value=rest.reduce((sum,row)=>sum+row.value,0);output.push({code:"其他",name:`${rest.length} 檔較小部位`,value,weight:value/total*100,members:rest.map(row=>row.code)});}
    return output;
  }

  function adjustedRows(rows=[]){
    const byDate=new Map();
    for(const row of Array.isArray(rows)?rows:[]){const date=validDate(row?.date),close=finite(row?.close);if(date&&close>0)byDate.set(date,{date,close});}
    return[...byDate.values()].sort((a,b)=>a.date.localeCompare(b.date));
  }

  function trailingReturn(rows,sessions){
    const valid=adjustedRows(rows),count=Math.max(1,Math.trunc(Number(sessions)||0));
    if(valid.length<=count)return null;
    const latest=valid.at(-1).close,base=valid[valid.length-1-count].close;
    return base>0?(latest/base-1)*100:null;
  }

  function ytdReturn(rows){
    const valid=adjustedRows(rows);if(!valid.length)return null;
    const latest=valid.at(-1),year=Number(latest.date.slice(0,4)),base=[...valid].reverse().find(row=>Number(row.date.slice(0,4))<year);
    return base?.close>0?(latest.close/base.close-1)*100:null;
  }

  function trends(rows){return{fiveDay:trailingReturn(rows,5),twentyDay:trailingReturn(rows,20),ytd:ytdReturn(rows)};}

  function sortRows(rows=[],mode="portfolioOrder",direction="desc"){
    const source=(Array.isArray(rows)?rows:[]).map((row,index)=>({...row,portfolioOrder:index}));
    if(mode==="portfolioOrder")return source;
    const key={todayPnl:"todayPnl",changeRate:"changeRate",totalPnl:"totalPnl",weight:"weight",fiveDay:"fiveDay",twentyDay:"twentyDay",ytd:"ytd"}[mode];
    if(!key)return source;
    const sign=direction==="asc"?1:-1;
    return source.sort((a,b)=>{const av=finite(a[key]),bv=finite(b[key]);if(av===null&&bv===null)return a.portfolioOrder-b.portfolioOrder;if(av===null)return 1;if(bv===null)return-1;return(av-bv)*sign||a.portfolioOrder-b.portfolioOrder;});
  }

  return Object.freeze({VERSION:"HS_PORTFOLIO_DASHBOARD_V1",hero,allocation,adjustedRows,trailingReturn,ytdReturn,trends,sortRows});
});
