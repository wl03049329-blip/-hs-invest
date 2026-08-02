const assert=require("node:assert/strict");
const core=require("../institutional-flow-core.js");

const rows=[];
for(let day=1;day<=20;day++){
  const date=`2026-07-${String(day).padStart(2,"0")}`;
  rows.push({date,name:"Foreign_Investor",buy:200,sell:100});
  rows.push({date,name:"Foreign_Dealer_Self",buy:20,sell:10});
  rows.push({date,name:"Investment_Trust",buy:80,sell:50});
  rows.push({date,name:"Dealer",buy:90,sell:50});
  rows.push({date,name:"Dealer_self",buy:60,sell:40});
  rows.push({date,name:"Dealer_Hedging",buy:30,sell:10});
}
const flow=core.build(rows);
assert.equal(flow.periods.twenty,20);
assert.equal(flow.foreign.today,110);
assert.equal(flow.trust.today,30);
assert.equal(flow.dealer.today,40,"Dealer total must win over components to prevent double counting");
assert.equal(flow.total.today,180);
assert.equal(flow.total.five,900);
assert.equal(flow.total.twenty,3600);
assert.equal(flow.total.today,flow.foreign.today+flow.trust.today+flow.dealer.today);
assert.match(core.trendText(flow),/20個交易日/);

const withoutTotal=rows.filter(row=>row.name!=="Dealer");
assert.equal(core.build(withoutTotal).dealer.today,40,"dealer components are fallback when Dealer total is absent");
const short=core.build(rows.filter(row=>row.date>="2026-07-15"));
assert.equal(short.periods.twenty,6,"actual valid trading-day count is displayed when fewer than 20");
console.log("institutional flow core tests passed");
