"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const core=require("../final-core-production.js"),canonical=require("../backtest/long-term/final-core-score-v1.js"),buy=require("../buy-point-core.js"),intraday=require("../intraday-buy-point-core.js"),drawdown=require("../drawdown-price-core.js");
const root=path.resolve(__dirname,".."),html=fs.readFileSync(path.join(root,"index.html"),"utf8"),quotes=fs.readFileSync(path.join(root,"scripts","update_market_quotes.py"),"utf8"),report=JSON.parse(fs.readFileSync(path.join(root,"backtest","long-term","output","phase7b_00757","phase7b_00757_complete_report.json"),"utf8"));
let passed=0;function test(name,fn){fn();passed+=1;console.log(`PASS ${passed}: ${name}`)}
const fixture={ticker:"00757",j:-2,k:18,d:19,dd52:-18,crashRaw:-12,marketAsOf:"2026-08-13T13:30:00+08:00"},result=core.buildFinal(fixture);

test("00757 strategyType is LONG_TERM_ETF and mode is shared long_term_core",()=>{assert.match(html,/id:"00757"[^\n]+strategyType:"LONG_TERM_ETF"[^\n]+strategyMode:"long_term_core"/);assert.doesNotMatch(html,/x\.id==="00757"/)});
test("00757 uses FINAL_CORE_WEIGHT_V1",()=>{assert.ok(core.SUPPORTED_TICKERS.includes("00757"));assert.equal(result.coreScoreVersion,"FINAL_CORE_WEIGHT_V1")});
test("00757 J weight is 30",()=>assert.equal(result.coreFactors.weeklyJ.weight,30));
test("00757 DD52 weight is 55",()=>assert.equal(result.coreFactors.dd52.weight,55));
test("00757 Crash weight is 15",()=>assert.equal(result.coreFactors.crash.weight,15));
test("auxiliary factors do not affect CoreScore",()=>assert.equal(core.buildFinal({...fixture,weeklyBias:99,marketFear:0,valuation:100}).coreScore,result.coreScore));
test("missing any core factor is N/A",()=>{assert.equal(core.buildFinal({...fixture,j:null}).coreScore,null);assert.equal(core.buildFinal({...fixture,dd52:null}).coreScore,null);assert.equal(core.buildFinal({...fixture,crashRaw:null,rows:[]}).coreScore,null)});
test("no renormalization",()=>{const missing=core.buildFinal({...fixture,dd52:null});assert.equal(missing.coreScoreDisplay,null);assert.equal(missing.dataStatus,"FAIL_CLOSED")});
test("ranking uses exact CoreScore",()=>assert.ok(core.compare({ticker:"00757",coreScore:70.1},{ticker:"0050",coreScore:69.9})<0));
test("historical trigger mapping exact",()=>assert.deepEqual([30,40,45,50,65,70,80,90].map(score=>core.labelFor(score).triggerRate),[22.1,14.8,11.6,9,3.6,2.8,1.3,.3]));
test("score labels exact",()=>assert.deepEqual([0,30,40,45,50,65,70,80,90].map(score=>core.labelFor(score).label),["一般持有","回檔訊號出現","加碼條件浮現","試探加碼","正式加碼訊號","積極加碼訊號","強力加碼訊號","重大加碼機會","歷史極端機會"]));
test("intraday Weekly J updates from latest 00757 snapshot",()=>{const rows=[];for(let i=0;i<70;i++){const date=new Date(Date.UTC(2026,4,1+i));if([0,6].includes(date.getUTCDay()))continue;const close=100-i*.15;rows.push({date:date.toISOString().slice(0,10),open:close,max:close+1,min:close-1,close,Trading_Volume:1000})}const formal=buy.weeklyKdj(rows).at(-1),date="2026-07-13",a=intraday.buildProvisionalRows(rows,{price:87,date,quoteTime:"09:30:00",open:88,high:89,low:86,volume:1000},rows.at(-1).date),b=intraday.buildProvisionalRows(rows,{price:90,date,quoteTime:"10:30:00",open:88,high:91,low:86,volume:2000},rows.at(-1).date);assert.ok(a&&b);assert.notEqual(buy.weeklyKdj(a.rows).at(-1).j,buy.weeklyKdj(b.rows).at(-1).j);assert.equal(formal.date,rows.at(-1).date);assert.match(quotes,/RADAR_CODES = \([^\n]*"00757"/)});
test("DD52 uses adjusted intraday High",()=>{const rows=Array.from({length:252},(_,i)=>({date:new Date(Date.UTC(2025,0,1+i)).toISOString().slice(0,10),high:i===100?150:110,close:100}));const stats=drawdown.priceStats(rows,100);assert.equal(stats.high52,150);assert.equal(drawdown.drawdownPercent(100,stats.high52),-100/3)});
test("schema finite and 009815 remains N/A",()=>{for(const key of ["coreScore","coreScoreDisplay","historicalTriggerRate"])assert.ok(result[key]===null||Number.isFinite(result[key]));assert.equal(result.coreLabel,result.label);assert.equal(result.dataStatus,"ETF_NATIVE_HISTORY");assert.equal(result.marketAsOf,fixture.marketAsOf);assert.equal(core.buildFinal({...fixture,ticker:"009815"}).coreScore,null);assert.equal(report.current.dataStatus,"ETF_NATIVE_HISTORY")});
test("homepage/radar mobile structure includes 00757 without fixed ordering",()=>{assert.match(html,/LONG_RADAR_CODES=new Set\(\[[^\]]*"00757"/);assert.match(html,/const longIds=new Set\(\[[^\]]*"00757"/);assert.match(html,/sort\(longRankComparator\)/);assert.match(html,/radarOverviewLong/);assert.match(html,/radarLongCard/)});
assert.deepEqual(canonical.WEIGHTS,{weeklyJ:30,dd52:55,crash:15});
console.log(`Phase 7B 00757: ${passed}/15 PASS`);
