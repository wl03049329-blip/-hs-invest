const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const portfolio = fs.readFileSync(path.join(root, "portfolio-v6.js"), "utf8");
const css = fs.readFileSync(path.join(root, "portfolio-v6.css"), "utf8");

assert.match(html, /HS \| ETF股市雷達 v6\.2/);
assert.match(html, /VERSION 6\.2/);
assert.match(html, /台股融資風險/);
assert.match(html, /margin-data\.json/);
assert.match(html, /使用最近交易日盤後資料/);
assert.match(html, /市場融資維持率僅用於觀察整體融資戶壓力/);
assert.match(html, /HSMarginRiskCore\.combineFear\(base,maintenanceFear,\.15\)/);
assert.match(portfolio, /餘額.*維持率/s);
assert.match(portfolio, /不以 0 代替/);
assert.match(css, /\.marginRiskGrid/);
assert.match(css, /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
assert.doesNotMatch(html, /融資維持率[^\n]{0,40}>0(?:\.0)?%/);

console.log("v6.2 margin integration tests passed");
