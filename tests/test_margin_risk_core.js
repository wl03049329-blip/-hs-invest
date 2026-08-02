const assert = require("node:assert/strict");
const core = require("../margin-risk-core.js");

const cases = [
  [{balanceDailyChange:1,maintenanceDailyChange:-1,maintenanceValue:155},"risk_high","槓桿壓力升高"],
  [{balanceDailyChange:-1,maintenanceDailyChange:-1,maintenanceValue:145},"deleverage","去槓桿壓力"],
  [{balanceDailyChange:-1,maintenanceDailyChange:1,maintenanceValue:165},"improving","壓力改善中"],
  [{balanceDailyChange:1,maintenanceDailyChange:1,maintenanceValue:185},"neutral_crowding","中性、留意擁擠"]
];
for(const [input,key,label] of cases){
  const result=core.classifyRisk(input);
  assert.equal(result.key,key);assert.equal(result.label,label);
  assert.doesNotMatch(result.summary,/必然|斷頭|保證/);
}

assert.equal(core.ratioBand(180).label,"安全墊較高");
assert.equal(core.ratioBand(160).label,"一般水位");
assert.equal(core.ratioBand(150).label,"安全墊縮小");
assert.equal(core.ratioBand(140).label,"壓力升高");
assert.equal(core.ratioBand(130).label,"接近法規參考區");
assert.equal(core.ratioBand(129.9).label,"極端壓力區");
assert.match(core.classifyRisk({balanceDailyChange:1,maintenanceDailyChange:-1,maintenanceValue:130}).summary,/個別信用帳戶/);

const payload=core.validatePayload({
  data_date:"2026-07-31",margin_balance:{value:507462771000,daily_change:1},
  maintenance_ratio:{value:172.4,coverage_ratio:99.1,method:"estimated_market_margin_maintenance_ratio",is_estimated:true}
},"2026-08-03");
assert.ok(payload);assert.equal(payload.maintenance_ratio.value,172.4);assert.equal(payload.stale,false);
assert.equal(core.validatePayload({data_date:"2026-07-31",margin_balance:{value:0},maintenance_ratio:{value:0}},"2026-08-03"),null);
assert.equal(core.combineFear(40,100,.8),49,"maintenance factor must be capped at 15%");
assert.equal(core.maintenanceFearScore(null,null),null);
console.log("margin risk core tests passed");
