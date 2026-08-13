const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const ui = fs.readFileSync(path.join(root, "portfolio-v6.js"), "utf8");
const css = fs.readFileSync(path.join(root, "portfolio-v6.css"), "utf8");
const marketUi = fs.readFileSync(path.join(root, "market-ui-core.js"), "utf8");
const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "update-market-quotes.yml"), "utf8");
const quoteJson = JSON.parse(fs.readFileSync(path.join(root, "market-quotes.json"), "utf8"));
const quoteMeta = JSON.parse(fs.readFileSync(path.join(root, "market-quotes-meta.json"), "utf8"));
const live = fs.readFileSync(path.join(root,"live-market-core.js"),"utf8");

const checks = [];
function check(name, fn) {
  fn();
  checks.push(name);
  process.stdout.write(`PASS ${name}\n`);
}

check("Version 6.2 品牌與五個正式分頁", () => {
  assert.match(html, /HS｜ETF股市雷達/);
  assert.match(html, /VERSION 6\.2/);
  assert.match(html, /data-tab="signals"[^>]*>[\s\S]*?<span>ETF雷達<\/span><\/button>/);
  for (const tab of ["today", "signals", "portfolio", "sentiment", "more"]) {
    assert.match(html, new RegExp(`data-tab="${tab}"`));
  }
  assert.doesNotMatch(html, /data-tab="trump"/);
  assert.match(html, /data-chip-panel="events"[^>]*>[\s\S]*?id="trump-watch"/);
});

check("首頁內嵌程式可通過語法解析", () => {
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1])
    .filter(source => source.trim());
  assert.ok(scripts.length > 0);
  for (const source of scripts) assert.doesNotThrow(() => new Function(source));
});

check("持股隱私與裝置遺失提示", () => {
  assert.match(html, /持股資料只儲存在此裝置，不會上傳或公開/);
  assert.match(html, /換手機、清除瀏覽器資料或使用無痕模式時/);
});

check("持股資料僅寫入 localStorage 且未放進網址", () => {
  assert.match(ui, /localStorage\.setItem\(HOLDINGS_KEY/);
  assert.doesNotMatch(ui, /URLSearchParams|history\.pushState|history\.replaceState|location\.search/);
  assert.doesNotMatch(ui, /sendBeacon|gtag|analytics|fetch\([^)]*holdings/i);
  assert.doesNotMatch(ui, /console\./);
});

check("行情請求使用整批固定網址，不包含持股代號", () => {
  assert.match(ui, /STOCK_DAY_ALL/);
  assert.match(ui, /tpex_mainboard_quotes/);
  assert.match(ui, /market-quotes\.json/);
  assert.match(ui, /market-quotes-meta\.json/);
  assert.doesNotMatch(ui, /data_id.*item\.code|ex_ch.*holdings/);
});

check("延遲行情更新、節流、退避與背景頁處理", () => {
  assert.match(live, /15\*60\*1000/);
  assert.match(html, /visibilitychange/);
  assert.match(html, /liveQuoteInFlight/);
  assert.match(ui, /行情更新失敗，已保留最後資料/);
  assert.doesNotMatch(html + ui + css, /即時行情/);
});

check("首頁五項情緒精簡卡片可切換籌碼頁", () => {
  assert.match(html, /id="homeCnnCard"/);
  for (const id of ["homeMarginBalanceCard", "homeMaintenanceCard", "homeForeignFuturesCard", "homeTmfRatioCard"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /data-home-chip/);
});

check("首頁固定四區順序且市場摘要移至我的頁", () => {
  const highlightsIndex = html.indexOf('id="todayHighlights"');
  const sentimentIndex = html.indexOf('id="homeSentiment"');
  const briefIndex = html.indexOf('id="homeEtfBrief"');
  const swingIndex = html.indexOf('id="homeSwingBrief"');
  assert.ok(highlightsIndex > 0 && highlightsIndex < sentimentIndex);
  assert.ok(sentimentIndex < briefIndex && briefIndex < swingIndex);
  assert.match(html, /class="dashboard tabHidden" data-tab-section="more"/);
});

check("市場摘要預設精簡且完整內容可展開", () => {
  assert.match(html, /<summary>展開完整摘要<\/summary>/);
  assert.match(html, /id="marketFullSummary"/);
  assert.match(html, /id="newsList"/);
  assert.doesNotMatch(html, /id="homeMarketOverview"/);
  assert.match(html, /上漲檔數/);
  assert.match(html, /下跌檔數/);
});

check("買點外框同時提供文字標籤與說明", () => {
  for (const text of ["等待", "加碼觀察", "更佳買點", "強力超賣", "極度超賣"]) {
    assert.match(html + marketUi, new RegExp(text));
  }
  assert.match(html, /外框顏色代表什麼？/);
  assert.match(html, /不等於直接買進訊號/);
  assert.match(html, /data-signal-level/);
  assert.match(html, /aria-label="外框分類/);
});

check("下探與回升文字正確且卡片不顯示必買", () => {
  assert.match(marketUi, /超賣但尚未止跌/);
  assert.match(marketUi, /超賣後回升/);
  const renderCards = html.slice(html.indexOf("function renderCards"), html.indexOf("function formatYi"));
  assert.doesNotMatch(renderCards, /必買/);
  assert.match(renderCards, /buyStage\.conclusion/);
});

check("原有主要功能仍在", () => {
  for (const marker of ["watchList", "cards", "cnnFearGreedContent", "fomoContent", "institutionContent", "trumpContent"]) {
    assert.match(html, new RegExp(`id="${marker}"`));
  }
  assert.doesNotMatch(html, /id="compare"/);
});

check("可及性與手機斷點", () => {
  assert.match(html, /aria-label="主要分頁"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /tabindex="0"/);
  for (const width of ["760px", "430px", "375px"]) assert.match(css, new RegExp(width.replace(".", "\\.")));
});

check("行情 JSON 結構與價格有效", () => {
  assert.equal(quoteJson.version, 2);
  assert.ok(Number.isFinite(Date.parse(quoteJson.updated_at)));
  assert.ok(quoteJson.items.length > 1000);
  assert.equal(quoteMeta.updated_at, quoteJson.updated_at);
  assert.equal(quoteMeta.item_count, quoteJson.items.length);
  for (const item of quoteJson.items) {
    assert.match(item.code, /^[0-9A-Z]{4,10}$/);
    assert.ok(Number.isFinite(item.price) && item.price > 0);
    assert.match(item.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(["delayed", "close"].includes(item.quote_mode));
  }
});

check("Actions 以固定排程更新同源行情", () => {
  assert.match(workflow, /cron: "25 0 \* \* 1-5"/);
  assert.match(workflow, /scripts\/run_intraday_radar_session\.py/);
  const sessionRunner = fs.readFileSync(path.join(root, "scripts", "run_intraday_radar_session.py"), "utf8");
  assert.match(sessionRunner, /"market-quotes\.json"[\s\S]*"market-quotes-meta\.json"[\s\S]*"market-overview\.json"[\s\S]*"tx-futures-quote\.json"/);
});

process.stdout.write(`\n${checks.length} V6 integration tests passed.\n`);
