const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const core = require("../portfolio-performance-core.js");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const ui = fs.readFileSync(path.join(root, "portfolio-v6.js"), "utf8");
const css = fs.readFileSync(path.join(root, "portfolio-v6.css"), "utf8");
let passed = 0;
function check(name, fn) { fn(); passed += 1; process.stdout.write(`PASS ${name}\n`); }
function snap(date, assets = 100000, {cash = 10000, holdings} = {}) {
  const base = holdings || {"0050": {quantity: 100, marketPrice: (assets - cash) / 100, marketValue: assets - cash}};
  return {date, timestamp: `${date}T05:30:00.000Z`, totalMarketValue: assets - cash, cash, totalAssets: assets, unrealizedPnL: assets - 95000, holdings: base};
}
function days(count, start = Date.UTC(2026, 0, 2)) { return Array.from({length: count}, (_, index) => new Date(start + index * 86400000).toISOString().slice(0, 10)); }
function history(values) { return values.map((value, index) => snap(days(values.length)[index], value * 1000)); }
const eventTypes = rows => core.analyzePortfolioContinuity(rows, {tradingDates: rows.map(row => row.date)}).events.map(event => event.type);

check("1 same holdings and cash is complete", () => assert.equal(core.analyzePortfolioContinuity([snap("2026-09-17"), snap("2026-09-18", 101000)], {tradingDates:["2026-09-17","2026-09-18"]}).status, "COMPLETE"));
check("2 cash increase detected", () => assert.ok(eventTypes([snap("2026-09-17"), snap("2026-09-18", 101000, {cash:11000})]).includes("CASH_CHANGED")));
check("3 cash decrease detected", () => assert.ok(eventTypes([snap("2026-09-17",100000,{cash:10000}), snap("2026-09-18",99000,{cash:9000})]).includes("CASH_CHANGED")));
check("4 quantity increase detected", () => assert.ok(eventTypes([snap("2026-09-17"),snap("2026-09-18",110000,{holdings:{"0050":{quantity:110,marketPrice:909.09,marketValue:100000}}})]).includes("HOLDING_QUANTITY_CHANGED")));
check("5 quantity decrease detected", () => assert.ok(eventTypes([snap("2026-09-17"),snap("2026-09-18",91000,{holdings:{"0050":{quantity:90,marketPrice:900,marketValue:81000}}})]).includes("HOLDING_QUANTITY_CHANGED")));
check("6 holding added detected", () => assert.ok(eventTypes([snap("2026-09-17"),snap("2026-09-18",120000,{holdings:{"0050":{quantity:100,marketPrice:900,marketValue:90000},"00830":{quantity:100,marketPrice:200,marketValue:20000}}})]).includes("HOLDING_ADDED")));
check("7 holding removed detected", () => assert.ok(eventTypes([snap("2026-09-17",120000,{holdings:{"0050":{quantity:100,marketPrice:900,marketValue:90000},"00830":{quantity:100,marketPrice:200,marketValue:20000}}}),snap("2026-09-18")]).includes("HOLDING_REMOVED")));
check("8 price-only movement is not a capital event", () => assert.equal(core.analyzePortfolioContinuity([snap("2026-09-17"),snap("2026-09-18",110000)],{tradingDates:["2026-09-17","2026-09-18"]}).hasCapitalEvent,false));
check("9 market value-only movement is not a capital event", () => assert.deepEqual(eventTypes([snap("2026-09-17"),snap("2026-09-18",95000)]),[]));
check("10 weekend is not a data gap", () => assert.equal(core.analyzePortfolioContinuity([snap("2026-09-18"),snap("2026-09-21")],{tradingDates:["2026-09-18","2026-09-21"]}).hasDataGap,false));

const weights=[{symbol:"A",weight:50},{symbol:"B",weight:30},{symbol:"C",weight:20}];
check("11 largest position", () => assert.equal(core.calculateConcentration(weights).largest,50));
check("12 top three concentration", () => assert.equal(core.calculateConcentration(weights).top3,100));
check("13 HHI", () => assert.ok(Math.abs(core.calculateConcentration(weights).hhi-.38)<1e-12));
check("14 effective holdings", () => assert.ok(Math.abs(core.calculateConcentration(weights).effectiveHoldings-1/.38)<1e-12));
check("15 zero portfolio unavailable", () => assert.equal(core.calculateConcentration([{symbol:"A",weight:0}]).available,false));
check("16 single holding", () => assert.equal(core.calculateConcentration([{symbol:"A",weight:100}]).effectiveHoldings,1));
check("17 weights reconcile through normalization", () => assert.equal(Math.round(core.calculateConcentration([{symbol:"A",weight:40},{symbol:"B",weight:40}]).rows.reduce((sum,row)=>sum+row.normalizedWeight,0)*100),100));

check("18 monotonic growth drawdown is zero", () => assert.equal(core.calculateMaxDrawdown(history(Array.from({length:10},(_,i)=>100+i)),{continuity:{}}).value,0));
check("19 known peak and trough drawdown", () => assert.ok(Math.abs(core.calculateMaxDrawdown(history([100,110,88,90,91,92,93,94,95,96]),{continuity:{}}).value+20)<1e-9));
check("20 recovery does not erase maximum drawdown", () => assert.ok(Math.abs(core.calculateMaxDrawdown(history([100,110,88,112,113,114,115,116,117,118]),{continuity:{}}).value+20)<1e-9));
check("21 drawdown needs 10 snapshots", () => assert.equal(core.calculateMaxDrawdown(history(Array(9).fill(100)),{continuity:{}}).status,"INSUFFICIENT_HISTORY"));
check("22 capital event disables drawdown", () => assert.equal(core.calculateMaxDrawdown(history(Array(10).fill(100)),{continuity:{hasCapitalEvent:true}}).status,"CAPITAL_EVENT"));
check("23 invalid snapshot fails soft", () => assert.equal(core.calculateMaxDrawdown([...history(Array(9).fill(100)),{date:"bad"}],{continuity:{}}).status,"INVALID_DATA"));

check("24 flat return volatility is zero", () => assert.equal(core.calculateAnnualizedVolatility(history(Array(21).fill(100)),{continuity:{}}).value,0));
check("25 known return series uses returns", () => { const result=core.calculateAnnualizedVolatility(history(Array.from({length:21},(_,i)=>100*(1+(i%2?.01:0)))),{continuity:{}}); assert.ok(result.value>0); });
check("26 volatility annualizes with sqrt 252", () => { const rows=history(Array.from({length:21},(_,i)=>100+i)),result=core.calculateAnnualizedVolatility(rows,{continuity:{}}),returns=rows.slice(1).map((row,i)=>row.totalAssets/rows[i].totalAssets-1),mean=returns.reduce((a,b)=>a+b,0)/returns.length,sample=Math.sqrt(returns.reduce((s,v)=>s+(v-mean)**2,0)/(returns.length-1)); assert.ok(Math.abs(result.value-sample*Math.sqrt(252)*100)<1e-9); });
check("27 volatility needs 20 returns", () => assert.equal(core.calculateAnnualizedVolatility(history(Array(20).fill(100)),{continuity:{}}).status,"INSUFFICIENT_HISTORY"));
check("28 capital event disables volatility", () => assert.equal(core.calculateAnnualizedVolatility(history(Array(21).fill(100)),{continuity:{hasCapitalEvent:true}}).status,"CAPITAL_EVENT"));
check("29 invalid values fail soft", () => assert.equal(core.calculateAnnualizedVolatility([...history(Array(20).fill(100)),{date:"bad"}],{continuity:{}}).status,"INVALID_DATA"));

check("30 overlap feature is explicitly unavailable", () => assert.match(html,/ETF 重疊分析尚無可靠成分股資料/));
check("31 no production overlap calculator is claimed", () => assert.equal(typeof core.calculateEtfOverlap,"undefined"));
check("32 portfolio signature ignores prices", () => assert.equal(core.portfolioSignature(snap("2026-09-17",100000)),core.portfolioSignature(snap("2026-09-18",110000))));
check("33 portfolio signature changes on quantity", () => assert.notEqual(core.portfolioSignature(snap("2026-09-17")),core.portfolioSignature(snap("2026-09-18",110000,{holdings:{"0050":{quantity:110,marketPrice:909.09,marketValue:100000}}}))));
check("34 allocation deviation", () => assert.equal(core.calculateAllocationDeviation([{symbol:"A",weight:60,targetAllocation:50},{symbol:"B",weight:40,targetAllocation:50}]).totalDeviation,10));
check("35 missing target fails soft", () => assert.equal(core.calculateAllocationDeviation([{symbol:"A",weight:100,targetAllocation:null}]).available,false));

const comparison={available:true,gapPt:2,points:[{date:"2026-09-17",portfolio:100,benchmark:100},{date:"2026-09-18",portfolio:103,benchmark:101}]};
check("36 benchmark remains available without capital event", () => assert.equal(core.guardBenchmark(comparison,{hasCapitalEvent:false}).available,true));
check("37 cash change guards relative difference", () => assert.equal(core.guardBenchmark(comparison,{hasCapitalEvent:true}).gapPt,null));
check("38 quantity change guards relative difference", () => assert.equal(core.guardBenchmark(comparison,core.analyzePortfolioContinuity([snap("2026-09-17"),snap("2026-09-18",110000,{holdings:{"0050":{quantity:110,marketPrice:909.09,marketValue:100000}}})])).reason,"CAPITAL_EVENT"));
check("39 price-only movement keeps comparison", () => assert.equal(core.guardBenchmark(comparison,core.analyzePortfolioContinuity([snap("2026-09-17"),snap("2026-09-18",110000)])).available,true));
check("40 UI has integrity message", () => assert.match(ui,/此區間包含資金或持股異動，資產變化不等同投資報酬率/));

check("41 risk center follows selected performance period", () => { assert.match(ui,/portfolioRiskPeriod/); assert.match(ui,/renderPerformance\(\);\s*renderRiskCenter\(\)/); });
check("42 responsive risk layout is mobile 2 by 2", () => { assert.match(css,/@media\(max-width:430px\)[\s\S]*portfolioRiskMetrics\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/); assert.match(css,/portfolioRiskDetails\{grid-template-columns:1fr\}/); });
check("43 no forbidden risk score or advanced ratios", () => { assert.doesNotMatch(ui,/Sharpe|Sortino|Monte Carlo|VaR|Risk Score/); assert.doesNotMatch(html,/Sharpe|Sortino|Monte Carlo|VaR|Risk Score/); });
check("44 snapshot schema remains backward compatible", () => assert.equal(core.VERSION,"HS_PORTFOLIO_SNAPSHOT_V1"));

process.stdout.write(`\n${passed} Portfolio Risk Phase 3 tests passed.\n`);
