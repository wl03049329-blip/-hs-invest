#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const core = require("../final-core-production.js");
const canonical = require("../backtest/long-term/final-core-score-v1.js");
const stages = require("../hs-decision-layer-v1.js");
const research = require("../scripts/build_c4_research_history.js");

const at = "2026-09-18T08:00:00.000Z";
const commit = "test-commit";
const rows = [];
let day = new Date("2024-01-02T00:00:00Z");
while (rows.length < 280) {
  if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) {
    const index = rows.length;
    const close = 100 + index * 0.07 + Math.sin(index / 7) * 3;
    rows.push({date: day.toISOString().slice(0, 10), open: close - 0.2,
      max: close + 1, min: close - 1, close, Trading_Volume: 1000 + index});
  }
  day.setUTCDate(day.getUTCDate() + 1);
}
function source(symbol = "0050", price = rows) {
  return {source_version: research.SOURCE_VERSION, provider: "FinMind", symbol,
    requested_start: "2000-01-01", requested_end: "2026-09-18", fetched_at: at,
    price: price.map(row => ({...row})), dividend: [], split: []};
}
const initial = source();
const beforeFinalized = fs.readFileSync(path.join(__dirname, "../finalized-core-score-snapshots-v1.json"));
const beforeIntraday = fs.readFileSync(path.join(__dirname, "../intraday-core-snapshots-v1.json"));
const records = research.reconstruct("0050", initial, at, commit);
assert.equal(records.length, 29, "252 valid OHLC rows required before first research score");
assert.equal(records[0].date, rows[251].date);
assert.equal(records.at(-1).date, rows.at(-1).date);
assert(records.every(row => row.data_status === "RESEARCH_HISTORICAL" && row.strategy_id === core.LONG_TERM_CORE_SCORE_VERSION));
assert(records.every(row => row.weekly_j_version === "WEEKLY_J_PRODUCTION_LEGACY_V1"));
assert(records.every(row => row.display_score === canonical.displayFinalCoreScoreV1(row.raw_total)));
assert(records.every(row => row.level === stages.STAGES.find(stage => row.display_score >= stage.min).label));
assert(records.every(row => row.score_level_version === "HS_C4_LEVELS_V2"));
assert(records.every(row => Math.abs(row.weekly_j_contribution + row.dd52_contribution + row.crash_contribution - row.raw_total) < 1e-9));
assert.deepEqual(research.reconstruct("0050", initial, at, "another-commit"), records, "same source/code gives stable records");

const future = rows.at(-1).date;
const futureSource = source("0050", [...rows, {date: "2026-09-19", open: 10000, max: 20000, min: 1, close: 10000, Trading_Volume: 100}]);
futureSource.split.push({date: "2026-09-19", before_price: 100, after_price: 50, type: "split"});
const afterFuture = research.reconstruct("0050", futureSource, at, commit);
const factorFields = ["weekly_j_raw", "weekly_j_score", "dd52_raw", "dd52_score", "crash_raw", "crash_score", "raw_total", "display_score", "level"];
for (let i = 0; i < records.length; i += 1) {
  for (const key of factorFields) assert.equal(afterFuture[i][key], records[i][key], `${key} must not see t+1 rows/actions`);
}
const last = records.at(-1);
assert.equal(last.date, future, "latest result stays at the t boundary");
assert.equal(last.dd52_raw, research.reconstruct("0050", source("0050", rows.slice(0, 280)), at, commit).at(-1).dd52_raw);
assert.equal(last.crash_raw, core.crashRawFromRows(rows));
assert.equal(research.reconstruct("009815", source("009815", []), at, commit).length, 0, "009815 no-native-data fail closed");
assert.equal(research.reconstruct("009815", source("009815", rows.slice(0, 251)), at, commit).length, 0);
assert.throws(() => research.reconstruct("00631L", source("00631L"), at, commit), /RESEARCH_SYMBOL_NOT_ALLOWED/);
assert.deepEqual(research.SYMBOLS, ["0050", "00662", "00830", "00935", "009815"]);

const official = {snapshots: [{date: last.date, snapshot_type: "FINALIZED_CLOSE", finalized: true,
  rows: [{symbol: "0050", final_core_score: last.raw_total, tier: core.labelFor(last.raw_total).label,
    factors: {
      weekly_j: {raw: last.weekly_j_raw, score: last.weekly_j_score, contribution: last.weekly_j_contribution},
      dd52: {raw: last.dd52_raw, score: last.dd52_score, contribution: last.dd52_contribution},
      crash: {raw: last.crash_raw, score: last.crash_score, contribution: last.crash_contribution}}}]}]};
assert.deepEqual(research.checkParity("0050", [last], official), {overlap_dates: 1, matching_dates: 1, mismatches: []});
official.snapshots[0].rows[0].factors.weekly_j.raw += 1;
assert.equal(research.checkParity("0050", [last], official).mismatches[0].field, "weekly_j_raw", "overlap mismatches fail visibly");
assert.equal(research.checkParity("0050", [last], {snapshots: []}).overlap_dates, 0, "zero overlap must be explicit");

const sampleArtifact = research.artifact("0050", initial, records, {overlap_dates: 0, matching_dates: 0, mismatches: []}, at, commit);
assert.equal(sampleArtifact.metadata.score_level_version,"HS_C4_LEVELS_V2");
assert.equal(sampleArtifact.metadata.parity_status, "NO_FINALIZED_OVERLAP");
assert.equal(sampleArtifact.metadata.records_sha256, research.sha(records));
assert.equal(sampleArtifact.artifact_sha256, research.sha({metadata: sampleArtifact.metadata, records}));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "hs-c4-research-test-"));
const file = path.join(temp, "0050.json");
assert.equal(research.writeResearch(file, sampleArtifact, false), "WRITTEN");
assert.equal(research.writeResearch(file, sampleArtifact, false), "UNCHANGED");
assert.throws(() => research.writeResearch(file, {...sampleArtifact, artifact_sha256: "changed"}, false), /EXPLICIT_REGENERATION_REQUIRED/);
assert(beforeFinalized.equals(fs.readFileSync(path.join(__dirname, "../finalized-core-score-snapshots-v1.json"))));
assert(beforeIntraday.equals(fs.readFileSync(path.join(__dirname, "../intraday-core-snapshots-v1.json"))));
for (const filename of ["../finalized-core-score-snapshots-v1.json", "../intraday-core-snapshots-v1.json"]) {
  assert(!fs.readFileSync(path.join(__dirname, filename), "utf8").includes("RESEARCH_HISTORICAL"));
}
console.log("C4 RESEARCH HISTORY PHASE 6.5: 12 guards PASS");
