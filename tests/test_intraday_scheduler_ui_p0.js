const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");

const root=path.resolve(__dirname,"..");
const html=fs.readFileSync(path.join(root,"index.html"),"utf8");
const start=html.indexOf("function intradayRadarDisplayState");
const end=html.indexOf("function createLongRankSnapshot");
assert.ok(start>=0&&end>start);
const context={taipeiToday:()=>"2026-08-13"};
vm.createContext(context);vm.runInContext(html.slice(start,end),context);
const schedule={current:"10:30",next:"下一次 11:30"};

let state=context.intradayRadarDisplayState("",schedule,null);
assert.equal(state.current,"等待盤中資料");
assert.notEqual(state.current,schedule.current);

state=context.intradayRadarDisplayState("2026-08-13 09:30",schedule,null);
assert.equal(state.current,"09:30");

state=context.intradayRadarDisplayState("2026-08-13 09:30",schedule,{status:"failed",trading_date:"2026-08-13",slot:"10:30"});
assert.equal(state.current,"09:30");assert.equal(state.failed,"10:30 更新失敗");assert.equal(state.next,"等待下一筆成功資料");

state=context.intradayRadarDisplayState("2026-08-13 10:30",schedule,{status:"success",trading_date:"2026-08-13",slot:"10:30"});
assert.equal(state.current,"10:30");assert.equal(state.failed,"");

assert.match(html,/actualSnapshotTime=radarDisplay\.current/);
assert.doesNotMatch(html,/actualSnapshotTime=snapshotAsOf\?snapshotSlot\.slice\(-5\):schedule\.current/);
assert.match(html,/validatedRadarRefresh\(detail\.radarRefresh,quotes\)/);
assert.match(html,/radarSlot:verifiedRefresh\.slot/);
console.log("PASS production UI only displays a validated successful intraday slot");
