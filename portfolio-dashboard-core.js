(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  root.HSPortfolioDashboardCore=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";

  const finite=value=>value===null||value===undefined||String(value).trim()===""?null:Number.isFinite(Number(value))?Number(value):null;
  const validDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(String(value||""))?String(value):"";
  const validCode=value=>/^[0-9A-Z]{4,10}$/.test(String(value||"").trim().toUpperCase());

  function effectiveHoldings(rows=[]){
    return(Array.isArray(rows)?rows:[]).filter(row=>validCode(row?.code??row?.symbol??row?.ticker)&&finite(row?.shares??row?.quantity)>0&&row?.deleted!==true&&row?.placeholder!==true);
  }

  function targetAllocationItems(holdings=[],targets={}){
    const actual=effectiveHoldings(holdings),seen=new Set(actual.map(row=>row.code));
    const additional=Object.entries(targets&&typeof targets==="object"&&!Array.isArray(targets)?targets:{}).filter(([code])=>validCode(code)&&!seen.has(code)).map(([code,targetAllocation])=>({code,shares:0,targetAllocation:normalizeTarget(targetAllocation).value}));
    return[...actual,...additional];
  }

  function hero(rows=[]){
    const source=effectiveHoldings(rows);
    const valuableHoldings=source.filter(row=>row?.quoteStatus==="current"&&finite(row.marketValue)!==null);
    const todayRows=valuableHoldings.filter(row=>finite(row.todayPnl)!==null&&finite(row.quote?.previousClose)>0);
    const costRows=source.filter(row=>finite(row.totalCost)!==null);
    const holdingsWithCost=valuableHoldings.filter(row=>finite(row.totalCost)!==null);
    const status=items=>items.length===0?"unavailable":items.length===source.length?"complete":"partial";
    const stockMarketValue=valuableHoldings.length?valuableHoldings.reduce((sum,row)=>sum+finite(row.marketValue),0):null;
    const todayPnl=todayRows.length?todayRows.reduce((sum,row)=>sum+finite(row.todayPnl),0):null;
    const previousMarketValue=todayRows.reduce((sum,row)=>sum+finite(row.shares)*finite(row.quote.previousClose),0);
    const remainingCostBasis=holdingsWithCost.length?holdingsWithCost.reduce((sum,row)=>sum+finite(row.totalCost),0):null;
    const unrealizedPnl=holdingsWithCost.length?holdingsWithCost.reduce((sum,row)=>sum+finite(row.marketValue)-finite(row.totalCost),0):null;
    return{complete:source.length>0&&valuableHoldings.length===source.length&&todayRows.length===source.length&&holdingsWithCost.length===source.length,holdingCount:source.length,valuableCount:valuableHoldings.length,marketValueStatus:status(valuableHoldings),todayStatus:status(todayRows),costStatus:status(costRows),unrealizedStatus:status(holdingsWithCost),unrealizedReason:valuableHoldings.length<source.length?"部分行情缺失":"部分成本缺失",todayPnl,todayRate:previousMarketValue>0?todayPnl/previousMarketValue*100:null,unrealizedPnl,unrealizedRate:remainingCostBasis>0?unrealizedPnl/remainingCostBasis*100:null,stockMarketValue,remainingCostBasis};
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

  function fixedCost(value){
    if(value===null||value===undefined||String(value).trim()==="")return"—";
    const amount=finite(value);
    return amount===null?"—":new Intl.NumberFormat("zh-TW",{minimumFractionDigits:2,maximumFractionDigits:2}).format(amount);
  }

  function fixedOne(value){
    const amount=finite(value);
    return amount===null?"—":`${amount.toFixed(1)}%`;
  }

  function targetDisplay(value){
    const target=normalizeTarget(value);
    return!target.ok||target.value===null?"未設定":`${target.value.toFixed(1)}%`;
  }

  function normalizeTarget(value){
    if(value===null||value===undefined||String(value).trim()==="")return{ok:true,value:null};
    const target=Number(value);
    if(!Number.isFinite(target)||target<0||target>100||Math.abs(target*10-Math.round(target*10))>1e-8)return{ok:false,value:null};
    return{ok:true,value:Number(target.toFixed(1))};
  }

  function targetSummary(values=[]){
    const normalized=(Array.isArray(values)?values:[]).map(value=>normalizeTarget(value));
    const valid=normalized.every(item=>item.ok);
    const configured=normalized.filter(item=>item.ok&&item.value!==null).length;
    const total=normalized.reduce((sum,item)=>sum+(item.ok&&item.value!==null?item.value:0),0);
    const gap=Number((100-total).toFixed(1));
    return{valid,configured,total:Number(total.toFixed(1)),gap,complete:valid&&normalized.length>0&&configured===normalized.length&&Math.abs(gap)<=.01,status:Math.abs(gap)<=.01?"complete":gap>0?"under":"over"};
  }

  function sortRows(rows=[],mode="portfolioOrder",direction="desc"){
    const source=(Array.isArray(rows)?rows:[]).map((row,index)=>({...row,portfolioOrder:index}));
    if(mode==="portfolioOrder")return source;
    const key={todayPnl:"todayPnl",changeRate:"changeRate",totalPnl:"totalPnl",weight:"weight",fiveDay:"fiveDay",twentyDay:"twentyDay",ytd:"ytd"}[mode];
    if(!key)return source;
    const sign=direction==="asc"?1:-1;
    return source.sort((a,b)=>{const av=finite(a[key]),bv=finite(b[key]);if(av===null&&bv===null)return a.portfolioOrder-b.portfolioOrder;if(av===null)return 1;if(bv===null)return-1;return(av-bv)*sign||a.portfolioOrder-b.portfolioOrder;});
  }

  return Object.freeze({VERSION:"HS_PORTFOLIO_DASHBOARD_V1",effectiveHoldings,targetAllocationItems,hero,allocation,adjustedRows,trailingReturn,ytdReturn,trends,fixedCost,fixedOne,targetDisplay,normalizeTarget,targetSummary,sortRows});
});
