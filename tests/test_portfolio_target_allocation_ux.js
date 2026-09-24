const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const dashboard = require("../portfolio-dashboard-core.js");
const core = require("../portfolio-core.js");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const ui = fs.readFileSync(path.join(root, "portfolio-v6.js"), "utf8");
const css = fs.readFileSync(path.join(root, "portfolio-v6.css"), "utf8");
let passed = 0;
function equal(actual, expected, label) { assert.equal(actual, expected, label); passed += 1; }
function check(value, label) { assert.ok(value, label); passed += 1; }

equal(dashboard.fixedCost(93.45), "93.45", "decimal average cost");
equal(dashboard.fixedCost(93), "93.00", "whole average cost keeps trailing zeros");
equal(dashboard.fixedCost(93450), "93,450.00", "total cost uses grouping");
equal(dashboard.fixedCost(93450.126), "93,450.13", "display rounds without mutating source");
equal(dashboard.fixedCost(0), "0.00", "zero is a valid cost");
equal(dashboard.fixedCost(null), "—", "null cost is unavailable");
equal(dashboard.fixedCost(NaN), "—", "NaN cost is unavailable");
equal(dashboard.fixedOne(105), "105.0%", "aggregate target may render above one hundred");

equal(dashboard.targetDisplay(20), "20.0%", "existing target displays one decimal");
equal(dashboard.targetDisplay(null), "未設定", "missing target is distinct");
equal(dashboard.targetDisplay(0), "0.0%", "zero target remains explicit");
equal(dashboard.targetDisplay(100), "100.0%", "one hundred target is valid");
equal(dashboard.targetDisplay(17.5), "17.5%", "decimal target is valid");
equal(dashboard.normalizeTarget(-1).ok, false, "negative target rejected");
equal(dashboard.normalizeTarget(101).ok, false, "target above one hundred rejected");
equal(dashboard.normalizeTarget("NaN").ok, false, "NaN target rejected");
equal(dashboard.normalizeTarget(Infinity).ok, false, "infinite target rejected");
equal(dashboard.normalizeTarget(17.55).ok, false, "more than one decimal rejected");
equal(dashboard.normalizeTarget(17.5).value, 17.5, "one decimal preserved");

equal(dashboard.targetSummary([20,20,30,10,20]).status, "complete", "total one hundred complete");
equal(dashboard.targetSummary([20,20,25,10,20]).gap, 5, "total ninety-five reports five missing");
equal(dashboard.targetSummary([20,20,35,10,20]).status, "over", "total one hundred five reports over");
equal(dashboard.targetSummary([0,100]).configured, 2, "zero is configured, not missing");
equal(dashboard.targetSummary([null,100]).complete, false, "missing target prevents completeness");

const holdings = [
  core.validateHolding({code:"0050",shares:10,averageCost:93.45,targetAllocation:20}),
  core.validateHolding({code:"00830",shares:20,averageCost:83,targetAllocation:null})
];
equal(core.validateTargetAllocations(holdings).total, 20, "legacy targets load through formal state");
equal(core.validateTargetAllocations(holdings).complete, false, "unset target keeps rebalance fail-soft");
equal(core.validateHolding({...holdings[1],targetAllocation:0}).targetAllocation, 0, "formal holding preserves zero target");
equal(core.validateHolding({...holdings[0],targetAllocation:17.5}).targetAllocation, 17.5, "formal holding preserves decimal target");

check(html.includes('id="portfolioTargetEditorOpen"'), "compact target CTA exists");
check(html.includes('id="portfolioTargetModal"'), "bulk target editor exists");
check(html.includes("目標佔比"), "holdings table includes target column");
check(/data-target-edit/.test(ui) && /addEventListener\("click",openTargetModal\)/.test(ui), "holdings target button opens complete target editor");
check(/data-target-batch/.test(ui) && /saveTargetBatch/.test(ui), "bulk target save is wired");
check(/saveTargetBatch[\s\S]*saveHoldings\(\)/.test(ui), "target update uses existing holdings persistence");
check(/refreshPortfolio\(\)/.test(ui), "target update refreshes rebalance immediately");
check(/targetBatchSummary\(\)/.test(ui) && /if\(!summary\.complete\)/.test(ui), "aggregate target save requires one hundred percent");
check(/dashboardCore\.fixedCost/.test(ui), "centralized cost formatter is used");
check(/portfolioTargetBatchTotal\.is-complete/.test(css), "complete total has restrained status styling");
check(/@media\(max-width:430px\)[^{]*\{[^}]*portfolioHoldingsTools/.test(css), "mobile holdings tools are responsive");
check(/portfolioTargetSheet[^}]*width:min\(520px/.test(css), "desktop target editor remains compact");
check(!/hsRadar\.portfolio\.target|TARGET_STORAGE_KEY/.test(ui), "no second target storage is introduced");
check(!/fetch\([^\n]*target/i.test(ui), "target editing is local-only and does not touch backend");

console.log(`PASS ${passed} Portfolio target allocation UX assertions`);
