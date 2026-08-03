const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const core = require("../portfolio-core.js");
const live = require("../live-market-core.js");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const quotes = fs.readFileSync(path.join(root, "portfolio-v6.js"), "utf8");
const css = fs.readFileSync(path.join(root, "portfolio-v6.css"), "utf8");
const liveSource = fs.readFileSync(path.join(root, "live-market-core.js"), "utf8");
const production = html + quotes + css + liveSource;

function check(name, fn) {
  fn();
  process.stdout.write(`PASS ${name}\n`);
}

check("台北盤中時段邊界", () => {
  assert.equal(core.isTaipeiMarketOpen(new Date("2026-07-29T01:00:00Z")), true);
  assert.equal(core.isTaipeiMarketOpen(new Date("2026-07-29T05:30:00Z")), true);
  assert.equal(core.isTaipeiMarketOpen(new Date("2026-07-29T05:31:00Z")), false);
  assert.equal(core.isTaipeiMarketOpen(new Date("2026-08-01T02:00:00Z")), false);
});

check("首頁延遲行情標示完整", () => {
  assert.match(html, /動態行情｜盤中 15～30 秒檢查｜來源時間為準｜僅供參考/);
  assert.match(html, /延遲行情｜最後成功更新/);
  assert.doesNotMatch(production, /即時行情/);
});

check("盤中 20 秒調度且只有首頁單一行情計時器", () => {
  assert.equal(live.pollDelay({spotActive:true}),20000);
  assert.match(html, /let liveQuoteTimer=null/);
  assert.match(html, /if\(liveQuoteInFlight\)/);
  assert.match(html, /liveQuoteAbortController\?\.abort\(\)/);
  const scheduler = quotes.slice(quotes.indexOf("function scheduleNext"), quotes.indexOf("async function updateQuotes"));
  assert.doesNotMatch(scheduler, /setTimeout/);
});

check("首頁、買點與持股共用同一批行情", () => {
  assert.match(quotes, /publicQuoteMap/);
  assert.match(quotes, /hs:delayed-quotes/);
  assert.match(html, /applyHomeDelayedQuotes/);
  assert.match(html, /renderMarket\(\)/);
  assert.match(html, /renderTop\(\)/);
  assert.match(html, /renderCards\(\)/);
  assert.match(quotes, /renderPortfolio\(true\)/);
});

check("失敗保留最後資料", () => {
  assert.match(html, /更新失敗，已保留最後資料/);
  assert.match(quotes, /更新失敗，已保留最後資料/);
  assert.match(quotes, /hs:delayed-quotes-error/);
});

check("背景暫停並在前景強制更新", () => {
  assert.match(html, /visibilitychange/);
  assert.match(html, /clearTimeout\(cnnPollTimer\)/);
  assert.match(html, /clearTimeout\(liveQuoteTimer\)/);
  assert.match(html, /refreshLiveQuotes\(\{force:true\}\)/);
});

check("CNN 每 20 分鐘更新且失敗保留", () => {
  assert.match(html, /CNN_POLL_INTERVAL=20\*60\*1000/);
  assert.match(html, /cnnPollInFlight/);
  assert.match(html, /preserveOnFailure/);
  assert.match(html, /cnnFearGreed=preserveOnFailure\?previous:null/);
});

check("FOMO 與三大法人清楚標示盤後資料", () => {
  assert.match(html, /使用最近交易日盤後資料｜資料日期/);
  assert.match(html, /今日盤後更新｜盤中沿用最近交易日資料｜資料日期/);
});
