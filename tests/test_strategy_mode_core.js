const assert = require("assert");
const core = require("../strategy-mode-core.js");

assert.deepStrictEqual(core.LONG_TERM_WEIGHTS, {
  weeklyKdj:35, weeklyBias:25, drawdown:20, marketFear:10, valuation:10
});
assert.deepStrictEqual(core.SWING_WEIGHTS, {
  stopConfirmation:30, trendStrength:25, technicalLow:15, momentum:10,
  historicalStats:10, valuationBackground:5, marketLiquidity:5
});

const long = core.longTermDecision({
  j:-5, k:12, d:16, weeklyBias:-12, fromHigh:-34, valuation:82, marketFear:88, stopConfirmation:25
});
assert(long.score >= 70, "large drawdown and reasonable valuation must remain an add opportunity");
assert(["second","fear"].includes(long.stage.key));
assert.strictEqual(long.stage.stopAdjustment, true);
assert.strictEqual(long.stage.recommendation, "仍在下跌，採較小批次加碼。");

const swingBlocked = core.swingDecision({
  stopConfirmation:25, trendStrength:80, technicalLow:90, momentum:75,
  historicalStats:70, valuation:70, marketLiquidity:90,
  breakingLow:true, kdDown:true, aboveMa5:false, aboveMa10:false
});
assert(["wait","near"].includes(swingBlocked.stage.key));
assert(!["first","confirmed"].includes(swingBlocked.stage.key));

const swingConfirmed = core.swingDecision({
  stopConfirmation:90, trendStrength:90, technicalLow:72, momentum:88,
  historicalStats:75, valuation:65, marketLiquidity:90,
  breakingLow:false, kdDown:false, aboveMa5:true, aboveMa10:true, trendImproving:true
});
assert.strictEqual(swingConfirmed.stage.key, "confirmed");

const missingValuation = core.longTermDecision({
  j:5, k:15, d:18, weeklyBias:-8, fromHigh:-25, valuation:null, marketFear:75, stopConfirmation:45
});
assert(Number.isFinite(missingValuation.score));
assert(missingValuation.missing.includes("valuation"));
assert(missingValuation.coverage === 90);

assert(core.weeklyKdjFactor(-5,12,15)>core.weeklyKdjFactor(5,15,18));
assert(core.weeklyKdjFactor(5,15,18)>core.weeklyKdjFactor(15,22,24));
assert(core.weeklyKdjFactor(15,22,24)>core.weeklyKdjFactor(25,30,32));
const falling=core.longTermDecision({j:2,k:12,d:18,weeklyBias:-10,fromHigh:-22,valuation:60,marketFear:80,stopConfirmation:20});
const recovered=core.longTermDecision({j:2,k:12,d:18,weeklyBias:-10,fromHigh:-22,valuation:60,marketFear:80,stopConfirmation:80});
assert.strictEqual(falling.score,recovered.score,"止跌確認不可否決或改寫長期加碼分");
assert(falling.stage.batchScale<recovered.stage.batchScale,"止跌不足只下修投入批次");

console.log("PASS long-term and swing strategy rules");
