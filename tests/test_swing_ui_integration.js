const assert = require("assert");
const fs = require("fs");

const html = fs.readFileSync("index.html","utf8");
const css = fs.readFileSync("v62-tech.css","utf8");

assert.match(html,/swing-strategy-core\.js/);
assert.match(html,/strategyMode:"swing00733"/);
assert.match(html,/strategyMode:"swing006201"/);
assert.match(html,/applyDedicatedSwingModels\(\)/);
assert.match(html,/00733｜強勢趨勢拉回/);
assert.match(html,/006201｜上櫃低檔轉折/);
assert.match(html,/Raw／Final Score/);
assert.match(html,/Exit Pressure/);
assert.match(html,/MA20／60／200/);
assert.match(html,/MA43／87／284/);
assert.match(html,/HS Swing Radar V1\.2\.1 Beta Validated Frozen/);
assert.match(html,/recordForwardSwingSignal/);
assert.match(html,/rawScore:result\.rawBuyScore/);
assert.match(html,/marketStatus:/);
const portfolio = fs.readFileSync("portfolio-v6.js","utf8");
assert.match(portfolio,/Trade ID/);
assert.match(portfolio,/買點／出場壓力/);
assert.match(portfolio,/cooldownRemaining/);

const visibleHomeOrder = ["todayHighlights","homeSentiment","homeEtfBrief","homeSwingBrief"];
let cursor = -1;
for (const id of visibleHomeOrder) {
  const next = html.indexOf(`id="${id}"`);
  assert.ok(next > cursor, `${id} should be in fixed home order`);
  cursor = next;
}
assert.match(html,/class="dashboard tabHidden" data-tab-section="more"/);
assert.match(html,/data-tab="more"[\s\S]{0,120}<span>我的<\/span>/);
assert.match(css,/strategy-swing00733/);
assert.match(css,/strategy-swing006201/);
assert.match(css,/todayHighlightsGrid/);
assert.match(css,/@media\(max-width:760px\)[\s\S]*todayHighlightsGrid\{grid-template-columns:repeat\(2/);

const inlineScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
for (const script of inlineScripts) new Function(script);

console.log("PASS dedicated swing UI integration and four-section homepage");
