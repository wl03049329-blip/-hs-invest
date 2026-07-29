const assert = require("assert");
const core = require("../etf-model-core.js");

const sumWeights = config => Object.values(config.weights).reduce((sum, weight) => sum + weight, 0);
for (const [category, config] of Object.entries(core.ETF_MODEL_CONFIG)) {
  if (category !== "other") assert.strictEqual(sumWeights(config), 100, `${category} weights`);
}

assert.deepStrictEqual(core.ETF_MODEL_CONFIG.equity_broad.weights, {
  pricePosition:10, oversold:10, stopConfirmation:25, longTrend:20,
  historicalStats:20, marketSentiment:10, liquidity:5
});
assert.deepStrictEqual(core.ETF_MODEL_CONFIG.bond_government_long.weights, {
  rateTrend:25, durationFit:15, longTrend:20, oversold:10,
  stopConfirmation:15, historicalStats:10, liquidity:5
});
assert.deepStrictEqual(core.ETF_MODEL_CONFIG.bond_investment_grade.weights, {
  rateTrend:15, creditSpread:25, longTrend:20, oversold:10,
  stopConfirmation:15, historicalStats:10, liquidity:5
});
assert.notDeepStrictEqual(
  core.ETF_MODEL_CONFIG.equity_broad.weights,
  core.ETF_MODEL_CONFIG.leveraged.weights,
  "leveraged model must differ from equity"
);
assert.strictEqual(core.ETF_MODEL_CONFIG.active_bond.family, "active_bond");

const equityMetrics = {
  pricePosition:80, oversold:90, stopConfirmation:70, longTrend:65,
  historicalStats:60, marketSentiment:55, liquidity:100
};
const equity = core.scoreModel("equity_broad", equityMetrics, "high");
assert.strictEqual(equity.status, "available");
assert.ok(equity.score >= 0 && equity.score <= 100);
assert.strictEqual(equity.coverage, 100);

const government = core.scoreModel("bond_government_long", {
  durationFit:50, longTrend:70, oversold:80, stopConfirmation:60, historicalStats:55, liquidity:100
}, "high");
assert.strictEqual(government.coverage, 75);
assert.strictEqual(government.status, "available");
assert.ok(government.missing.includes("rateTrend"));

const credit = core.scoreModel("bond_investment_grade", {
  longTrend:70, oversold:80, stopConfirmation:60, historicalStats:55, liquidity:100
}, "high");
assert.strictEqual(credit.coverage, 60);
assert.strictEqual(credit.score, null);
assert.strictEqual(credit.status, "insufficient");

const lowConfidence = core.scoreModel("equity_broad", equityMetrics, "low");
assert.strictEqual(lowConfidence.score, null);
assert.match(lowConfidence.message, /類型待確認/);

const items = [
  {id:"A",score:80,strategyCategory:"equity_broad"},
  {id:"B",score:60,strategyCategory:"equity_broad"},
  {id:"C",score:90,strategyCategory:"leveraged"},
  {id:"D",score:null,strategyCategory:"equity_broad"}
];
core.applyTypePercentiles(items);
assert.strictEqual(items[0].sameTypeRank, 1);
assert.strictEqual(items[0].sameTypeTopPercent, 50);
assert.strictEqual(items[1].sameTypeRank, 2);
assert.strictEqual(items[2].sameTypeRank, 1);
assert.strictEqual(items[3].sameTypeRank, undefined);

console.log("PASS ETF asset-model weights, normalization, missing-data gate and type percentiles");
