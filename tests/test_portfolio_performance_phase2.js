const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const core = require("../portfolio-performance-core.js");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const ui = fs.readFileSync(path.join(root, "portfolio-v6.js"), "utf8");
const css = fs.readFileSync(path.join(root, "portfolio-v6.css"), "utf8");
const checks = [];
function check(name, fn) { fn(); checks.push(name); process.stdout.write(`PASS ${name}\n`); }
function snap(date, assets = 100000, timestamp = `${date}T05:30:00.000Z`) {
  return {date, timestamp, totalMarketValue: assets - 10000, cash: 10000, totalAssets: assets, unrealizedPnL: assets - 95000, holdings: {"0050": {quantity: 100, marketPrice: (assets - 10000) / 100, marketValue: assets - 10000}}};
}

check("forward snapshot schema validates", () => assert.equal(core.validateSnapshot(snap("2026-09-18")).version, core.VERSION));
check("invalid snapshot cannot overwrite history", () => { const prior=[core.validateSnapshot(snap("2026-09-18"))]; const result=core.appendDailySnapshot(prior,{date:"2026-09-18"}); assert.equal(result.changed,false); assert.deepEqual(result.history,prior); });
check("same-day keeps latest valid snapshot", () => { const first=snap("2026-09-18",100000,"2026-09-18T02:00:00Z"), last=snap("2026-09-18",105000,"2026-09-18T05:30:00Z"); const result=core.appendDailySnapshot([first],last); assert.equal(result.history.length,1); assert.equal(result.history[0].totalAssets,105000); });
check("same timestamp replaces snapshot when ledger-derived portfolio changes", () => { const first=snap("2026-09-18",100000), changed={...snap("2026-09-18",101000),ledgerVersion:"HS_PORTFOLIO_LEDGER_V1",ledgerLastEventId:"evt-buy"}; const result=core.appendDailySnapshot([first],changed); assert.equal(result.status,"REPLACED_DAILY_LAST"); assert.equal(result.changed,true); assert.equal(result.history[0].totalAssets,101000); assert.equal(result.history[0].ledgerLastEventId,"evt-buy"); });
check("older same-day snapshot is rejected", () => { const last=snap("2026-09-18",105000,"2026-09-18T05:30:00Z"), old=snap("2026-09-18",100000,"2026-09-18T02:00:00Z"); assert.equal(core.appendDailySnapshot([last],old).status,"OLDER_OR_IDENTICAL"); });
check("period selection respects YTD and ALL", () => { const rows=[snap("2025-12-31"),snap("2026-01-02"),snap("2026-09-18")]; assert.equal(core.selectPeriod(rows,"YTD","2026-09-18").length,2); assert.equal(core.selectPeriod(rows,"ALL","2026-09-18").length,3); });
check("asset change requires two dates", () => { assert.equal(core.assetChange([snap("2026-09-18")]).available,false); assert.ok(Math.abs(core.assetChange([snap("2026-09-17",100000),snap("2026-09-18",105000)]).rate-5)<1e-9); });
check("benchmark aligns exact trading dates and normalizes 100", () => { const result=core.alignBenchmark([snap("2026-09-17",100000),snap("2026-09-18",110000)],[{date:"2026-09-17",close:50},{date:"2026-09-18",close:52.5}]); assert.equal(result.available,true); assert.equal(result.points[0].portfolio,100); assert.equal(result.points[0].benchmark,100); assert.equal(result.gapPt,5); });
check("benchmark does not fill missing dates", () => assert.equal(core.alignBenchmark([snap("2026-09-17"),snap("2026-09-18")],[{date:"2026-09-17",close:50}]).available,false));
const health = rows => rows.some(row=>!Number.isFinite(row.weight)||!Number.isFinite(row.targetAllocation))?null:Math.round(100 - rows.reduce((sum,row)=>sum+Math.abs(row.weight-row.targetAllocation),0)/2);
const baseRows=[{code:"0050",marketValue:70000,weight:70,targetAllocation:50,price:50,coreScore:30},{code:"00830",marketValue:30000,weight:30,targetAllocation:50,price:75,coreScore:55}];
check("smart capital reconciles every dollar", () => { const plan=core.buildCapitalAllocationPlan({rows:baseRows,availableCash:10001,allocationHealthScore:health}); assert.equal(plan.allocated+plan.remaining,10001); });
check("overweight holding receives no new cash", () => { const plan=core.buildCapitalAllocationPlan({rows:baseRows,availableCash:10000,allocationHealthScore:health}); assert.equal(plan.rows.find(row=>row.symbol==="0050").allocationAmount,0); assert.ok(plan.rows.find(row=>row.symbol==="00830").allocationAmount>0); });
check("target gap remains primary over Core Score", () => { const rows=[{code:"0050",marketValue:20000,weight:20,targetAllocation:60,price:50,coreScore:1},{code:"00830",marketValue:80000,weight:80,targetAllocation:40,price:80,coreScore:100}]; const plan=core.buildCapitalAllocationPlan({rows,availableCash:10000,allocationHealthScore:health}); assert.equal(plan.rows.find(row=>row.symbol==="00830").allocationAmount,0); });
check("missing Core Score does not block allocation", () => { const rows=[{code:"0050",marketValue:20000,weight:20,targetAllocation:100,price:50,coreScore:null}]; assert.equal(core.buildCapitalAllocationPlan({rows,availableCash:5000,allocationHealthScore:health}).allocated,5000); });
check("missing price fails that holding gracefully", () => { const rows=[{code:"0050",marketValue:20000,weight:20,targetAllocation:100,price:null,coreScore:50}]; const plan=core.buildCapitalAllocationPlan({rows,availableCash:5000,allocationHealthScore:health}); assert.equal(plan.allocated,0); assert.ok(plan.rows[0].reasonCodes.includes("PRICE_UNAVAILABLE")); });
check("missing target fails that holding gracefully", () => { const rows=[{code:"0050",marketValue:20000,weight:20,targetAllocation:null,price:50,coreScore:50}]; assert.equal(core.buildCapitalAllocationPlan({rows,availableCash:5000,allocationHealthScore:health}).status,"NO_ELIGIBLE_TARGET"); });
check("zero cash remains a simulation with no allocation", () => { const plan=core.buildCapitalAllocationPlan({rows:baseRows,availableCash:0,allocationHealthScore:health}); assert.equal(plan.status,"ZERO_CASH"); assert.equal(plan.allocated,0); });
check("empty holdings return explicit state", () => assert.equal(core.buildCapitalAllocationPlan({rows:[],availableCash:1000}).status,"EMPTY_HOLDINGS"));
check("allocation is deterministic", () => { const input={rows:baseRows,availableCash:12345,allocationHealthScore:health}; assert.deepEqual(core.buildCapitalAllocationPlan(input),core.buildCapitalAllocationPlan(input)); });
check("health before and after reuse supplied health contract", () => { const plan=core.buildCapitalAllocationPlan({rows:baseRows,availableCash:10000,allocationHealthScore:health}); assert.ok(Number.isFinite(plan.healthBefore)); assert.ok(Number.isFinite(plan.healthAfter)); });
check("UI preserves forward-only history and uses ledger-only true returns", () => { assert.match(ui,/FORWARD_SNAPSHOT_ONLY/); assert.match(ui,/backtest\/long-term\/historical-adjusted\.json/); assert.match(ui,/dates\[0\] !== taipeiToday\(\)/); assert.match(ui,/ledgerCore\.calculateTwr/); assert.match(ui,/ledgerCore\.calculateXirr/); });
check("Phase 2 information architecture and responsive styles exist", () => { for(const id of ["portfolioPerformanceChart","portfolioSmartTargetOpen"]) assert.match(html,new RegExp(`id="${id}"`)); for(const className of ["portfolioPerformancePanel","portfolioCapitalPlan"]) assert.match(html,new RegExp(`class="[^"]*${className}`)); assert.match(css,/portfolioPerformanceBody/); assert.match(css,/@media\(max-width:430px\)/); });
check("smart capital stays simulation-only", () => { const render=ui.slice(ui.indexOf("function renderCapitalPlan"),ui.indexOf("function refreshPortfolio")); assert.doesNotMatch(render,/saveHoldings|commitHolding|holdings\s*=/); assert.match(html,/不會修改真實持股/); });

process.stdout.write(`\n${checks.length} Portfolio Performance Phase 2 tests passed.\n`);
