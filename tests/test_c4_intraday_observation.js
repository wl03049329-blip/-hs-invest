"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { observations } = require("../backend/c4_observation_bridge.js");
const adapter = require("../hs-live-source-adapter.js");
const front = require("../c4-intraday-observation.js");

const four = ["0050","00757","00830","00935"];
const date = "2026-11-13";
function fixture() {
  const histories = {}, rows = {};
  for (const symbol of [...four,"00662"]) {
    rows[symbol] = {code:symbol,market:"TWSE",source:"https://mis.twse.com.tw/stock/api/getStockInfo.jsp",
      price_field:"z",date,quote_time:"09:30:01",price:91,open:92,high:93,low:90,volume:1800000};
    histories[symbol] = Array.from({length:300}, (_,i) => ({
      date:new Date(Date.UTC(2026,10,12)-(299-i)*86400000).toISOString().slice(0,10),
      open:100+i/50,close:100+i/50,max:102+i/50,min:98+i/50,Trading_Volume:1000000
    }));
  }
  return {tradingDate:date,slot:"09:30",now:date+"T09:31:00+08:00",marketState:"OPEN",
    rows,histories,previousSession:"2026-11-12"};
}
test("four isolated observations with documented suspension and WAIT_NATIVE",()=>{
  const f=fixture(), saved=JSON.stringify(f), out=observations(f);
  assert.equal(out.formal_eligible,false);
  assert.equal(out.items["00662"].status,"SPLIT_SUSPENDED");
  assert.equal(out.items["009815"].status,"WAIT_NATIVE");
  for(const symbol of four){
    assert.equal(out.items[symbol].status,"OBSERVED");
    assert(Number.isFinite(out.items[symbol].score));
    assert(!("rank" in out.items[symbol]));
  }
  assert.equal(adapter.railwayToCanonical(out,{targetDate:date,symbols:four}).status,"UNAVAILABLE");
  assert.equal(JSON.stringify(f),saved);
});
for(const [change,expected] of [
  [q=>delete q["0050"],"QUOTE_UNAVAILABLE"],
  [q=>q["0050"].quote_time="09:00:00","QUOTE_STALE"],
  [q=>q["0050"].quote_time="09:32:00","QUOTE_TIME_INVALID"],
  [q=>q["0050"].date="2026-11-12","QUOTE_DATE_INVALID"],
  [q=>q["0050"].volume=0,"WAITING_FIRST_TRADE"],
  [q=>q["0050"].price_field="y","QUOTE_SOURCE_INVALID"],
]){
  test("only the affected symbol is rejected: "+expected,()=>{
    const f=fixture();change(f.rows);const out=observations(f);
    assert.deepEqual(out.items["0050"],{status:expected});
    for(const s of four.slice(1))assert.equal(out.items[s].status,"OBSERVED");
  });
}
test("stale history, close and next-date payload are not promoted",()=>{
  const f=fixture(); f.histories["0050"].pop();
  assert.equal(observations(f).items["0050"].status,"HISTORY_UNVERIFIED");
  assert.equal(observations({...f,now:date+"T13:30:00+08:00"}).items["00757"].status,"OFF_SESSION");
  assert.throws(()=>observations({...f,tradingDate:"2026-11-17"}),/INVALID_OBSERVATION_DATE/);
  const next=observations({...f,tradingDate:"2026-11-17",now:"2026-11-17T09:30:00+08:00"});
  assert.equal(next.items["00662"].status,"SPLIT_RESUMPTION_UNVERIFIED");
  assert.equal(next.items["00757"].status,"QUOTE_DATE_INVALID");
});
test("two or all missing, then recover without mixing dates or formal authority",()=>{
  const f=fixture(), now=Date.parse(f.now);
  for(const count of [2,4]){
    const rows={...f.rows};
    for(const s of four.slice(0,count))delete rows[s];
    const o=observations({...f,rows});
    assert.equal(Object.values(front.validate(o,now,date)).filter(r=>r.status==="OBSERVED").length,4-count);
    assert.equal(front.validate(o,now,"2026-11-16"),null);
    assert.equal(front.validate({...o,formal_eligible:true},now,date),null);
  }
  const o=observations(f);
  assert.equal(front.validate(o,now+421000,date)["0050"].status,"QUOTE_STALE");
  assert.equal(front.validate(o,now,date)["0050"].status,"OBSERVED");
});
