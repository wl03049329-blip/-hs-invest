"use strict";
// Audit only: archived inputs plus official extensions, never write artifacts.
process.env.TZ="UTC";
const {decisionAtClose}=require("./finalize_core_score_history");
const {official}=require("./update_c4_close_observations.cjs");
const crypto=require("node:crypto");
const fs=require("node:fs"),path=require("node:path");
const targets=["0050","00757","00830","00935"], dates=["2026-11-13","2026-11-16"];
const hash=x=>crypto.createHash("sha256").update(x).digest("hex");
const roc=x=>{const m=String(x).match(/^(\d{3})[年/](\d\d)[月/](\d\d)日?$/);if(!m)throw Error("ROC_DATE");return (+m[1]+1911)+"-"+m[2]+"-"+m[3];};
const n=x=>{const s=String(x).replaceAll(",","");if(!/^\d+(?:\.\d+)?$/.test(s))throw Error("INVALID_NUMBER");return Number(s);};
async function replay(fetchImpl=fetch, asof=new Date()){
 const receipts={};
 const get=async url=>{const r=await fetchImpl(url,{signal:AbortSignal.timeout(15000),redirect:"error"});if(!r.ok)throw Error("HTTP_"+r.status);const raw=Buffer.from(await r.arrayBuffer());receipts[url]=hash(raw);return raw;};
 const actionURL="https://www.twse.com.tw/exchangeReport/TWT49U?response=json&startDate=20260901&endDate=20261116";
 const p=JSON.parse(await get(actionURL)), prefix=["資料日期","股票代號","股票名稱","除權息前收盤價","除權息參考價","權值+息值","權/息"];
 if(p.stat!=="OK"||p.strDate!=="20260901"||p.endDate!=="20261116"||JSON.stringify(p.fields?.slice(0,7))!==JSON.stringify(prefix)||!Array.isArray(p.data))
  throw Error("ACTION_COVERAGE_UNVERIFIED");
 const action=p.data.filter(r=>targets.includes(r[1])).map(r=>{
  if(r[6]!=="息")throw Error("UNREVIEWED_ACTION_"+r[1]);
  const before_price=n(r[3]),reference_price=n(r[4]),cash=n(r[5]),date=roc(r[0]);
  if(date<"2026-09-01"||date>"2026-11-16"||Math.abs(before_price-reference_price-cash)>1e-7)throw Error("CASH_ACTION_MISMATCH");
  return {date,stock_id:r[1],before_price,reference_price,stock_and_cache_dividend:cash,stock_or_cache_dividend:"息"};
 });
 const observations=require("../data/c4-close-observations-v1.json"), result={}, official0050={};
 const closes={};
 for(const date of dates){
  const source=observations.sessions.find(s=>s.date===date).source, raw=await get(source);
  closes[date]=official(raw,date);
 }
 for(const symbol of targets){
  const hs=require("../data/radar-history/twse/"+symbol+".json");
  if(!hs.verified||hs.price_type!=="RAW_UNADJUSTED"||hs.requested_end!=="2026-11-12")throw Error("ARCHIVE_UNVERIFIED");
  const seed=symbol==="00757"?{price:[],dividend:[],split:[]}:require("../research/c4_historical/source/"+symbol+".json");
  const known=action.filter(x=>x.stock_id===symbol);
  const expected=[...seed.dividend,...hs.dividends.map(x=>({...x,stock_and_cache_dividend:x.amount}))];
  for(const a of expected.filter(a=>a.date>="2026-09-01")){
   if(!known.some(x=>x.date===a.date&&Math.abs(x.stock_and_cache_dividend-a.stock_and_cache_dividend)<1e-8))throw Error("ACTION_ARCHIVE_CONFLICT_"+symbol);
  }
  for(const a of known.filter(a=>a.date<=hs.requested_end)){
   if(!expected.some(x=>x.date===a.date&&Math.abs(x.stock_and_cache_dividend-a.stock_and_cache_dividend)<1e-8))throw Error("ACTION_ARCHIVE_OMISSION_"+symbol);
  }
  const bars=[...seed.price,...hs.price];
  const monthly=JSON.parse(await get("https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=20261101&stockNo="+symbol+"&response=json"));
  if(monthly.stat!=="OK"||!monthly.title?.includes(symbol)||monthly.fields?.slice(3,7).join(",")!=="開盤價,最高價,最低價,收盤價")throw Error("MONTH_SCHEMA");
  for(const date of dates){
   const rows=monthly.data.filter(r=>roc(r[0])===date);
   if(rows.length!==1)throw Error("MONTH_DATE");
   const x=rows[0], bar={date,open:n(x[3]),max:n(x[4]),min:n(x[5]),close:n(x[6]),Trading_Volume:n(x[1])};
   if(bar.close!==closes[date].get(symbol)||bar.Trading_Volume<=0||bar.max<Math.max(bar.open,bar.close)||bar.min>Math.min(bar.open,bar.close))throw Error("OHLC_CONFLICT");
   bars.push(bar);
  }
  const dividend=[...seed.dividend.filter(x=>x.date<"2026-09-01"),...known];
  if(symbol==="0050"){
   // Independently compare every official raw bar available in the local
   // evidence bundle and every dated cash event in the frozen input window.
   const evidence=path.resolve(__dirname,"../../hs-lc4-evidence/raw");
   const indexed=new Map(bars.filter(x=>x.date>="2023-01-01").map(x=>[x.date,x]));
   let checked=0;const differences=[];
   for(let year=2023;year<=2026;year++)for(let month=1;month<=12;month++){
    const ym=year+String(month).padStart(2,"0");
    if(ym>"202611")continue;
    const raw=fs.readFileSync(path.join(evidence,"twse-0050-"+ym+".json"));
    receipts["archive:0050:"+ym]=hash(raw);
    const j=JSON.parse(raw);
    if(j.stat!=="OK"||!j.title?.includes("0050")||j.fields?.slice(3,7).join(",")!=="開盤價,最高價,最低價,收盤價")throw Error("ARCHIVE_OHLC_SCHEMA");
    for(const r of j.data){
     const date=roc(r[0]);if(date>"2026-11-05")continue;
     const b=indexed.get(date);checked++;
     if(!b||[b.open,b.max,b.min,b.close,b.Trading_Volume].some((x,i)=>x!==n(r[[3,4,5,6,1][i]])))differences.push(date);
    }
   }
   let cashMatches=0;
   for(let year=2023;year<=2026;year++){
    const raw=fs.readFileSync(path.join(evidence,"twse-actions-"+year+".json"));receipts["archive:TWT49U:"+year]=hash(raw);
    const j=JSON.parse(raw);
    if(j.stat!=="OK"||JSON.stringify(j.fields?.slice(0,7))!==JSON.stringify(prefix))throw Error("ARCHIVE_ACTION_SCHEMA");
    const rows=j.data.filter(r=>r[1]==="0050");
    const old=dividend.filter(a=>a.date.startsWith(String(year)));
    if(old.length!==rows.length||rows.some(r=>r[6]!=="息"||!old.some(a=>a.date===roc(r[0])&&
       a.before_price===n(r[3])&&a.reference_price===n(r[4])&&a.stock_and_cache_dividend===n(r[5]))))throw Error("ARCHIVE_DIVIDEND_PARITY");
    cashMatches+=rows.length;
   }
   Object.assign(official0050,{checked,differences,cashMatches,splitComparison:"2025-06-18 official 188.65 to 47.16 matches sealed FinMind; rounded price factor, not 0.25"});
  }
  result[symbol]=[];
  const original=globalThis.fetch;
  try{
   globalThis.fetch=async url=>{
    if(url.origin!=="https://api.finmindtrade.com"||url.searchParams.get("data_id")!==symbol)throw Error("UNEXPECTED_REQUEST");
    const k=url.searchParams.get("dataset"), sets={TaiwanStockPrice:bars,TaiwanStockDividendResult:dividend,TaiwanStockSplitPrice:seed.split};
    if(!Object.hasOwn(sets,k))throw Error("DATASET_SCOPE");
    return Response.json({status:200,data:sets[k].filter(x=>x.date>=url.searchParams.get("start_date"))});
   };
   for(const date of dates){
    const d=await decisionAtClose(symbol,date), target=observations.sessions.find(s=>s.date===date).symbols[symbol];
    const parity=[["weekly_j","weeklyJ"],["dd52","dd52"],["crash","crash"]].every(([key,k])=>
     Math.abs(d.coreFactors[k].raw-target.factors[key][0])<1e-8&&Math.abs(d.coreFactors[k].score-target.factors[key][1])<1e-8);
    result[symbol].push({date,score:d.coreScore,delta:d.coreScore-target.score,parity:parity&&d.label===target.tier&&Math.abs(d.coreScore-target.score)<1e-8,
     provenance:symbol==="00757"?"TWSE_RAW_ARCHIVE_WITHOUT_INDEPENDENT_CAPITAL_ACTION_COMPLETENESS":"HYBRID_SEALED_FINMIND_AND_TWSE"});
   }
  }finally{globalThis.fetch=original;}
 }
 return {release_eligible:false,source_cutoff:"2026-11-16",asof:asof.toISOString(),result,official0050,receipts};
}
if(require.main===module)replay().then(x=>console.log(JSON.stringify(x,null,2))).catch(e=>{console.error(e.message);process.exitCode=1;});
