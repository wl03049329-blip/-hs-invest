const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");

const root=path.resolve(__dirname,"..");
const html=fs.readFileSync(path.join(root,"index.html"),"utf8");
const css=fs.readFileSync(path.join(root,"formal-black-gold.css"),"utf8");
const signalsStart=html.indexOf('<section id="signals"');
const signals=html.slice(signalsStart,html.indexOf('<footer',signalsStart));

assert(signals.indexOf('class="radarPageHeader"')<signals.indexOf('class="radarModeLauncher"'));
assert(signals.indexOf('class="radarModeLauncher"')<signals.indexOf('id="radarModeContext"'));
assert(signals.indexOf('id="radarModeContext"')<signals.indexOf('id="radarOverview"'));
assert.equal((signals.match(/data-radar-mode=/g)||[]).length,2);
assert.doesNotMatch(signals,/class="radarSegments"/);

assert.match(signals,/ETF RADAR[\s\S]*ETF 雷達[\s\S]*快速查看 HS 精選標的與你的自選 ETF/);
assert.match(signals,/hsSelectBadge">HS SELECT<[\s\S]*弘昇精選[\s\S]*弘昇長期追蹤、研究與模型驗證的 ETF/);
assert.match(signals,/watchlistBadge">MY WATCHLIST<[\s\S]*我的自選[\s\S]*查看趨勢、拉回、動能與相對強弱狀態/);
assert.match(html,/let radarMode="featured";/);
assert.match(html,/\$\("#watchPanel"\)\.hidden=!isMy/);
assert.match(html,/加入你想追蹤的 ETF，查看趨勢、拉回、動能與相對強弱狀態。最多可加入 20 檔。/);

assert.match(css,/\.hsSelectBadge/);
assert.match(css,/\.radarModeCardFeatured\.active/);
assert.match(css,/\.radarModeCardWatchlist\.active/);
assert.match(css,/@media\(max-width:760px\)[\s\S]*\.radarModeLauncher\{grid-template-columns:1fr/);
assert.match(css,/#signals>\.signalLegend\{order:8\}/);

console.log("PASS ETF Radar UI Phase 1 hierarchy and branding");
