const assert = require("assert");
const core = require("../strategy-mode-core.js");

assert.deepStrictEqual(core.LONG_TERM_WEIGHTS, {
  drawdown:25, valuation:20, technicalLow:15, marketFear:15,
  longTermFundamental:10, historicalStats:10, stopConfirmation:5
});
assert.deepStrictEqual(core.SWING_WEIGHTS, {
  stopConfirmation:30, trendStrength:25, technicalLow:15, momentum:10,
  historicalStats:10, valuationBackground:5, marketLiquidity:5
});

const long = core.longTermDecision({
  fromHigh:-34, valuation:82, technicalLow:90, marketFear:88,
  longTermFundamental:75, historicalStats:72, stopConfirmation:25
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
  fromHigh:-25, valuation:null, technicalLow:80, marketFear:75,
  longTermFundamental:70, historicalStats:65, stopConfirmation:45
});
assert(Number.isFinite(missingValuation.score));
assert(missingValuation.missing.includes("valuation"));
assert(missingValuation.coverage === 80);

console.log("PASS long-term and swing strategy rules");
