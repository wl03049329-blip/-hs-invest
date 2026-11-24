"use strict";
const assert=require("node:assert/strict"),test=require("node:test"),p=require("../scripts/portfolio_open_close.cjs");
const r=(d,code,px,shares="100")=>({Date:d,Code:code,TradeVolume:shares,ClosingPrice:px});
const buf=rows=>Buffer.from(JSON.stringify(rows));
const later="2026-11-24", earlier="2026-11-23";
function tw(date,rows){return p.snapshot(buf(rows),p.JSON_TWSE,date);}
test("licensed close coverage is not tied to radar symbols and missing trades are not fabricated",()=>{
 const x=tw(later,[r("1151124","2330","1000"),r("1151124","00631L","27.00"),r("1151124","00685L","8.61","0")]);
 assert.deepEqual(x.prices,{"2330":"1000","00631L":"27"});assert.equal(p.validate(x),x);
 assert.throws(()=>p.validate({...x,prices:{"2330":"1"}}),/INVALID_OPEN_CLOSE_RECEIPT/);
 assert.throws(()=>p.snapshot(buf([r("1151124","2330","1000")]),"https://www.twse.com.tw/exchangeReport/MI_INDEX",later),/SOURCE_OR_EXPECTED_DATE/);
});
test("stale rows, mixed dates and duplicate rows never become current",()=>{
 for(const rows of [[r("1151123","2330","1000")],[r("1151124","2330","1000"),r("1151123","0050","95")]])assert.throws(()=>tw(later,rows),/SESSION_MISMATCH/);
 assert.throws(()=>tw(later,[r("1151124","2330","1000"),r("1151124","2330","1000")]),/INSTRUMENT_INTEGRITY/);
});
test("TPEx covers new stocks or ETFs; no other venue can silently provide a prior",()=>{
 const close=p.snapshot(buf([{Date:"1151124",SecuritiesCompanyCode:"006201",Close:"29.97",TradingShares:"100"}]),p.JSON_TPEX,later);
 assert.equal(close.prices["006201"],"29.97");
 const prior=tw(earlier,[r("1151123","2330","980")]);
 assert.throws(()=>p.pair([prior,close],{expectedDate:later,verifiedSessions:[earlier,later]}),/MARKET_CONFLICT/);
});
test("append is idempotent, holds revisions, and pair requires the actual previous session",()=>{
 const a=tw(earlier,[r("1151123","2330","990")]),b=tw(later,[r("1151124","2330","1000")]),list=p.append(p.append([],a),b);
 assert.equal(p.append(list,b),list);
 assert.throws(()=>p.append(list,tw(later,[r("1151124","2330","1001")])),/REVISION_REQUIRES_REVIEW/);
 assert.equal(p.pair([b],{expectedDate:later,verifiedSessions:[earlier,later]}),null);
 assert.throws(()=>p.pair(list,{expectedDate:later,verifiedSessions:[later,earlier]}),/CALENDAR_EVIDENCE_REQUIRED/);
 assert.equal(p.pair(list,{expectedDate:later,verifiedSessions:[earlier,later]}).corporate_actions,"UNVERIFIED");
});
test("holiday and year rollover use explicit official sessions, not subtraction",()=>{
 const a=tw("2026-12-31",[r("1151231","2330","990")]),b=tw("2027-01-04",[r("1160104","2330","1000")]);
 assert.equal(p.pair([a,b],{expectedDate:"2027-01-04",verifiedSessions:["2026-12-31","2027-01-04"]}).previous_date,"2026-12-31");
});
test("stale TWSE JSON falls back only to the licensed CSV, not historical website data",async()=>{
 const csv='日期,證券代號,證券名稱,成交股數,成交金額,開盤價,最高價,最低價,收盤價,漲跌價差,成交筆數\n"1151124","2330","fixture","100","1000","9","11","9","10","1","3"\n';
 const calls=[];
 const x=await p.collect("TWSE",later,async url=>{
  calls.push(url);
  return {ok:true,url,body:new Response(url===p.JSON_TWSE?buf([r("1151123","2330","9")]):csv).body};
 });
 assert.deepEqual(calls,[p.JSON_TWSE,p.CSV_TWSE]);assert.equal(x.prices["2330"],"10");
});
