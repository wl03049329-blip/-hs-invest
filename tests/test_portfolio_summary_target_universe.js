const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const dashboard = require("../portfolio-dashboard-core.js");
const core = require("../portfolio-core.js");

let passed = 0;
function equal(actual, expected, label) { assert.equal(actual, expected, label); passed++; }
function check(value, label) { assert.ok(value, label); passed++; }

const current = (code, shares, marketValue, todayPnl, previousClose, totalCost = null) => ({
  code, shares, marketValue, todayPnl, totalCost, quoteStatus: "current", quote: {previousClose}
});
const valid = current("0050", 10, 1200, 50, 115, 900);
const missingCost = current("00830", 5, 500, 20, 96);
const stale = {...current("00935", 8, 640, 10, 78, 600), quoteStatus: "stale"};
const missing = {code:"00662", shares:4, quoteStatus:"missing", marketValue:null, todayPnl:null};
const complete = [valid, current("00830",5,500,20,96,400), current("00935",8,640,10,78,600), current("009815",2,200,5,97,160)];
equal(dashboard.hero(complete).holdingCount, 4, "four complete holdings count as four");
check(Number.isFinite(dashboard.hero(complete).stockMarketValue), "complete holdings have market value");
check(Number.isFinite(dashboard.hero(complete).todayPnl), "complete holdings have today P/L");
check(Number.isFinite(dashboard.hero(complete).unrealizedPnl), "complete holdings have unrealized P/L");
const partial = dashboard.hero([valid, missingCost, stale, missing]);
equal(partial.holdingCount, 4, "only real holdings count");
equal(partial.valuableCount, 2, "only current quoted holdings valued");
equal(partial.stockMarketValue, 1700, "market value independent of cost completeness");
equal(partial.todayPnl, 70, "today P/L independent of cost completeness");
equal(partial.unrealizedPnl, 300, "unrealized P/L uses only rows with cost");
equal(partial.marketValueStatus, "partial", "partial quote coverage is explicit");
equal(partial.costStatus, "partial", "cost coverage is independently partial");
equal(dashboard.hero([valid,stale]).costStatus, "complete", "stale price does not masquerade as missing cost");
equal(dashboard.hero([valid,stale]).unrealizedReason, "部分行情缺失", "unrealized note identifies quote gap");
equal(dashboard.hero([stale, missing]).stockMarketValue, null, "all unavailable produces dash");
equal(dashboard.hero([missingCost]).todayPnl, 20, "missing cost does not hide today P/L");
equal(dashboard.hero([missingCost]).unrealizedPnl, null, "missing cost never invents unrealized P/L");

const raw = [valid, missingCost, stale, missing, {code:"00757",shares:0,marketValue:999}];
equal(dashboard.effectiveHoldings(raw).length, 4, "zero-share row excluded from effective holdings");
equal(dashboard.hero(raw).holdingCount, 4, "Hero count matches effective holdings");
equal(dashboard.allocation(dashboard.effectiveHoldings(raw)).length, 3, "allocation excludes the missing quote without changing holding count");

const closeQuote = new Map([["0050", {price:120,previousClose:115,date:"2026-09-21",quoteMode:"close"}]]);
const closeRows = core.calculatePortfolio([core.validateHolding({code:"0050",shares:10,averageCost:90})], closeQuote, {now:Date.parse("2026-09-21T13:45:00+08:00")}).rows;
equal(closeRows[0].quoteStatus, "current", "valid official close remains available");
equal(dashboard.hero(closeRows).stockMarketValue, 1200, "closed-session quote reaches Hero");

const targets = dashboard.targetAllocationItems([{code:"0050",shares:10,targetAllocation:60}], {"00662":40});
equal(targets.length, 2, "held and target-only symbols share target universe");
equal(targets[1].shares, 0, "target-only symbol has no fake holding");
equal(dashboard.targetSummary(targets.map(row=>row.targetAllocation)).complete, true, "held plus unheld target sums to 100");
equal(dashboard.targetSummary([60,45]).status, "over", "over 100 remains blocked");
const advice = core.calculateRebalanceAdvice({rows:[{code:"0050",marketValue:1000,targetAllocation:60},{code:"00662",marketValue:0,targetAllocation:40}],cash:1000});
equal(advice.status, "ready", "target-only symbol participates in Smart Rebalance");
check(advice.rows.some(row=>row.code==="00662"), "target-only symbol remains in advice");
check(advice.rows.find(row=>row.code==="00662").suggestedAmount>0, "available cash can fund an unheld target");
const fiveTargets = dashboard.targetAllocationItems([
  {code:"0050",shares:10,targetAllocation:20},
  {code:"00830",shares:10,targetAllocation:30},
  {code:"00935",shares:10,targetAllocation:10},
  {code:"009815",shares:10,targetAllocation:20}
], {"00662":20});
equal(fiveTargets.length, 5, "four held plus one unheld produce five target inputs");
equal(fiveTargets.find(row=>row.code==="00662").targetAllocation, 20, "unheld symbol retains its configured 20 percent target");
equal(dashboard.targetSummary(fiveTargets.map(row=>row.targetAllocation)).complete, true, "five-symbol targets validate to 100 percent");
const fiveAdvice = core.calculateRebalanceAdvice({rows:fiveTargets.map(row=>({code:row.code,marketValue:row.shares>0?1000:0,targetAllocation:row.targetAllocation})),cash:1000});
equal(fiveAdvice.status, "ready", "five-symbol rebalance includes zero-share target");
equal(fiveAdvice.rows.find(row=>row.code==="00662").actualWeight, 0, "unheld symbol current allocation is zero");
check(fiveAdvice.rows.find(row=>row.code==="00662").suggestedAmount>0, "five-symbol rebalance recommends building position");

const ui = fs.readFileSync(path.join(__dirname,"..","portfolio-v6.js"),"utf8");
const html = fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8");
check(ui.includes("core.calculatePortfolio(effectiveHoldings(), quoteMap"), "calculation rows use effective holdings");
check(/marketRows = computed\.rows\s*\.filter\(row => row\.quoteStatus === "current"/.test(ui), "chart and Hero use the same current-price eligibility");
check(ui.includes("const rows = rebalanceRows()"), "rebalance uses full target universe");
check(ui.includes("rebalanceSettings.targets = nextTargets"), "target-only universe persists in existing settings");
check(/const updateRebalanceSettings = \(\) => \{\s*rebalanceSettings = \{\s*\.\.\.rebalanceSettings,/.test(ui), "cash and profile edits preserve target-only symbols");
check(html.includes('id="portfolioTargetSymbolAdd"'), "user can add unheld target symbol");
check(/data-target-batch=/.test(ui) && !/data-target-batch=[^>]*disabled/.test(ui), "target-only input remains editable");
check(!ui.includes("hsRadar.portfolio.targetOnly"), "no second storage key created");

console.log(`PASS ${passed} Portfolio summary and target-universe assertions`);
