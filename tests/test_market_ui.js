const assert = require("node:assert/strict");
const guide = require("../market-ui-core.js");

const cases = [
  {j: 20, label: "等待", className: "neutral"},
  {j: 19.99, label: "加碼觀察", className: "yellow"},
  {j: 10, label: "加碼觀察", className: "yellow"},
  {j: 9.99, label: "更佳買點", className: "orange"},
  {j: 0, label: "更佳買點", className: "orange"},
  {j: -0.01, label: "強力超賣", className: "red"},
  {j: -10, label: "強力超賣", className: "red"},
  {j: -10.01, label: "極度超賣", className: "purple"}
];

for (const item of cases) {
  assert.deepEqual(guide.classifyJ(item.j), {label: item.label, className: item.className});
  process.stdout.write(`PASS J=${item.j} → ${item.label}／${item.className}\n`);
}

assert.equal(guide.turnText("下探"), "超賣但尚未止跌");
assert.equal(guide.turnText("回升"), "超賣後回升");
assert.doesNotMatch(JSON.stringify(cases), /必買/);
process.stdout.write("PASS 下探與回升說明不含必買暗示\n");
