const assert = require("node:assert/strict");
const core = require("../portfolio-core.js");

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`PASS ${name}\n`);
}

const holding = (code, shares = 1000, averageCost = 50) => ({code, shares, averageCost, customName: "", name: code});
const quote = (price, previousClose = price - 1) => ({price, previousClose, name: "測試標的", date: "2026-07-28", fetchedAt: "2026-07-29T00:00:00Z"});

test("新增持股格式驗證", () => {
  assert.deepEqual(core.validateHolding(holding("0050")).code, "0050");
});

test("股票代號可包含英文字尾", () => {
  assert.equal(core.validateHolding(holding("00631L")).code, "00631L");
});

test("股數與均價必須大於 0", () => {
  assert.throws(() => core.validateHolding(holding("0050", 0, 50)), /股數/);
  assert.throws(() => core.validateHolding(holding("0050", 1, 0)), /平均成本/);
  assert.throws(() => core.validateHolding(holding("0050", "NaN", 50)), /股數/);
});

test("名稱移除控制字元與 HTML 特徵", () => {
  assert.equal(core.sanitizeName("<img onerror=1>\u0000 核心"), "img onerror=1 核心");
});

test("同代號合併採加權平均成本", () => {
  const merged = core.mergeHolding(holding("0050", 100, 50), holding("0050", 200, 65));
  assert.equal(merged.shares, 300);
  assert.equal(merged.averageCost, 60);
});

test("覆蓋資料可通過驗證", () => {
  const overwritten = core.validateHolding(holding("0050", 888, 72));
  assert.equal(overwritten.shares, 888);
  assert.equal(overwritten.averageCost, 72);
});

test("策略類型與目標配置只保存在本機持股資料", () => {
  const item = core.validateHolding({...holding("00733"), strategyType: "swing00733", targetAllocation: 25});
  assert.equal(item.strategyType, "swing00733");
  assert.equal(item.targetAllocation, 25);
  assert.throws(() => core.validateHolding({...holding("00733"), targetAllocation: 101}), /目標配置/);
});

test("目標配置總和不可超過 100%", () => {
  assert.equal(core.validateTargetAllocations([
    {...holding("00733"), targetAllocation: 40},
    {...holding("006201"), targetAllocation: 60}
  ]).ok, true);
  assert.equal(core.validateTargetAllocations([
    {...holding("00733"), targetAllocation: 60},
    {...holding("006201"), targetAllocation: 50}
  ]).ok, false);
});

test("強勢趨勢可啟用再平衡保護", () => {
  const result = core.rebalanceDecision({actualWeight: 35, targetAllocation: 25, trendProtected: true});
  assert.equal(result.state, "trend_protected");
  assert.match(result.label, /趨勢保護/);
});

test("匯入拒絕重複代號", () => {
  assert.throws(() => core.validateImportPayload({holdings: [holding("0050"), holding("0050")]}), /重複/);
});

test("匯入拒絕超過 30 檔", () => {
  const rows = Array.from({length: 31}, (_, index) => holding(String(1000 + index)));
  assert.throws(() => core.validateImportPayload({holdings: rows}), /最多 30/);
});

test("10、20、30 檔持股都合法", () => {
  for (const count of [10, 20, 30]) {
    const rows = Array.from({length: count}, (_, index) => holding(String(1000 + index)));
    assert.equal(core.validateImportPayload({holdings: rows}).length, count);
  }
});

test("今日與累積損益公式", () => {
  const result = core.calculatePortfolio([holding("0050", 1000, 50)], new Map([["0050", quote(60, 58)]]));
  assert.equal(result.complete, true);
  assert.equal(result.totalCost, 50000);
  assert.equal(result.totalMarketValue, 60000);
  assert.equal(result.totalPnl, 10000);
  assert.equal(result.returnRate, 20);
  assert.equal(result.todayPnl, 2000);
  assert.ok(Math.abs(result.todayRate - (2000 / 58000 * 100)) < 1e-10);
});

test("市值占比公式", () => {
  const result = core.calculatePortfolio(
    [holding("0050", 100, 50), holding("2330", 10, 100)],
    new Map([["0050", quote(60, 59)], ["2330", quote(600, 590)]])
  );
  assert.equal(result.rows[0].marketValue, 6000);
  assert.equal(result.rows[1].marketValue, 6000);
  assert.equal(result.rows[0].weight, 50);
  assert.equal(result.rows[1].weight, 50);
});

test("缺少個別行情不會被誤算為 0", () => {
  const result = core.calculatePortfolio(
    [holding("0050"), holding("2330")],
    new Map([["0050", quote(60, 59)]])
  );
  assert.equal(result.complete, false);
  assert.equal(result.totalMarketValue, null);
  assert.equal(result.rows[1].marketValue, null);
  assert.equal(result.rows[1].todayPnl, null);
});

test("缺少前收不會產生錯誤今日損益", () => {
  const result = core.calculatePortfolio([holding("0050")], new Map([["0050", quote(60, null)]]));
  assert.equal(result.complete, false);
  assert.equal(result.rows[0].todayPnl, null);
});

test("合法零損益保留為數值 0", () => {
  const result = core.calculatePortfolio([holding("0050", 100, 60)], new Map([["0050", quote(60, 60)]]));
  assert.equal(result.complete, true);
  assert.equal(result.todayPnl, 0);
  assert.equal(result.totalPnl, 0);
  assert.equal(result.returnRate, 0);
});

test("圓餅圖占比總和接近 100%", () => {
  const holdings = Array.from({length: 10}, (_, index) => holding(String(1000 + index), 100 + index, 10));
  const quotes = new Map(holdings.map((item, index) => [item.code, quote(20 + index, 19 + index)]));
  const result = core.calculatePortfolio(holdings, quotes);
  const allocation = core.buildAllocation(result.rows);
  assert.equal(allocation.length, 8);
  assert.equal(allocation.at(-1).code, "其他");
  assert.ok(Math.abs(allocation.reduce((sum, item) => sum + item.weight, 0) - 100) < 1e-9);
});

test("證交所整批行情解析", () => {
  const map = core.parseTwseRows([{Date: "1150728", Code: "0050", Name: "元大台灣50", ClosingPrice: "52.50", Change: "1.00"}], "2026-07-29T00:00:00Z");
  assert.equal(map.get("0050").price, 52.5);
  assert.equal(map.get("0050").previousClose, 51.5);
  assert.equal(map.get("0050").date, "2026-07-28");
});

test("櫃買中心整批行情解析", () => {
  const map = core.parseTpexRows([{Date: "1150728", SecuritiesCompanyCode: "00679B", CompanyName: "元大美債20年", Close: "27.10", Change: "-0.20"}], "2026-07-29T00:00:00Z");
  assert.equal(map.get("00679B").price, 27.1);
  assert.equal(map.get("00679B").previousClose, 27.3);
});

test("同源行情快取驗證與解析", () => {
  const map = core.parseCachedQuotes({
    updated_at: new Date().toISOString(),
    items: [{code: "0050", name: "元大台灣50", price: 52.5, previous_close: 51.5, high:53, low:51, volume:1234000, date: "2026-07-28", market: "TWSE", quote_mode:"delayed", quote_time:"10:30:00"}]
  });
  assert.equal(map.get("0050").price, 52.5);
  assert.equal(map.get("0050").high, 53);
  assert.equal(map.get("0050").low, 51);
  assert.equal(map.get("0050").volume, 1234000);
  assert.equal(map.get("0050").quoteMode, "delayed");
  assert.throws(() => core.parseCachedQuotes({updated_at: "2000-01-01T00:00:00Z", items: []}), /更新時間/);
});

test("無效行情列會被丟棄", () => {
  const map = core.parseTwseRows([{Date: "bad", Code: "0050", Name: "x", ClosingPrice: "--", Change: "--"}], "now");
  assert.equal(map.size, 0);
});

test("所有計算輸出不含 NaN 或 Infinity", () => {
  const result = core.calculatePortfolio([holding("0050")], new Map());
  const text = JSON.stringify(result);
  assert.equal(text.includes("NaN"), false);
  assert.equal(text.includes("Infinity"), false);
  assert.equal(text.includes("undefined"), false);
});

process.stdout.write(`\n${passed} portfolio core tests passed.\n`);
