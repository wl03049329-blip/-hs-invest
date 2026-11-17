"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const {receipt,capture,captureWindow} = require("../scripts/audit_twse_close_capture.cjs");
const {sessions,missingReceipts} = require("../scripts/audit_twse_close_watchdog.cjs");
const date = "2026-11-16";
const now = () => new Date("2026-11-16T10:20:00Z");
const raw = close => Buffer.from(JSON.stringify([{Date:"1151116",Code:"0050",
  OpeningPrice:"10",HighestPrice:"12",LowestPrice:"9",ClosingPrice:close,TradeVolume:"123"}]));

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
