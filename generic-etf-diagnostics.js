(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  root.HSGenericEtfDiagnostics=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";

  const REQUIREMENTS=Object.freeze({ma43:43,ma87:87,ma200:200,weeklyKdjWeeks:9,dd52:252,rs20:21,rs60:61,volumeMa20:20});
  const APPROVED_BENCHMARKS=Object.freeze({"0050":"MARKET_BASELINE","0056":"0050","00919":"0050","00935":"0050"});
  const WAIT_NATIVE=new Set(["009815"]);
  const UNSUPPORTED_CATEGORIES=new Set(["bond","bond_government_long","bond_corporate","commodity","futures","inverse","leveraged","reit"]);
  const finite=value=>Number.isFinite(Number(value));
  const number=value=>finite(value)?Number(value):null;
  const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
  const round=(value,digits=2)=>finite(value)?Number(Number(value).toFixed(digits)):null;
  const average=values=>{const valid=values.filter(finite).map(Number);return valid.length?valid.reduce((sum,value)=>sum+value,0)/valid.length:null};
  const change=(current,previous)=>finite(current)&&finite(previous)&&Number(previous)!==0?(Number(current)/Number(previous)-1)*100:null;

  function normalizeRows(input){
    const byDate=new Map();
    (Array.isArray(input)?input:[]).forEach(row=>{
      const date=String(row?.date||"").slice(0,10),close=number(row?.close);
      if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!finite(close)||close<=0)return;
      const open=number(row.open)??close,high=number(row.max??row.high)??Math.max(open,close),low=number(row.min??row.low)??Math.min(open,close);
      byDate.set(date,{date,open,high:Math.max(high,open,close),low:Math.min(low,open,close),close,volume:number(row.Trading_Volume??row.trading_volume??row.volume),quoteTime:String(row.quote_time||row.quoteTime||"")});
    });
    return [...byDate.values()].sort((a,b)=>a.date.localeCompare(b.date));
  }

  function sma(rows,period,index=rows.length-1,key="close"){
    if(index+1<period)return null;
    return average(rows.slice(index-period+1,index+1).map(row=>row[key]));
  }
  function slope(rows,period,lookback=10){
    const current=sma(rows,period),previous=sma(rows,period,rows.length-1-lookback);
    return change(current,previous);
  }
  function distance(price,ma){return change(price,ma)}

  function isoWeekStart(date){
    const value=new Date(`${date}T00:00:00Z`),day=value.getUTCDay()||7;
    value.setUTCDate(value.getUTCDate()-day+1);
    return value.toISOString().slice(0,10);
  }
  function weeklyRows(rows){
    const weeks=new Map();
    rows.forEach(row=>{
      const key=isoWeekStart(row.date),existing=weeks.get(key);
      if(!existing)weeks.set(key,{date:key,open:row.open,high:row.high,low:row.low,close:row.close});
      else{existing.high=Math.max(existing.high,row.high);existing.low=Math.min(existing.low,row.low);existing.close=row.close}
    });
    return [...weeks.values()].sort((a,b)=>a.date.localeCompare(b.date));
  }
  function weeklyKdj(rows){
    const weeks=weeklyRows(rows);let k=50,d=50;
    const series=weeks.map((week,index)=>{
      const window=weeks.slice(Math.max(0,index-8),index+1),high=Math.max(...window.map(item=>item.high)),low=Math.min(...window.map(item=>item.low));
      const rsv=high===low?50:(week.close-low)/(high-low)*100;
      k=(2*k+rsv)/3;d=(2*d+k)/3;
      return{...week,k,d,j:3*k-2*d};
    });
    const current=series.at(-1),previous=series.at(-2),j=number(current?.j),delta=j!==null&&finite(previous?.j)?j-previous.j:null,direction=delta===null?"—":delta>0.35?"RISING":delta<-.35?"FALLING":"FLAT";
    let state="—";
    if(j!==null){
      if(j<20)state=direction==="RISING"?"低檔回升":"低檔續弱";
      else if(j>80)state=direction==="FALLING"?"高檔轉弱":"高檔";
      else state=direction==="RISING"?"中性回升":"中性";
    }
    return{weeks:weeks.length,j:round(j),delta:round(delta),direction,state,k:round(current?.k),d:round(current?.d)};
  }

  function rollingHigh(rows,period){return rows.length>=period?Math.max(...rows.slice(-period).map(row=>row.high)):null}
  function pullbackPercentile(rows,period=252){
    if(rows.length<period)return{percentile:null,samples:0};
    const values=[];
    for(let index=period-1;index<rows.length;index++){
      const high=Math.max(...rows.slice(index-period+1,index+1).map(row=>row.high));
      values.push((rows[index].close/high-1)*100);
    }
    const current=values.at(-1),rank=values.filter(value=>value<=current).length/values.length*100;
    return{percentile:round(rank),samples:values.length};
  }
  function atr(rows,period=20){
    if(rows.length<period+1)return null;
    const tr=[];
    for(let index=rows.length-period;index<rows.length;index++)tr.push(Math.max(rows[index].high-rows[index].low,Math.abs(rows[index].high-rows[index-1].close),Math.abs(rows[index].low-rows[index-1].close)));
    return average(tr);
  }
  function pullback(rows){
    const price=rows.at(-1)?.close,periods=[20,60,120,252],drawdowns={};
    periods.forEach(period=>{const high=rollingHigh(rows,period);drawdowns[`dd${period===252?"52":period}`]=high===null?null:round((price/high-1)*100)});
    const reference=drawdowns.dd60??drawdowns.dd20;
    const state=reference===null?"—":reference>=-2?"接近高點":reference>=-5?"輕微拉回":reference>=-12?"正常拉回":reference>=-20?"偏深拉回":"極深拉回";
    const atr20=atr(rows),atrAdjusted=finite(atr20)&&atr20>0&&finite(price)?round((price-(rollingHigh(rows,60)??price))/atr20):null;
    return{...drawdowns,state,historical:pullbackPercentile(rows),atr20:round(atr20),atrAdjusted};
  }

  function trend(rows){
    const price=rows.at(-1)?.close,ma43=sma(rows,43),ma87=sma(rows,87),ma200=sma(rows,200),slope43=slope(rows,43),slope87=slope(rows,87);
    let state="—";
    if([price,ma43,ma87,ma200,slope43,slope87].every(finite)){
      if(price>ma43&&ma43>ma87&&ma87>ma200&&slope43>0&&slope87>0)state="強勢";
      else if(price>ma87&&price>ma200&&ma87>ma200&&slope87>=0)state="健康";
      else if(price<ma200&&slope87<0)state="破壞";
      else if(price<ma87||slope87<0)state="轉弱";
      else state="中性";
    }
    return{state,ma43:round(ma43),ma87:round(ma87),ma200:round(ma200),distance43:round(distance(price,ma43)),distance87:round(distance(price,ma87)),distance200:round(distance(price,ma200)),slope43:round(slope43),slope87:round(slope87),ma87Above200:finite(ma87)&&finite(ma200)?ma87>=ma200:null};
  }

  function dailyKdj(rows){
    let k=50,d=50;const series=[];
    rows.forEach((row,index)=>{const window=rows.slice(Math.max(0,index-8),index+1),high=Math.max(...window.map(item=>item.high)),low=Math.min(...window.map(item=>item.low)),rsv=high===low?50:(row.close-low)/(high-low)*100;k=(2*k+rsv)/3;d=(2*d+k)/3;series.push({k,d,j:3*k-2*d})});
    return series;
  }
  function recovery(rows){
    if(rows.length<21)return{state:"—",checks:{},available:false};
    const price=rows.at(-1).close,ma20=sma(rows,20),kdj=dailyKdj(rows),current=kdj.at(-1),previous=kdj.at(-2),low5=Math.min(...rows.slice(-5).map(row=>row.low)),priorLow5=Math.min(...rows.slice(-10,-5).map(row=>row.low));
    const checks={dailyKdjRising:current.j>previous.j,momentum10:(change(price,rows.at(-11)?.close)??-Infinity)>0,lowStopped:low5>=priorLow5,reclaimedMa20:finite(ma20)&&price>=ma20,shortReversal:price>rows.at(-2).close&&rows.at(-2).close>=rows.at(-3).close};
    const count=Object.values(checks).filter(Boolean).length,state=count>=4?"確認回升":count===3?"部分確認":count===2?"初步止跌":"尚未止跌";
    return{state,count,checks,available:true};
  }

  function alignedReturns(rows,benchmarkRows,period){
    const benchmark=new Map(benchmarkRows.map(row=>[row.date,row.close])),pairs=rows.map(row=>benchmark.has(row.date)?[row.close,benchmark.get(row.date)]:null).filter(Boolean);
    if(pairs.length<period)return null;
    const slice=pairs.slice(-period),etf=change(slice.at(-1)[0],slice[0][0]),base=change(slice.at(-1)[1],slice[0][1]);
    return finite(etf)&&finite(base)?etf-base:null;
  }
  function relativeStrength(symbol,rows,benchmarkRows,benchmark){
    if(benchmark==="MARKET_BASELINE")return{state:"市場基準",benchmark:"0050",rs20:null,rs60:null,recovery20:null,available:true,baseline:true};
    if(!benchmark||!Array.isArray(benchmarkRows)||!benchmarkRows.length)return{state:"—",benchmark:null,rs20:null,rs60:null,recovery20:null,available:false,reason:"相對強弱基準尚未完成驗證。"};
    const normalized=normalizeRows(benchmarkRows),rs20=alignedReturns(rows,normalized,21),rs60=alignedReturns(rows,normalized,61),previous20=rows.length>=42?alignedReturns(rows.slice(0,-20),normalized,21):null,recovery20=finite(rs20)&&finite(previous20)?rs20-previous20:null;
    let state="—";
    if(finite(rs20)&&finite(rs60))state=rs20>3&&rs60>3?"強勢":rs20<-5&&rs60<-5?"破壞":rs20<0||rs60<0?"轉弱":"完整";
    return{state,benchmark,rs20:round(rs20),rs60:round(rs60),recovery20:round(recovery20),available:finite(rs20)&&finite(rs60),baseline:false,reason:finite(rs20)&&finite(rs60)?"":"基準對齊交易日不足。"};
  }

  function assetSupport(symbol,metadata){
    if(WAIT_NATIVE.has(symbol)||metadata?.waitNative)return"WAIT_NATIVE";
    const category=String(metadata?.category||"").toLowerCase(),strategy=String(metadata?.strategyType||"").toLowerCase(),type=String(metadata?.type||metadata?.assetClass||"").toLowerCase();
    if([...UNSUPPORTED_CATEGORIES].some(value=>category.includes(value)||strategy.includes(value)||type.includes(value))||/債|bond|槓桿|反向|商品|期貨|reit/.test(type))return"UNSUPPORTED_ASSET_CLASS";
    return"SUPPORTED";
  }
  function summary(states){
    if(states.trend==="破壞"&&states.pullback==="極深拉回"&&states.weekly==="低檔續弱"&&states.recovery==="尚未止跌")return"價格已明顯拉回，但趨勢與止跌結構仍偏弱，目前下跌風險仍高。";
    if(["強勢","健康"].includes(states.trend)&&states.pullback==="正常拉回"&&states.weekly==="低檔回升"&&["部分確認","確認回升"].includes(states.recovery))return"已出現合理拉回與低檔回升，趨勢結構仍完整，止跌訊號正在建立。";
    if(states.trend==="強勢"&&states.rs==="強勢"&&states.pullback==="接近高點")return"趨勢與相對強弱維持良好，但目前價格接近近期高檔，尚未形成明顯波段拉回。";
    return`趨勢${states.trend}、${states.pullback}，週線動能${states.weekly}，止跌狀態為${states.recovery}。`;
  }

  function evaluate(input={}){
    const symbol=String(input.symbol||input.id||"").trim().toUpperCase(),metadata=input.metadata||{},rows=normalizeRows(input.rows),support=assetSupport(symbol,metadata),latest=rows.at(-1);
    const base={symbol,name:metadata.name||symbol,price:latest?.close??null,changeValue:rows.length>1?round(latest.close-rows.at(-2).close):null,changePct:rows.length>1?round(change(latest.close,rows.at(-2).close)):null,dataAsOf:latest?.date||null,quoteTime:latest?.quoteTime||"",maturityState:support,requirements:REQUIREMENTS};
    if(support!=="SUPPORTED")return{...base,trend:null,pullback:null,weekly:null,rs:null,recovery:null,summary:null};
    if(rows.length<43||weeklyRows(rows).length<9)return{...base,maturityState:"INSUFFICIENT_HISTORY",trend:null,pullback:null,weekly:null,rs:null,recovery:null,summary:null};
    const trendData=trend(rows),pullbackData=pullback(rows),weekly=weeklyKdj(rows),recoveryData=recovery(rows),benchmark=input.benchmark??APPROVED_BENCHMARKS[symbol]??null,rs=relativeStrength(symbol,rows,input.benchmarkRows,benchmark);
    const coverage={ma43:rows.length>=43,ma87:rows.length>=87,ma200:rows.length>=200,weeklyKdj:weekly.weeks>=9,dd52:rows.length>=252,volumeMa20:rows.slice(-20).filter(row=>finite(row.volume)).length>=20,rs20:rs.baseline||finite(rs.rs20),rs60:rs.baseline||finite(rs.rs60)};
    const technicalReady=coverage.ma43&&coverage.ma87&&coverage.ma200&&coverage.weeklyKdj&&coverage.dd52&&coverage.volumeMa20;
    let maturityState=!technicalReady?"PARTIAL":rs.available?"MATURE":!benchmark?"BENCHMARK_UNAVAILABLE":"PARTIAL";
    const canSummarize=maturityState==="MATURE"||maturityState==="BENCHMARK_UNAVAILABLE";
    return{...base,maturityState,trend:trendData,pullback:pullbackData,weekly,rs,recovery:recoveryData,coverage,summary:canSummarize?summary({trend:trendData.state,pullback:pullbackData.state,weekly:weekly.state,rs:rs.state,recovery:recoveryData.state}):null};
  }

  return Object.freeze({REQUIREMENTS,APPROVED_BENCHMARKS,normalizeRows,evaluate});
});
