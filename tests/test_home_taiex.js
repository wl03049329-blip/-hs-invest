"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const core = require("../home-taiex-core");
const {parseReport, buildSnapshot} = require("../scripts/update_home_taiex.cjs");
const at = "2026-11-07T01:00:00.000Z";
const clock = Date.parse(at);
function report(month, items) {
  const bytes = Buffer.from(JSON.stringify({
    stat:"OK", date:month.replace("-","") + "01",
    fields:["日期","成交股數","成交金額","成交筆數","發行量加權股價指數","漲跌點數"],
    data:items.map(([day, close, delta]) => [day, "1","2","3",close,delta])
  }));
  return {month, bytes};
}
const recent = report("2026-11", [
  ["115/11/05","41,574.72","-1,374.19"],
  ["115/11/06","39,701.64","-1,873.08"]
]);
const known = buildSnapshot([recent], at);

test("official closing change, baseline and percentage stay bound to one session", () => {
  assert.deepEqual(core.view(known,clock), {
    value:"39,701.64",change:"▼ −1,873.08 點（−4.51%）",tone:"fall",date:"2026-11-06"
  });
  assert.equal(known.previous_trade_date,"2026-11-05");
  assert.equal(known.evidence.length,1);
});
test("month/year rollover uses the last published session, not calendar yesterday", () => {
  const reports = [report("2025-12",[["114/12/31","30,000.00","12.00"]]),
    report("2026-01",[["115/01/02","30,150.00","+150.00"]])];
  const timestamp = "2026-01-02T08:00:00.000Z";
  const data = buildSnapshot(reports,timestamp);
  assert.equal(data.previous_trade_date,"2025-12-31");
  assert.equal(data.evidence.length,2);
  assert.equal(core.view(data,Date.parse(timestamp)).change,"▲ +150.00 點（+0.50%）");
});
test("flat uses neutral styling and exact zero only from valid official rows", () => {
  const data = {...known, close_cents:known.previous_close_cents, change_cents:0};
  assert.equal(core.view(data,clock).tone,"flat");
  assert.equal(core.view(data,clock).change,"0.00 點（0.00%）");
});
test("publication delay, weekends, several missing days, older data and HTTP failure preserve LKG", () => {
  for (const incoming of [null, known, {...known, trade_date:"2026-11-04", previous_trade_date:"2026-11-03"},
                          {...known, change_cents:known.change_cents+100}, {...known, validation:"FAILED"}]) {
    assert.equal(core.select(known,incoming,Date.parse("2026-11-15")),known);
  }
  assert.equal(core.select(null,null,clock),null);
});
test("only a newer verified tuple replaces the cache; same-date revisions stay quarantined", () => {
  const next = buildSnapshot([report("2026-11",[
    ["115/11/06","39,701.64","-1,873.08"],["115/11/09","40,001.64","+300.00"]
  ])],"2026-11-09T09:00:00.000Z");
  const after = Date.parse("2026-11-09T09:05:00.000Z");
  assert.equal(core.select(known,next,after),next);
  assert.equal(core.select(next,known,after),next);
  assert.equal(core.select(known,next,clock),known);
  assert.equal(core.select(known,{...known, close_cents:4000000, change_cents:4000000-known.previous_close_cents},after),known);
});
test("rejects mixed dates, missing baseline, incorrect official change and premature timestamps", () => {
  assert.throws(()=>buildSnapshot([recent],"2026-11-06T05:00:00.000Z"),/INVALID_SNAPSHOT/);
  assert.throws(()=>buildSnapshot([report("2026-11",[["115/11/06","39,701.64","-1,873.08"]])],at),/BASELINE/);
  assert.throws(()=>buildSnapshot([report("2026-11",[
    ["115/11/05","41,574.72","-1,374.19"],["115/11/06","39,701.64","-1,873.09"]
  ])],at),/PREVIOUS_CLOSE_MISMATCH/);
  assert.throws(()=>parseReport(recent.bytes,"2026-10"),/INVALID_TWSE_REPORT/);
  assert.throws(()=>parseReport(report("2026-11",[["115/11/31","1.00","0.00"]]).bytes,"2026-11"),/DATE_ORDER/);
  assert.throws(()=>parseReport(report("2026-11",[["115/11/06","---","0.00"]]).bytes,"2026-11"),/POINT_FORMAT/);
  assert.throws(()=>parseReport(report("2026-11",[["115/11/06","1.00","0.00"],["115/11/06","1.00","0.00"]]).bytes,"2026-11"),/DATE_ORDER/);
});
