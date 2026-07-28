const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const ui = fs.readFileSync(path.join(root, "portfolio-v6.js"), "utf8");
const css = fs.readFileSync(path.join(root, "portfolio-v6.css"), "utf8");
const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "update-market-quotes.yml"), "utf8");
const quoteJson = JSON.parse(fs.readFileSync(path.join(root, "market-quotes.json"), "utf8"));
const quoteMeta = JSON.parse(fs.readFileSync(path.join(root, "market-quotes-meta.json"), "utf8"));

const checks = [];
function check(name, fn) {
  fn();
  checks.push(name);
  process.stdout.write(`PASS ${name}\n`);
}

check("Version 6.0 與六個頂部分頁", () => {
  assert.match(html, /VERSION 6\.0/);
  for (const tab of ["today", "signals", "portfolio", "sentiment", "trump", "more"]) {
    assert.match(html, new RegExp(`data-tab="${tab}"`));
  }
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
  assert.match(ui, /60000/);
  assert.match(ui, /900000/);
  assert.match(ui, /visibilitychange/);
  assert.match(ui, /refreshInFlight/);
  assert.match(ui, /行情更新失敗，已保留最後資料/);
  assert.doesNotMatch(html + ui + css, /即時行情/);
});

check("首頁 CNN 與 FOMO 精簡卡片可切換籌碼頁", () => {
  assert.match(html, /id="homeCnnCard"/);
  assert.match(html, /id="homeFomoCard"/);
  assert.match(ui, /switchTab\("sentiment"\)/);
});

check("原有主要功能仍在", () => {
  for (const marker of ["watchList", "cards", "cnnFearGreedContent", "fomoContent", "institutionContent", "trumpContent", "compare"]) {
    assert.match(html, new RegExp(`id="${marker}"`));
  }
});

check("可及性與手機斷點", () => {
  assert.match(html, /aria-label="主要分頁"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /tabindex="0"/);
  for (const width of ["760px", "430px", "375px"]) assert.match(css, new RegExp(width.replace(".", "\\.")));
});

check("行情 JSON 結構與價格有效", () => {
  assert.equal(quoteJson.version, 1);
  assert.ok(Number.isFinite(Date.parse(quoteJson.updated_at)));
  assert.ok(quoteJson.items.length > 1000);
  assert.equal(quoteMeta.updated_at, quoteJson.updated_at);
  assert.equal(quoteMeta.item_count, quoteJson.items.length);
  for (const item of quoteJson.items) {
    assert.match(item.code, /^[0-9A-Z]{4,10}$/);
    assert.ok(Number.isFinite(item.price) && item.price > 0);
    assert.match(item.date, /^\d{4}-\d{2}-\d{2}$/);
  }
});

check("Actions 以固定排程更新同源行情", () => {
  assert.match(workflow, /cron: "\*\/5 1-6 \* \* 1-5"/);
  assert.match(workflow, /scripts\/update_market_quotes\.py/);
  assert.match(workflow, /git add market-quotes\.json market-quotes-meta\.json/);
});

process.stdout.write(`\n${checks.length} V6 integration tests passed.\n`);
