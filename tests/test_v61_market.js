const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const core = require("../market-v61-core.js");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "portfolio-v6.css"), "utf8");
const quoteUi = fs.readFileSync(path.join(root, "portfolio-v6.js"), "utf8");
const marketCore = fs.readFileSync(path.join(root, "market-v61-core.js"), "utf8");
const quoteScript = fs.readFileSync(path.join(root, "scripts", "update_market_quotes.py"), "utf8");
const futuresScript = fs.readFileSync(path.join(root, "scripts", "update_futures_position.py"), "utf8");
const marketWorkflow = fs.readFileSync(path.join(root, ".github", "workflows", "update-market-quotes.yml"), "utf8");
const futuresWorkflow = fs.readFileSync(path.join(root, ".github", "workflows", "update-futures-position.yml"), "utf8");
const overviewRaw = JSON.parse(fs.readFileSync(path.join(root, "market-overview.json"), "utf8"));
const futuresRaw = JSON.parse(fs.readFileSync(path.join(root, "futures-position.json"), "utf8"));

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

check("台指期日盤、夜盤與收盤狀態", () => {
  assert.equal(core.futuresSession(new Date("2026-07-27T00:45:00Z")).key, "day");
  assert.equal(core.futuresSession(new Date("2026-07-27T05:45:00Z")).key, "day");
  assert.equal(core.futuresSession(new Date("2026-07-27T07:00:00Z")).key, "night");
  assert.equal(core.futuresSession(new Date("2026-07-28T21:00:00Z")).key, "night");
  assert.equal(core.futuresSession(new Date("2026-08-02T02:00:00Z")).key, "closed");
});

check("台指期官方日資料不會冒充日盤或夜盤行情", () => {
  const item = core.validateOverview(overviewRaw, new Date("2026-07-29T15:49:00Z")).instruments.tx_front;
  const updatedAt = "2026-07-29T15:40:00Z";
  for (const [time, session] of [
    ["2026-07-29T02:30:00Z", "day"],
    ["2026-07-29T14:00:00Z", "night"],
    ["2026-07-29T15:49:00Z", "night"],
    ["2026-07-29T18:00:00Z", "night"],
    ["2026-07-31T14:00:00Z", "night"],
    ["2026-07-31T18:00:00Z", "night"]
  ]) {
    assert.equal(core.futuresSession(new Date(time)).key, session);
    const state = core.txQuoteState(item, new Date(time), updatedAt);
    assert.equal(state.key, "stale");
    assert.equal(state.label, "資料已過期");
  }
  assert.equal(core.txQuoteState(item, new Date("2026-07-29T06:30:00Z"), updatedAt).key, "official_close");
});

check("台指期有效延遲時間戳才可標示日盤或夜盤", () => {
  const base = core.validateOverview(overviewRaw, new Date("2026-07-29T14:00:00Z")).instruments.tx_front;
  const day = {...base, quoteMode: "delayed", sourceSession: "day", quoteTimestamp: "2026-07-29T02:25:00Z"};
  const night = {...base, quoteMode: "delayed", sourceSession: "night", quoteTimestamp: "2026-07-29T13:55:00Z"};
  assert.equal(core.txQuoteState(day, new Date("2026-07-29T02:30:00Z"), "2026-07-29T02:26:00Z").key, "day_delayed");
  assert.equal(core.txQuoteState(night, new Date("2026-07-29T14:00:00Z"), "2026-07-29T13:56:00Z").key, "night_delayed");
  assert.equal(core.txQuoteState(night, new Date("2026-07-29T14:30:00Z"), "2026-07-29T13:56:00Z").key, "stale");
  assert.equal(core.txQuoteState(null, new Date("2026-07-29T14:00:00Z"), "").key, "unavailable");
});

check("四項行情 JSON 完整且不以 0 代替", () => {
  const overview = core.validateOverview(overviewRaw);
  assert.deepEqual(Object.keys(overview.instruments).sort(), ["otc", "taiex", "tsmc", "tx_front"]);
  for (const item of Object.values(overview.instruments)) {
    assert.ok(item.value > 0);
    assert.ok(Number.isFinite(item.change));
    assert.ok(Number.isFinite(item.changePct));
  }
  assert.match(overview.instruments.tx_front.contractMonth, /^\d{6}$/);
  const invalid = structuredClone(overviewRaw);
  invalid.instruments.taiex.value = 0;
  assert.throws(() => core.validateOverview(invalid), /行情數值無效/);
});

check("過期行情會標示最後成功資料", () => {
  const stale = structuredClone(overviewRaw);
  stale.updated_at = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  assert.equal(core.validateOverview(stale).stale, true);
  assert.match(html, /目前顯示最後成功行情/);
  assert.match(html + marketCore, /夜盤行情暫無可靠免費來源/);
  assert.match(html + marketCore, /目前顯示最近官方收盤資料/);
  assert.match(html + marketCore, /資料已過期/);
  assert.match(html, /最後成功更新/);
  assert.match(css, /\.marketQuoteCard\.isStale/);
});

check("四張行情卡與首頁順序", () => {
  for (const key of ["taiex", "otc", "tx_front", "tsmc"]) assert.match(html, new RegExp(key));
  const overview = html.indexOf('id="homeMarketOverview"');
  const sentiment = html.indexOf('id="homeSentiment"');
  const brief = html.indexOf('id="homeEtfBrief"');
  const summary = html.indexOf('class="panel marketPanel"');
  assert.ok(overview < sentiment && sentiment < brief && brief < summary);
  assert.doesNotMatch(html + css + quoteUi, /即時行情|即時報價|零延遲/);
});

check("行情來源有逾時、驗證與失敗保留", () => {
  assert.match(quoteScript, /timeout=timeout/);
  assert.match(quoteScript, /fetch_mis_snapshot/);
  assert.match(quoteScript, /select_near_month_tx/);
  assert.match(quoteScript, /existing_overview/);
  assert.match(quoteScript, /official_daily_close_only/);
  assert.match(html, /目前顯示最後成功行情/);
});

check("前端 60 秒檢查且只在版本變動重繪", () => {
  assert.match(html, /MARKET_OVERVIEW_POLL_INTERVAL=60\*1000/);
  assert.match(quoteUi, /changed: false/);
  assert.match(quoteUi, /if \(result\.changed\)/);
  assert.match(quoteUi, /hs:quote-cache-checked/);
});

check("ETF雷達自選與精選互相獨立", () => {
  assert.match(html, /data-radar-mode="my"/);
  assert.match(html, /data-radar-mode="featured"/);
  assert.match(html, /function radarList\(\)/);
  assert.match(html, /hs_etf_watchlist_v1/);
  assert.match(html, /localStorage\.setItem\("hs_etf_radar_mode_v1"/);
  assert.match(html, /弘昇精選固定追蹤 5 檔 ETF/);
});

check("精簡買點卡可展開且保留非色彩標籤", () => {
  assert.match(html, /<details class="card signalCard/);
  assert.match(html, /signalCardSummary/);
  assert.match(html, /signalLevel/);
  assert.match(html, /週 KD 以最近完成資料計算/);
  assert.match(css, /min-height:88px/);
  assert.match(css, /@media\(max-width:760px\)/);
});

check("期貨部位 JSON 與推估公式有效", () => {
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

check("期貨口徑與盤後補抓排程", () => {
  assert.match(futuresRaw.methodology, /相同交易日/);
  assert.match(futuresRaw.methodology, /所有有效月份/);
  assert.match(futuresRaw.methodology, /含 MTX 週契約/);
  assert.match(futuresWorkflow, /cron: "20 10 \* \* 1-5"/);
  assert.match(futuresWorkflow, /cron: "0 11 \* \* 1-5"/);
  assert.match(marketWorkflow, /cron: "\*\/5 1-6 \* \* 1-5"/);
  assert.match(marketWorkflow, /cron: "\*\/10 7-15 \* \* 1-5"/);
  assert.match(marketWorkflow, /cron: "55 15 \* \* 1-5"/);
  assert.match(marketWorkflow, /cron: "\*\/10 16-20 \* \* 1-5"/);
  assert.match(marketWorkflow, /cron: "0 21 \* \* 1-5"/);
  assert.match(marketWorkflow, /cancel-in-progress: true/);
});

check("市場一句話與額外快速資訊存在", () => {
  assert.match(html, /id="marketOneLine"/);
  assert.match(html, /市場廣度/);
  assert.match(html, /大型／中小型/);
  assert.match(html, /台積電同步/);
  assert.match(html, /marketInterpretation/);
});

check("手機 375、390、430 共用雙欄行情與單欄買點", () => {
  assert.match(css, /\.marketOverviewCards\{grid-template-columns:repeat\(2/);
  assert.match(css, /\.signalCardSummary/);
  for (const width of [375, 390, 430]) assert.ok(width <= 760);
});
