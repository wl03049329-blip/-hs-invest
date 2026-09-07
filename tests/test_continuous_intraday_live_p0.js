"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const publisher = require("../scripts/build_intraday_core_snapshots.js");
const resolver = require("../canonical-score-resolver.js");

const symbols = [...publisher.SYMBOLS];
const version = publisher.SCORE_VERSION;
const date = "2026-09-07";
const protectedFiles = ["finalized-core-score-snapshots-v1.json", "forward-action-policy-shadow-v1.json", "intraday-core-snapshots-v1.json"];
const hashes = Object.fromEntries(protectedFiles.filter(fs.existsSync).map(file => [file, crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")]));

function history(seed) {
  const rows = [];
  for (let cursor = new Date("2025-06-02T00:00:00Z"), index = 0; cursor <= new Date("2026-09-04T00:00:00Z"); cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    if ([0, 6].includes(cursor.getUTCDay())) continue;
    const close = seed * (.84 + index * .00065 + Math.sin(index / 8) * .018);
    rows.push({date: cursor.toISOString().slice(0, 10), open: close * .996, max: close * 1.012, min: close * .988, close, Trading_Volume: 1_000_000 + index});
    index += 1;
  }
  return rows;
}
const histories = Object.fromEntries(symbols.map((symbol, index) => [symbol, history(90 + index * 3)]));
function raw(slot, offset = 0, quoteTime = `${slot}:00`) {
  return {status: "SUCCESS", captured_at: `${date}T${quoteTime}+08:00`, items: Object.fromEntries(symbols.map((symbol, index) => [symbol, {
    price: 100 + index + offset, open: 99 + index, high: 103 + index + Math.max(offset, 0), low: 97 + index + Math.min(offset, 0),
    volume: 1200000, date, quote_time: quoteTime
  }]))};
}
function build(slot, offset, existing = {schema_version: 1, snapshots: []}, quoteTime) {
  const key = `${date}_${slot.replace(":", "")}`;
  return publisher.buildSnapshot({quotes: {intraday_quote_snapshots: {[key]: raw(slot, offset, quoteTime)}}, histories, existing, tradingDate: date, slot, calculatedAt: `${date}T${slot}:30+08:00`});
}
function finalized() {
  return {schema_version: 1, core_score_version: version, snapshots: [{date: "2026-09-04", snapshot_type: "FINALIZED_CLOSE", finalized: true, finalized_at: "2026-09-04T13:30:00+08:00", source: {data_as_of: "2026-09-04T13:30:00+08:00"}, rows: symbols.map((symbol, index) => ({symbol, final_core_score: 40 + index, tier: "一般持有", core_score_version: version, data_as_of: "2026-09-04T13:30:00+08:00", factors: {weekly_j: {raw: 20}, dd52: {raw: -10}, crash: {raw: -4}}}))}]};
}

const at1017 = build("10:17", 0);
const at1143 = build("11:43", 1, {schema_version: 1, snapshots: [at1017.snapshot]});
assert.equal(at1017.published, true);
assert.equal(at1143.published, true);
assert.equal(at1143.snapshot.items["0050"].previous_successful_intraday_slot, "10:17");
console.log("A/B PASS: canonical publisher accepts and chains 10:17 / 11:43 rolling snapshots");

const misleadingSlot = structuredClone(at1017.snapshot);
misleadingSlot.slot = "12:00";
misleadingSlot.market_as_of = `${date}T10:17:00+08:00`;
for (const item of Object.values(misleadingSlot.items)) item.market_as_of = `${date}T10:17:00+08:00`;
const latestByAsOf = structuredClone(at1143.snapshot);
latestByAsOf.slot = "10:15";
const view = resolver.buildDualTrackView({finalizedArtifact: finalized(), intradaySnapshots: [misleadingSlot, latestByAsOf], targetDate: date, scoreVersion: version, symbols, now: new Date("2026-09-07T03:44:00Z"), tradingDayStatus: "TRADING_DAY", maxAgeMinutes: 15});
assert.equal(view.live_snapshot.slot, "10:15");
assert.equal(view.items["0050"].live.market_as_of, latestByAsOf.items["0050"].market_as_of);
assert.equal(view.items["0050"].live.display_eligible, true);
console.log("C/D/E PASS: selector uses latest market_as_of, not the lexically newest slot label");

const stale = resolver.buildDualTrackView({finalizedArtifact: finalized(), intradaySnapshots: [at1017.snapshot], targetDate: date, scoreVersion: version, symbols, now: new Date("2026-09-07T02:33:00Z"), tradingDayStatus: "TRADING_DAY", maxAgeMinutes: 15});
assert.equal(stale.items["0050"].live.display_eligible, false);
assert.equal(stale.items["0050"].live.reason, "STALE_INTRADAY_SNAPSHOT");
console.log("F PASS: stale rolling snapshot is display-ineligible");

assert.equal(resolver.resolveMarketState({targetDate: date, now: new Date("2026-09-07T02:17:00Z"), tradingDayStatus: "TRADING_DAY", finalizedSnapshot: {source_status: "FINALIZED_EOD", trading_date: "2026-09-04"}}), "OPEN");
for (const [now, status, reason] of [["2026-09-07T06:00:00Z", "TRADING_DAY", "MARKET_CLOSED"], ["2026-09-06T02:00:00Z", "HOLIDAY", "MARKET_HOLIDAY"]]) {
  const target = now.startsWith("2026-09-06") ? "2026-09-06" : date;
  const result = resolver.buildDualTrackView({finalizedArtifact: finalized(), intradaySnapshots: [at1143.snapshot], targetDate: target, scoreVersion: version, symbols, now: new Date(now), tradingDayStatus: status});
  assert.equal(result.items["0050"].live.display_eligible, false);
  assert.equal(result.items["0050"].live.reason, reason);
}
console.log("G/H PASS: previous finalized does not close an OPEN market; CLOSED/HOLIDAY suppress LIVE");

assert.equal(view.primary, "official");
assert.equal(view.items["0050"].primary, "official");
assert.equal(view.items["0050"].official.status, "FINALIZED");
for (const [file, before] of Object.entries(hashes)) assert.equal(crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"), before);
console.log("I/J PASS: LIVE remains secondary and mutates no finalized/Forward/history artifact");

const html = fs.readFileSync("index.html", "utf8");
assert.match(html, /maxAgeMinutes:15/);
assert.match(html, /formatHomeQuoteTime\(live\.market_as_of\)/);
assert.match(html, /盤中資料不完整/);
assert.match(html, /盤中資料已過期/);
console.log("UI PASS: homepage uses rolling as-of time and exposes invalid-data reasons");

console.log("PASS continuous intraday LIVE contract 10/10");
