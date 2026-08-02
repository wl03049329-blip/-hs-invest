const assert = require("node:assert/strict");
const core = require("../margin-risk-core.js");

const cases = [
  [{balanceDailyChange:1, maintenanceDailyChange:-1}, "risk_high", "風險升高"],
  [{balanceDailyChange:-1, maintenanceDailyChange:-1}, "deleverage", "去槓桿壓力"],
  [{balanceDailyChange:-1, maintenanceDailyChange:1}, "improving", "改善中"],
  [{balanceDailyChange:1, maintenanceDailyChange:1}, "neutral_crowding", "中性"]
];
for (const [input, key, label] of cases) {
  const result = core.classifyRisk(input);
  assert.equal(result.key, key);
  assert.equal(result.label, label);
  assert.ok(!/確定|必買|斷頭/.test(result.summary));
}

const missing = core.classifyRisk({balanceDailyChange:10, maintenanceDailyChange:null});
assert.equal(missing.key, "balance_rising");
assert.match(missing.summary, /維持率資料目前缺值/);

const stale = core.classifyRisk({balanceDailyChange:-1, maintenanceDailyChange:1, stale:true});
assert.equal(stale.key, "stale");
assert.match(stale.summary, /超過 3 個交易日/);

const payload = core.validatePayload({
  data_date:"2026-07-31",
  margin_balance:{value:507462771000,daily_change:13596988000,change_20d:1,percentile_60d:90},
  maintenance_ratio:{value:null,daily_change:null,average_20d:null,percentile_60d:null}
}, "2026-08-03");
assert.ok(payload);
assert.equal(payload.maintenance_ratio.value, null);
assert.equal(payload.stale, false);

const invalidZero = core.validatePayload({
  data_date:"2026-07-31",
  margin_balance:{value:0},
  maintenance_ratio:{value:0}
}, "2026-08-03");
assert.equal(invalidZero, null);

assert.equal(core.combineFear(40,100,.15),49);
assert.equal(core.combineFear(40,100,.8),49, "maintenance factor must be capped at 15%");
assert.equal(core.combineFear(40,null,.15),40);
assert.equal(core.maintenanceFearScore(null,null),null);
assert.equal(core.maintenanceFearScore(160,10),90);

console.log("margin risk core tests passed");
