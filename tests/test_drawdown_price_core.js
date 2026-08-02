const assert = require("assert");
const core = require("../drawdown-price-core.js");

assert.strictEqual(core.targetPrice(100, 5), 95);
assert(Math.abs(core.targetPrice(100, 70) - 30) < 1e-9);
assert.strictEqual(core.targets(70).find(row => row.level === 15).price, 59.5);
assert.strictEqual(core.labelFor(-3), "高檔附近");
assert.strictEqual(core.labelFor(-11.43), "修正區");
assert.strictEqual(core.labelFor(-20, "security"), "進入技術性熊市幅度");
assert.strictEqual(core.labelFor(-20, "index"), "技術性熊市");
assert.strictEqual(core.labelFor(-50), "腰斬區");
assert.strictEqual(core.currentLevel(-24.2), 20);
assert.strictEqual(core.nextLevel(-24.2), 25);

const rows = Array.from({length:300}, (_, index) => ({
  date:`2025-${String(Math.floor(index / 28) % 12 + 1).padStart(2,"0")}-${String(index % 28 + 1).padStart(2,"0")}`,
  max:index === 12 ? 150 : index === 280 ? 120 : 100,
  close:90
}));
const stats = core.priceStats(rows, 80);
assert.strictEqual(stats.allTimeHigh, 150);
assert.strictEqual(stats.high52, 120);
assert.strictEqual(stats.price, 80);
assert(Number.isFinite(core.drawdownPercent(stats.price, stats.high52)));
for (const value of Object.values(stats).filter(value => typeof value === "number")) assert(Number.isFinite(value));

console.log("PASS drawdown levels, labels and formal high statistics");
