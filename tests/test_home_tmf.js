"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),vm=require("node:vm");
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
function colorFixture(previous,net){
  const x=structuredClone(snapshot),[prev,current]=x.observations;
  for(const [row,value] of [[prev,previous],[current,net]]){
    // Synthetic tiny positions preserve the real report dates and market totals.
    // No expectation depends on the latest published net or its direction.
    row.net=value;
    for(const key of Object.keys(row.institutional))row.institutional[key]={long:0,short:0,net:0};
    row.institutional["投信"]={long:Math.max(0,-value),short:Math.max(0,value),net:-value};
  }
  x.net=net;x.net_change=net-previous;
  assert.equal(core.valid(x,now),true);
  return x;
}
const positions=[[-1,"fall","−1 口"],[0,"flat","0 口"],[1,"rise","+1 口"]];
const movements=[[-1,"fall","▼ 較前交易日 −1 口"],[0,"flat","較前交易日 0 口"],[1,"rise","▲ 較前交易日 +1 口"]];
test("movement color, arrow and sign follow only the delta across all position signs",()=>{
  for(const [net,,label] of positions)for(const [delta,tone,change] of movements){
    const x=colorFixture(net-delta,net),view=core.view(x,now);
    assert.deepEqual(view,{value:label,change,tone,date:x.trade_date});
  }
});
test("homepage renders net and movement colors independently",async()=>{
  const source=fs.readFileSync(require.resolve("../home-taiex-display"),"utf8");
  for(const [net,positionTone,label] of positions)for(const [delta,deltaTone,change] of movements){
    const x=colorFixture(net-delta,net),nodes=Object.fromEntries(["b","strong","time","[data-taiex-state],[data-tmf-state]"].map(k=>[k,{dataset:{}}]));
    const card={querySelector:k=>nodes[k],setAttribute(){}};
    const context={window:{HSHomeTmf:{...core,valid:v=>core.valid(v,now),select:(a,b)=>core.select(a,b,now),view:v=>core.view(v,now)}},
      document:{getElementById:id=>id==="homeTmfRatioCard"?card:null,addEventListener(){}},
      localStorage:{getItem:()=>null,setItem(){},removeItem(){}},addEventListener(){},setInterval(){},setTimeout,clearTimeout,AbortController,
      fetch:async()=>({ok:true,json:async()=>x})};
    vm.runInNewContext(source,context);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(nodes.b.textContent,label);
    assert.equal(nodes.b.dataset.homeTone,positionTone);
    assert.equal(nodes.strong.textContent,change);
    assert.equal(nodes.strong.dataset.homeTone,deltaTone);
  }
});
test("settlement exclusion retains and reconciles official market total",()=>{
  // Build a raw, six-contract fixture even when the freshly fetched report
  // has already removed the expiring contract or rolled into a new month.
  const x=colorFixture(0,0), o=x.observations[1];
  const [year, monthNumber]=x.trade_date.split("-").map(Number);
  const month=x.trade_date.slice(0,7).replace("-","");
  o.months=Object.fromEntries(Array.from({length:6},(_,i)=>[
    new Date(Date.UTC(year,monthNumber-1+i,1)).toISOString().slice(0,7).replace("-",""),
    100+i
  ]));
  delete o.excluded_expiry;
  o.market_open_interest=Object.values(o.months).reduce((total,n)=>total+n,0);
  assert.equal(core.valid(x,now),true,"ordinary six-contract report");
  const n=o.months[month];
  delete o.months[month];
  o.excluded_expiry={month,open_interest:n,raw_total:o.market_open_interest};
  o.market_open_interest-=n;
  assert.equal(core.valid(x,now),true,"settlement report excluding exactly one contract");
  for(const mutate of [
    row=>row.excluded_expiry.raw_total++,
    row=>row.excluded_expiry.open_interest++,
    row=>row.market_open_interest++,
    row=>row.months[month]=n
  ]){
    const bad=structuredClone(x);mutate(bad.observations[1]);
    assert.equal(core.valid(bad,now),false);
  }
});
