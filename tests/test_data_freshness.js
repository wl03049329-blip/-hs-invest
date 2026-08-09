const assert=require("node:assert/strict");
const core=require("../data-freshness-core.js");

const now=new Date("2026-08-09T04:00:00Z");
assert.equal(core.normalize({value:1,data_date:"2026-08-07",updated_at:"2026-08-07T12:00:00Z"},{now,maxTradingDayAge:3}).status,"LATEST");
assert.equal(core.normalize({value:1,data_date:"2026-07-31",updated_at:"2026-08-01T00:00:00Z"},{now,maxTradingDayAge:3}).status,"STALE");
assert.equal(core.normalize({},{now}).status,"WAITING");
assert.equal(core.normalize({data_date:"2026-08-07",failed:true},{now}).status,"FAILED");
assert.equal(core.normalize({data_date:"2026-08-07",fallback:true},{now}).status,"FALLBACK");
assert.equal(core.isNewerDataDate("2026-08-08","2026-08-07"),true);
assert.equal(core.isNewerDataDate("2026-08-07","2026-08-07"),false);
assert.equal(core.label("STALE"),"資料可能過期");
console.log("PASS normalized data freshness and new-data-date guard");
