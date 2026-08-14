const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");

const root=path.resolve(__dirname,"..");
const html=fs.readFileSync(path.join(root,"index.html"),"utf8");
const start=html.indexOf("function intradayRadarDisplayState");
const end=html.indexOf("function createLongRankSnapshot");
assert.ok(start>=0&&end>start);
const context={taipeiToday:()=>"2026-08-14"};
vm.createContext(context);vm.runInContext(html.slice(start,end),context);
const schedule={current:"13:30",next:"今日已完成"};

const missed={
  trading_date:"2026-08-14",snapshot_status:"SNAPSHOT_MISSED",
  success_count:0,expected_count:5,missed_slots:["09:30","10:30","11:30","12:30","13:30"],failed_slots:[]
};
let state=context.intradayRadarDisplayState("",schedule,null,missed);
assert.equal(state.current,"等待盤中資料");
assert.equal(state.failed,"今日盤中資料未建立（0/5）");
assert.equal(state.snapshotStatus,"SNAPSHOT_MISSED");

const partial={
  trading_date:"2026-08-14",snapshot_status:"SNAPSHOT_PARTIAL",
  success_count:3,expected_count:5,missed_slots:["09:30"],failed_slots:["13:30"]
};
state=context.intradayRadarDisplayState("2026-08-14 12:30",schedule,null,partial);
assert.equal(state.current,"12:30");
assert.equal(state.failed,"今日盤中資料未完整建立（3/5）");

assert.match(html,/市場正式資料 \$\{esc\(all\[0\]\?\.date\|\|"—"\)\}｜盤中雷達/);
assert.match(html,/liveRadarCompleteness=metaResult\.value\?\.intraday_completeness/);
assert.match(html,/radarCompleteness:liveRadarCompleteness/);
console.log("PASS P0.2 homepage separates formal market date from intraday completeness");
