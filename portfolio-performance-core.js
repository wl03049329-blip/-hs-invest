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
    if(!tradingDate||!time||market===null||market<0||cash===null||assets===null||pnl===null||!raw?.holdings||typeof raw.holdings!=="object"||Array.isArray(raw.holdings))return null;
    const holdings={};
    for(const [symbol,item] of Object.entries(raw.holdings)){
      const quantity=finite(item?.quantity),marketPrice=finite(item?.marketPrice),marketValue=finite(item?.marketValue);
      if(!/^[0-9A-Z]{4,10}$/.test(symbol)||quantity===null||quantity<=0||marketPrice===null||marketPrice<=0||marketValue===null||marketValue<0)return null;
      holdings[symbol]={quantity,marketPrice,marketValue};
    }
    const ledgerVersion=raw?.ledgerVersion?String(raw.ledgerVersion):null,ledgerLastEventId=raw?.ledgerLastEventId?String(raw.ledgerLastEventId):null,portfolioSignature=raw?.portfolioSignature?String(raw.portfolioSignature):null;
    return{version:VERSION,date:tradingDate,timestamp:time,totalMarketValue:market,investedMarketValue:market,cash,totalAssets:assets,unrealizedPnL:pnl,holdings,ledgerVersion,ledgerLastEventId,portfolioSignature};
  }
  function appendDailySnapshot(history,raw){
    const snapshot=validateSnapshot(raw),rows=(Array.isArray(history)?history:[]).map(validateSnapshot).filter(Boolean).sort((a,b)=>a.date.localeCompare(b.date)||a.timestamp.localeCompare(b.timestamp));
    if(!snapshot)return{status:"INVALID_SNAPSHOT",history:rows,changed:false};
    const index=rows.findIndex(row=>row.date===snapshot.date);
    if(index>=0){
      if(rows[index].timestamp>snapshot.timestamp)return{status:"OLDER_OR_IDENTICAL",history:rows,changed:false};
      if(rows[index].timestamp===snapshot.timestamp&&JSON.stringify(rows[index])===JSON.stringify(snapshot))return{status:"OLDER_OR_IDENTICAL",history:rows,changed:false};
      rows[index]=snapshot;return{status:"REPLACED_DAILY_LAST",history:rows,changed:true,snapshot};
    }
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
  const CAPITAL_EVENT_TYPES=Object.freeze(["CASH_CHANGED","HOLDING_QUANTITY_CHANGED","HOLDING_ADDED","HOLDING_REMOVED"]);
  function portfolioSignature(snapshot){
    const valid=validateSnapshot(snapshot);if(!valid)return"";
    return Object.entries(valid.holdings).sort(([a],[b])=>a.localeCompare(b)).map(([symbol,item])=>`${symbol}:${Number(item.quantity).toFixed(8)}`).join("|");
  }
  function analyzePortfolioContinuity(snapshotRows,{tradingDates=[],invalidCount=0}={}){
    const source=Array.isArray(snapshotRows)?snapshotRows:[],validated=source.map(validateSnapshot),invalid=Number(invalidCount)||validated.filter(row=>!row).length,rows=validated.filter(Boolean).sort((a,b)=>a.date.localeCompare(b.date)||a.timestamp.localeCompare(b.timestamp)),events=[];
    const expected=[...new Set((Array.isArray(tradingDates)?tradingDates:[]).map(date).filter(Boolean))].sort(),expectedIndex=new Map(expected.map((value,index)=>[value,index]));
    for(let index=1;index<rows.length;index+=1){
      const previous=rows[index-1],current=rows[index],from=previous.date,to=current.date,previousSymbols=new Set(Object.keys(previous.holdings)),currentSymbols=new Set(Object.keys(current.holdings));
      if(Math.abs(previous.cash-current.cash)>0.01)events.push({type:"CASH_CHANGED",from,to,previous:previous.cash,current:current.cash});
      for(const symbol of currentSymbols){
        if(!previousSymbols.has(symbol))events.push({type:"HOLDING_ADDED",from,to,symbol});
        else if(Math.abs(previous.holdings[symbol].quantity-current.holdings[symbol].quantity)>1e-8)events.push({type:"HOLDING_QUANTITY_CHANGED",from,to,symbol,previous:previous.holdings[symbol].quantity,current:current.holdings[symbol].quantity});
      }
      for(const symbol of previousSymbols)if(!currentSymbols.has(symbol))events.push({type:"HOLDING_REMOVED",from,to,symbol});
      const left=expectedIndex.get(from),right=expectedIndex.get(to);
      if(Number.isInteger(left)&&Number.isInteger(right)&&right-left>1)events.push({type:"DATA_GAP",from,to,missingTradingDays:right-left-1});
    }
    const capitalEvents=events.filter(event=>CAPITAL_EVENT_TYPES.includes(event.type)),dataGaps=events.filter(event=>event.type==="DATA_GAP");
    return{status:invalid?"INVALID_DATA":capitalEvents.length?"CAPITAL_EVENT":rows.length<2||dataGaps.length?"INSUFFICIENT_HISTORY":"COMPLETE",valid:invalid===0,rows,events,capitalEvents,dataGaps,hasCapitalEvent:Boolean(capitalEvents.length),hasDataGap:Boolean(dataGaps.length),complete:invalid===0&&!capitalEvents.length&&!dataGaps.length};
  }
  function guardBenchmark(comparison,continuity){
    if(continuity?.hasCapitalEvent)return{...(comparison||{}),available:false,gapPt:null,guarded:true,reason:"CAPITAL_EVENT"};
    return{...(comparison||{}),guarded:false,reason:null};
  }
  function calculateConcentration(inputRows){
    const valid=(Array.isArray(inputRows)?inputRows:[]).map(row=>({symbol:String(row?.code||row?.symbol||""),marketValue:finite(row?.marketValue),weight:finite(row?.weight)})).filter(row=>row.marketValue!==null&&row.marketValue>=0||row.weight!==null&&row.weight>=0),marketTotal=valid.reduce((sum,row)=>sum+(row.marketValue||0),0);
    const weights=valid.map(row=>({symbol:row.symbol,weight:row.weight!==null?row.weight:marketTotal>0?(row.marketValue||0)/marketTotal*100:0})).filter(row=>row.weight>=0).sort((a,b)=>b.weight-a.weight||a.symbol.localeCompare(b.symbol)),totalWeight=weights.reduce((sum,row)=>sum+row.weight,0);
    if(!weights.length||totalWeight<=0)return{available:false,largest:null,top3:null,hhi:null,effectiveHoldings:null,totalWeight,rows:weights};
    const normalized=weights.map(row=>({...row,normalizedWeight:row.weight/totalWeight})),hhi=normalized.reduce((sum,row)=>sum+row.normalizedWeight**2,0);
    return{available:true,largest:normalized[0].normalizedWeight*100,top3:normalized.slice(0,3).reduce((sum,row)=>sum+row.normalizedWeight,0)*100,hhi,effectiveHoldings:hhi>0?1/hhi:null,totalWeight,rows:normalized};
  }
  function calculateAllocationDeviation(inputRows){
    const rows=(Array.isArray(inputRows)?inputRows:[]).map(row=>({symbol:String(row?.code||row?.symbol||""),current:finite(row?.weight),target:finite(row?.targetAllocation)}));
    if(!rows.length||rows.some(row=>row.current===null||row.target===null))return{available:false,totalDeviation:null,largestUnderweight:null,largestOverweight:null,rows:[]};
    const output=rows.map(row=>({...row,gap:row.current-row.target})),under=[...output].sort((a,b)=>a.gap-b.gap)[0],over=[...output].sort((a,b)=>b.gap-a.gap)[0];
    return{available:true,totalDeviation:output.reduce((sum,row)=>sum+Math.abs(row.gap),0)/2,largestUnderweight:under?.gap<0?under:null,largestOverweight:over?.gap>0?over:null,rows:output};
  }
  function historicalGuard(snapshotRows,continuity,minimum){
    const rows=(Array.isArray(snapshotRows)?snapshotRows:[]).map(validateSnapshot);if(rows.some(row=>!row))return{available:false,status:"INVALID_DATA",rows:[]};
    const valid=rows.filter(Boolean).sort((a,b)=>a.date.localeCompare(b.date));if(continuity?.hasCapitalEvent)return{available:false,status:"CAPITAL_EVENT",rows:valid};if(continuity?.hasDataGap)return{available:false,status:"INSUFFICIENT_HISTORY",rows:valid};if(valid.length<minimum)return{available:false,status:"INSUFFICIENT_HISTORY",rows:valid};return{available:true,status:"COMPLETE",rows:valid};
  }
  function calculateMaxDrawdown(snapshotRows,{continuity,minimumSnapshots=10}={}){
    const guard=historicalGuard(snapshotRows,continuity,minimumSnapshots);if(!guard.available)return{available:false,status:guard.status,value:null,observations:guard.rows.length};
    let peak=0,maximum=0;for(const row of guard.rows){const value=finite(row.totalAssets);if(value===null||value<=0)return{available:false,status:"INVALID_DATA",value:null,observations:guard.rows.length};peak=Math.max(peak,value);maximum=Math.min(maximum,value/peak-1);}
    return{available:true,status:"COMPLETE",value:maximum*100,observations:guard.rows.length};
  }
  function calculateAnnualizedVolatility(snapshotRows,{continuity,minimumReturns=20}={}){
    const guard=historicalGuard(snapshotRows,continuity,minimumReturns+1);if(!guard.available)return{available:false,status:guard.status,value:null,observations:Math.max(0,guard.rows.length-1)};
    const returns=[];for(let index=1;index<guard.rows.length;index+=1){const previous=finite(guard.rows[index-1].totalAssets),current=finite(guard.rows[index].totalAssets);if(previous===null||previous<=0||current===null||current<=0)return{available:false,status:"INVALID_DATA",value:null,observations:returns.length};returns.push(current/previous-1);}
    const mean=returns.reduce((sum,value)=>sum+value,0)/returns.length,variance=returns.reduce((sum,value)=>sum+(value-mean)**2,0)/(returns.length-1);
    return{available:true,status:"COMPLETE",value:Math.sqrt(variance)*Math.sqrt(252)*100,observations:returns.length};
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
  function buildCashOnlyRebalancePlan({rows=[],availableCash=0}={}){
    const cash=finite(availableCash);
    const source=(Array.isArray(rows)?rows:[]).map(row=>({
      symbol:String(row?.code||row?.symbol||"").trim().toUpperCase(),
      target:finite(row?.targetAllocation),
      marketValue:finite(row?.marketValue),
      price:finite(row?.price)
    }));
    const configured=source.filter(row=>row.target!==null);
    if(!configured.length)return{status:"TARGET_MISSING",cash,allocated:0,remaining:cash,rows:[]};
    if(configured.some(row=>!/^[0-9A-Z]{4,10}$/.test(row.symbol)||row.target<0||row.target>100)||Math.abs(configured.reduce((sum,row)=>sum+row.target,0)-100)>.01)return{status:"TARGET_INCOMPLETE",cash,allocated:0,remaining:cash,rows:[]};
    if(configured.some(row=>row.marketValue===null||row.marketValue<0||row.price===null||row.price<=0))return{status:"PRICE_UNAVAILABLE",cash,allocated:0,remaining:cash,rows:configured.map(row=>({...row,status:row.marketValue===null||row.price===null||row.price<=0?"PRICE_UNAVAILABLE":"WAITING"}))};
    const currentTotal=configured.reduce((sum,row)=>sum+row.marketValue,0);
    const usableCash=Math.max(0,cash||0),projected=currentTotal+usableCash;
    const gaps=configured.map(row=>({...row,currentAllocation:currentTotal>0?row.marketValue/currentTotal*100:0,gap:Math.max(0,projected*row.target/100-row.marketValue)}));
    const gapTotal=gaps.reduce((sum,row)=>sum+row.gap,0),scale=gapTotal>usableCash&&gapTotal>0?usableCash/gapTotal:1;
    const planned=gaps.map(row=>{const budget=Math.max(0,Math.floor(row.gap*scale*100)/100),estimatedUnits=row.price>0?Math.floor((budget/row.price)+1e-8):0,allocationAmount=Math.round(estimatedUnits*row.price*100)/100;return{...row,budget,estimatedUnits,allocationAmount,status:row.gap<=0?"OVERWEIGHT":usableCash<=0?"NO_CASH":"READY"}});
    const allocated=Math.round(planned.reduce((sum,row)=>sum+row.allocationAmount,0)*100)/100;
    return{status:usableCash<=0?"NO_CASH":"READY",cash,allocated,remaining:Math.round((usableCash-allocated)*100)/100,rows:planned.sort((a,b)=>b.allocationAmount-a.allocationAmount||a.symbol.localeCompare(b.symbol))};
  }
  return Object.freeze({VERSION,STORAGE_KEY,PERIOD_DAYS,CAPITAL_EVENT_TYPES,validateSnapshot,appendDailySnapshot,selectPeriod,assetChange,alignBenchmark,portfolioSignature,analyzePortfolioContinuity,guardBenchmark,calculateConcentration,calculateAllocationDeviation,calculateMaxDrawdown,calculateAnnualizedVolatility,buildCapitalAllocationPlan,buildCashOnlyRebalancePlan});
});
