const assert = require("node:assert/strict");
const core = require("../portfolio-core.js");

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`PASS ${name}\n`);
}

const NOW = Date.parse("2026-08-21T05:30:00Z");
const holding = code => ({code, shares: 1000, averageCost: 50});
const quote = (overrides = {}) => ({
  price: 60,
  previousClose: 59,
  name: "測試 ETF",
  date: "2026-08-21",
  quoteTime: "13:30:00",
  fetchedAt: "2026-08-21T05:31:00Z",
  ...overrides
});

test("最新逐檔 quote 依自己的 date + quoteTime 判定為 current", () => {
  const freshness = core.quoteFreshness(quote(), {now: NOW});
  assert.equal(freshness.status, "current");
  assert.match(freshness.asOf, /^2026-08-21T13:30:00\+08:00$/);
});

test("global updated_at 新但逐檔 quote 舊時仍標記 stale", () => {
  const old = quote({date: "2026-08-13", quoteTime: "13:30:00", fetchedAt: "2026-08-21T05:31:00Z", sourceUpdatedAt: "2026-08-21T05:31:00Z"});
  assert.equal(core.quoteFreshness(old, {now: NOW}).status, "stale");
});

test("未來 as-of 不會被當成目前行情", () => {
  const future = quote({date: "2026-08-22", quoteTime: "09:30:00"});
  assert.equal(core.quoteFreshness(future, {now: NOW}).status, "stale");
});

test("LKG fallback 保留估值但不再被視為完整最新損益", () => {
  const fallback = quote({stale: true, fallback: true, staleReason: "source_missing"});
  const result = core.calculatePortfolio([holding("0050")], new Map([["0050", fallback]]), {now: NOW});
  assert.equal(result.complete, false);
  assert.equal(result.fallbackCount, 1);
  assert.equal(result.rows[0].quoteStatus, "stale");
  assert.equal(result.rows[0].valueSource, "market_fallback");
  assert.equal(result.rows[0].marketValue, 60000);
  assert.equal(result.rows[0].todayPnl, 1000);
});

test("單檔來源缺失只把該檔 LKG 標 stale，其餘持股正常更新", () => {
  const previous = new Map([
    ["0050", quote({price: 55})],
    ["00830", quote({price: 80})]
  ]);
  const incoming = new Map([["0050", quote({price: 61})]]);
  const result = core.mergePortfolioQuoteRefresh({
    previous,
    incoming,
    holdings: [holding("0050"), holding("00830"), holding("00935")],
    sourceUpdatedAt: "2026-08-21T05:31:00Z"
  });
  assert.equal(result.currentCount, 1);
  assert.equal(result.staleCount, 1);
  assert.equal(result.missingCount, 1);
  assert.equal(result.quotes.get("0050").price, 61);
  assert.equal(result.quotes.get("0050").stale, false);
  assert.equal(result.quotes.get("00830").stale, true);
  assert.equal(result.quotes.get("00830").staleReason, "source_missing");
  assert.equal(result.quotes.has("00935"), false);
});

test("關閉 autoRefresh 時舊快取明確轉為 stale，而非偽裝最新", () => {
  const result = core.mergePortfolioQuoteRefresh({
    previous: new Map([["0050", quote()]]),
    incoming: new Map([["0050", quote({price: 62})]]),
    holdings: [holding("0050")],
    applyPortfolio: false
  });
  assert.equal(result.currentCount, 0);
  assert.equal(result.staleCount, 1);
  assert.equal(result.quotes.get("0050").price, 60);
  assert.equal(result.quotes.get("0050").staleReason, "auto_refresh_disabled");
});

test("代號正規化可對齊 TWSE MIS 與持股代號", () => {
  assert.equal(core.normalizeCode("tse_0050.tw"), "0050");
  assert.equal(core.normalizeCode(" 00631l "), "00631L");
});

test("缺行情不會用 0 補值或把缺失誤認為 stale quote", () => {
  const result = core.calculatePortfolio([holding("0050")], new Map(), {now: NOW});
  assert.equal(result.rows[0].quote, null);
  assert.equal(result.rows[0].marketValue, null);
  assert.equal(result.rows[0].todayPnl, null);
  assert.equal(JSON.stringify(result).includes("NaN"), false);
});

process.stdout.write(`\n${passed} portfolio quote freshness P0 tests passed.\n`);
