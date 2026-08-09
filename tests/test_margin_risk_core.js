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

assert.equal(core.ratioBand(160).label,"市場槓桿壓力一般");
assert.equal(core.ratioBand(150).label,"維持率轉弱");
assert.equal(core.ratioBand(140).label,"壓力升高");
assert.equal(core.ratioBand(130).label,"接近法規參考區");
assert.equal(core.ratioBand(129.9).label,"極端壓力區");

const raw={
  data_date:"2026-07-31",
  model:{name:"rolling_estimated_margin_cost",is_estimated:true,warmup_trading_days:125},
  margin_balance:{estimated_financing_principal:545500000000,balance_shares:9096008000,daily_change:1},
  maintenance_ratio:{value:163.08,collateral_market_value:889600000000,estimated_financing_principal:545500000000,method:"rolling_estimated_margin_cost",is_estimated:true},
  coverage:{coverage_ratio:99.1}
};
const payload=core.validatePayload(raw,"2026-08-03");
assert.ok(payload);assert.equal(payload.maintenance_ratio.value,163.08);assert.equal(payload.stale,false);
assert.deepEqual(core.displayValues(payload),{financingPrincipal:545500000000,collateralMarketValue:889600000000,maintenanceRatio:163.08,dataDate:"2026-07-31"});
assert.equal(core.validatePayload({data_date:"2026-07-31",margin_balance:{estimated_financing_principal:0},maintenance_ratio:{value:0}},"2026-08-03"),null);
assert.equal(core.combineFear(40,100,.8),49,"maintenance factor must be capped at 15%");
console.log("margin risk core tests passed");
