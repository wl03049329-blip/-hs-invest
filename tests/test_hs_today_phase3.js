const assert = require("node:assert/strict");
const fs = require("node:fs");
const decision = require("../hs-decision-layer-v1.js");
const html = fs.readFileSync("index.html", "utf8");

assert.doesNotMatch(html, /hsDashboardDetails|hsTodaySummary|查看完整長期加碼決策|radarCurrentSlot|radarNextSlot|id="rankList"|\$\("#rankList"\)|renderHSToday\(/);
assert.match(html, /id="hsDashboardC4Grid"/);
assert.match(html, /c4Grid\.innerHTML=decisionCenterC4Cards\(dashboardOfficialRows,longs,dualTrack\)/);
assert.match(html, /const longIds=new Set\(\["0050","00830","00662","00757","009815","00935"\]\)/);
for (const key of ["score", "change", "threshold"]) assert.match(html, new RegExp('data-home-c4-sort="' + key + '"'));
assert.match(html, /renderHomeDataHealth\(dualTrack,health\)/);
assert.match(html, /id="lc4-radar-v2"/);
assert.match(html, /描述性研究，非正式買進訊號/);
assert.match(html, /radarOverviewCurrent/);
assert.deepEqual(decision.NEXT_THRESHOLDS, [30, 40, 45, 50, 65, 70, 80, 90]);
console.log("Legacy homepage retired; current C4, validation and research contracts: PASS");
