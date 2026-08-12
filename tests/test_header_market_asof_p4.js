const assert=require("assert");
const fs=require("fs");
const path=require("path");
const vm=require("vm");

const root=path.resolve(__dirname,"..");
const html=fs.readFileSync(path.join(root,"index.html"),"utf8");
const intraday=require(path.join(root,"intraday-buy-point-core.js"));
const start=html.indexOf("function formatHeaderMarketAsOf");
const end=html.indexOf("function marketValueText");
assert.ok(start>=0&&end>start,"P4 Header marketAsOf helpers must exist");
const source=html.slice(start,end);
const context={Date,Intl,Number,Object,Array,HSIntradayBuyPointCore:intraday,latestSuccessfulMarketAsOf:"",$:()=>null};
vm.createContext(context);vm.runInContext(source,context);

const close="2026-08-11T13:30:00+08:00",at0930="2026-08-12T09:30:00+08:00",at1030="2026-08-12T10:30:00+08:00",at1330="2026-08-12T13:30:00+08:00";

assert.strictEqual(context.headerMarketUpdateText(close),"資料更新｜2026-08-11 13:30:00");
console.log("TEST 1 PASS: previous close remains Header source before new market data");

let successful=context.newerSuccessfulMarketAsOf(close,at0930);
assert.strictEqual(context.headerMarketUpdateText(successful),"資料更新｜2026-08-12 09:30:00");
console.log("TEST 2 PASS: 09:30 successful marketAsOf updates Header");

successful=context.newerSuccessfulMarketAsOf(successful,at1030);
assert.strictEqual(context.headerMarketUpdateText(successful),"資料更新｜2026-08-12 10:30:00");
console.log("TEST 3 PASS: 10:30 successful marketAsOf updates Header");

const afterFailure=context.newerSuccessfulMarketAsOf(successful,"");
assert.strictEqual(afterFailure,at1030);assert.strictEqual(context.headerMarketUpdateText(afterFailure),"資料更新｜2026-08-12 10:30:00");
console.log("TEST 4 PASS: failed refresh retains previous successful Header timestamp");

assert.doesNotMatch(source,/Date\.now\s*\(/);assert.doesNotMatch(source,/new Date\s*\(\s*\)/);
assert.doesNotMatch(html,/m\.textContent=`資料更新｜\$\{all\[0\]\.date\}/);
console.log("TEST 5 PASS: Header does not use browser current time or formal row directly");

assert.strictEqual(intraday.quoteAsOf({date:"2026-08-12",quoteTime:"10:30:00"}),at1030);
assert.match(html,/if\(x\.intraday\?\.asOf\)appliedAsOf\.push\(x\.intraday\.asOf\)/);
console.log("TEST 6 PASS: Header source is P1 canonical marketAsOf");

assert.strictEqual(context.headerMarketUpdateText(context.newerSuccessfulMarketAsOf(successful,at1330)),"資料更新｜2026-08-12 13:30:00");
assert.strictEqual(context.headerMarketUpdateText(context.newerSuccessfulMarketAsOf(at1330,"")),"資料更新｜2026-08-12 13:30:00");

const formal=context.formalCloseMarketAsOf([{formalState:{date:"2026-08-11"}},{formalState:{date:"2026-08-10"}}]);
assert.strictEqual(formal,close);
assert.match(html,/const newestApplied=appliedAsOf\.sort/);assert.match(html,/if\(!updated\)[\s\S]*?return false;[\s\S]*?const newestApplied=/);

console.log("P4 TRACE");
console.log("Previous close latest formal date=2026-08-11 latest marketAsOf=2026-08-11T13:30:00+08:00 Header=2026-08-11 13:30:00");
console.log("09:30 success marketAsOf=2026-08-12T09:30:00+08:00 snapshotTime=09:30 Header=2026-08-12 09:30:00");
console.log("10:30 success marketAsOf=2026-08-12T10:30:00+08:00 snapshotTime=10:30 Header=2026-08-12 10:30:00");
console.log("10:30 failure previous successful marketAsOf=2026-08-12T09:30:00+08:00 Header=2026-08-12 09:30:00");
console.log("13:30 success marketAsOf=2026-08-12T13:30:00+08:00 Header=2026-08-12 13:30:00");
