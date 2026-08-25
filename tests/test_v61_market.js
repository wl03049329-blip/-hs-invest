const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const core = require("../market-v61-core.js");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "portfolio-v6.css"), "utf8");
const tech = fs.readFileSync(path.join(root, "v62-tech.css"), "utf8");
const quoteUi = fs.readFileSync(path.join(root, "portfolio-v6.js"), "utf8");
const quoteScript = fs.readFileSync(path.join(root, "scripts", "update_market_quotes.py"), "utf8");
const futuresScript = fs.readFileSync(path.join(root, "scripts", "update_futures_position.py"), "utf8");
const marketWorkflow = fs.readFileSync(path.join(root, ".github", "workflows", "update-market-quotes.yml"), "utf8");
const marketRunner = fs.readFileSync(path.join(root, "scripts", "run_intraday_radar_session.py"), "utf8");
const futuresWorkflow = fs.readFileSync(path.join(root, ".github", "workflows", "update-futures-position.yml"), "utf8");
const overviewRaw = JSON.parse(fs.readFileSync(path.join(root, "market-overview.json"), "utf8"));
const futuresRaw = JSON.parse(fs.readFileSync(path.join(root, "futures-position.json"), "utf8"));
const txRaw = JSON.parse(fs.readFileSync(path.join(root, "tx-futures-quote.json"), "utf8"));

function check(name, fn) {
  fn();
  process.stdout.write(`PASS ${name}\n`);
}

check("現貨盤中、收盤與休市狀態", () => {
  assert.equal(core.spotSession(new Date("2026-07-29T01:00:00Z"), "2026-07-29").key, "intraday");
  assert.equal(core.spotSession(new Date("2026-07-29T05:30:00Z"), "2026-07-29").key, "intraday");
  assert.equal(core.spotSession(new Date("2026-07-29T05:31:00Z"), "2026-07-29").key, "closed");
  assert.equal(core.spotSession(new Date("2026-08-01T02:00:00Z"), "2026-07-31").key, "holiday");
});

check("首頁行情 JSON 僅保留三項現貨且不以 0 代替", () => {
  const overview = core.validateOverview(overviewRaw);
  assert.deepEqual(Object.keys(overview.instruments).sort(), ["otc", "taiex", "tsmc"]);
  for (const item of Object.values(overview.instruments)) {
    assert.ok(item.value > 0);
    assert.ok(Number.isFinite(item.change));
    assert.ok(Number.isFinite(item.changePct));
  }
  const invalid = structuredClone(overviewRaw);
  invalid.instruments.taiex.value = 0;
  assert.throws(() => core.validateOverview(invalid), /行情數值無效/);
});

check("台指期僅保留於正式資料與籌碼，不在首頁冒充盤中行情", () => {
  assert.doesNotMatch(html, /id="homeMarketOverview"/);
  assert.doesNotMatch(JSON.stringify(overviewRaw), /tx_front|台指期近月/);
  const mainBlock = quoteScript.slice(quoteScript.indexOf("def main()"));
  assert.match(mainBlock, /TAIFEX_DAILY_URL|build_tx_fallback/);
  assert.equal(txRaw.authorized_intraday,false);
  assert.equal(txRaw.availability,"official_close_only");
  assert.match(txRaw.message,/需串接授權來源/);
  assert.match(futuresScript, /外資/);
  assert.match(html, /id="futuresPositionContent"/);
});

check("三項正式行情資料保留，首頁改以四個決策區塊呈現", () => {
  for (const key of ["taiex", "otc", "tsmc"]) assert.match(JSON.stringify(overviewRaw), new RegExp(key));
  assert.match(html, /id="todayHighlights"/);
  assert.match(html, /id="homeEtfBrief"/);
  const highlights = html.indexOf('id="todayHighlights"');
  const brief = html.indexOf('id="homeEtfBrief"');
  const sentiment = html.indexOf('id="homeSentiment"');
  const summary = html.indexOf('class="panel marketPanel"');
  assert.ok(highlights < sentiment && sentiment < brief && brief < summary);
  assert.doesNotMatch(html + css + quoteUi, /即時行情|即時報價|零延遲/);
});

check("行情來源有逾時、驗證與失敗保留", () => {
  assert.match(quoteScript, /timeout=timeout/);
  assert.match(quoteScript, /fetch_mis_snapshot/);
  assert.match(quoteScript, /existing_overview/);
  assert.match(html, /更新失敗，已保留最後資料/);
  assert.match(css, /\.marketQuoteCard\.isStale/);
});

check("前端單一 ETF 排名輪詢器且快取版本未變不重抓大檔", () => {
  assert.match(html, /scheduleLongRankRefresh/);
  assert.match(html, /metaTime!==liveMarketCacheVersion/);
  assert.match(html, /cache:"no-store"/);
  assert.match(html, /AbortController/);
  assert.match(html, /hs:quote-cache-checked/);
});

check("ETF雷達自選與精選互相獨立且使用 namespaced localStorage", () => {
  assert.match(html, /data-radar-mode="my"/);
  assert.match(html, /data-radar-mode="featured"/);
  assert.match(html, /function radarList\(\)/);
  assert.match(html, /HSStorage\.keys\.watchlist/);
  assert.match(html, /localStorage\.setItem\(RADAR_MODE_STORAGE_KEY/);
  assert.match(html, /弘昇精選固定追蹤 8 檔 ETF/);
});

check("精簡買點卡可展開且有非色彩訊號", () => {
  assert.match(html, /<details class="card signalCard/);
  assert.match(html, /signalCardSummary/);
  assert.match(html, /signalLevel/);
  assert.match(html, /歷史位置/);
  assert.match(html, /止跌確認/);
  assert.match(html, /市場環境/);
  assert.match(html, /歷史相似訊號統計/);
  assert.match(html, /分批買進地圖/);
  assert.match(css, /min-height:104px/);
  assert.match(css, /@media\(max-width:760px\)/);
});

check("期貨部位 JSON 與推估公式維持有效", () => {
  const futures = core.validateFuturesPosition(futuresRaw);
  for (const key of ["foreign_tx", "estimated_non_institutional_mtx", "estimated_non_institutional_tmf"]) {
    const item = futures[key];
    assert.equal(item.long - item.short, item.net);
    assert.ok(item.long >= 0 && item.short >= 0);
  }
  assert.equal(futures.sourceStatus.aligned, true);
  assert.match(futuresScript, /total - institutional_long/);
  assert.match(futuresScript, /total - institutional_short/);
  assert.match(futuresScript, /if estimated_long < 0 or estimated_short < 0/);
});

check("期貨籌碼官方來源多時段補抓保留，首頁正式 fallback 由同一 Actions 更新", () => {
  assert.match(futuresRaw.methodology, /相同交易日/);
  for (const cron of ["30 7 * * 1-5", "30 8 * * 1-5", "0 10 * * 1-5", "0 12 * * 1-5", "0 23 * * 0-4"]) {
    assert.ok(futuresWorkflow.includes(`cron: "${cron}"`));
  }
  assert.match(marketWorkflow, /cron: "27,30,35,40,45 1,2,3,4,5 \* \* 1-5"/);
  assert.match(marketWorkflow, /run_intraday_radar_session\.py/);
  assert.match(marketRunner, /tx-futures-quote\.json/);
  assert.doesNotMatch(marketWorkflow, /concurrency:/);
  assert.match(marketWorkflow, /needs: intraday/);
  assert.match(marketWorkflow, /if: \$\{\{ always\(\) \}\}/);
});

check("首頁重點與情緒結論存在", () => {
  assert.match(html, /id="todayHighlightsConclusion"/);
  assert.match(html, /id="homeSentimentConclusion"/);
  assert.match(html, /id="homeEtfBrief"/);
  assert.match(html, /id="homeSwingBrief"/);
});

check("手機 375、390、430 使用雙欄決策摘要與精簡買點", () => {
  assert.match(tech, /\.todayHighlightsGrid\{grid-template-columns:repeat\(2/);
  assert.match(css, /\.signalCardSummary/);
  for (const width of [375, 390, 430]) assert.ok(width <= 760);
});
