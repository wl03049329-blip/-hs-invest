"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const core=require("../home-tmf-core"), snapshot=require("../home-tmf-net.json");
const now=Date.parse(snapshot.retrieved_at)+86400000;
test("validated official positions derive both numbers on a coherent pair of sessions",()=>{
  assert.equal(core.valid(snapshot,now),true);
  assert.equal(snapshot.observations[1].net-snapshot.observations[0].net,snapshot.net_change);
  assert.equal(core.view(snapshot,now).date,snapshot.trade_date);
});
test("fail closed on missing source, incorrect market balance, mixed dates and invalid deltas",()=>{
  for(const mutate of [
    x=>x.contract="MTX",x=>x.session="AFTER_HOURS",x=>x.net_change++,x=>x.net++,
    x=>x.observations[0].date=x.trade_date,x=>x.observations[1].market_open_interest++,
    x=>delete x.observations[0].institutional["投信"],x=>x.observations[1].evidence[0].url="https://example.com"
  ]){
    const bad=structuredClone(snapshot);mutate(bad);
    assert.equal(core.valid(bad,now),false);
    assert.equal(core.select(snapshot,bad,now),snapshot);
  }
  assert.equal(core.select(snapshot,null,now),snapshot);
  assert.equal(core.select(null,null,now),null);
});
test("net direction never controls movement color, zero is neutral",()=>{
  const x=structuredClone(snapshot),[prev,current]=x.observations;
  current.institutional["投信"]={long:current.net+1,short:0,net:-0};
  current.institutional["投信"].net=current.institutional["投信"].long;
  x.net=current.net=-1;x.net_change=current.net-prev.net;
  assert.match(core.view(x,now).value,/^−1 口$/);
  assert.equal(core.view(x,now).tone,"fall");
  const y=structuredClone(snapshot);
  const p=y.observations[0];
  p.institutional["投信"]={long:p.net-y.net+1,short:0,net:p.net-y.net+1};
  p.net=y.net-1;y.net_change=1;
  assert.equal(core.view(y,now).tone,"rise");
  assert.match(core.view(y,now).change,/▲ 較前交易日 \+1 口/);
  p.institutional["投信"].long--;p.institutional["投信"].net--;p.net++;y.net_change=0;
  assert.equal(core.view(y,now).tone,"flat");
  assert.match(core.view(y,now).change,/較前交易日 0 口/);
});
