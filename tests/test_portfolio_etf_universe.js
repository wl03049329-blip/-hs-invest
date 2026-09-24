"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const core = require("../portfolio-core.js");
const catalogCore = require("../portfolio-etf-catalog.js");
const root = path.join(__dirname, "..");
const universe = JSON.parse(fs.readFileSync(path.join(root, "etf-universe.json"), "utf8"));
const marketQuotes = JSON.parse(fs.readFileSync(path.join(root, "market-quotes.json"), "utf8"));
const portfolioSource = fs.readFileSync(path.join(root, "portfolio-v6.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const holding = (code, name = "") => core.validateHolding({code, name, shares: 1, averageCost: 10});

assert.ok(Array.isArray(universe.items) && universe.items.length > 0);
const catalog = catalogCore.build({core, universe, marketQuotes, watchlist: [{id: "0050", name: "舊名稱"}], stocks: [{stock_id: "0050", stock_name: "另一個舊名稱"}]});
assert.equal(new Set(catalog.map(item => item.code)).size, catalog.length);
assert.equal(catalog.find(item => item.code === "0050").name, universe.items.find(item => item.code === "0050").name);
assert.equal(catalog.find(item => item.code === "0050").source, "etf_universe");
assert.equal(catalog.filter(item => item.source === "etf_universe").length, universe.items.length);

for (const item of universe.items) {
  const code = core.normalizeCode(item.code);
  assert.match(code, core.CODE_PATTERN, `ETF Universe 代號不合法：${item.code}`);
  assert.equal(holding(item.code).code, code);
  const entry = catalog.find(row => row.code === code);
  assert.ok(entry, `catalog 缺少 ${code}`);
  assert.equal(entry.name, core.sanitizeName(item.name));
  assert.ok(catalogCore.search(catalog, code).some(row => row.code === code), `無法搜尋 ${code}`);
}

for (const code of ["00400A", "00679B", "00631L", "00632R", "00635U", "00636K", "00687C", "00981A"]) {
  assert.equal(holding(code.toLowerCase()).code, code);
  assert.equal(core.normalizeCode(`TSE_${code.toLowerCase()}.tw`), code);
  assert.equal(core.normalizeCode(`OTC_${code.toLowerCase()}.tw`), code);
}
assert.equal(holding("09999Z").code, "09999Z");
assert.equal(catalogCore.search(catalog, "美債").length > 0, true);
assert.equal(catalogCore.search(catalog, "主動").length > 0, true);
assert.equal(catalogCore.search(catalog, "國泰").length > 0, true);
assert.equal(catalogCore.search(catalog, "NASDAQ").length > 0, true);
assert.ok(catalogCore.search(catalog, "國泰投信").some(row => row.issuer === "國泰投信"));

const categories = {
  active: item => item.strategy_category.startsWith("active_"),
  bond: item => item.asset_class === "bond",
  leveragedInverse: item => ["leveraged", "inverse"].includes(item.strategy_category),
  equity: item => item.asset_class === "equity" && item.active_passive !== "active"
};
for (const [label, predicate] of Object.entries(categories)) {
  const sampleKey = code => [...code].reduce((hash, char) => (Math.imul(hash, 33) + char.charCodeAt(0)) >>> 0, 20260924);
  const samples = universe.items.filter(predicate).sort((a, b) => sampleKey(a.code) - sampleKey(b.code)).slice(0, 3);
  assert.equal(samples.length, 3, `${label} 樣本不足`);
  for (const item of samples) {
    const entry = catalogCore.search(catalog, item.code).find(row => row.code === item.code);
    assert.equal(entry.name, item.name);
    assert.equal(holding(item.code, entry.name).code, item.code);
    assert.equal(core.calculatePortfolio([holding(item.code, entry.name)], new Map()).rows[0].code, item.code);
  }
}

const missing = core.calculatePortfolio([holding("09999Z", "商品資料待更新")], new Map()).rows[0];
assert.equal(missing.code, "09999Z");
assert.equal(missing.marketValue, null);
assert.equal(missing.todayPnl, null);
assert.equal(missing.returnRate, null);
assert.equal(missing.quote, null);
const quoted = core.calculatePortfolio(
  [holding("00679B", "元大美債20年")],
  new Map([["00679B", {price: 30.5, previousClose: 30, date: "2026-09-24", quoteTime: "13:30:00", name: "元大美債20年"}]]),
  {now: Date.parse("2026-09-24T13:31:00+08:00")}
).rows[0];
assert.equal(quoted.quoteStatus, "current");
assert.equal(quoted.marketValue, 30.5);
assert.equal(quoted.todayPnl, 0.5);
const noUniverse = catalogCore.build({core, marketQuotes, watchlist: [{id: "09999Z", name: "待更新"}], stocks: null});
assert.ok(noUniverse.length > 0);
assert.ok(noUniverse.some(row => row.code === "09999Z"));
assert.ok(catalogCore.build({core, watchlist: [{id: "09999Z", name: "待更新"}], previous: noUniverse}).length > 0);
assert.match(portfolioSource, /const ETF_UNIVERSE_URL = "etf-universe\.json"/);
assert.match(portfolioSource, /Promise\.allSettled\(/);
assert.doesNotMatch(portfolioSource, /event\.target\.value = core\.normalizeCode\(event\.target\.value\)\.replace/);
assert.match(html, /portfolio-etf-catalog\.js/);
assert.match(html, /id="portfolioCode"[^>]*maxlength="60"/);

async function loadWith({universeResult, marketResult}) {
  const start = portfolioSource.indexOf("  async function loadCatalog() {");
  const end = portfolioSource.indexOf("\n  function searchCatalog(", start);
  assert.ok(start >= 0 && end > start);
  const sandbox = {
    core, etfCatalog: catalogCore, catalog: [], catalogLoading: null, holdings: [], watchlist: [],
    ETF_UNIVERSE_URL: "etf-universe.json", MARKET_CACHE_URL: "market-quotes.json",
    fetchJson: url => url === "etf-universe.json" ? universeResult() : marketResult(),
    apiGet: () => Promise.reject(new Error("FinMind unavailable"))
  };
  vm.createContext(sandbox);
  vm.runInContext(portfolioSource.slice(start, end), sandbox);
  await vm.runInContext("loadCatalog()", sandbox);
  return vm.runInContext("catalog", sandbox);
}

(async () => {
  const primary = await loadWith({universeResult: () => Promise.resolve(universe), marketResult: () => Promise.reject(new Error("quotes unavailable"))});
  assert.equal(primary.filter(row => row.source === "etf_universe").length, universe.items.length);
  const secondary = await loadWith({universeResult: () => Promise.reject(new Error("universe unavailable")), marketResult: () => Promise.resolve(marketQuotes)});
  assert.ok(secondary.some(row => row.code === "00400A" && row.source === "market_quotes"));
  console.log(`PASS: ${universe.items.length} ETF Universe codes, four type groups, loader fallback, missing quote, search, symbol normalization`);
})().catch(error => {console.error(error);process.exitCode = 1;});
