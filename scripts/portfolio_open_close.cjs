"use strict";
// Licensed close snapshots only. No holdings, corporate-action inference, or
// market/FINAL writes. Intended as an independent stage of the close producer.
const crypto=require("node:crypto");
const {csvRows}=require("./audit_twse_close_capture.cjs");
const sha=bytes=>crypto.createHash("sha256").update(bytes).digest("hex");
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==="object"?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const hash=v=>sha(JSON.stringify(canonical(v)));
const SCHEMA="HS_PORTFOLIO_OPEN_CLOSE_V1", LICENSE="https://data.gov.tw/license";
const JSON_TWSE="https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL";
const CSV_TWSE="https://www.twse.com.tw/exchangeReport/STOCK_DAY_ALL?response=open_data";
const JSON_TPEX="https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes";
const sources=Object.freeze({
 [JSON_TWSE]:Object.freeze({market:"TWSE",dataset:"https://data.gov.tw/dataset/11549",attribution:"臺灣證券交易所",code:"Code",close:"ClosingPrice",volume:"TradeVolume"}),
 [CSV_TWSE]:Object.freeze({market:"TWSE",dataset:"https://data.gov.tw/dataset/11549",attribution:"臺灣證券交易所",code:"Code",close:"ClosingPrice",volume:"TradeVolume",csv:true}),
 [JSON_TPEX]:Object.freeze({market:"TPEx",dataset:"https://data.gov.tw/dataset/11371",attribution:"證券櫃檯買賣中心",code:"SecuritiesCompanyCode",close:"Close",volume:"TradingShares"}),
});
const id=s=>typeof s==="string"&&/^[0-9A-Z]{4,10}$/.test(s);
const price=p=>typeof p==="string"&&/^\d{1,8}(?:\.\d{1,6})?$/.test(p)&&Number(p)>0;
const volume=x=>typeof x==="string"&&/^\d{1,15}$/.test(x)&&Number.isSafeInteger(Number(x))&&Number(x)>0;
const date=d=>typeof d==="string"&&/^20\d\d-\d\d-\d\d$/.test(d)&&Number.isFinite(Date.parse(d))&&new Date(d).toISOString().slice(0,10)===d;
const roc=d=>String(+d.slice(0,4)-1911)+d.slice(5).replaceAll("-","");
const isHash=s=>typeof s==="string"&&/^[0-9a-f]{64}$/.test(s);
function snapshot(raw,url,expectedDate){
 const source=sources[url];if(!source||!date(expectedDate))throw Error("SOURCE_OR_EXPECTED_DATE");
 const rows=source.csv?csvRows(raw,false):JSON.parse(raw);
 if(!Array.isArray(rows)||!rows.length||rows.length>20000||rows.some(r=>r?.Date!==roc(expectedDate)))throw Error("SOURCE_SESSION_MISMATCH");
 const prices={},seen=new Set();
 for(const row of rows){
  const code=row[source.code],px=row[source.close],qty=row[source.volume];
  if(!id(code)||seen.has(code))throw Error("OFFICIAL_INSTRUMENT_INTEGRITY");
  seen.add(code);
  // A report may contain no-trade rows. Never convert '-' or zero into a close.
  if(price(px)&&volume(qty)) prices[code]=String(Number(px));
 }
 if(!Object.keys(prices).length)throw Error("NO_TRADED_CLOSES");
 const value={schema:SCHEMA,date:expectedDate,market:source.market,source:url,dataset:source.dataset,attribution:source.attribution,license:LICENSE,response_sha256:sha(raw),prices};
 return {...value,content_sha256:hash(value)};
}
function validate(receipt){
 const {content_sha256,...v}=receipt||{},s=sources[v.source];
 if(v.schema!==SCHEMA||!s||s.market!==v.market||v.dataset!==s.dataset||v.attribution!==s.attribution||v.license!==LICENSE||!date(v.date)||!isHash(v.response_sha256)||!v.prices||Array.isArray(v.prices)||typeof v.prices!=="object"||!Object.keys(v.prices).length||!Object.entries(v.prices).every(([key,value])=>id(key)&&price(value))||!isHash(content_sha256)||hash(v)!==content_sha256)throw Error("INVALID_OPEN_CLOSE_RECEIPT");
 return receipt;
}
function append(history,incoming){
 validate(incoming);
 const dated=new Map();let last="";
 for(const row of history){validate(row);if(row.market!==incoming.market||row.date<=last)throw Error("CACHE_INTEGRITY");dated.set(row.date,row);last=row.date;}
 const old=dated.get(incoming.date);
 if(old){
  if(hash(old.prices)!==hash(incoming.prices))throw Error("SOURCE_REVISION_REQUIRES_REVIEW");
  return history;
 }
 if(incoming.date<last)throw Error("CLOSE_RETROACTIVE_INSERT_REQUIRES_REVIEW");
 return [...history,incoming];
}
function pair(history,{expectedDate,verifiedSessions}){
 if(!date(expectedDate)||!Array.isArray(verifiedSessions)||verifiedSessions.length<2||
    verifiedSessions.some((d,i)=>!date(d)||i&&d<=verifiedSessions[i-1])||verifiedSessions.at(-1)!==expectedDate)
  throw Error("CALENDAR_EVIDENCE_REQUIRED");
 const previousDate=verifiedSessions.at(-2),latest=history.filter(r=>r.date===expectedDate),previous=history.filter(r=>r.date===previousDate);
 if(latest.length!==1||previous.length!==1)return null;
 const today=validate(latest[0]),prior=validate(previous[0]);
 if(today.market!==prior.market)throw Error("CLOSE_MARKET_CONFLICT");
 return {date:expectedDate,previous_date:previousDate,market:today.market,current_sha256:today.content_sha256,
         previous_sha256:prior.content_sha256,corporate_actions:"UNVERIFIED",prices_today:today.prices,prices_previous:prior.prices};
}
async function collect(market,day,request=fetch){
 if(!date(day))throw Error("CLOSE_DATE");
 const urls=market==="TWSE"?[JSON_TWSE,CSV_TWSE]:market==="TPEx"?[JSON_TPEX]:[];
 if(!urls.length)throw Error("CLOSE_MARKET");
 const errors=[];
 for(const url of urls){
  try {
   const r=await request(url,{cache:"no-store",redirect:"error",signal:AbortSignal.timeout(12000)});
   if(!r.ok||r.url!==url)throw Error("OPEN_CLOSE_HTTP_OR_REDIRECT");
   const read=r.body?.getReader();if(!read)throw Error("OPEN_CLOSE_BODY_UNAVAILABLE");
   const chunks=[];let size=0;
   try{
    for(;;){
     const {done,value}=await read.read();if(done)break;
     size+=value.length;if(size>4000000){await read.cancel();throw Error("OPEN_CLOSE_BODY_LIMIT");}
     chunks.push(Buffer.from(value));
    }
   }finally{read.releaseLock();}
   const raw=Buffer.concat(chunks,size);
   return snapshot(raw,url,day);
  }catch(e){errors.push(e.message);}
 }
 throw Error(market+": "+errors.join("; "));
}
module.exports={collect,snapshot,validate,append,pair,JSON_TWSE,CSV_TWSE,JSON_TPEX};
if(require.main===module){
 const day=process.argv[2];
 const now=new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Taipei",dateStyle:"short",timeStyle:"medium"}).format(new Date());
 if(!date(day)||day>now.slice(0,10)||day===now.slice(0,10)&&now.slice(11,16)<"18:00")throw Error("SESSION_NOT_COMPLETED");
 Promise.allSettled(["TWSE","TPEx"].map(m=>collect(m,day))).then(results=>{
  for(const r of results)if(r.status==="fulfilled"){
   const {prices,...v}=r.value;
   console.log(JSON.stringify({...v,trade_count:Object.keys(prices).length}));
  }else{console.error(r.reason.message);process.exitCode=2;}
 });
}
