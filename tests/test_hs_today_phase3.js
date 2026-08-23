const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const html = fs.readFileSync("index.html", "utf8");
const css = fs.readFileSync("formal-black-gold.css", "utf8");
const decision = require("../hs-decision-layer-v1.js");

const between = (start, end) => {
  const from = html.indexOf(start);
  return html.slice(from, html.indexOf(end, from));
};
const today = between("function hsTodayFactorAdapter", "function renderTop");

// 1–2: Homepage uses the shared interpreter and does not create score rules.
assert.match(html, /<script src="hs-decision-layer-v1\.js\?v=20260823-dl1"><\/script>/);
assert.match(today, /interpreter\.interpret\(buildHSTodayDecisionInput\(item\)\)/);
assert.doesNotMatch(today, /HSFinalCoreProduction\.buildFinal|computeCoreScore|calculateWeekly|buildIntradayRadarBatch/);
assert.doesNotMatch(today, /score\s*(?:>=|<=|>|<)\s*\d/);

// 3–7: Candidate eligibility and deterministic ordering use Decision Layer output.
assert.match(today, /item\?\.id!=="00631L"/);
assert.match(today, /source_status==="SUCCESS"/);
assert.match(today, /decision_stage/);
assert.match(today, /distance_to_next_stage/);
assert.match(today, /Number\(b\.decision\.score\)-Number\(a\.decision\.score\)\|\|a\.index-b\.index/);
assert.match(today, /item\?\.id==="009815"[\s\S]*sourceStatus:"WAIT_NATIVE"/);
assert.match(today, /sourceStatus:"FAIL_CLOSED"/);

const candidateSource = html.slice(html.indexOf("function hsTodayStageRank"), html.indexOf("function hsTodayHeadline"));
const candidateSandbox = {window:{HSDecisionLayerV1:decision}};
vm.runInNewContext(candidateSource, candidateSandbox);
const row = (id, stage, distance, score, index, status = "SUCCESS") => ({item:{id}, index, decision:{source_status:status, decision_stage:stage, distance_to_next_stage:distance, score}});
assert.strictEqual(candidateSandbox.selectHSTodayCandidate([row("0050", "GENERAL", 11, 29, 0), row("00830", "SMALL_ADD", 7, 58, 1)]).item.id, "00830");
assert.strictEqual(candidateSandbox.selectHSTodayCandidate([row("0050", "SMALL_ADD", 7, 58, 0), row("00830", "SMALL_ADD", 3, 52, 1)]).item.id, "00830");
assert.strictEqual(candidateSandbox.selectHSTodayCandidate([row("0050", "SMALL_ADD", 3, 52, 0), row("00830", "SMALL_ADD", 3, 58, 1)]).item.id, "00830");
assert.strictEqual(candidateSandbox.selectHSTodayCandidate([row("0050", "SMALL_ADD", 3, 58, 0), row("00830", "SMALL_ADD", 3, 58, 1)]).item.id, "0050");
assert.strictEqual(candidateSandbox.selectHSTodayCandidate([row("00631L", "EXTREME_REFERENCE", 0, 90, 0), row("0050", "GENERAL", 11, 25, 1)]).item.id, "0050");
assert.strictEqual(candidateSandbox.selectHSTodayCandidate([row("009815", null, null, null, 0, "WAIT_NATIVE"), row("0050", null, null, null, 1, "FAIL_CLOSED")]), null);

// 8–12: UI only translates established Decision Layer fields.
assert.match(today, /decision\.distance_to_next_stage/);
assert.match(today, /DD52:"中期回檔幅度"/);
assert.match(today, /WEEKLY_J:"短期超賣程度"/);
assert.match(today, /CRASH:"急跌程度"/);
assert.match(today, /主要原因：目前無可比較基準/);
for (const wording of ["保留主要資金", "準備資金，等待條件成熟", "可小額部署，保留後續資金", "依紀律分批部署", "罕見行情，仍需分批與保留資金"]) assert.ok(today.includes(wording));
assert.doesNotMatch(today, /\d+\s*%/);

// 13–16: 00631L uses its independent V1 state; unavailable Core does not invent a candidate.
assert.match(today, /const state=leverageV1State\(item\)/);
assert.match(today, /state\?\.trigger\?"急跌條件已觸發":available\?"戰術待命":"資料尚未齊備"/);
assert.match(today, /00631L · HS LEVERAGE/);
assert.match(today, /資料尚未齊備，暫不提供今日決策摘要/);
assert.match(today, /source_status==="SUCCESS"/);

// 17–20: Existing HS LIVE path remains canonical, formal tiers remain owned elsewhere, and IDs stay unique.
assert.match(html, /function longRankRow\(x,index,previous,rank=index\+1\)/);
assert.match(html, /item\.intraday\?\.canonical/);
assert.match(html, /function coreStatusTier\(score,label=""\)/);
assert.strictEqual((html.match(/id="hsTodaySummary"/g) || []).length, 1);
assert.match(css, /#homeEtfBrief\.hsLivePanel \.hsTodaySummary/);

// Ensure the shared contract still owns all formal decision thresholds.
assert.deepStrictEqual(decision.NEXT_THRESHOLDS, [40, 50, 65, 70, 80, 90]);
console.log("HS TODAY Phase 3 integration contract: PASS");
