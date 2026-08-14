const assert=require("assert");
const fs=require("fs");
const path=require("path");
const vm=require("vm");

const root=path.resolve(__dirname,"..");
const html=fs.readFileSync(path.join(root,"index.html"),"utf8");
const css=fs.readFileSync(path.join(root,"formal-black-gold.css"),"utf8");
const production=require(path.join(root,"final-core-production.js"));
const start=html.indexOf("function isCompletedTradingDate");
const end=html.indexOf("function longOverviewCardHtml");
assert.ok(start>=0&&end>start,"P3 history helpers must exist");
const context={Date,Number,Array,Object,Math,Set,HSFinalCoreProduction:production,loadDailyLongRankHistory:()=>({schema_version:1,snapshots:[]})};
vm.createContext(context);vm.runInContext(html.slice(start,end),context);

const item=(ticker,date,score,j=12)=>({
  symbol:ticker,trading_date:date,final_core_score:score,display_score:Math.floor(score),
  status:"stored label is diagnostic only",data_as_of:`${date}T13:30:00+08:00`,
  calculated_at:`${date}T06:00:00.000Z`,engine_version:"FINAL_CORE_WEIGHT_V1",weekly_j:j
});
const snapshot=(date,items,type="FINALIZED_CLOSE")=>({snapshot_type:type,tradingDate:date,finalizedAt:`${date}T06:00:00.000Z`,items});
const weekdays=["2026-08-14","2026-08-13","2026-08-12","2026-08-11","2026-08-10","2026-08-07","2026-08-06","2026-08-05","2026-08-04","2026-08-03"];
const ten={schema_version:1,snapshots:weekdays.map((date,index)=>snapshot(date,{"00830":item("00830",date,28+index,index)})).reverse()};

let rows=context.officialCoreScoreHistory(ten,"00830",10);
assert.strictEqual(rows.length,10);assert.strictEqual(rows[0].tradingDate,"2026-08-14");assert.strictEqual(rows.at(-1).tradingDate,"2026-08-03");
assert.ok(rows.every(row=>row.dataAsOf.startsWith(row.tradingDate)&&row.engineVersion==="FINAL_CORE_WEIGHT_V1"));
console.log("TEST 1 PASS: latest ten finalized trading-day records render newest first");

const withWeekend={schema_version:1,snapshots:[...ten.snapshots,snapshot("2026-08-09",{"00830":item("00830","2026-08-09",99)}),snapshot("2026-08-17",{"00830":item("00830","2026-08-17",99)},"INTRADAY")]};
rows=context.officialCoreScoreHistory(withWeekend,"00830",10);assert.strictEqual(rows.length,10);assert.ok(!rows.some(row=>["2026-08-09","2026-08-17"].includes(row.tradingDate)));
console.log("TEST 2 PASS: weekend and provisional records are excluded; actual finalized dates drive history");

rows=context.officialCoreScoreHistory({schema_version:1,snapshots:ten.snapshots.slice(-6)},"00830",10);assert.strictEqual(rows.length,6);
console.log("TEST 3 PASS: six legal records stay six without fabricated backfill");

assert.deepStrictEqual(JSON.parse(JSON.stringify(context.coreScoreHistoryState("009815",ten))),{kind:"wait_native",rows:[]});
console.log("TEST 4 PASS: 009815 remains WAIT_NATIVE without a fake score");

const own00757={schema_version:1,snapshots:[snapshot("2026-08-14",{"00757":item("00757","2026-08-14",44.9),"009815":item("009815","2026-08-14",88)})]};
rows=context.officialCoreScoreHistory(own00757,"00757",10);assert.strictEqual(rows.length,1);assert.strictEqual(rows[0].symbol,"00757");assert.strictEqual(rows[0].displayScore,44);
console.log("TEST 5 PASS: 00757 reads only its own finalized history");

const boundaries={schema_version:1,snapshots:[
  snapshot("2026-08-14",{"0050":item("0050","2026-08-14",40)}),
  snapshot("2026-08-13",{"0050":item("0050","2026-08-13",39)}),
  snapshot("2026-08-12",{"0050":item("0050","2026-08-12",30)}),
  snapshot("2026-08-11",{"0050":item("0050","2026-08-11",29)})
]};
assert.deepStrictEqual(Array.from(context.officialCoreScoreHistory(boundaries,"0050",10),row=>row.status),["加碼條件浮現","回檔訊號出現","回檔訊號出現","一般持有"]);
console.log("TEST 6 PASS: status boundaries reuse canonical production mapping");

assert.match(html,/data-core-score-history="\$\{esc\(x\.id\)\}">近10日盤後分數/);
assert.match(html,/class="sheet coreScoreSheet coreScoreHistorySheet"/);
for(const text of ["資料讀取中","尚無合法盤後歷史紀錄","歷史資料讀取失敗"])assert.ok(html.includes(text),`missing UI state: ${text}`);
assert.match(css,/#homeEtfBrief \.longRankActions\{[^}]*display:flex/i);
assert.match(css,/#homeEtfBrief \.longRankActions \.miniBtn\{[^}]*white-space:nowrap/);
assert.match(css,/\.coreScoreSheet\{[^}]*safe-area-inset-top/);
console.log("TEST 7 PASS: dual CTA, shared P2 safe area and mobile nowrap guards are present");

console.log("P3 finalized close history tests: 7/7 PASS");
