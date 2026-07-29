const assert = require("assert");
const core = require("../market-events-core.js");

assert.strictEqual(core.isOfficialUrl("https://www.federalreserve.gov/newsevents/test"), true);
assert.strictEqual(core.isOfficialUrl("https://example.com/fake"), false);
assert.strictEqual(core.decisionLabel(0), "維持利率不變（0碼）");
assert.match(core.decisionLabel(-25), /降息1碼/);
assert.match(core.decisionLabel(50), /升息2碼/);

const fake = core.validateEvent({
  id:"fake",date:"2026-07-29",title:"FOMC",type:"FOMC",risk:"高",
  status:"announced",result_summary:"fake",official_source_url:"https://example.com"
});
assert.strictEqual(fake.status, "scheduled");
assert.strictEqual(fake.resultConfirmed, false);

const official = core.validateEvent({
  id:"official",date:"2026-07-29",title:"FOMC",type:"FOMC",risk:"高",
  status:"announced",result_summary:"維持利率",official_source_url:"https://www.federalreserve.gov/test"
});
assert.strictEqual(official.resultConfirmed, true);

assert.strictEqual(core.comparisonLabel({actual:"2.8",expected:"2.7"}), "高於預期 0.1 個百分點");
assert.strictEqual(core.comparisonLabel({actual:"2.8",expected:""}), "");

const groups = core.groupEvents([
  official,
  {id:"tomorrow",date:"2026-07-31",title:"CPI",type:"CPI",risk:"高",status:"scheduled"},
  {id:"later",date:"2026-08-01",title:"PCE",type:"PCE",risk:"高",status:"scheduled"},
  {id:"third",date:"2026-08-02",title:"GDP",type:"GDP",risk:"中",status:"scheduled"},
  {id:"fourth",date:"2026-08-03",title:"NFP",type:"NFP",risk:"高",status:"scheduled"},
  {id:"old",date:"2026-04-01",title:"old",type:"CPI",risk:"中",status:"scheduled"}
], new Date("2026-07-30T12:00:00+08:00"));
assert.strictEqual(groups.upcoming.length, 3);
assert.strictEqual(groups.announced.length, 1);
assert.ok(groups.history.some(event => event.id === "official"));
assert.ok(!groups.history.some(event => event.id === "old"));

const custom = core.validateEvent({
  id:"custom",date:"2026-07-30",title:"自訂",type:"自訂",risk:"自訂",
  status:"announced",result_summary:"使用者手動結果",custom:true
}, {custom:true});
assert.strictEqual(custom.resultConfirmed, true);

const tariff = core.validateEvent({
  id:"tariff",date:"2026-07-30",title:"關稅公告",type:"TARIFF",risk:"高",
  status:"announced",result_summary:"對特定商品加徵關稅",tariff_rate:"25%",
  affected_scope:"特定國家／商品",effective_date:"2026-08-01",
  official_source_url:"https://ustr.gov/official-notice"
});
assert.strictEqual(tariff.resultConfirmed, true);
assert.strictEqual(tariff.tariff_rate, "25%");
assert.strictEqual(tariff.affected_scope, "特定國家／商品");

console.log("PASS official-event verification, status grouping and result formatting");
