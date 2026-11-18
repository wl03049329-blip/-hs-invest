"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const {receipt,capture,captureWindow,archiveReceipt,appendClose,windowCoverage} = require("../scripts/audit_twse_close_capture.cjs");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const {sessions,missingReceipts} = require("../scripts/audit_twse_close_watchdog.cjs");
const date = "2026-11-16";
const now = () => new Date("2026-11-16T10:20:00Z");
const raw = close => Buffer.from(JSON.stringify([{Date:"1151116",Code:"0050",
  OpeningPrice:"10",HighestPrice:"12",LowestPrice:"9",ClosingPrice:close,TradeVolume:"123"}]));
const openRaw = (date="1151116",close="27.95",change="-3.9700") => Buffer.from(JSON.stringify([
  {Date:date,Code:"00631L",ClosingPrice:close,Change:change,TradeVolume:"678825245"}]));
const market = Buffer.from(JSON.stringify([{Date:"1151116",TradeVolume:"1100000"}]));

test("00631L requires a dated confirmed session and handles a bounded next-morning retry", () => {
  assert.equal(archiveReceipt(openRaw("1151113"),market,now(),false).status,"DEFERRED_SOURCE_DATE");
  assert.equal(archiveReceipt(openRaw(),market,new Date("2026-11-17T00:17:00Z"),false).status,"DEFERRED_WINDOW");
  assert.equal(archiveReceipt(openRaw(),market,new Date("2026-11-17T00:17:00Z"),true).record.trading_date,date);
  assert.equal(archiveReceipt(openRaw(),market,new Date("2026-11-17T10:20:00Z"),false).status,"DEFERRED_SESSION");
  const {record} = archiveReceipt(openRaw(),market,now(),false);
  assert.equal(record.close_twd,"27.95");
  assert.equal(record.comparison_twd,"31.92");
  assert.match(record.response_sha256,/^[a-f0-9]{64}$/);
  assert.equal(archiveReceipt(openRaw("1151116","27.95","X"),market,now(),false).record.comparison_twd,null);
});
test("licensed CSV independently confirms the close and previous price basis", () => {
  const stock = Buffer.from('日期,證券代號,證券名稱,成交股數,成交金額,開盤價,最高價,最低價,收盤價,漲跌價差,成交筆數\n"1151116","00631L","元大,台灣50","678825245","1","31.25","31.37","27.95","27.95","-3.9700","1"\n');
  const daily = Buffer.from('日期,成交股數,成交金額,成交筆數,發行量加權股價指數,漲跌點數\n"1151116","1000","1","1","1","1"\n');
  const options = {csv:true,marketCsv:true,manual:true};
  const {record} = archiveReceipt(stock,daily,new Date("2026-11-16T16:15:00Z"),true,false,options);
  assert.equal(record.trading_date,"2026-11-16");
  assert.equal(record.close_twd,"27.95");
  assert.equal(record.comparison_twd,"31.92");
  assert.ok(record.source.endsWith("response=open_data"));
  assert.throws(() => archiveReceipt(Buffer.from("bad header"),daily,now(),false,false,options),/OPEN_CSV_HEADER/);
});
test("00631L replays are idempotent; corrections never replace original bytes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),"hs-00631l-test-"));
  try {
    const {record} = archiveReceipt(openRaw(),market,now(),false);
    const {name,status} = appendClose(dir,record);
    assert.equal(status,"APPENDED");
    const original = fs.readFileSync(path.join(dir,name),"utf8");
    assert.equal(appendClose(dir,{...record,response_sha256:"f".repeat(64)}).status,"DUPLICATE");
    assert.throws(() => appendClose(dir,{...record,close_twd:"28.00"}),/REVISION/);
    assert.equal(fs.readFileSync(path.join(dir,name),"utf8"),original);
  } finally { fs.unlinkSync(path.join(dir,date+".json")); fs.rmdirSync(dir); }
});
test("window eligibility rejects missing days and unverified action basis", () => {
  const first = "2026-11-13", days = [first,date];
  const {record} = archiveReceipt(openRaw(),market,now(),false);
  assert.deepEqual(windowCoverage([record],days,first,date,true),{status:"MISSING_SESSIONS",missing:[first]});
  const complete = [{...record,trading_date:first,close_twd:"31.92"},record];
  assert.equal(windowCoverage(complete,days,first,date,false).status,"PRICE_BASIS_UNVERIFIED");
  assert.equal(windowCoverage(complete,days,first,date,true).status,"COMPLETE");
});

test("watchdog uses actual completed sessions, never weekday guesses", () => {
  const entries = [{Date:"1151113",TradeVolume:"100"},{Date:"1151116",TradeVolume:"200"}];
  assert.deepEqual(sessions(entries,"2026-11-13","2026-11-17"),["2026-11-13","2026-11-16"]);
  assert.throws(() => sessions([...entries,entries[0]],"2026-11-13","2026-11-17"),/DUPLICATE/);
  assert.throws(() => sessions(entries,"2026-11-13","2026-11-15"),/ROW_INVALID/);
});

test("Taipei slots accept bounded delays but reject the next slot or next date", () => {
  const created = "2026-11-16T10:20:00Z";
  assert.equal(captureWindow(new Date("2026-11-16T10:47:00Z"),"18:20",created),date);
  assert.equal(captureWindow(new Date("2026-11-16T12:26:00Z"),"20:20",created),date);
  assert.throws(() => captureWindow(new Date("2026-11-16T12:20:00Z"),"18:20",created),/WINDOW_MISSED/);
  assert.throws(() => captureWindow(new Date("2026-11-17T10:25:00Z"),"18:20",created),/WINDOW_MISSED/);
});

test("watchdog flags both skipped and failed capture, but accepts the second clean slot", () => {
  const prefix = "twse-close-main-", days = ["2026-11-13",date,"2026-11-17"];
  assert.deepEqual(missingReceipts(days,[prefix+days[0]+"-ok-18-20",prefix+days[1]],prefix),[date,days[2]]);
  assert.deepEqual(missingReceipts(days,[prefix+days[0]+"-ok-18-20",prefix+date+"-ok-20-20"],prefix),[days[2]]);
});

test("receipt has no raw prices and changes are flagged only for affected symbols", () => {
  const first = receipt(raw("10"),date,null,now());
  const duplicate = receipt(raw("10"),date,first,now());
  const revised = receipt(raw("11"),date,first,now());
  assert.equal(first.symbols["0050"].corporateActions,"UNKNOWN");
  assert.equal(first.symbols["0050"].scoreEligible,false);
  assert.equal(first.rawRetained,false);
  assert.equal(first.symbols["0050"].close,undefined);
  assert.equal(duplicate.responseChanged,false);
  assert.equal(revised.responseChanged,true);
  assert.equal(revised.symbols["0050"].revised,true);
  assert.equal(revised.symbols["00757"].revised,false);
  assert.throws(() => receipt(raw("10"),date,{...first,date:"2026-11-13"},now()),/PREVIOUS_RECEIPT_INVALID/);
});

test("5xx retry is bounded but rate limits and stale sessions fail closed", async () => {
  let calls=0;
  await capture(date,null,{now,pause:async()=>{},get:async()=>{
    calls++;
    return calls===1 ? new Response(null,{status:503}) : new Response(raw("10"));
  }});
  assert.equal(calls,2);
  calls=0;
  await assert.rejects(capture(date,null,{now,get:async()=>{calls++;return new Response(null,{status:429});}}),/HTTP_429/);
  assert.equal(calls,1);
  await assert.rejects(capture("2026-11-17",null,{
    now:()=>new Date("2026-11-17T10:20:00Z"),get:async()=>new Response(raw("10"))
  }),/SESSION_DATE_MISMATCH/);
});
