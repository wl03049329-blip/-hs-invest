const assert = require("node:assert/strict");
const fs = require("node:fs");

const html = fs.readFileSync("index.html", "utf8");
const css = fs.readFileSync("formal-black-gold.css", "utf8");
const core = fs.readFileSync("leverage-v1-core.js", "utf8");

assert.match(html, /id="homeLeverageBrief"[\s\S]*?HS LEVERAGE[\s\S]*?00631L 槓桿戰術雷達/);
assert.ok(html.indexOf('id="homeLeverageBrief"') < html.indexOf('id="homeSwingBrief"'));
assert.match(html, /<script src="leverage-v1-core\.js\?v=20260822-l1"><\/script>/);
assert.match(html, /function leverageV1State\(item\)/);
assert.match(html, /function leverageHomeCard\(item\)/);
assert.match(html, /正式 V1/);
assert.match(html, /5D Crash Velocity/);
assert.match(html, /戰術觀察/);
assert.match(html, /FORWARD SHADOW/);
assert.match(html, /Frozen threshold \$\{threshold\}/);
assert.match(html, /String\(v1\.threshold\)/);
assert.match(html, /Crash Velocity 資料不足，正式訊號維持 FAIL CLOSED/);
assert.match(html, /\$\("#homeLeverageCard"\)\.innerHTML=leverageHomeCard\(all\.find\(x=>x\.id==="00631L"\)\)/);

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
