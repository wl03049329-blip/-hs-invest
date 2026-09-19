(function(root,factory){const api=factory();if(typeof module==="object"&&module.exports)module.exports=api;if(root)root.HSPortfolioPerformanceCore=api;})(typeof window!=="undefined"?window:globalThis,function(){
  "use strict";
  const VERSION="HS_PORTFOLIO_SNAPSHOT_V1";
  const STORAGE_KEY="hsRadar.portfolio.snapshotHistory.v1";
  const PERIOD_DAYS=Object.freeze({"1M":31,"3M":93,"YTD":null,"1Y":366,"ALL":Infinity});
  const finite=value=>{if(value===null||value===undefined||value==="")return null;const n=Number(value);return Number.isFinite(n)?n:null};
  const date=value=>/^\d{4}-\d{2}-\d{2}$/.test(String(value||""))?String(value):"";
  const timestamp=value=>{const text=String(value||""),ms=Date.parse(text);return Number.isFinite(ms)?new Date(ms).toISOString():""};
  const clamp=(value,min,max)=>Math.min(max,Math.max(min,value));
  function validateSnapshot(raw){
    const tradingDate=date(raw?.date),time=timestamp(raw?.timestamp),market=finite(raw?.totalMarketValue),cash=finite(raw?.cash),assets=finite(raw?.totalAssets),pnl=finite(raw?.unrealizedPnL);
    if(!tradingDate||!time||market===null||market<0||cash===null||cash<0||assets===null||assets<0||pnl===null||!raw?.holdings||typeof raw.holdings!=="object"||Array.isArray(raw.holdings))return null;
    const holdings={};
    for(const [symbol,item] of Object.entries(raw.holdings)){
      const quantity=finite(item?.quantity),marketPrice=finite(item?.marketPrice),marketValue=finite(item?.marketValue);
      if(!/^[0-9A-Z]{4,10}$/.test(symbol)||quantity===null||quantity<=0||marketPrice===null||marketPrice<=0||marketValue===null||marketValue<0)return null;
      holdings[symbol]={quantity,marketPrice,marketValue};
    }
    return{version:VERSION,date:tradingDate,timestamp:time,totalMarketValue:market,investedMarketValue:market,cash,totalAssets:assets,unrealizedPnL:pnl,holdings};
  }
  function appendDailySnapshot(history,raw){
    const snapshot=validateSnapshot(raw),rows=(Array.isArray(history)?history:[]).map(validateSnapshot).filter(Boolean).sort((a,b)=>a.date.localeCompare(b.date)||a.timestamp.localeCompare(b.timestamp));
    if(!snapshot)return{status:"INVALID_SNAPSHOT",history:rows,changed:false};
    const index=rows.findIndex(row=>row.date===snapshot.date);
    if(index>=0){if(rows[index].timestamp>=snapshot.timestamp)return{status:"OLDER_OR_IDENTICAL",history:rows,changed:false};rows[index]=snapshot;return{status:"REPLACED_DAILY_LAST",history:rows,changed:true,snapshot};}
    rows.push(snapshot);rows.sort((a,b)=>a.date.localeCompare(b.date));return{status:"APPENDED",history:rows,changed:true,snapshot};
  }
  function selectPeriod(history,period="1M",asOf){
    const rows=(Array.isArray(history)?history:[]).map(validateSnapshot).filter(Boolean).sort((a,b)=>a.date.localeCompare(b.date));if(!rows.length)return[];
    const end=date(asOf)||rows.at(-1).date;if(period==="ALL")return rows.filter(row=>row.date<=end);
    const endDate=new Date(`${end}T00:00:00Z`);let start;
    if(period==="YTD")start=`${end.slice(0,4)}-01-01`;else{const days=PERIOD_DAYS[period]||31;start=new Date(endDate.getTime()-(days-1)*86400000).toISOString().slice(0,10);}
    return rows.filter(row=>row.date>=start&&row.date<=end);
  }
  function assetChange(rows){
    if(!Array.isArray(rows)||rows.length<2)return{available:false,amount:null,rate:null};const first=finite(rows[0]?.totalAssets),last=finite(rows.at(-1)?.totalAssets);if(first===null||first<=0||last===null)return{available:false,amount:null,rate:null};return{available:true,amount:last-first,rate:(last/first-1)*100};
  }
  function alignBenchmark(snapshotRows,benchmarkRows){
    const prices=new Map((Array.isArray(benchmarkRows)?benchmarkRows:[]).map(row=>[date(row?.date),finite(row?.close)]).filter(([d,p])=>d&&p!==null&&p>0));
    const aligned=(Array.isArray(snapshotRows)?snapshotRows:[]).map(row=>({date:row.date,portfolio:finite(row.totalAssets),benchmark:prices.get(row.date)})).filter(row=>row.date&&row.portfolio!==null&&row.portfolio>0&&row.benchmark>0);
    if(aligned.length<2)return{available:false,points:[],portfolioChange:null,benchmarkChange:null,gapPt:null};
    const p0=aligned[0].portfolio,b0=aligned[0].benchmark,points=aligned.map(row=>({date:row.date,portfolio:Number((row.portfolio/p0*100).toFixed(4)),benchmark:Number((row.benchmark/b0*100).toFixed(4))})),portfolioChange=points.at(-1).portfolio-100,benchmarkChange=points.at(-1).benchmark-100;
    return{available:true,points,portfolioChange,benchmarkChange,gapPt:portfolioChange-benchmarkChange};
  }
  function buildCapitalAllocationPlan({rows=[],availableCash=0,allocationHealthScore}={}){
    const cash=Math.max(0,finite(availableCash)||0),valid=(Array.isArray(rows)?rows:[]).map(row=>{const symbol=String(row?.code||row?.symbol||"").toUpperCase(),marketValue=finite(row?.marketValue),current=finite(row?.weight),target=finite(row?.targetAllocation),price=finite(row?.price??row?.quote?.price),score=finite(row?.coreScore);return{symbol,marketValue,current,target,price,score};}).filter(row=>/^[0-9A-Z]{4,10}$/.test(row.symbol));
    if(!valid.length)return{status:"EMPTY_HOLDINGS",cash,allocated:0,remaining:cash,rows:[],healthBefore:null,healthAfter:null};
    const total=valid.reduce((sum,row)=>sum+(row.marketValue||0),0),projected=total+cash;
    const candidates=valid.map(row=>{const reasonCodes=[];if(row.target===null)reasonCodes.push("TARGET_MISSING");if(row.price===null||row.price<=0)reasonCodes.push("PRICE_UNAVAILABLE");const need=row.target===null||row.marketValue===null?0:Math.max(0,projected*row.target/100-row.marketValue);if(need>0)reasonCodes.push("UNDERWEIGHT");else if(row.target!==null)reasonCodes.push(row.current>row.target?"OVERWEIGHT":"NEAR_TARGET");if(row.score!==null&&row.score>=40)reasonCodes.push("HIGH_CORE_SCORE");const modifier=row.score===null?1:1+clamp(row.score,0,100)/100*.15;return{...row,need,weight:need*modifier,reasonCodes};});
    const eligible=candidates.filter(row=>row.need>0&&row.price>0&&row.target!==null),weightTotal=eligible.reduce((sum,row)=>sum+row.weight,0),shares=new Map();let remainingCash=Math.round(cash);
    eligible.forEach((row,index)=>{const proposed=index===eligible.length-1?remainingCash:Math.round(cash*row.weight/weightTotal),amount=Math.max(0,Math.min(Math.round(row.need),remainingCash,proposed));shares.set(row.symbol,amount);remainingCash-=amount;});
    const planned=candidates.map(row=>{const amount=shares.get(row.symbol)||0,afterValue=(row.marketValue||0)+amount,afterWeight=projected>0?afterValue/projected*100:null;return{symbol:row.symbol,allocationAmount:amount,estimatedUnits:row.price>0?amount/row.price:null,beforeAllocation:row.current,afterAllocation:afterWeight,targetAllocation:row.target,allocationGapBefore:row.current!==null&&row.target!==null?row.current-row.target:null,allocationGapAfter:afterWeight!==null&&row.target!==null?afterWeight-row.target:null,coreScore:row.score,reasonCodes:cash<=0?[...row.reasonCodes,"INSUFFICIENT_CASH"]:row.reasonCodes};});
    const allocated=Math.round(cash)-remainingCash,remaining=remainingCash,healthFn=typeof allocationHealthScore==="function"?allocationHealthScore:()=>null;
    return{status:cash<=0?"ZERO_CASH":eligible.length?"READY":"NO_ELIGIBLE_TARGET",cash,allocated,remaining,rows:planned.sort((a,b)=>b.allocationAmount-a.allocationAmount||a.symbol.localeCompare(b.symbol)),healthBefore:healthFn(valid.map(row=>({weight:row.current,targetAllocation:row.target}))),healthAfter:healthFn(planned.map(row=>({weight:row.afterAllocation,targetAllocation:row.targetAllocation})))};
  }
  return Object.freeze({VERSION,STORAGE_KEY,PERIOD_DAYS,validateSnapshot,appendDailySnapshot,selectPeriod,assetChange,alignBenchmark,buildCapitalAllocationPlan});
});
