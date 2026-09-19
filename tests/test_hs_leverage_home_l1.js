const assert = require("node:assert/strict");
const fs = require("node:fs");

const html = fs.readFileSync("index.html", "utf8");
const css = fs.readFileSync("formal-black-gold.css", "utf8");
const core = fs.readFileSync("leverage-v1-core.js", "utf8");

assert.match(html, /id="homeLeverageBrief"[\s\S]*?HS LEVERAGE[\s\S]*?00631L 槓桿戰術雷達/);
assert.doesNotMatch(html, /id="homeSwingBrief"/);
assert.match(html, /<script src="leverage-v1-core\.js\?v=20260822-l1"><\/script>/);
assert.match(html, /function leverageV1State\(item\)/);
assert.match(html, /function leverageHomeCompactCard\(item\)/);
assert.match(html, /獨立策略｜不納入 C4 排名/);
assert.match(html, /5D 急跌速度/);
assert.match(html, /戰術觀察/);
assert.match(html, /5D 急跌速度相對觸發門檻/);
assert.match(html, /等待極端急跌訊號/);
assert.match(html, /\$\("#homeLeverageCard"\)\.innerHTML=leverageHomeCompactCard\(all\.find\(x=>x\.id==="00631L"\)\)/);

const renderTop = html.slice(html.lastIndexOf("function renderTop(){"));
const leverageRenderer = html.slice(html.indexOf("function leverageV1State"), html.indexOf("function renderTop(){", html.indexOf("function leverageV1State")));
assert.match(renderTop, /swingIds=new Set\(\["00733","006201"\]\)/);
assert.doesNotMatch(renderTop, /swingIds=new Set\(\[[^\]]*"00631L"/);
assert.match(html.slice(html.indexOf("function todayBuyDecisionText"), html.indexOf("function priceFlashClass")), /swingIds=new Set\(\["00733","006201"\]\)/);
assert.doesNotMatch(leverageRenderer, /appendForward|recordForward|saveTradeState|localStorage/);

assert.match(css, /#homeLeverageBrief\{/);
assert.match(css, /\.hsLeverageCard\{/);
assert.match(css, /\.hsLeverageV1\{/);
assert.match(css, /\.hsLeverageTactical\{/);
assert.match(css, /\.hsLeverageForward\{/);
assert.match(css, /@media\(max-width:430px\).*\.hsLeverageCard/s);

assert.doesNotMatch(core, /localStorage|appendForward|recordForward|saveTradeState/);
console.log("HS LEVERAGE home separation and render contract: PASS");
