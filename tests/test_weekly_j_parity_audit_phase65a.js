#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const audit = require("../scripts/audit_weekly_j_parity_phase65a.js");
const core = require("../final-core-production.js");

const protectedFiles = ["finalized-core-score-snapshots-v1.json", "intraday-core-snapshots-v1.json"];
const before = protectedFiles.map(file => fs.readFileSync(path.join(__dirname, "..", file)));
const originalTimezone = process.env.TZ;
const example = [
  {date: "2026-09-11", open: 100, max: 101, min: 99, close: 100, Trading_Volume: 100},
  {date: "2026-09-14", open: 90, max: 92, min: 89, close: 91, Trading_Volume: 100},
  {date: "2026-09-15", open: 91, max: 93, min: 90, close: 92, Trading_Volume: 100},
  {date: "2026-09-16", open: 92, max: 94, min: 91, close: 93, Trading_Volume: 100}
];
const local = audit.weeklyTrace(example, "Asia/Taipei");
const runner = audit.weeklyTrace(example, "UTC");
assert.equal(audit.firstBoundaryDifference(local, runner).date, "2026-09-14");
assert.deepEqual(local.weekly_bars.at(-1).source_daily_dates, ["2026-09-14", "2026-09-15", "2026-09-16"]);
assert.deepEqual(runner.weekly_bars.at(-1).source_daily_dates, ["2026-09-15", "2026-09-16"]);
assert.equal(local.initialization.k, 50);
assert.equal(local.initialization.d, 50);
assert.equal(local.rsv_k_d_j_trace[0].previous_k, 50);
assert.equal(local.rsv_k_d_j_trace[0].previous_d, 50);
const first = local.rsv_k_d_j_trace[0];
assert.equal(first.k, 2 / 3 * 50 + 1 / 3 * first.rsv);
assert.equal(first.d, 2 / 3 * 50 + 1 / 3 * first.k);
assert.equal(first.j, 3 * first.k - 2 * first.d);
assert.deepEqual(audit.weeklyTrace(example, "UTC"), runner, "trace must be deterministic");
assert.equal(process.env.TZ, originalTimezone, "audit must restore process timezone");
const future = [
  ...example,
  {date: "2026-09-17", open: 500, max: 1000, min: 1, close: 500, Trading_Volume: 100},
  {date: "2026-09-18", open: 600, max: 1000, min: 1, close: 600, Trading_Volume: 100}
];
for (const tz of ["Asia/Taipei", "UTC"]) {
  const cutoff = audit.clean(future, "2026-09-16");
  assert.deepEqual(audit.weeklyTrace(cutoff, tz), audit.weeklyTrace(example, tz), "no future weekly bar leakage");
}
assert.equal(audit.withTimezone("UTC", () => audit.weekKey("2026-09-14")), "2026-09-07");
assert.equal(audit.withTimezone("Asia/Taipei", () => audit.weekKey("2026-09-14")), "2026-09-13");

const price = [];
let date = new Date("2023-01-03T00:00:00Z");
while (price.length < 260) {
  if (![0, 6].includes(date.getUTCDay())) {
    const i = price.length, close = 100 + i * .05 + Math.sin(i / 4) * 2;
    price.push({date: date.toISOString().slice(0, 10), open: close - .3, max: close + 1,
      min: close - 1, close, Trading_Volume: 1000});
  }
  date.setUTCDate(date.getUTCDate() + 1);
}
const target = price.at(-1).date;
const utc = audit.weeklyTrace(price, "UTC").terminal;
const high = Math.max(...price.slice(-252).map(row => row.max));
const decision = core.buildFinal({ticker: "0050", j: utc.j, k: utc.k, d: utc.d,
  dd52: (price.at(-1).close / high - 1) * 100, rows: price});
const source = {
  price: {rows: [...price, {...price.at(-1), date: "2026-09-19", close: 999}], response_sha256: "price-hash"},
  dividend: {rows: [{date: "2026-09-19", before_price: 100, reference_price: 50}], response_sha256: "dividend-hash"},
  split: {rows: [], response_sha256: "split-hash"}
};
const snapshot = {date: target, snapshot_type: "FINALIZED_CLOSE", finalized: true,
  source: {source_type: "TWSE_OFFICIAL_RAW_DAILY_OHLC"},
  rows: [{symbol: "0050", factors: {weekly_j: {raw: utc.j}}, final_core_score: decision.coreScore,
    data_as_of: `${target}T13:30:00+08:00`}]};
const result = audit.makeAudit("0050", target, snapshot, source, "2026-09-19T00:00:00Z");
assert.equal(result.data_status, "PARITY_AUDIT");
assert.equal(result.first_divergence_stage, "WEEKLY_GROUPING_BOUNDARY");
assert.equal(result.research.daily_input_range.end, target);
assert.equal(result.as_of_safety.future_daily_rows_used, false);
assert.equal(result.as_of_safety.future_corporate_actions_used, false);
assert.equal(result.research.corporate_action_input_counts.dividend, 0);
assert.equal(result.production.weekly_bars, "NOT_STORED");
assert(!fs.existsSync(path.join(__dirname, "..", "research", "c4_historical", "0050.json")), "failed research dataset unpublished");
protectedFiles.forEach((file, i) => assert(before[i].equals(fs.readFileSync(path.join(__dirname, "..", file)))));
const script = fs.readFileSync(path.join(__dirname, "..", "scripts", "audit_weekly_j_parity_phase65a.js"), "utf8");
assert(script.includes("research\", \"audits\""));
assert(!script.includes("index.html") && !script.includes("phase7") && !script.includes("RESEARCH_HISTORICAL"));
console.log("WEEKLY J PARITY AUDIT PHASE 6.5A: 10 guards PASS");
