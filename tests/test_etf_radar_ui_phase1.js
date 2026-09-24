const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");

const root=path.resolve(__dirname,"..");
const html=fs.readFileSync(path.join(root,"index.html"),"utf8");
const css=fs.readFileSync(path.join(root,"formal-black-gold.css"),"utf8");
const signalsStart=html.indexOf('<section id="signals"');
const signals=html.slice(signalsStart,html.indexOf('<footer',signalsStart));

assert(signals.indexOf('class="radarPageHeader"')<signals.indexOf('class="radarModeLauncher"'));
assert(signals.indexOf('class="radarModeLauncher"')<signals.indexOf('id="radarOverview"'));
assert.equal((signals.match(/data-radar-mode=/g)||[]).length,2);
assert.doesNotMatch(signals,/class="radarSegments"/);
assert.doesNotMatch(signals,/id="radarModeContext"/);

assert.match(signals,/資料更新｜—[\s\S]*ETF 雷達[\s\S]*精選標的與自選 ETF 的訊號總覽/);
assert.match(signals,/data-radar-mode="featured"[^>]*>[\s\S]*?<strong>弘昇精選<\/strong>/);
assert.match(signals,/data-radar-mode="my"[^>]*>[\s\S]*?<strong>我的自選<\/strong>/);
assert.match(html,/let radarMode="featured";/);
assert.match(html,/\$\("#watchPanel"\)\.hidden=!isMy/);
assert.match(html,/追蹤你關注標的的趨勢與 HS C4 訊號/);
assert.doesNotMatch(html,/\$\("#radarModeContext"\)|\$\("#radarModeBadge"\)|\$\("#radarModeHeading"\)|\$\("#radarModeDescription"\)/);

assert.match(css,/\.hsSelectBadge/);
assert.match(css,/\.radarModeCardFeatured\.active/);
assert.match(css,/\.radarModeCardWatchlist\.active/);
assert.match(css,/@media\(max-width:760px\)[\s\S]*\.radarModeLauncher\{grid-template-columns:1fr/);
assert.match(css,/#signals \.radarModeLauncher\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
assert.doesNotMatch(signals,/class="panel signalLegend"/);
assert.match(css,/@media\(max-width:430px\)[\s\S]*\.radarModeCardFeatured::after\{display:none\}/);

console.log("PASS ETF Radar UI Phase 1 hierarchy and branding");
