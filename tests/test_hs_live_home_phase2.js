const assert = require("assert");
const fs = require("fs");
const html = fs.readFileSync("index.html", "utf8");
const css = fs.readFileSync("formal-black-gold.css", "utf8");

assert.match(html, /HS LIVE · 盤中長期加碼雷達/);
assert.match(html, /長期加碼決策/);
assert.match(html, /id="hsLiveReadScore"[^>]+data-read-core-score/);
assert.match(html, /function hsLiveNextTier\(score\)/);
assert.match(html, /function hsLiveDriverSummary\(canonical\)/);
assert.match(html, /function hsLiveTimeline\(symbol,snapshot\)/);
assert.match(html, /liveCanonicalCoreSnapshots=canonicalCoreSnapshots/);
assert.match(html, /delta_vs_previous_close/);
assert.match(html, /data-core-score-history=/);
assert.match(html, /hsLiveRank rank-\$\{rank\}/);
assert.match(html, /WAIT_NATIVE；資料不夠，不假裝有正式 Core Score/);

const liveSection = html.slice(html.indexOf("function applyHomeDelayedQuotes"), html.indexOf("function renderMarket"));
assert.doesNotMatch(liveSection, /buildIntradayRadarBatch/);
assert.match(css, /#homeEtfBrief\.hsLivePanel/);
assert.match(css, /\.hsLiveGrid/);
assert.match(css, /\.hsLiveTimeline/);
assert.match(css, /\.hsLiveRank\.rank-1/);
assert.match(css, /\.hsLiveRank\.rank-2/);
assert.match(css, /\.hsLiveRank\.rank-3/);
assert.match(css, /\.hsLiveTier[^}]*font-size:11px/);
assert.match(css, /hsLiveCard>summary\{grid-template-columns:38px minmax\(0,1fr\) 104px/);
assert.match(css, /hsLiveRank\.rank-1\{border:1px solid transparent/);
assert.match(css, /hsLiveCard>summary\{grid-template-columns:42px minmax\(0,1fr\) 92px 116px;grid-template-areas:/);
assert.match(css, /hsLiveRank:not\(\.is-wait\)\{width:42px;height:52px/);
assert.match(css, /hsLiveTier\{min-height:30px;padding:7px 12px;font-size:12px/);
assert.match(html, /<span class="hsLiveRank rank-\$\{rank\}" aria-label="第\$\{rank\}名">\$\{String\(rank\)\}<\/span>/);
assert.match(css, /grid-template-areas:"rank identity score delta" "rank tier score open"/);
assert.match(css, /hsLiveRank:not\(\.is-wait\)\{width:40px;height:45px;font-size:30px/);
assert.match(css, /hsLiveScore>b\{font-size:42px/);
assert.match(css, /@media\(max-width:700px\)\{#homeEtfBrief\.hsLivePanel \.hsLiveGrid\{grid-template-columns:1fr/);
assert.match(css, /white-space:nowrap/);

console.log("HS LIVE Phase 2 UI contract: PASS");
