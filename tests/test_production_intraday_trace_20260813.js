const assert=require("node:assert/strict");
const buy=require("../buy-point-core.js");
const intraday=require("../intraday-buy-point-core.js");
const strategy=require("../strategy-mode-core.js");

const configs={
  "0050":{base:105,p0930:103.2,p1030:101.8,valuation:null},
  "00662":{base:120,p0930:118.1,p1030:116.8,valuation:58},
  "00830":{base:90,p0930:86.7,p1030:84.9,valuation:65},
  "00935":{base:60,p0930:57.1,p1030:58.2,valuation:null},
  "009815":{base:12,p0930:11.82,p1030:11.68,valuation:54}
};

function officialRows(base){
  const rows=[];
  const end=new Date("2026-08-07T00:00:00Z");
  for(let i=64;i>=0;i--){
    const d=new Date(end);d.setUTCDate(d.getUTCDate()-i*7);
    const close=base*(.72+(64-i)*.0045+Math.sin((64-i)/5)*.012);
    rows.push({date:d.toISOString().slice(0,10),open:close*.995,max:close*1.018,min:close*.982,close,Trading_Volume:1e6+(64-i)*8000});
  }
  for(const [date,mult] of [["2026-08-10",.995],["2026-08-11",1.002],["2026-08-12",1]]){
    const close=base*mult;rows.push({date,open:close*.996,max:close*1.012,min:close*.988,close,Trading_Volume:1.8e6});
  }
  return rows;
}

function quote(price,time,base){
  return{price,date:"2026-08-13",quoteTime:time,open:base*.995,high:Math.max(base*1.004,price*1.006),low:Math.min(base*.985,price*.994),volume:950000};
}

function trace(code,time){
  const cfg=configs[code],rows=officialRows(cfg.base),q=quote(time==="09:30:00"?cfg.p0930:cfg.p1030,time,cfg.base);
  const provisional=intraday.buildProvisionalRows(rows,q,"2026-08-12");
  assert.ok(provisional);const feature=buy.buildWeeklyFeatures(provisional.rows).at(-1),formal=buy.buildWeeklyFeatures(rows).at(-1);
  const high52=Math.max(...rows.slice(-252).map(row=>row.max));
  const drawdown=(q.price/high52-1)*100;
  const decision=strategy.longTermDecision({j:feature.j,k:feature.k,d:feature.d,weeklyBias:feature.bias40w,fromHigh:drawdown,marketFear:63.9,valuation:cfg.valuation});
  const currentWeek=buy.weeklyKdj(provisional.rows).at(-1);
  return{ticker:code,snapshotTime:time.slice(0,5),marketAsOf:provisional.asOf,latestPrice:q.price,provisionalWeekOpen:currentWeek.open,provisionalWeekHigh:currentWeek.high,provisionalWeekLow:currentWeek.low,provisionalWeekClose:currentWeek.close,previousK:currentWeek.previousK,previousD:currentWeek.previousD,weeklyK:feature.k,weeklyD:feature.d,weeklyJ:feature.j,Bias40W:feature.bias40w,CoreScore:decision.score,formalWeeklyJ:formal.j,drawdown};
}

function rankSlot(time){
  const rows=Object.keys(configs).map(code=>trace(code,time)).sort((a,b)=>(b.CoreScore??-1)-(a.CoreScore??-1)||a.weeklyJ-b.weeklyJ||a.drawdown-b.drawdown||a.ticker.localeCompare(b.ticker));
  return rows.map((row,index)=>({...row,rank:index+1}));
}

const at0930=rankSlot("09:30:00"),at1030=rankSlot("10:30:00");
const previous0930=new Map(at0930.map(item=>[item.ticker,item]));
for(const item of at0930){
  assert.match(item.marketAsOf,/^2026-08-13T09:30:00\+08:00$/);
  assert.notEqual(item.weeklyJ,item.formalWeeklyJ,`${item.ticker} must not reuse 2026-08-12 weekly J`);
  item.previousSnapshotTime=null;item.scoreDelta=null;item.rankDelta=null;
}
for(const item of at1030){
  const previous=previous0930.get(item.ticker);assert.ok(previous);
  assert.match(item.marketAsOf,/^2026-08-13T10:30:00\+08:00$/);
  item.previousSnapshotTime="09:30";item.scoreDelta=item.CoreScore-previous.CoreScore;item.rankDelta=previous.rank-item.rank;
}

console.log("2026-08-13 09:30 TRACE");
for(const item of at0930)console.log(JSON.stringify(item));
console.log("2026-08-13 10:30 TRACE");
for(const item of at1030)console.log(JSON.stringify(item));
console.log("PASS 2026-08-13 production core pipeline: quote → provisional OHLC → weekly KDJ/Bias40W → CoreScore → rank → same-day delta");
