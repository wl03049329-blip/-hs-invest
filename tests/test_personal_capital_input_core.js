const assert=require("node:assert/strict");
const fs=require("node:fs");
const core=require("../personal-capital-input-core.js");
const portfolioCore=require("../portfolio-core.js");
let passed=0;
function test(name,fn){fn();passed++;process.stdout.write(`PASS ${name}\n`);}
const now=new Date("2026-08-24T04:30:00Z"); // 12:30 Taipei, Sunday: Friday close is one trading day old.
const holding=(code="0050",targetAllocation=60)=>({code,shares:100,averageCost:90,targetAllocation});
const quote=(overrides={})=>({price:100,previousClose:99,date:"2026-08-21",fetchedAt:"2026-08-21T06:00:00Z",quoteMode:"close",...overrides});
const formal=(overrides={})=>({score:70,scoreStatus:"complete",coverage:100,stage:{key:"add"},metrics:{weeklyKdj:70},breakdown:[],...overrides});
const formalItem=(overrides={})=>({id:"0050",scoreMode:"formal",formalState:{date:"2026-08-21"},formalStrategyDecisions:{long_term_core:formal()},...overrides});
const input=(overrides={})=>({symbol:"0050",holdings:[holding()],quotes:{"0050":quote()},radarItem:formalItem(),now,...overrides});
test("valid fresh formal 0050 is READY",()=>assert.equal(core.normalizeSymbol(input()).eligibility,"READY"));
test("valid fresh intraday 0050 is READY",()=>{
  const time="2026-08-24T04:25:00Z",i=input({quotes:{"0050":quote({date:"2026-08-24",quoteMode:"delayed",fetchedAt:time,quoteAsOf:time})},radarItem:{id:"0050",scoreMode:"intraday",intraday:{asOf:time,quoteDate:"2026-08-24"},formalState:{date:"2026-08-21"},strategyDecisions:{long_term_core:formal()}}});
  assert.equal(core.normalizeSymbol(i).eligibility,"READY");
});
test("stale and future portfolio quotes fail closed",()=>{
  assert.ok(core.normalizeSymbol(input({quotes:{"0050":quote({date:"2026-08-18",fetchedAt:"2026-08-18T06:00:00Z"})}})).reasons.includes("PORTFOLIO_QUOTE_STALE"));
  assert.ok(core.normalizeSymbol(input({quotes:{"0050":quote({date:"2026-08-25",fetchedAt:"2026-08-25T06:00:00Z"})}})).reasons.includes("PORTFOLIO_QUOTE_FUTURE"));
});
test("missing quote and cost fallback both fail closed",()=>{
  const result=core.normalizeSymbol(input({quotes:{}}));
  assert.ok(result.reasons.includes("PORTFOLIO_QUOTE_MISSING"));
  assert.equal(portfolioCore.calculatePortfolio([holding()],{}).rows[0].allocationValue,9000);
  assert.equal(result.eligibility,"DATA_UNAVAILABLE");
});
test("missing target, decision, and insufficient coverage fail closed",()=>{
  assert.ok(core.normalizeSymbol(input({holdings:[holding("0050",null)]})).reasons.includes("TARGET_ALLOCATION_MISSING"));
  assert.ok(core.normalizeSymbol(input({radarItem:formalItem({formalStrategyDecisions:{}})})).reasons.includes("RADAR_DECISION_MISSING"));
  assert.ok(core.normalizeSymbol(input({radarItem:formalItem({formalStrategyDecisions:{long_term_core:formal({coverage:65,scoreStatus:"provisional"})}})})).reasons.includes("RADAR_COVERAGE_INSUFFICIENT"));
});
test("stale radar and formal as-of mismatch fail closed",()=>{
  assert.ok(core.normalizeSymbol(input({radarItem:formalItem({formalState:{date:"2026-08-18"}})})).reasons.includes("RADAR_STALE"));
  assert.ok(core.normalizeSymbol(input({radarItem:formalItem({formalState:{date:"2026-08-20"}})})).reasons.includes("ASOF_MISMATCH"));
});
test("source conflict fails closed",()=>assert.ok(core.normalizeSymbol(input({quoteSources:[{price:102,date:"2026-08-21"}]})).reasons.includes("SOURCE_CONFLICT")));
test("009815 insufficient history fails closed",()=>{
  const result=core.normalizeSymbol(input({symbol:"009815",holdings:[holding("009815")],quotes:{"009815":quote()},radarItem:{...formalItem(),id:"009815",formalStrategyDecisions:{long_term_core:formal({coverage:65,scoreStatus:"provisional"})}}}));
  assert.ok(result.reasons.includes("RADAR_COVERAGE_INSUFFICIENT"));
});
test("leveraged, swing, and 00757 symbols are out of scope",()=>["00631L","006201","00733","00757"].forEach(symbol=>assert.deepEqual(core.normalizeSymbol({...input(),symbol}).reasons,["SYMBOL_OUT_OF_SCOPE"])));
test("portfolio-level adapter reuses collective target validation",()=>{
  const result=core.normalizePortfolio({...input(),holdings:[holding("0050",60),holding("00662",50)]});
  assert.equal(result.targetAllocation.ok,false);
});
test("market value is the existing Portfolio Core result, never a cost fallback",()=>{
  const expected=portfolioCore.calculatePortfolio([holding()],{"0050":quote()}).rows[0];
  const result=core.normalizeSymbol(input());
  assert.equal(result.portfolio.marketValue,expected.marketValue);
  assert.equal(result.portfolio.actualWeightPct,expected.weight);
});
test("adapter introduces no Core Score calculation",()=>{
  const source=fs.readFileSync(require.resolve("../personal-capital-input-core.js"),"utf8");
  assert.doesNotMatch(source,/longTermDecision\s*\(|weightedScore\s*\(|scoreModel\s*\(/);
});
process.stdout.write(`PASS ${passed} focused personal-capital input tests\n`);
