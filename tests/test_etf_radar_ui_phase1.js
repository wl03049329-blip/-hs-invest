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
assert.match(signals,/hsSelectBadge">HS SELECT<[\s\S]*弘昇精選[\s\S]*長期追蹤・研究模型驗證的 ETF[\s\S]*aria-hidden="true">›/);
assert.match(signals,/watchlistBadge">MY WATCHLIST<[\s\S]*我的自選[\s\S]*查看追蹤 ETF 的趨勢與訊號[\s\S]*aria-hidden="true">›/);
assert.match(html,/let radarMode="featured";/);
assert.match(html,/\$\("#watchPanel"\)\.hidden=!isMy/);
assert.match(html,/加入你想追蹤的 ETF，查看趨勢、拉回、動能與相對強弱狀態。最多可加入 20 檔。/);
assert.doesNotMatch(html,/\$\("#radarModeContext"\)|\$\("#radarModeBadge"\)|\$\("#radarModeHeading"\)|\$\("#radarModeDescription"\)/);

assert.match(css,/\.hsSelectBadge/);
assert.match(css,/\.radarModeCardFeatured\.active/);
assert.match(css,/\.radarModeCardWatchlist\.active/);
assert.match(css,/@media\(max-width:760px\)[\s\S]*\.radarModeLauncher\{grid-template-columns:1fr/);
assert.doesNotMatch(signals,/class="panel signalLegend"/);
assert.match(css,/@media\(max-width:430px\)[\s\S]*\.radarModeCardFeatured::after\{display:none\}/);

console.log("PASS ETF Radar UI Phase 1 hierarchy and branding");
