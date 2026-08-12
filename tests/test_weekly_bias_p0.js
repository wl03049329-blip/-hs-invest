const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const buyPoint = require("../buy-point-core.js");
const strategy = require("../strategy-mode-core.js");

const rows = [];
const start = new Date("2025-01-03T00:00:00Z");
for (let index = 0; index < 60; index += 1) {
  const date = new Date(start);
  date.setUTCDate(date.getUTCDate() + index * 7);
  const close = 80 + index * 0.7 + Math.sin(index / 3) * 2;
  rows.push({date:date.toISOString().slice(0, 10), open:close - 0.5, max:close + 1, min:close - 1, close, Trading_Volume:1000000 + index * 1000});
}

const features = buyPoint.buildWeeklyFeatures(rows);
const latest = features.at(-1);
const expectedMa40w = rows.slice(-40).reduce((sum, row) => sum + row.close, 0) / 40;
const expectedBias40w = (rows.at(-1).close / expectedMa40w - 1) * 100;
assert.ok(Math.abs(latest.ma40w - expectedMa40w) < 1e-10, "MA40W must use exactly 40 weekly closes");
assert.ok(Math.abs(latest.bias40w - expectedBias40w) < 1e-10, "Bias40W must use the current/latest weekly close");

const provisionalRows = rows.concat([
  {date:"2026-02-23", open:121, max:122, min:120, close:121, Trading_Volume:1100000},
  {date:"2026-02-25", open:122, max:124, min:121, close:123, Trading_Volume:1200000}
]);
const provisional = buyPoint.buildWeeklyFeatures(provisionalRows).at(-1);
const expectedProvisionalMa40w = buyPoint.weeklyKdj(provisionalRows).slice(-40).reduce((sum, week) => sum + week.close, 0) / 40;
assert.ok(Math.abs(provisional.price - 123) < 1e-10, "unfinished week must use the latest available price");
assert.ok(Math.abs(provisional.bias40w - (123 / expectedProvisionalMa40w - 1) * 100) < 1e-10, "unfinished-week Bias40W must use its latest provisional close");

const full = strategy.longTermDecision({j:latest.j, k:latest.k, d:latest.d, weeklyBias:latest.bias40w, fromHigh:-15.12, marketFear:66, valuation:65});
const biasFactor = full.breakdown.find(item => item.key === "weeklyBias");
assert.ok(biasFactor, "valid Bias40W must be in the factor list");
assert.equal(full.availableWeight, 100);
assert.equal(full.coverage, 100);
assert.equal(biasFactor.weight, 15);
assert.equal(biasFactor.value, strategy.weeklyBiasFactor(latest.bias40w));
assert.ok(Math.abs(biasFactor.contribution - biasFactor.value * 0.15) < 1e-10);
assert.equal(Math.round(full.breakdown.reduce((sum, item) => sum + item.contribution, 0)), full.score);

const zeroBias = strategy.longTermDecision({j:20, k:25, d:28, weeklyBias:0, fromHigh:-10, marketFear:50, valuation:50});
assert.equal(zeroBias.availableWeight, 100, "zero Bias40W is valid, not missing");
const missingBias = strategy.longTermDecision({j:20, k:25, d:28, weeklyBias:null, fromHigh:-10, marketFear:50, valuation:50});
assert.equal(missingBias.availableWeight, 85, "a genuinely missing Bias40W remains excluded dynamically");
const missingValuation = strategy.longTermDecision({j:20, k:25, d:28, weeklyBias:-3, fromHigh:-10, marketFear:50, valuation:null});
assert.equal(missingValuation.availableWeight, 95, "an unrelated missing factor remains excluded dynamically");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
assert.match(html, /weeklyBias:x\.weekBias/);
assert.match(html, /weekBias:Number\.isFinite\(x\.bias40w\)\?x\.bias40w:null/);
assert.match(html, /Bias40W \$\{fmt\(x\.weekBias\)\}%/);
assert.match(html, /貢獻 \+\$\{item\.contribution\.toFixed\(2\)\} 分/);
assert.doesNotMatch(html, /週乖離（約13週均線）/);

console.log("PASS P0 weekly Bias40W integration and dynamic weight regression");
