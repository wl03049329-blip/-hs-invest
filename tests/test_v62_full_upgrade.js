const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const read = name => fs.readFileSync(path.join(root, name), "utf8");
const html = read("index.html");
const tech = read("v62-tech.css");
const strategy = read("strategy-mode-core.js");
const valuation = JSON.parse(read("etf-valuation.json"));
const proxies = JSON.parse(read("valuation-proxy-map.json"));
const commodities = JSON.parse(read("commodity-quotes.json"));

assert.match(html, /class="brandLogo"/);
assert.match(html, /assets\/icon-192\.png/);
assert.match(html, /apple-touch-icon\.png/);
assert.match(html, /site\.webmanifest/);
for (const file of ["assets/hs-etf-radar-mark.svg", "assets/icon-192.png", "assets/icon-512.png", "assets/apple-touch-icon.png"]) {
  assert.ok(fs.statSync(path.join(root, file)).size > 200, `${file} missing`);
}
assert.match(tech, /--bg:#050609/);
assert.doesNotMatch(`${tech}\n${html.slice(0, 2500)}`, /#06100c|#0c1a14/);
assert.match(html, /bottomNavButton appNavButton/);
assert.match(html, /黃金/);
assert.match(html, /布蘭特原油/);
assert.doesNotMatch(html, /杜蘭特原油/);
assert.match(html, /今天怎麼買/);
assert.match(html, /homeMovingAverageStates/);
assert.match(html, /技術.*估值.*止跌/);
assert.match(html, /長期核心加碼/);
assert.match(html, /波段進場/);

for (const code of ["0050", "00830", "00662", "009815", "00935"]) {
  assert.ok(proxies.items[code], `${code} proxy missing`);
  assert.ok(valuation.items[code], `${code} valuation missing`);
  assert.notEqual(valuation.items[code].current_pe, 0);
}
assert.equal(proxies.items["009815"].benchmark, "彭博TPEx Magnificent 7 Plus美國大型科技指數");
assert.equal(proxies.items["00830"].primary_proxy, "SOXQ");
assert.equal(proxies.items["00662"].primary_proxy, "QQQ");
assert.match(strategy, /long_term_core/);
assert.match(strategy, /swing/);
assert.match(strategy, /stopConfirmation: 5/);
assert.match(strategy, /stopConfirmation: 30/);

for (const key of ["gold", "brent"]) {
  const item = commodities.items[key];
  assert.ok(item && Number.isFinite(item.value) && item.value > 0);
  assert.ok(Number.isFinite(item.change_pct));
  assert.match(item.source_name, /Twelve Data|舊版最後成功快取/);
}
for (const tab of ["overview", "mood", "margin", "institutions", "futures", "events"]) {
  assert.match(html, new RegExp(`data-chip-tab="${tab}"`));
}
assert.match(html, /tariff_rate/);
assert.match(html, /affected_scope/);
assert.match(html, /effective_date/);
assert.match(html, /中性摘要/);
assert.doesNotMatch(html, />\s*(?:NaN|undefined|Infinity)\s*</);
for (const width of [375, 390, 430]) assert.match(tech, new RegExp(width === 430 ? "max-width:430px" : "max-width:760px"));

console.log("PASS v6.2 black UI, brand, commodities, strategy, valuation, chip tabs and event results integration");
