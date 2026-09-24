"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const core = require("../portfolio-core.js");
const dashboard = require("../portfolio-dashboard-core.js");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const portfolio = fs.readFileSync(path.join(root, "portfolio-v6.js"), "utf8");
const universe = JSON.parse(fs.readFileSync(path.join(root, "etf-universe.json"), "utf8"));
const cache = JSON.parse(fs.readFileSync(path.join(root, "market-quotes.json"), "utf8"));
const official = universe.items.find(item => item.code === "006208");
assert.equal(official?.name, "富邦台50");

const quoteRow = cache.items.find(item => item.code === "006208");
assert.ok(quoteRow && quoteRow.price > 0 && quoteRow.previous_close > 0);
const parserStart = html.indexOf("function parsePublicQuoteCache(payload){");
const parserEnd = html.indexOf("function parseCanonicalCoreSnapshots", parserStart);
assert.ok(parserStart >= 0 && parserEnd > parserStart);
assert.doesNotMatch(html, /LIVE_QUOTE_PUBLIC_CODES/);
const parserContext = vm.createContext({Map});
vm.runInContext(`${html.slice(parserStart, parserEnd)};this.parse=parsePublicQuoteCache`, parserContext);
const shared = parserContext.parse(cache);
for (const symbol of ["006208", "0050", "00830", "00935", "009815"]) {
  const row = cache.items.find(item => item.code === symbol);
  if (row && row.price > 0 && row.previous_close > 0) assert.ok(shared.has(symbol), `${symbol} 被公開行情 parser 丟棄`);
}
assert.equal(shared.get("006208").name, "富邦台50");
const invalid = parserContext.parse({items: [
  {code: "09999Z", price: 0, previous_close: 10},
  {code: "006208", price: 1, previous_close: 0},
  {code: "BAD!", price: 1, previous_close: 1}
]});
assert.equal(invalid.size, 0);
assert.equal(shared.has("09999Z"), false);
assert.match(html, /const LONG_RADAR_CODES=new Set\(\["0050","00662","00757","00830","00935","009815"\]\)/);

const holding = core.validateHolding({code: "006208", shares: 1000, averageCost: 256, name: official.name});
const quote = shared.get("006208");
const now = Date.parse(`${quote.date}T14:00:00+08:00`);
const quoted = core.calculatePortfolio([holding], shared, {now});
assert.equal(quoted.rows[0].quoteStatus, "current");
assert.equal(quoted.rows[0].marketValue, 1000 * quote.price);
assert.ok(Math.abs(quoted.rows[0].todayPnl - 1000 * (quote.price - quote.previousClose)) < 1e-6);
assert.ok(Math.abs(quoted.rows[0].totalPnl - 1000 * (quote.price - 256)) < 1e-6);
assert.equal(quoted.rows[0].weight, 100);
assert.equal(dashboard.hero(quoted.rows).stockMarketValue, quoted.rows[0].marketValue);
assert.equal(dashboard.allocation(quoted.rows, 6)[0].value, quoted.rows[0].marketValue);
const unknown = core.calculatePortfolio([core.validateHolding({code: "09999Z", shares: 1, averageCost: 10})], shared, {now});
assert.equal(unknown.rows[0].marketValue, null);
assert.equal(unknown.rows[0].todayPnl, null);

const formStart = portfolio.indexOf("  function formHolding() {");
const formEnd = portfolio.indexOf("\n  function commitHolding(", formStart);
const commitStart = formEnd + 1;
const commitEnd = portfolio.indexOf("\n  async function submitPortfolio(", commitStart);
const submitStart = portfolio.indexOf("  async function submitPortfolio(event) {");
const submitEnd = portfolio.indexOf("\n  function duplicateAction(", submitStart);
const nameStart = portfolio.indexOf("  function holdingName(row) {");
const nameEnd = portfolio.indexOf("\n  function radarFor(", nameStart);
assert.ok(formStart >= 0 && formEnd > formStart && commitEnd > commitStart && submitStart >= 0 && submitEnd > submitStart && nameStart >= 0 && nameEnd > nameStart);
let committed = null;
const fields = {"#portfolioCode": {value: "006208"}, "#portfolioShares": {value: "1000"}, "#portfolioAverageCost": {value: "256"}, "#portfolioCustomName": {value: ""}, "#portfolioStrategyType": {value: ""}, "#portfolioTargetAllocation": {value: ""}, "#portfolioFormError": {textContent: ""}};
const context = vm.createContext({
  core, catalog: [], quoteMap: new Map(), publicQuoteMap: new Map(), holdings: [], editingCode: null,
  $v6: selector => fields[selector],
  loadCatalog: async () => { context.catalog = [{code: "006208", name: official.name}]; },
  commitHolding: item => { committed = item; }
});
vm.runInContext(`${portfolio.slice(formStart, formEnd)}\n${portfolio.slice(submitStart, submitEnd)}\n${portfolio.slice(nameStart, nameEnd)}`, context);

(async () => {
  await vm.runInContext("submitPortfolio({preventDefault(){}})", context);
  assert.equal(committed?.code, "006208");
  assert.equal(committed?.name, official.name);
  assert.equal(committed?.shares, 1000);
  assert.equal(committed?.averageCost, 256);
  assert.equal(context.holdingName({...committed, quote: {...quote, name: "006208"}}), official.name);
  let replayed = null;
  const replay = vm.createContext({
    core, Map, holdings: [], marketCacheVersion: cache.updated_at, window: {HSLiveMarket: {latestQuotes: () => shared}},
    saveHoldings() {}, closePortfolioModal() {}, refreshPortfolio() { throw Error("shared quote should reconcile before refresh"); },
    applySharedQuotes(event) { replayed = core.mergePortfolioQuoteRefresh({previous: new Map(), incoming: event.detail.quotes, holdings: replay.holdings}); },
    updateQuotes() {}
  });
  vm.runInContext(portfolio.slice(commitStart, commitEnd), replay);
  replay.commitHolding(committed);
  assert.equal(replayed.currentCount, 1);
  assert.equal(replayed.quotes.get("006208")?.price, quote.price);
  console.log("PASS Portfolio 006208 public quote, direct-code name, valuation, allocation, missing-quote safety and Radar isolation");
})().catch(error => { console.error(error); process.exitCode = 1; });
