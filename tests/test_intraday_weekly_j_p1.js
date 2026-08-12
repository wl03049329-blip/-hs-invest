const assert=require("assert"),fs=require("fs"),path=require("path");
const buy=require("../buy-point-core.js"),intraday=require("../intraday-buy-point-core.js");
const symbols={"00830":[90,86.70,86.85],"00935":[58,56.95,57.30],"0050":[106,104.70,105.20],"00662":[124,122.05,122.30],"009815":[12,11.64,11.67]};
const dates=["2026-06-05","2026-06-12","2026-06-19","2026-06-26","2026-07-03","2026-07-10","2026-07-17","2026-07-24","2026-07-31","2026-08-07"];
function rows(base){
  const result=dates.map((date,index)=>{const close=base*(1.08-index*.012);return{date,open:close*1.002,max:close*1.018,min:close*.982,close,Trading_Volume:1e6+index*2e4}});
  result.push(
    {date:"2026-08-10",open:base*.975,max:base*.985,min:base*.958,close:base*.965,Trading_Volume:9e5},
    {date:"2026-08-11",open:base*.962,max:base*.970,min:base*.948,close:base*.955,Trading_Volume:95e4},
    {date:"2026-08-12",open:base,max:base*9,min:base*.1,close:base*1.5,Trading_Volume:99e6}
  );
  return result;
}
function quote(price,time,base,later){return{price,date:"2026-08-12",quoteTime:time,open:base*.968,high:Math.max(price,base*(later?.978:.972)),low:Math.min(price,base*(later?.942:.946)),volume:later?18e5:72e4}}
function trace(source,q){
  const provisional=intraday.buildProvisionalRows(source,q,"2026-08-11");assert.ok(provisional);
  const weekly=buy.weeklyKdj(provisional.rows),current=weekly.at(-1),window=weekly.slice(-9),highest=Math.max(...window.map(x=>x.high)),lowest=Math.min(...window.map(x=>x.low));
  return{asOf:provisional.asOf,finalizedThrough:provisional.finalizedThrough,latestPrice:q.price,weekOpen:current.open,weekHigh:current.high,weekLow:current.low,provisionalClose:current.close,rsv:(current.close-lowest)/(highest-lowest)*100,previousK:current.previousK,previousD:current.previousD,k:current.k,d:current.d,j:current.j,display:current.j.toFixed(2),rows:provisional.rows};
}
const output={};
for(const [symbol,[base,priceA,priceB]] of Object.entries(symbols)){
  const source=rows(base),original=JSON.stringify(source),a=trace(source,quote(priceA,"09:30:00",base,false)),b=trace(source,quote(priceB,"10:30:00",base,true));
  assert.notStrictEqual(a.asOf,b.asOf); // TEST 1
  assert.strictEqual(a.provisionalClose,priceA);assert.strictEqual(b.provisionalClose,priceB); // TEST 2
  assert.ok(a.weekHigh<base*2&&a.weekLow>base*.5); // TEST 3 and 9: later same-day row excluded
  assert.strictEqual(a.previousK,b.previousK);assert.strictEqual(a.previousD,b.previousD); // TEST 4
  assert.strictEqual(a.finalizedThrough,"2026-08-11");assert.strictEqual(b.finalizedThrough,"2026-08-11"); // TEST 5
  assert.notStrictEqual(a.j,b.j);assert.strictEqual(JSON.stringify(source),original); // TEST 7 and immutable finalized history
  output[symbol]={a:{price:a.latestPrice,j:a.j,display:a.display},b:{price:b.latestPrice,j:b.j,display:b.display}};
}
assert.strictEqual(Object.keys(output).length,5); // TEST 8
const baseRows=rows(100).filter(row=>row.date<"2026-08-12"),satA=trace(baseRows,{price:120,date:"2026-08-12",quoteTime:"09:30:00",open:110,high:120,low:108,volume:1000}),satB=trace(baseRows,{price:121,date:"2026-08-12",quoteTime:"10:30:00",open:110,high:121,low:108,volume:2000});
assert.strictEqual(satA.rsv,100);assert.strictEqual(satB.rsv,100);assert.strictEqual(satA.j,satB.j); // TEST 6
const fridayRows=rows(90).filter(row=>row.date<"2026-08-12"),friday={price:87,date:"2026-08-14",quoteTime:"13:30:00",open:87.2,high:88,low:85.5,volume:3e6};
const provisionalFriday=buy.weeklyKdj(intraday.buildProvisionalRows(fridayRows,friday,"2026-08-13").rows).at(-1),finalFriday=buy.weeklyKdj([...fridayRows,{date:"2026-08-14",open:87.2,max:88,min:85.5,close:87,Trading_Volume:3e6}]).at(-1);
assert.strictEqual(provisionalFriday.k,finalFriday.k);assert.strictEqual(provisionalFriday.d,finalFriday.d);assert.strictEqual(provisionalFriday.j,finalFriday.j); // TEST 10
assert.strictEqual(intraday.quoteAsOf({date:"2026-08-12",quoteTime:"09:30"}),"2026-08-12T09:30:00+08:00");
assert.strictEqual(intraday.isFreshIntradayQuote({date:"2026-08-12",quoteTime:"09:30:00"},new Date("2026-08-12T11:01:00+08:00"),90),false);
const html=fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8");
assert.match(html,/intradayLongRankAsOf\(longs\)/);assert.match(html,/item\.intraday\?\.asOf/);assert.match(html,/longRankSnapshot\(longs,saved,version,snapshotAsOf\)/);assert.match(html,/minute>=30&&minute<=49/);
console.log(JSON.stringify(output,null,2));
console.log("PASS P1 TEST 1-10; run P0 and V6 suites for TEST 11-12");
