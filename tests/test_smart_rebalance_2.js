const assert = require("node:assert/strict");
const core = require("../portfolio-core.js");

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`PASS ${name}\n`);
}

function fixture({cash = 0, targets = [50, 30, 20]} = {}) {
  const rows = [
    {code: "0050", marketValue: 60000, targetAllocation: targets[0], trend: "neutral"},
    {code: "00830", marketValue: 25000, targetAllocation: targets[1], trend: "neutral"},
    {code: "00935", marketValue: 15000, targetAllocation: targets[2], trend: "neutral"}
  ];
  const advice = core.calculateRebalanceAdvice({rows, cash, profile: "trend", cashFirst: true, trendProtection: true});
  const total = rows.reduce((sum, row) => sum + row.marketValue, 0);
  const viewRows = rows.map(row => ({code: row.code, weight: row.marketValue / total * 100, targetAllocation: row.targetAllocation}));
  return core.buildRebalanceReadout({rows: viewRows, advice});
}

test("Case A 超配顯示正差異", () => {
  const item = fixture().items.find(row => row.code === "0050");
  assert.equal(item.stateLabel, "超配");
  assert.equal(item.allocationGap, 10);
});

test("Case B 低配顯示負差異", () => {
  const item = fixture().items.find(row => row.code === "00935");
  assert.equal(item.stateLabel, "低配");
  assert.equal(item.allocationGap, -5);
});

test("Case C 接近目標沿用容忍區間", () => {
  const item = fixture().items.find(row => row.code === "00830");
  assert.equal(item.stateLabel, "接近目標");
  assert.equal(item.allocationGap, -5);
});

test("Case D 多檔低配依缺口排序", () => {
  assert.deepEqual(fixture().fundingPriority.map(row => row.code), ["00830", "00935"]);
});

test("Case E 目標改變會重算狀態與順序", () => {
  const result = fixture({targets: [40, 25, 35]});
  assert.equal(result.items.find(row => row.code === "00935").allocationGap, -20);
  assert.equal(result.fundingPriority[0].code, "00935");
});

test("Case F 零現金仍顯示下一筆新增資金方向", () => {
  const result = fixture({cash: 0});
  assert.ok(result.fundingPriority.length > 0);
  assert.match(result.recommendation, /下一筆新增資金/);
  assert.equal(result.fundingMode, "以新增資金再平衡");
});

process.stdout.write(`\n${passed} Smart Rebalance 2.0 tests passed.\n`);
