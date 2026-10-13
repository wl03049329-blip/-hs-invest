"use strict";
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const C=require('../radar-history-core'),S=require('../radar-history-source');
const root=path.resolve(__dirname,'..'),cutoff='2026-10-13';
const expected={"0050":5729,"00662":2517,"00757":1906,"00830":1813,"00935":715,"009815":171};
for(const [symbol,count] of Object.entries(expected)){
  const seedPath=path.join(root,'research/c4_historical/source',symbol+'.json');
  const seed=fs.existsSync(seedPath)?JSON.parse(fs.readFileSync(seedPath)).price:[];
  const archive=JSON.parse(fs.readFileSync(path.join(root,'data/radar-history',symbol==='009815'?'tpex':'twse',symbol+'.json')));
  const raw=[...seed,...archive.price],dates=[...new Set([...raw.map(r=>r.date),...(S.SUSPENSIONS[symbol]?.dates||[])])].filter(d=>d<=cutoff).sort();
  const normalized=C.prices(raw,symbol,dates,cutoff,'2026-10-13T16:00:00Z');
  assert.equal(normalized.invalid.length,0);assert.equal(normalized.rows.length,count);
  const axis=C.axis(dates,[],normalized.rows),range=C.range(axis,'ALL');
  assert.deepEqual(range,{from:0,to:axis.length-1});
  for(const actual of [range,{from:2.2737367544323206e-13,to:range.to},{from:0,to:range.to-2.2737367544323206e-13}]){
    const x=C.extrema(axis,[],normalized.rows,actual);
    assert.equal(x.sessions,axis.length,symbol+' full range must include both boundaries');
    assert.equal(x.priceCount,count,symbol+' visible candles must match verified bars');
  }
  const first=C.detail(axis[0],dates,[],normalized.rows,[]),last=C.detail(axis.at(-1),dates,[],normalized.rows,[]);
  assert.equal(first.price.time,normalized.rows[0].time);assert.equal(last.price.time,cutoff);
  for(const choice of ['10D','20D','60D','120D','1Y']){
    const r=C.range(axis,choice),x=C.extrema(axis,[],normalized.rows,r);
    assert.equal(r.to,axis.length-1);assert.equal(x.sessions,r.to-r.from+1);
    assert.equal(C.detail(axis[r.to],dates,[],normalized.rows,[]).price.time,cutoff);
  }
  console.log('PASS '+symbol+' raw/normalized/full-range/first/last/latest boundaries '+count);
}
const d=['2026-10-01','2026-10-02','2026-10-05'],p=d.map((time,i)=>({time,high:i+1,low:i+1}));
assert.equal(C.extrema(d,[],p,{from:0.00001,to:2}).sessions,2,'real fractional exclusion must remain');
assert.equal(C.extrema(d,[],p,{from:0,to:1.99999}).sessions,2,'real right exclusion must remain');
assert.equal(C.extrema(d,[],p,{from:-10,to:20}).sessions,3);
assert.equal(C.extrema(d,[],p,{from:4,to:5}).sessions,0);
assert.equal(C.extrema(d,[],p,{from:-5,to:-1}).sessions,0);
console.log('PASS fractional viewport exclusions and empty/outside ranges remain truthful');
