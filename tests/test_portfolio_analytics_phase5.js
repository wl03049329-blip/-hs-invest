const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const ledgerCore=require("../portfolio-ledger-core.js"),analytics=require("../portfolio-analytics-core.js");
const root=path.resolve(__dirname,".."),html=fs.readFileSync(path.join(root,"index.html"),"utf8"),ui=fs.readFileSync(path.join(root,"portfolio-v6.js"),"utf8"),css=fs.readFileSync(path.join(root,"portfolio-v6.css"),"utf8");
let passed=0;function check(name,fn){fn();passed+=1;process.stdout.write(`PASS ${passed}: ${name}\n`)}
const makeEvent=(type,date,extra={},index=0)=>ledgerCore.normalizeEvent({type,tradeDate:date,timestamp:`${date}T${String(1+index).padStart(2,"0")}:00:00+08:00`,createdAt:`${date}T${String(1+index).padStart(2,"0")}:00:00+08:00`,...extra});
const events=[
  makeEvent("OPENING_CASH","2026-01-01",{grossAmount:100000,source:"LEGACY_CASH_MIGRATION"}),
  makeEvent("OPENING_POSITION","2026-01-01",{symbol:"0050",quantity:10,unitPrice:100,source:"LEGACY_HOLDINGS_MIGRATION"},1),
  makeEvent("BUY","2026-01-10",{symbol:"0050",quantity:10,unitPrice:120,fee:10},2),
  makeEvent("DEPOSIT","2026-01-12",{grossAmount:5000},3),
  makeEvent("DIVIDEND","2026-01-15",{symbol:"0050",grossAmount:100},4),
  makeEvent("SELL","2026-01-20",{symbol:"0050",quantity:5,unitPrice:150,fee:5,tax:2},5),
  makeEvent("FEE","2026-01-22",{grossAmount:20},6),
  makeEvent("TAX","2026-01-23",{grossAmount:10},7),
  makeEvent("WITHDRAWAL","2026-01-25",{grossAmount:2000},8)
];
const ledger={version:ledgerCore.VERSION,events,ledgerInitializedAt:"2026-01-01T00:00:00.000Z",performanceStartDate:"2026-01-01",legacyMigrationVersion:ledgerCore.MIGRATION_VERSION};
const snap=(date,totalAssets,price=100,quantity=10)=>({date,timestamp:`${date}T05:30:00.000Z`,totalMarketValue:price*quantity,cash:totalAssets-price*quantity,totalAssets,unrealizedPnL:0,holdings:{"0050":{quantity,marketPrice:price,marketValue:price*quantity}}});
const snapshots=[snap("2026-01-01",101000,100,10),snap("2026-01-15",106000,125,20),snap("2026-01-31",106000,140,15)];
const benchmark=[{date:"2026-01-01",close:100},{date:"2026-01-15",close:102},{date:"2026-01-31",close:104}];

const profit=analytics.calculateProfitBreakdown({ledger,marketRows:[{code:"0050",marketValue:2100}]});
check("1 opening unrealized P/L",()=>assert.equal(profit.unrealizedPnL,442.5));
check("2 buy unrealized uses weighted cost",()=>assert.equal(ledgerCore.derivePortfolioStateFromLedger(events).holdings[0].costBasis,1657.5));
check("3 partial sell realized",()=>assert.equal(profit.realizedPnL,190.5));
check("4 dividend included",()=>assert.equal(profit.dividendIncome,100));
check("5 standalone fee deducted",()=>assert.equal(profit.standaloneFees,20));
check("6 standalone tax deducted",()=>assert.equal(profit.standaloneTaxes,10));
check("7 buy fee not double counted",()=>assert.equal(profit.totalInvestmentPnL,703));
check("8 sell fee and tax not double counted",()=>assert.equal(profit.realizedPnL,190.5));
check("9 deposit excluded from profit",()=>assert.equal(profit.totalInvestmentPnL,703));
check("10 withdrawal excluded from profit",()=>assert.equal(profit.totalInvestmentPnL,703));

const contribution=analytics.calculatePortfolioContribution({ledger,snapshots,period:"ALL"});
check("11 single ETF contribution",()=>assert.equal(contribution.rows.length,1));
check("12 multiple ETF contribution sorting",()=>{const multi={...ledger,events:[...events,makeEvent("OPENING_POSITION","2026-01-01",{symbol:"00830",quantity:1,unitPrice:50},9)]};const snaps=[{...snapshots[0],holdings:{...snapshots[0].holdings,"00830":{quantity:1,marketPrice:50,marketValue:50}}},{...snapshots[2],holdings:{...snapshots[2].holdings,"00830":{quantity:1,marketPrice:40,marketValue:40}}}];const rows=analytics.calculatePortfolioContribution({ledger:multi,snapshots:snaps,period:"ALL"}).rows;assert.deepEqual(rows.map(x=>x.symbol),["0050","00830"])});
check("13 positive contribution",()=>assert.equal(contribution.rows[0].amount,733));
check("14 negative contribution",()=>{const result=analytics.calculatePortfolioContribution({ledger:{...ledger,events:events.slice(0,2)},snapshots:[snap("2026-01-01",101000,100,10),snap("2026-01-31",100500,50,10)]});assert.equal(result.rows[0].amount,-500)});
check("15 dividend contribution",()=>assert.equal(contribution.rows[0].dividend,100));
check("16 realized sale proceeds included",()=>assert.equal(contribution.rows[0].sellCash,743));
check("17 external flow excluded",()=>assert.equal(contribution.totalContribution,703));
check("18 insufficient start snapshot",()=>assert.equal(analytics.calculatePortfolioContribution({ledger,snapshots:[snapshots[0]],period:"ALL"}).status,"INSUFFICIENT_START_SNAPSHOT"));
check("19 selected period",()=>{const result=analytics.calculatePortfolioContribution({ledger,snapshots,period:"1M",asOf:"2026-01-31"});assert.equal(result.startDate,"2026-01-01")});
check("20 deterministic contribution sorting",()=>assert.deepEqual(analytics.calculatePortfolioContribution({ledger,snapshots}),analytics.calculatePortfolioContribution({ledger,snapshots})));

const dividend=analytics.calculateDividendAnalytics({ledger,year:"2026"});
check("21 single dividend",()=>assert.equal(dividend.yearTotal,100));
check("22 multiple dividends same ETF",()=>{const copy={...ledger,events:[...events,makeEvent("DIVIDEND","2026-02-15",{symbol:"0050",grossAmount:50},9)]};assert.equal(analytics.calculateDividendAnalytics({ledger:copy,year:"2026"}).yearTotal,150)});
check("23 multiple ETF dividends",()=>{const copy={...ledger,events:[...events,makeEvent("DIVIDEND","2026-02-15",{symbol:"00830",grossAmount:50},9)]};assert.equal(analytics.calculateDividendAnalytics({ledger:copy,year:"2026"}).bySymbol.length,2)});
check("24 monthly grouping",()=>assert.equal(dividend.monthly[0].amount,100));
check("25 yearly grouping",()=>assert.deepEqual(dividend.years,["2026"]));
check("26 edited dividend recalculates",()=>{const id=events.find(x=>x.type==="DIVIDEND").id,result=ledgerCore.mutateLedger(ledger,{type:"EDIT",id,event:{...events.find(x=>x.id===id),grossAmount:200}});assert.equal(analytics.calculateDividendAnalytics({ledger:result.ledger,year:"2026"}).yearTotal,200)});
check("27 deleted dividend recalculates",()=>{const id=events.find(x=>x.type==="DIVIDEND").id,result=ledgerCore.mutateLedger(ledger,{type:"DELETE",id});assert.equal(analytics.calculateDividendAnalytics({ledger:result.ledger,year:"2026"}).status,"EMPTY")});
check("28 opening cost denominator",()=>assert.ok(Math.abs(dividend.cumulativeDividendToCost-100/1657.5*100)<1e-9));
check("29 zero cost safe handling",()=>{const onlyCash={version:ledgerCore.VERSION,events:[events[0]],ledgerInitializedAt:ledger.ledgerInitializedAt,performanceStartDate:ledger.performanceStartDate};assert.equal(analytics.calculateDividendAnalytics({ledger:onlyCash}).cumulativeDividendToCost,null)});

const trading=analytics.calculateTradingAnalytics({ledger,period:"ALL",asOf:"2026-01-31"});
check("30 buy count",()=>assert.equal(trading.buyCount,1));
check("31 sell count",()=>assert.equal(trading.sellCount,1));
check("32 cumulative buy",()=>assert.equal(trading.cumulativeBuy,1210));
check("33 cumulative sell",()=>assert.equal(trading.cumulativeSell,743));
check("34 average buy",()=>assert.equal(trading.averageBuy,1210));
check("35 profitable sell",()=>assert.equal(trading.profitableSellCount,1));
check("36 loss sell",()=>assert.equal(trading.lossSellCount,0));
check("37 fewer than five percentage suppression",()=>assert.equal(trading.profitableSellRatio,null));
check("38 deposit separate",()=>assert.equal(trading.deposits,5000));
check("39 withdrawal separate",()=>assert.equal(trading.withdrawals,2000));

const report=analytics.buildMonthlyPortfolioReport({ledger,snapshots,benchmarkRows:benchmark,month:"2026-01"});
check("40 full available month",()=>assert.equal(report.available,true));
check("41 partial month labeled",()=>assert.equal(report.partialMonth,false));
check("42 ledger starts mid-month",()=>{const midEvents=[makeEvent("OPENING_POSITION","2026-01-15",{symbol:"0050",quantity:20,unitPrice:110}),makeEvent("OPENING_CASH","2026-01-15",{grossAmount:103800},1)],mid={...ledger,performanceStartDate:"2026-01-15",events:midEvents};const result=analytics.buildMonthlyPortfolioReport({ledger:mid,snapshots:snapshots.slice(1),benchmarkRows:benchmark.slice(1),month:"2026-01"});assert.equal(result.partialMonth,true)});
check("43 report deposits",()=>assert.equal(report.netDeposits,3000));
check("44 report withdrawals",()=>assert.equal(report.netDeposits,3000));
check("45 report dividends",()=>assert.equal(report.dividends,100));
check("46 report realized P/L",()=>assert.equal(report.realizedPnL,190.5));
check("47 benchmark aligned",()=>assert.ok(Math.abs(report.benchmarkReturn-4)<1e-9));
check("48 benchmark missing fail soft",()=>assert.equal(analytics.buildMonthlyPortfolioReport({ledger,snapshots,benchmarkRows:[],month:"2026-01"}).benchmarkReturn,null));
check("49 max drawdown",()=>assert.equal(report.maxDrawdown,0));
check("50 missing snapshot is incomplete",()=>{const result=analytics.buildMonthlyPortfolioReport({ledger,snapshots:[snapshots[0],snapshots[2]],benchmarkRows:benchmark,month:"2026-01"});assert.equal(result.status,"INCOMPLETE_SNAPSHOTS")});
check("51 year boundary selection",()=>assert.equal(analytics.buildAnnualPortfolioSummary({ledger,snapshots,year:"2025"}).available,false));
check("51a report excludes events after latest snapshot",()=>{const future={...ledger,events:[...events,makeEvent("DEPOSIT","2026-02-01",{grossAmount:9999},9)]};const result=analytics.buildMonthlyPortfolioReport({ledger:future,snapshots,benchmarkRows:benchmark,month:"2026-01"});assert.equal(result.netDeposits,3000)});
check("51b annual summary excludes events after latest snapshot",()=>{const future={...ledger,events:[...events,makeEvent("DIVIDEND","2026-02-01",{symbol:"0050",grossAmount:9999},9)]};const result=analytics.buildAnnualPortfolioSummary({ledger:future,snapshots,year:"2026"});assert.equal(result.dividends,100)});

check("52 isolated add/delete replay",()=>{const added=ledgerCore.mutateLedger(ledger,{type:"ADD",event:makeEvent("DEPOSIT","2026-01-30",{grossAmount:1},9)});const deleted=ledgerCore.mutateLedger(added.ledger,{type:"DELETE",id:added.ledger.events.find(x=>x.grossAmount===1&&x.type==="DEPOSIT").id});assert.equal(deleted.ok,true);assert.equal(ledgerCore.derivePortfolioStateFromLedger(deleted.ledger.events).cash,ledgerCore.derivePortfolioStateFromLedger(ledger.events).cash)});
check("53 reload after delete validates",()=>assert.ok(ledgerCore.validateLedger(JSON.parse(JSON.stringify(ledger)))));
check("54 backup export fixture fields",()=>{const backup={version:4,holdings:[],ledger,snapshots,rebalanceSettings:{cash:1},performanceStartDate:ledger.performanceStartDate};assert.ok(backup.ledger&&backup.snapshots&&backup.rebalanceSettings)});
check("55 backup restore fixture parses",()=>assert.ok(JSON.parse(JSON.stringify({ledger,snapshots}))));
check("56 ledger restored",()=>assert.ok(ledgerCore.validateLedger(JSON.parse(JSON.stringify(ledger)))));
check("57 snapshots restored",()=>assert.equal(JSON.parse(JSON.stringify(snapshots)).length,3));
check("58 targets restored",()=>assert.deepEqual(JSON.parse(JSON.stringify({targets:{"0050":100}})).targets,{"0050":100}));
check("59 performanceStartDate restored",()=>assert.equal(JSON.parse(JSON.stringify(ledger)).performanceStartDate,"2026-01-01"));
check("60 analytics core is read-only",()=>{const before=JSON.stringify(ledger);analytics.calculateProfitBreakdown({ledger,marketRows:[{code:"0050",marketValue:2100}]});assert.equal(JSON.stringify(ledger),before)});
check("61 UI loads analytics core",()=>assert.match(html,/portfolio-analytics-core\.js\?v=20260920-portfolio-analytics-p5/));
check("62 shared period state",()=>assert.match(ui,/portfolioAnalysisPeriod/));
check("63 analytics information architecture",()=>assert.ok(html.indexOf("portfolioPerformancePanel")<html.indexOf("portfolioAnalyticsCenter")&&html.indexOf("portfolioAnalyticsCenter")<html.indexOf("portfolioRiskCenter")));
check("64 mobile 2 by 2 summary",()=>assert.match(css,/portfolioAnalyticsSummary\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/));
check("65 no forbidden advanced models",()=>["Sharpe","Sortino","Monte Carlo","VaR","Risk Score"].forEach(term=>assert.equal(`${html}${ui}`.includes(term),false)));
console.log(`Portfolio Analytics Phase 5: ${passed}/${passed} PASS`);
