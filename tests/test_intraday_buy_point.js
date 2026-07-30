const assert = require("assert");
const core = require("../intraday-buy-point-core.js");

const officialRows = [
  {date:"2026-07-28",close:100,max:103,min:98,Trading_Volume:1000000},
  {date:"2026-07-29",close:96,max:99,min:95,Trading_Volume:1500000}
];
const original = JSON.stringify(officialRows);

const priceOnly = core.buildProvisionalRows(officialRows, {
  price:98,
  date:"2026-07-30",
  quoteTime:"10:30:00"
}, "2026-07-29");
assert.ok(priceOnly);
assert.strictEqual(priceOnly.coverage, 70);
assert.strictEqual(priceOnly.hasHighLow, false);
assert.strictEqual(priceOnly.hasVolume, false);
assert.strictEqual(priceOnly.rows.at(-1).close, 98);
assert.strictEqual(priceOnly.rows.at(-1).Trading_Volume, null);
assert.strictEqual(JSON.stringify(officialRows), original, "formal OHLCV must not be mutated");

const fullQuote = core.buildProvisionalRows(officialRows, {
  price:98,
  high:100,
  low:94,
  volume:820000,
  date:"2026-07-30",
  quoteTime:"10:30:00"
}, "2026-07-29");
assert.strictEqual(fullQuote.coverage, 100);
assert.strictEqual(fullQuote.rows.at(-1).max, 100);
assert.strictEqual(fullQuote.rows.at(-1).min, 94);
assert.strictEqual(fullQuote.rows.at(-1).Trading_Volume, 820000);

const components = [
  ["j_rebound",16],["kd_turn",16],["ma5",12],["ma10",12],
  ["low_stable",16],["volume_contract",14],["momentum",14]
];
const formal = {components:components.map(([key,maximum])=>({key,maximum,points:maximum/2}))};
const provisional = {components:components.map(([key,maximum])=>({key,maximum,points:maximum}))};
const mergedPriceOnly = core.mergeStopConfirmation(formal, provisional, {
  hasHighLow:false,
  hasVolume:false,
  stopLabel:score=>String(score)
});
assert.strictEqual(mergedPriceOnly.intradayCoverage, 70);
assert.strictEqual(
  mergedPriceOnly.components.find(item=>item.key==="low_stable").points,
  8,
  "missing intraday low must preserve formal component"
);
assert.strictEqual(
  mergedPriceOnly.components.find(item=>item.key==="volume_contract").points,
  7,
  "missing intraday volume must preserve formal component"
);
assert.strictEqual(core.scoreDelta(55,52), 3);
assert.strictEqual(core.scoreDelta(null,52), null);

console.log("PASS intraday provisional OHLCV coverage, formal preservation and score delta");
