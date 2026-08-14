const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const buy=require("../buy-point-core.js");
const intraday=require("../intraday-buy-point-core.js");
const core=require("../final-core-production.js");
const strategy=require("../strategy-mode-core.js");

function tradingRows(base=100){
  const rows=[];
  for(let cursor=new Date("2025-07-01T00:00:00Z"),i=0;cursor<=new Date("2026-08-13T00:00:00Z");cursor.setUTCDate(cursor.getUTCDate()+1)){
    if([0,6].includes(cursor.getUTCDay()))continue;
    const close=base*(.82+i*.00072+Math.sin(i/11)*.025);
    rows.push({date:cursor.toISOString().slice(0,10),open:close*.996,max:close*1.012,min:close*.988,close,Trading_Volume:900000+i*1200});
    i++;
  }
  return rows;
}

function quote(price,time,{high,low}={}){
  return{price,date:"2026-08-14",quoteTime:`${time}:00`,open:101,high:high??Math.max(102,price),low:low??Math.min(99,price),volume:1200000};
}

function snapshot(symbol,rows,q,slot,calculatedAt){
  const provisional=intraday.buildProvisionalRows(rows,q,rows.at(-1).date);
  assert.ok(provisional,"provisional rows must be created");
  const feature=buy.buildWeeklyFeatures(provisional.rows,"LONG_TERM_ETF").at(-1);
  assert.ok(feature,"weekly features must exist");
  const high52=Math.max(...provisional.rows.slice(-252).map(row=>Number(row.max??row.close)).filter(Number.isFinite));
  const dd52=(q.price/high52-1)*100;
  const input={ticker:symbol,j:feature.j,k:feature.k,d:feature.d,dd52,rows:provisional.rows,weeklyBias:feature.bias40w,marketFear:61,valuation:null,marketAsOf:provisional.asOf};
  const decision=core.buildDecision(input,null,core.LONG_TERM_CORE_SCORE_VERSION);
  const audit=intraday.buildCoreAudit({symbol,snapshotSlot:slot,tradingDate:q.date,price:q.price,priceAsOf:provisional.asOf,weeklyJRaw:feature.j,bias40wRaw:feature.bias40w,bias40wScore:strategy.weeklyBiasFactor(feature.bias40w),drawdown52wRaw:dd52,decision,calculatedAt,dataAsOf:provisional.asOf,status:"SUCCESS"});
  return{provisional,feature,decision,audit};
}

const rows00830=tradingRows(100);
const s0930=snapshot("00830",rows00830,quote(100,"09:30"),"09:30","2026-08-14T01:31:00.000Z");
const s1030=snapshot("00830",rows00830,quote(95,"10:30",{high:102,low:94}),"10:30","2026-08-14T02:31:00.000Z");
assert.equal(s0930.provisional.rows.at(-1).close,100);
assert.equal(s1030.provisional.rows.at(-1).close,95);
assert.notEqual(s0930.feature.j,s1030.feature.j);
assert.notEqual(s0930.feature.bias40w,s1030.feature.bias40w);
assert.notEqual(s0930.audit.drawdown_52w_raw,s1030.audit.drawdown_52w_raw);
assert.notEqual(s0930.decision.coreScore,s1030.decision.coreScore);
const peer0930=snapshot("0050",tradingRows(106),quote(104,"09:30"),"09:30","2026-08-14T01:31:00.000Z");
const peer1030=snapshot("0050",tradingRows(106),quote(103,"10:30"),"10:30","2026-08-14T02:31:00.000Z");
const rank=items=>items.sort((a,b)=>core.compare({ticker:a.audit.symbol,coreScore:a.decision.coreScore},{ticker:b.audit.symbol,coreScore:b.decision.coreScore})).map((item,index)=>({...item,rank:index+1}));
const ranked0930=rank([s0930,peer0930]),ranked1030=rank([s1030,peer1030]);
assert.deepEqual(ranked0930.map(item=>item.rank),[1,2]);
assert.deepEqual(ranked1030.map(item=>item.rank),[1,2]);
console.log("Test 1 PASS: price → provisional week → J/Bias40W/DD52 → formal Core Engine → ranking reruns");

let sameDisplay=null;
for(let price=99.99;price>=99.5&&!sameDisplay;price-=.01){
  const current=snapshot("00830",rows00830,quote(Number(price.toFixed(2)),"10:30"),"10:30",`2026-08-14T02:31:${String(Math.round((100-price)*10)).padStart(2,"0")}.000Z`);
  if(current.feature.j!==s0930.feature.j&&current.decision.coreScoreDisplay===s0930.decision.coreScoreDisplay)sameDisplay=current;
}
assert.ok(sameDisplay,"fixture must find changed raw J in the same display-score bucket");
assert.notEqual(sameDisplay.audit.weekly_j_raw,s0930.audit.weekly_j_raw);
assert.equal(sameDisplay.decision.coreScoreDisplay,s0930.decision.coreScoreDisplay);
assert.notEqual(sameDisplay.audit.data_as_of,s0930.audit.data_as_of);
assert.notEqual(sameDisplay.audit.calculated_at,s0930.audit.calculated_at);
console.log("Test 2 PASS: changed raw feature and as-of can legitimately keep the same displayed score");

const withFuture=[...rows00830,{date:"2026-08-15",open:1,max:999,min:1,close:999,Trading_Volume:1}];
const noLookAhead=snapshot("00830",withFuture,quote(97,"10:30",{high:101,low:96}),"10:30","2026-08-14T02:31:00.000Z");
assert.equal(noLookAhead.provisional.rows.at(-1).date,"2026-08-14");
assert.ok(!noLookAhead.provisional.rows.some(row=>row.date>"2026-08-14"));
assert.ok(noLookAhead.audit.drawdown_52w_raw>-100,"future high must not contaminate current DD52");
console.log("Test 3 PASS: no look-ahead data enters the 10:30 snapshot");

const successfulEntries=[s0930,peer0930].map(item=>({symbol:item.audit.symbol,audit:item.audit}));
assert.equal(intraday.validateCoreBatch(successfulEntries,["0050","00830"],"2026-08-14","09:30").status,"SUCCESS");
const previousSuccessful=JSON.stringify(successfulEntries);
const failed=intraday.validateCoreBatch(successfulEntries.slice(0,1),["0050","00830"],"2026-08-14","10:30");
assert.equal(failed.status,"UPDATE_FAILED");
assert.equal(JSON.stringify(successfulEntries),previousSuccessful,"failed batch must not mutate the previous successful snapshot");
console.log("Test 4 PASS: failed computation remains stale and cannot create a fake later snapshot");

const parityInput={ticker:"00830",j:s1030.feature.j,k:s1030.feature.k,d:s1030.feature.d,dd52:s1030.audit.drawdown_52w_raw,rows:s1030.provisional.rows,weeklyBias:s1030.feature.bias40w,marketFear:61,valuation:null,marketAsOf:s1030.audit.data_as_of};
const intradayDecision=core.buildDecision(parityInput,null,core.LONG_TERM_CORE_SCORE_VERSION);
const formalDecision=core.buildDecision({...parityInput},null,core.LONG_TERM_CORE_SCORE_VERSION);
assert.deepEqual(intradayDecision.coreFactors,formalDecision.coreFactors);
assert.equal(intradayDecision.coreScore,formalDecision.coreScore);
const html=fs.readFileSync(path.resolve(__dirname,"..","index.html"),"utf8");
const intradayBlock=html.slice(html.indexOf("function applyIntradayEstimate"),html.indexOf("function cloneIntradayCandidate"));
assert.match(html,/refreshDecisionModel\(x\);[\s\S]{0,300}strategyDecisionFor\(x,"long_term_core"\)/);
assert.match(html,/HSFinalCoreProduction\.buildDecision\(/);
assert.doesNotMatch(html,/calculateIntradayScore|intradayScoreEngine/);
assert.doesNotMatch(intradayBlock,/calcBuyScore|LONG_TERM_WEIGHTS|weightedScore/);
console.log("Test 5 PASS: intraday and formal paths use the same latest HS Core Score Engine");

console.log("00830 09:30 AUDIT",JSON.stringify({...s0930.audit,rank:ranked0930.find(item=>item.audit.symbol==="00830").rank}));
console.log("00830 10:30 AUDIT",JSON.stringify({...s1030.audit,rank:ranked1030.find(item=>item.audit.symbol==="00830").rank}));
