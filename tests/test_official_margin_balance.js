'use strict';
const assert=require('node:assert/strict'),M=require('../official-margin-balance.js');
const H='a'.repeat(64);
const d=['2026-11-04','2026-11-05','2026-11-06'];
const tw=(date,amount_ntd)=>({date,amount_ntd,sha256:H});
const tp=(date,amount_ntd)=>({...tw(date,amount_ntd),board_sha256:H});
const sample={schema:'HS_OFFICIAL_MARGIN_BALANCE_V1',sessions:d,
  twse:[tw(d[0],596945870000),tw(d[1],576409039000),tw(d[2],580000000000)],
  tpex:[tp(d[0],190919219000),tp(d[2],184000000000)]};
const data=M.parse(sample,d[2]);
const combined=M.marketView(data,'combined',d[2],60);
assert.equal(combined.rows.length,2);
assert.equal(combined.rows[0].amount,787865089000);
assert.equal(combined.rows[1].amount,764000000000);
assert.equal(combined.rows[1].delta,null);
assert.equal(combined.plot[1].amount,null);
assert.equal(M.marketView(data,'twse',d[2]).rows[1].delta,-20536831000);
assert.equal(M.money(576409039000),'5,764.09');
assert.equal(M.change(-20536831000),'↓ −205.37');
assert.equal(M.marketView(data,'twse','2026-11-15').status,'stale');
assert.equal(M.marketView(M.parse({...sample,tpex:[]},d[2]),'combined',d[2]).status,'missing');
assert.equal(M.marketView(M.parse({...sample,tpex:sample.tpex.slice(0,1)},d[2]),'combined',d[2]).status,'waiting');
assert.equal(M.marketView(M.parse({...sample,source_status:{twse:'ready',tpex:'failed'}},d[2]),'combined',d[2]).status,'failed');
for(const bad of [
 {...sample,sessions:[d[1],d[0]]},
 {...sample,twse:[tw(d[0],596945870)]},
 {...sample,twse:[tw(d[0],0)]},
 {...sample,tpex:[tw(d[0],190919219000)]},
 {...sample,twse:[tw(d[0],1000),tw(d[0],1000)]},
])assert.throws(()=>M.parse(bad,d[2]));
assert.throws(()=>M.parse(sample,d[1]));
const actual=require('../official-margin-balance.json');
const newest=actual.sessions.at(-1);
const seed=M.parse(actual,newest);
assert.ok(seed.maps.twse.size&&seed.maps.tpex.size);
if(actual.sessions.includes('2026-11-05')){
  assert.equal(seed.maps.twse.get('2026-11-05'),576409039000);
  assert.equal(seed.maps.tpex.get('2026-11-05'),184037303000);
  assert.equal(M.marketView(seed,'combined','2026-11-05').rows.find(r=>r.date==='2026-11-05').amount,760446342000);
}
console.log('Official margin: schema, units, missing values, date alignment and amount fixture PASS');
