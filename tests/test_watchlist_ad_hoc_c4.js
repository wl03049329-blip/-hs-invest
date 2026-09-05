"use strict";
const assert=require("node:assert/strict");
const crypto=require("node:crypto");
const fs=require("node:fs");
const path=require("node:path");
const root=path.resolve(__dirname,"..");
const core=require(path.join(root,"final-core-production.js"));
const buyPoint=require(path.join(root,"buy-point-core.js"));
const html=fs.readFileSync(path.join(root,"index.html"),"utf8");

function tradingRows(count=300){
  const rows=[];let date=new Date("2025-01-02T00:00:00Z");
  while(rows.length<count){
    if(date.getUTCDay()!==0&&date.getUTCDay()!==6){
      const index=rows.length,close=100+index*.06+Math.sin(index/9)*5;
      rows.push({date:date.toISOString().slice(0,10),open:close-.4,max:close+1,min:close-1,close,Trading_Volume:1000000+index});
    }
    date.setUTCDate(date.getUTCDate()+1);
  }
  return rows;
}
function metadata(code,name="Fixture ETF",officialType="國內成分證券指數股票型基金"){return{id:code,name,exchange:"TWSE",officialType,type:"ETF"}}
function input(ticker,rows=tradingRows()){
  const weekly=buyPoint.weeklyKdj(rows).at(-1),high52=Math.max(...rows.slice(-252).map(row=>row.max)),dd52=(rows.at(-1).close/high52-1)*100;
  return{ticker,metadata:metadata(ticker),j:weekly.j,k:weekly.k,d:weekly.d,dd52,rows,rowsAdjusted:true};
}
function hash(file){return crypto.createHash("sha256").update(fs.readFileSync(path.join(root,file))).digest("hex")}

const protectedFiles=[
  "finalized-core-score-snapshots-v1.json",
  "intraday-core-snapshots-v1.json",
  "research/forward-action-policy-v1/ledger.jsonl",
  "research/forward-action-policy-v1/meta.json",
  "research/personal-capital-forward-v1/personal-capital-forward-observations-v1.json"
];
const before=Object.fromEntries(protectedFiles.map(file=>[file,hash(file)]));

const eligibleInput=input("00830"),official=core.buildFinal(eligibleInput),adHoc=core.buildAdHocScore(eligibleInput);
assert.equal(adHoc.score,official.coreScore,"00830 raw score must be exactly equal");
assert.equal(adHoc.displayScore,official.coreScoreDisplay,"00830 display score must be exactly equal");
assert.deepEqual(adHoc.components,official.coreFactors,"all three canonical components must be exactly equal");

const nonEligible=core.buildAdHocScore(input("00878"));
assert.equal(nonEligible.available,true);assert.equal(nonEligible.mode,"AD_HOC");assert.equal(nonEligible.officialEligible,false);assert.equal(nonEligible.forwardEligible,false);

const commodityInput=input("00635U");commodityInput.metadata=metadata("00635U","期元大S&P黃金","ETF（ISIN CFI）");
const commodity=core.buildAdHocScore(commodityInput);
assert.equal(commodity.available,true);assert.equal(commodity.mode,"AD_HOC");assert.equal(commodity.officialEligible,false);

const waitNative=core.buildAdHocScore(input("009815"));
assert.equal(waitNative.available,true);assert.equal(waitNative.mode,"AD_HOC");assert.equal(waitNative.officialEligible,false);assert.equal(core.buildFinal(input("009815")).coreScore,null,"009815 official WAIT_NATIVE behavior remains unavailable");

const short=core.buildAdHocScore(input("00878",tradingRows(120)));
assert.equal(short.available,false);assert.equal(short.score,null);assert.equal(short.reason,"INSUFFICIENT_DAILY_HISTORY");
assert.equal(core.buildAdHocScore({ticker:"999999"}).available,false);
assert.equal(core.buildAdHocScore({...input("00878"),rowsAdjusted:false}).reason,"CANONICAL_INPUT_UNAVAILABLE");
assert.equal(core.buildAdHocScore({...input("00878"),j:null}).available,false,"missing component must fail closed");

assert.deepEqual(core.SUPPORTED_TICKERS,["0050","00662","00757","00830","00935"]);
assert.match(html,/const LONG_RADAR_SCORED_CODES=new Set\(\["0050","00662","00757","00830","00935"\]\)/);
assert.match(html,/id="watchAdHocForm"/);assert.match(html,/AD_HOC 自選試算/);assert.match(html,/資料來源：Provider EOD|<dd>Provider EOD<\/dd>/);
assert.match(html,/const WATCHLIST_STORAGE_KEY=HSStorage\.keys\.watchlist/);
assert.doesNotMatch(html,/adHoc[^\n]{0,80}appendForwardRecord|appendForwardRecord[^\n]{0,80}adHoc/i);

for(const file of protectedFiles)assert.equal(hash(file),before[file],`${file} must remain byte-identical`);
console.log("PASS AD_HOC C4 exact engine reuse, maturity, ETF metadata, WAIT_NATIVE, persistence and protected integrity guards");
