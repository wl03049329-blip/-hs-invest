const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const universe = JSON.parse(fs.readFileSync(path.join(root, "etf-universe.json"), "utf8"));
const events = JSON.parse(fs.readFileSync(path.join(root, "market-events.json"), "utf8"));

assert.match(html, /id:"00935",name:"野村臺灣新科技50"/);
assert.match(html, /弘昇精選固定追蹤 6 檔 ETF/);
assert.match(html, /slice\(0,20\)/);
assert.match(html, /hs_etf_universe_cache_v1/);
assert.match(html, /ETF清單資料可能過期/);
assert.match(html, /\^\[0-9A-Z\]\{4,10\}\$/);
assert.match(html, /模型可用資料/);
assert.match(html, /技術低檔程度/);
assert.match(html, /估值吸引力/);
assert.match(html, /盤中試算買點/);
assert.match(html, /盤後正式買點/);
assert.match(html, /盤中模型資料覆蓋率/);
assert.match(html, /估值尚未納入正式分數/);
assert.match(html, /valuation-core\.js/);
assert.match(html, /intraday-buy-point-core\.js/);
assert.match(html, /同類型前/);
assert.match(html, /低於 70%/);

for (const tab of ["overview", "mood", "institutions", "futures", "events"]) {
  assert.match(html, new RegExp(`data-chip-tab="${tab}"`));
  assert.match(html, new RegExp(`data-chip-panel="${tab}"`));
}
assert.match(html, /hs_chip_tab_v1/);
assert.match(html, /scrollIntoView\(\{behavior:"smooth",block:"start"\}\)/);
assert.match(html, /即將公布/);
assert.match(html, /已公布結果/);
assert.match(html, /查看最近 90 天歷史事件/);
assert.match(html, /data-custom-result/);

assert.ok(universe.total >= 300);
assert.ok(universe.items.some(item => item.code === "00935"));
assert.ok(events.items.some(item => item.status === "announced" && item.official_source_url));
assert.match(html, /n!==null&&n!==undefined&&n!==""&&Number\.isFinite/);
assert.match(html, /Number\.isFinite\(x\.score\)/);
assert.match(html, /不以 0 代替/);

console.log("PASS ETF universe, six featured funds, model UI, event results and chip tabs integration");
