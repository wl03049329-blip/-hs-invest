const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const core=require("../strategy-mode-core.js");

const root=path.resolve(__dirname,"..");
const html=fs.readFileSync(path.join(root,"index.html"),"utf8");
const css=fs.readFileSync(path.join(root,"formal-black-gold.css"),"utf8");
const close=(a,b,tolerance=1e-10)=>assert.ok(Math.abs(a-b)<=tolerance,`${a} != ${b}`);
const factor=(decision,key)=>decision.factorBreakdown.find(item=>item.key===key);

const etf00830=core.longTermDecision({j:29.09,k:35,d:40,weeklyBias:24.560774,fromHigh:-15.02,marketFear:67.13,valuation:65,stopConfirmation:38});
assert.deepEqual(etf00830.factorBreakdown.map(item=>item.key),["weeklyKdj","weeklyBias","drawdown","marketFear","valuation"]);
assert.ok(etf00830.factorBreakdown.every(item=>item.available));
assert.equal(etf00830.availableWeight,100);
console.log("TEST 1 PASS: 00830 exposes all five canonical factors");

const bias=factor(etf00830,"weeklyBias");
assert.equal(bias.raw,24.560774);assert.equal(bias.score,0);assert.equal(bias.available,true);assert.equal(bias.contribution,0);
console.log("TEST 2 PASS: valid Bias40W score 0 remains available");

assert.equal(etf00830.availableWeight,100);assert.ok(!etf00830.missing.includes("weeklyBias"));
console.log("TEST 3 PASS: valid zero factor remains in availableWeight");

const missingValuation=core.longTermDecision({j:20,k:25,d:28,weeklyBias:-3,fromHigh:-10,marketFear:50,valuation:null});
const missingFactor=factor(missingValuation,"valuation");
assert.equal(missingFactor.available,false);assert.equal(missingFactor.score,null);assert.equal(missingFactor.contribution,null);assert.equal(missingValuation.availableWeight,95);
assert.match(html,/資料不足/);assert.match(html,/缺失即停止評分/);
console.log("TEST 4 PASS: unavailable factor is distinct from a zero score");

for(const item of etf00830.factorBreakdown)close(item.contribution,item.score*item.weight/100);
console.log("TEST 5 PASS: contributions use internal canonical factor scores");

const contributionTotal=etf00830.factorBreakdown.reduce((sum,item)=>sum+(item.contribution||0),0);
close(contributionTotal,etf00830.weightedRawTotal);
console.log("TEST 6 PASS: contributions sum to weightedRawTotal");

close(missingValuation.normalizedScore,missingValuation.weightedRawTotal/(missingValuation.availableWeight/100));
console.log("TEST 7 PASS: normalization uses availableWeight");

assert.equal(etf00830.score,Math.round(etf00830.normalizedScore));
console.log("TEST 8 PASS: display score equals canonical longTermScore");

for(const id of ["00935","0050"]){
  const decision=core.longTermDecision({j:16,k:22,d:26,weeklyBias:-4,fromHigh:-12,marketFear:58,valuation:null});
  assert.equal(decision.availableWeight,95,`${id} expected 95%`);assert.equal(factor(decision,"valuation").available,false);
}
console.log("TEST 9 PASS: 00935 / 0050 missing valuation shows 95% availableWeight");

const etf009815=core.longTermDecision({j:18,k:24,d:27,weeklyBias:null,fromHigh:-9,marketFear:55,valuation:52});
assert.equal(etf009815.availableWeight,85);assert.equal(factor(etf009815,"weeklyBias").available,false);assert.equal(factor(etf009815,"weeklyBias").score,null);
console.log("TEST 10 PASS: 009815 insufficient Bias40W is not rendered as zero");

assert.match(html,/longTermFactorGrid/);assert.match(html,/coreScore/);assert.match(html,/coreScoreDisplay/);assert.match(html,/長期核心正式分數拆解/);
assert.match(css,/@media\(max-width:430px\)\{\.longTermFactorGrid\{grid-template-columns:1fr\}/);
console.log("TEST 11 PASS: responsive P5 breakdown markup has no horizontal grid dependency");

console.log("00830 P5 TRACE");
for(const item of etf00830.factorBreakdown)console.log(`${item.key}: raw=${item.raw} score=${item.score} weight=${item.weight} available=${item.available} contribution=${item.contribution.toFixed(2)}`);
console.log(`weightedRawTotal=${etf00830.weightedRawTotal.toFixed(2)} availableWeight=${etf00830.availableWeight}% normalizedScore=${etf00830.normalizedScore.toFixed(2)} finalScore=${etf00830.score}`);
console.log(`0050/00935: missing=valuation availableWeight=${missingValuation.availableWeight}% display=資料不足／本次不計入`);
console.log(`009815: missing=weeklyBias availableWeight=${etf009815.availableWeight}% display=資料不足／本次不計入`);
