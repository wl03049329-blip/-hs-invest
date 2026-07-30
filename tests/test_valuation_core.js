const assert = require("assert");
const core = require("../valuation-core.js");

const technical = core.technicalLowScore({
  j:-8,
  jPercentile:7,
  fromHigh:-24,
  drawdownPercentile:91,
  price:76,
  ma60:88,
  ma200:95,
  stopConfirmation:100
});
assert.ok(technical.score >= 0 && technical.score <= 100);
assert.strictEqual(technical.coverage, 100);
assert.deepStrictEqual(
  technical.components.map(item => item.key),
  ["jLevel","jHistory","drawdown","drawdownHistory","belowMa60","belowMa200"]
);
assert.ok(!technical.components.some(item => item.key.includes("stop")), "technical low must not double-count stop confirmation");

const missingHistory = core.technicalLowScore({j:5, fromHigh:-12, price:90, ma60:95, ma200:100});
assert.ok(Number.isFinite(missingHistory.score));
assert.strictEqual(missingHistory.coverage, 60);

const valuation = core.valuationScore({
  currentPe:51.891877,
  forwardPe:29.070746,
  pb:13.62833,
  earningsGrowth:78.502,
  peg:.661,
  pePercentile:null,
  forwardPePercentile:null
});
assert.ok(valuation.score >= 0 && valuation.score <= 100);
assert.strictEqual(valuation.coverage, 75);

const invalidPe = core.valuationScore({
  currentPe:-10,
  forwardPe:0,
  pb:null,
  earningsGrowth:null,
  peg:null
});
assert.strictEqual(invalidPe.score, null);
assert.strictEqual(invalidPe.coverage, 0);

const validated = core.validateValuationItem({
  benchmark:"PHLX Semiconductor Sector Index",
  primary_proxy:"SOXQ",
  secondary_proxy:"SOXX",
  current_pe:51.89,
  forward_pe:null,
  pb:13.6,
  earnings_growth:null,
  peg:null,
  valuation_score:48,
  history_sample_count:1,
  history_status:"building",
  source_name:"Invesco public fund characteristics JSON",
  source_url:"https://example.com/data",
  source_date:new Date().toISOString().slice(0,10),
  is_proxy:true,
  proxy_note:"SOXX tracks a different index."
});
assert.ok(validated);
assert.strictEqual(validated.forwardPe, null, "missing forward P/E must remain null");
assert.strictEqual(validated.historySampleCount, 1);

console.log("PASS technical-low layers, valuation missing-data rules and proxy validation");
