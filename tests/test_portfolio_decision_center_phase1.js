const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const core = require("../portfolio-core.js");
const finalCore = require("../final-core-production.js");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const ui = fs.readFileSync(path.join(root, "portfolio-v6.js"), "utf8");
const css = fs.readFileSync(path.join(root, "portfolio-v6.css"), "utf8");

const holding = (code, shares, averageCost, targetAllocation) => ({code, shares, averageCost, targetAllocation});
const quote = (price, previousClose) => ({price, previousClose, name: "測試標的", date: new Date().toISOString().slice(0, 10), quoteTime: "13:25:00", fetchedAt: new Date().toISOString()});

const portfolio = core.calculatePortfolio([
  holding("0050", 100, 50, 40),
  holding("00830", 200, 80, 60)
], new Map([
  ["0050", quote(100, 98)],
  ["00830", quote(90, 89)]
]));

assert.equal(portfolio.totalMarketValue, 28000, "total market value reuses existing portfolio calculation");
assert.equal(portfolio.totalPnl, 7000, "unrealized P/L remains market value minus cost");
assert.equal(Number(portfolio.rows.reduce((sum, row) => sum + row.weight, 0).toFixed(6)), 100, "allocation sums to 100%");
assert.equal(Number((portfolio.rows[0].weight - portfolio.rows[0].targetAllocation).toFixed(2)), -4.29, "allocation delta is a percentage-point difference");

assert.equal(core.allocationHealthScore([{weight: 40, targetAllocation: 40}, {weight: 60, targetAllocation: 60}]), 100);
assert.equal(core.allocationHealthScore([{weight: 30, targetAllocation: 40}, {weight: 70, targetAllocation: 60}]), 90);
assert.equal(core.allocationHealthScore([{weight: 50, targetAllocation: null}]), null, "missing targets fail gracefully");

const attention = core.buildPortfolioAttention([
  {code: "0050", name: "元大台灣50", weight: 35, targetAllocation: 40, coreScore: 53, coreLabel: finalCore.labelFor(53).label},
  {code: "00662", name: "富邦NASDAQ", weight: 15, targetAllocation: 20, coreScore: 20, coreLabel: finalCore.labelFor(20).label},
  {code: "00830", name: "國泰費城半導體", weight: 25, targetAllocation: 20, coreScore: 48, coreLabel: finalCore.labelFor(48).label}
]);
assert.deepEqual(attention.map(row => row.code), ["0050", "00662", "00830"], "attention sorting is deterministic");
assert.deepEqual(attention.map(row => row.priority), [1, 2, 3]);
assert.equal(attention[0].coreLabel, "正式加碼訊號", "Core Score wording comes from the formal mapping");

const sorted = core.sortPortfolioRows([
  {code: "0050", marketValue: 10000, weight: 40, totalPnl: 500, coreScore: 35},
  {code: "00830", marketValue: 20000, weight: 60, totalPnl: -100, coreScore: 50}
]);
assert.deepEqual(sorted.map(row => row.code), ["00830", "0050"], "default sort is market value descending");
assert.deepEqual(core.sortPortfolioRows(sorted, "totalPnl").map(row => row.code), ["0050", "00830"]);
assert.deepEqual(core.sortPortfolioRows(sorted, "coreScore").map(row => row.code), ["00830", "0050"]);
assert.deepEqual(core.sortPortfolioRows([], "marketValue"), [], "empty portfolio never crashes");

const portfolioStart = html.indexOf('<section id="portfolio"');
const portfolioEnd = html.indexOf('<section id="sentiment"', portfolioStart);
const section = html.slice(portfolioStart, portfolioEnd);
for (const id of ["portfolioHeroTodayPnl", "portfolioHeroUnrealizedPnl", "portfolioHeroMarketValue", "portfolioSummary", "portfolioAllocationHealth", "portfolioAttentionList", "portfolioList", "rebalanceTitle", "portfolioExportBtn"]) {
  assert.match(section, new RegExp(`id="${id}"`));
}
assert.ok(section.indexOf("portfolioDecisionHero") < section.indexOf("allocationPanel"));
assert.ok(section.indexOf("allocationPanel") < section.indexOf("portfolioAttentionPanel"));
assert.ok(section.indexOf("portfolioAttentionPanel") < section.indexOf("portfolioHoldingsSection"));
assert.ok(section.indexOf("portfolioHoldingsSection") < section.indexOf("portfolioCapitalPlan"));
assert.ok(section.indexOf("portfolioCapitalPlan") < section.indexOf("rebalancePanel"));
assert.ok(section.indexOf("rebalancePanel") < section.indexOf("portfolioSettings"));
assert.match(section, /<option value="todayPnl">今日損益<\/option>/);
assert.match(section, /<option value="twentyDay">20D<\/option>/);
assert.match(section, /<option value="ytd">YTD<\/option>/);

assert.match(ui, /window\.HSFinalCoreProduction\?\.labelFor/);
assert.doesNotMatch(ui, /score\s*>=\s*(?:30|40|45|50|65|70)/, "portfolio UI must not create a second Core Score mapping");
assert.match(ui, /尚未建立個人持股/);
assert.match(ui, /行情資料不完整/);
assert.match(ui, /capitalReasonText\(row\.reasonCodes\)/);

for (const width of [760, 430, 375]) assert.match(css, new RegExp(`@media\\(max-width:${width}px\\)`));
assert.match(css, /\.portfolioDecisionGrid\{display:grid/);
assert.match(css, /@media\(max-width:760px\)[\s\S]*\.portfolioDecisionGrid\{grid-template-columns:1fr\}/);
assert.match(css, /\.portfolioHeroValue[^{]*\{[^}]*overflow-wrap:anywhere/);
assert.match(css, /\.holdingMarketValue>b[^{]*\{[^}]*overflow-wrap:anywhere/);

console.log("PASS Portfolio Decision Center Phase 1 calculations, hierarchy, sorting, empty state and responsive contract");
