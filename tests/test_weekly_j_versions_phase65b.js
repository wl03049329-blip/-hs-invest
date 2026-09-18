#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {execFileSync} = require("node:child_process");
const weekly = require("../research/c4_historical/weekly_j_versions.js");
const research = require("../scripts/build_c4_research_history.js");
const buy = require("../buy-point-core.js");

const ROOT = path.resolve(__dirname, "..");
const dir = path.join(ROOT, "research", "c4_historical");
assert.equal(weekly.weekKey("2026-09-14", weekly.LEGACY), "2026-09-07");
assert.equal(weekly.weekKey("2026-09-15", weekly.LEGACY), "2026-09-14");
assert.equal(weekly.weekKey("2026-09-14", weekly.TW), "2026-09-14");
assert.equal(weekly.weekKey("2026-09-18", weekly.TW), "2026-09-14");
assert.equal(weekly.weekKey("2026-09-19", weekly.TW), "2026-09-14");
assert.equal(weekly.weekKey("invalid", weekly.TW), null);
assert.throws(() => weekly.calculateWeeklyJ([], "UNKNOWN"), /UNKNOWN_WEEKLY_J_VERSION/);

const known = [
  ["0050", "2026-09-18", 100.99812531854704, 101.88526432173711],
  ["00662", "2026-09-17", 46.935222189938884, 49.96017164534835],
  ["00830", "2026-09-18", 40.427473449632515, 39.436665395947]
];
for (const [symbol, date, legacyExpected, twExpected] of known) {
  const source = JSON.parse(fs.readFileSync(path.join(dir, "source", `${symbol}.json`), "utf8"));
  const price = research.sourceRows(source, symbol).filter(row => row.date >= `${Number(date.slice(0, 4)) - 3}-01-01` && row.date <= date);
  const events = [
    ...source.dividend.filter(row => row.date <= date).map(row => ({...row, kind: "distribution"})),
    ...source.split.filter(row => row.date <= date).map(row => ({...row, kind: "split"}))
  ];
  const adjusted = buy.adjustPriceHistory(price, events).rows;
  const legacy = weekly.calculateWeeklyJ(adjusted, weekly.LEGACY).at(-1).j;
  const tw = weekly.calculateWeeklyJ(adjusted, weekly.TW).at(-1).j;
  assert.equal(legacy, legacyExpected, `${symbol} ${date} legacy`);
  assert.equal(tw, twExpected, `${symbol} ${date} Taipei`);
  const code = `const h=require('./research/c4_historical/weekly_j_versions');` +
    `const b=require('./buy-point-core');const r=require('./scripts/build_c4_research_history');` +
    `const s=require('./research/c4_historical/source/${symbol}.json');const date='${date}';` +
    `const p=r.sourceRows(s,'${symbol}').filter(x=>x.date>='${Number(date.slice(0, 4)) - 3}-01-01'&&x.date<=date);` +
    `const e=[...s.dividend.filter(x=>x.date<=date).map(x=>({...x,kind:'distribution'})),` +
    `...s.split.filter(x=>x.date<=date).map(x=>({...x,kind:'split'}))];` +
    `const rows=b.adjustPriceHistory(p,e).rows;` +
    `process.stdout.write(JSON.stringify([h.calculateWeeklyJ(rows,h.LEGACY).at(-1).j,h.calculateWeeklyJ(rows,h.TW).at(-1).j]));`;
  for (const tz of ["UTC", "Asia/Taipei", "America/New_York"]) {
    const actual = JSON.parse(execFileSync(process.execPath, ["-e", code], {
      cwd: ROOT, env: {...process.env, TZ: tz}, encoding: "utf8"}));
    assert.deepEqual(actual, [legacyExpected, twExpected], `${symbol} ${date} ${tz}`);
  }
}

const official = JSON.parse(fs.readFileSync(path.join(ROOT, "finalized-core-score-snapshots-v1.json"), "utf8"));
let overlap = 0;
for (const symbol of research.SYMBOLS) {
  const source = JSON.parse(fs.readFileSync(path.join(dir, "source", `${symbol}.json`), "utf8"));
  const artifact = JSON.parse(fs.readFileSync(path.join(dir, `${symbol}.json`), "utf8"));
  assert.equal(artifact.metadata.data_status, research.STATUS);
  assert.equal(artifact.metadata.weekly_j_version, weekly.LEGACY);
  assert.equal(artifact.metadata.provenance.source_ohlc_sha256, research.sha(source));
  assert.equal(artifact.metadata.records_sha256, research.sha(artifact.records));
  assert.equal(artifact.artifact_sha256, research.sha({metadata: artifact.metadata, records: artifact.records}));
  assert.equal(artifact.metadata.record_count, artifact.records.length);
  const parity = research.checkParity(symbol, artifact.records, official);
  assert.deepEqual(parity.mismatches, [], `${symbol} parity`);
  assert.equal(parity.overlap_dates, artifact.metadata.parity.overlap_dates);
  overlap += parity.overlap_dates;
  assert(artifact.records.every(row => row.data_status === research.STATUS && row.weekly_j_version === weekly.LEGACY));
  if (symbol === "009815") assert.equal(artifact.records.length, 0);
  // Regeneration from committed inputs must preserve all numerical and provenance fields.
  const rebuilt = research.reconstruct(symbol, source, source.fetched_at, "ignored");
  assert.deepEqual(rebuilt, artifact.records, `${symbol} deterministic regeneration`);
}
assert.equal(overlap, 72);
const comparison = JSON.parse(fs.readFileSync(path.join(dir, "weekly_j_comparison.json"), "utf8"));
const {content_sha256, ...unsigned} = comparison;
assert.equal(content_sha256, research.sha(unsigned));
assert.equal(comparison.etfs.length, 5);
assert.equal(comparison.etfs.find(row => row.etf === "009815").record_count, 0);
console.log(`WEEKLY J VERSIONS PHASE 6.5B: known cases, 3 timezones, ${overlap} overlap rows, hashes and regeneration PASS`);
