const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const dashboard = require("../portfolio-dashboard-core.js");
const performance = require("../portfolio-performance-core.js");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const ui = fs.readFileSync(path.join(root, "portfolio-v6.js"), "utf8");
const css = fs.readFileSync(path.join(root, "portfolio-v6.css"), "utf8");

let passed = 0;
function check(condition, message) { assert.ok(condition, message); passed += 1; }
function equal(actual, expected, message) { assert.equal(actual, expected, message); passed += 1; }
function near(actual, expected, message, tolerance = 1e-8) { assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual}`); passed += 1; }

const rows = [
  { code: "0050", name: "元大台灣50", shares: 100, marketValue: 11000, totalCost: 9000, totalPnl: 2000, todayPnl: 200, quoteStatus: "current", quote: { previousClose: 108 } },
  { code: "00830", name: "國泰費城半導體", shares: 200, marketValue: 16000, totalCost: 15000, totalPnl: 1000, todayPnl: -400, quoteStatus: "current", quote: { previousClose: 82 } }
];
const hero = dashboard.hero(rows);
equal(hero.todayPnl, -200, "Hero uses summed holding today P/L");
near(hero.todayRate, -200 / 27200 * 100, "Hero uses previous market value denominator");
equal(hero.unrealizedPnl, 3000, "Hero unrealized P/L excludes realized P/L and dividends");
near(hero.unrealizedRate, 12.5, "Hero unrealized return uses remaining cost basis");
equal(hero.stockMarketValue, 27000, "Hero stock market value excludes cash");
equal(hero.remainingCostBasis, 24000, "Hero exposes remaining holding cost");
equal(dashboard.hero([{...rows[0], quoteStatus: "stale"}]).complete, false, "Missing or stale quote fails soft");
equal(dashboard.hero([]).todayPnl, null, "Empty portfolio never invents a number");

const six = Array.from({length: 6}, (_, index) => ({code: `00${index}`, name: `ETF ${index}`, marketValue: index + 1}));
const seven = [...six, {code: "LONG", name: "很長很長很長的 ETF 正式名稱", marketValue: 7}];
equal(dashboard.allocation(six).length, 6, "Six holdings remain individually visible");
equal(dashboard.allocation(seven).length, 6, "More than six holdings collapse into six legend rows");
equal(dashboard.allocation(seven).at(-1).code, "其他", "Smaller positions are grouped as Other");
equal(dashboard.allocation(seven).at(-1).members.length, 2, "Other preserves grouped symbol membership");
near(dashboard.allocation(seven).reduce((sum, row) => sum + row.weight, 0), 100, "Allocation sums to 100%");
equal(dashboard.allocation([{code: "0050", marketValue: 0}]).length, 0, "Zero market value has no fake allocation");
equal(dashboard.allocation([{code: "0050", marketValue: null}]).length, 0, "Missing market value fails soft");
check(dashboard.allocation(seven).some(row => row.name.includes("較小部位")), "Long names do not alter grouping contract");

const history = Array.from({length: 30}, (_, index) => ({date: `2025-12-${String(index + 1).padStart(2, "0")}`, close: 100 + index}));
history.push({date: "2026-01-02", close: 132});
near(dashboard.trailingReturn(history, 5), (132 / 125 - 1) * 100, "5D uses five valid sessions");
near(dashboard.trailingReturn(history, 20), (132 / 110 - 1) * 100, "20D uses twenty valid sessions");
near(dashboard.ytdReturn(history), (132 / 129 - 1) * 100, "YTD uses prior-year final adjusted close");
equal(dashboard.trailingReturn(history.slice(0, 5), 5), null, "Insufficient 5D history displays unavailable");
equal(dashboard.ytdReturn([{date: "2026-01-02", close: 132}]), null, "Insufficient YTD history displays unavailable");
equal(dashboard.adjustedRows([{date: "2026-01-02", close: 10}, {date: "2026-01-02", close: 11}]).length, 1, "Adjusted history deduplicates trading dates");

const sortable = [{code: "A", todayPnl: 2, weight: 20}, {code: "B", todayPnl: -1, weight: 80}];
equal(dashboard.sortRows(sortable, "todayPnl", "desc")[0].code, "A", "Sort descending works");
equal(dashboard.sortRows(sortable, "todayPnl", "asc")[0].code, "B", "Sort ascending works");
equal(dashboard.sortRows(sortable, "portfolioOrder")[0].code, "A", "Default portfolio order is preserved");

for (const label of ["股票", "今日損益", "股票漲跌幅", "總損益", "股數", "均價／總成本", "市值佔比", "近 5 日漲幅", "近 20 日漲幅", "今年漲幅"]) check(html.includes(label), `Holdings table includes ${label}`);
check(/portfolioHoldingsTableViewport\{[^}]*overflow-x:auto/.test(css), "Only table viewport scrolls horizontally");
check(/holdingColSymbol[^}]*position:sticky/.test(css), "Symbol column is sticky");
check(/portfolioHoldingsTableHead\{position:sticky/.test(css), "Table header is sticky");
check(/data-holdings-view="pnl"/.test(html) && /data-holdings-view="position"/.test(html) && /data-holdings-view="trend"/.test(html), "All three table shortcuts exist");
equal((html.match(/class="portfolioHoldingsTable"/g) || []).length, 1, "Shortcuts reuse one table");
check(/viewport\.scrollTo/.test(ui), "Shortcut tabs only scroll the table viewport");
check(/overflow-x:hidden/.test(css), "Page protects against body horizontal overflow");
check(/grid-template-columns:170px 92px 102px 112px 72px 125px 85px 90px 90px 90px/.test(css), "Header and rows share the same column contract");
check(/\.portfolioEmpty\[hidden\]\{display:none\}/.test(css), "Populated portfolios never show the empty state");

const planInput = [
  {symbol: "0050", marketValue: 60000, weight: 60, targetAllocation: 40, price: 100, coreScore: 30},
  {symbol: "00830", marketValue: 40000, weight: 40, targetAllocation: 60, price: 80, coreScore: 58}
];
const before = JSON.stringify(planInput);
const plan = performance.buildCapitalAllocationPlan({rows: planInput, availableCash: 100000, allocationHealthScore: value => value});
equal(JSON.stringify(planInput), before, "Cash scenario does not mutate holdings or ledger input");
near(plan.rows.reduce((sum, row) => sum + row.allocationAmount, 0) + plan.remaining, plan.cash, "Cash plan reconciles exactly", 0.01);
check(plan.rows.some(row => row.coreScore === 58), "HS score remains visible in allocation output");
check(plan.rows.some(row => row.reasonCodes.includes("UNDERWEIGHT")), "Deterministic reason codes are preserved");
check(plan.rows.every(row => Object.hasOwn(row, "beforeAllocation") && Object.hasOwn(row, "afterAllocation") && Object.hasOwn(row, "targetAllocation")), "Before, after, and target are available");
check(performance.buildCapitalAllocationPlan({rows: [{symbol: "0050", marketValue: 10, weight: 100, targetAllocation: 100, price: 1, coreScore: null}], availableCash: 100}).rows[0].coreScore === null, "Missing Core Score fails soft");
check(performance.buildCapitalAllocationPlan({rows: [{symbol: "0050", marketValue: 10, weight: 10, targetAllocation: 100, price: null}], availableCash: 100}).rows[0].reasonCodes.includes("PRICE_UNAVAILABLE"), "Missing quote fails soft");
check(performance.buildCapitalAllocationPlan({rows: [{symbol: "0050", marketValue: 100, weight: 100, targetAllocation: 50, price: 10}], availableCash: 100}).rows[0].allocationAmount === 0, "All-overweight scenario does not invent an allocation");
check(/capitalPlanCashScenario/.test(ui) && !/capitalPlanCashScenario\s*=\s*ledger/.test(ui), "Scenario cash remains transient UI state");
check(/data-portfolio-tool="performance"/.test(html) && /data-portfolio-tool="risk"/.test(html) && /data-portfolio-tool="transactions"/.test(html), "Advanced Phase panels remain present");

console.log(`PASS ${passed} Portfolio Brokerage Dashboard assertions`);
