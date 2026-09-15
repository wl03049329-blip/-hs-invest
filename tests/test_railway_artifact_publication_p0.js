#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const core = require("../scripts/build_intraday_core_snapshots.js");
const bridge = require("../scripts/publish_railway_live_artifacts.js");

const date = "2026-09-14", slot = "10:17";
const quotes = Object.fromEntries(core.SYMBOLS.map(symbol => [symbol, {
  code: symbol, name: symbol, price: 100, price_field: "z", previous_close: 99,
  date, quote_time: "10:16:00", market: "TWSE", open: 99, high: 101, low: 98,
  volume: 1000, source: "https://mis.twse.com.tw/stock/api/getStockInfo.jsp", quote_source: "MIS_Z"
}]));
const raw = {status: "SUCCESS", items: quotes};
const fingerprint = core.rawFingerprint(raw, date, slot);
const snapshot = {
  schema_version: 1, contract: core.SLOT_CONTRACT, snapshot_type: "INTRADAY_CORE", status: "SUCCESS",
  trading_date: date, slot, captured_at: `${date}T10:17:00+08:00`, market_as_of: `${date}T10:16:00+08:00`,
  calculated_at: `${date}T10:17:01+08:00`, score_version: core.SCORE_VERSION, source_completeness: "5/5",
  source: {provider: "TWSE_MIS", required_symbols: "5/5", input_fingerprint: fingerprint},
  freshness: {status: "FRESH", trading_date: date, market_as_of: `${date}T10:16:00+08:00`},
  items: Object.fromEntries(core.SYMBOLS.map(symbol => [symbol, {status: "SUCCESS", score: 50, display_score: 50,
    score_version: core.SCORE_VERSION, market_as_of: `${date}T10:16:00+08:00`}]))
};
const payload = {schema_version: 1, trigger_source: "RAILWAY_PRIMARY", run_id: "r", trading_date: date, slot,
  captured_at: snapshot.captured_at, completeness: "5/5", quote_timestamps: {},
  quote_freshness: Object.fromEntries(core.SYMBOLS.map(s => [s, "FRESH"])),
  quote_sources: Object.fromEntries(core.SYMBOLS.map(s => [s, "MIS_Z"])), input_fingerprint: fingerprint,
  score_version: core.SCORE_VERSION, quotes, snapshot};

const eventFile = path.join(os.tmpdir(), `hs-publish-event-${process.pid}.json`);
const envelope = {version: bridge.ENVELOPE_VERSION, payload};
assert.ok(Object.keys(envelope).length <= 10, "repository_dispatch client_payload must stay within GitHub's top-level key limit");
fs.writeFileSync(eventFile, JSON.stringify({client_payload: envelope}));
const decoded = bridge.eventPayload(eventFile);
assert.equal(decoded.input_fingerprint, fingerprint, "versioned envelope must preserve the fingerprint");
assert.deepEqual(decoded.quote_sources, payload.quote_sources, "versioned envelope must preserve quote provenance");
assert.throws(() => bridge.eventPayload(path.join(os.tmpdir(), "hs-publish-missing-event.json")), /invalid_event_envelope/);
fs.unlinkSync(eventFile);

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "hs-publish-"));
const files = {quotes: path.join(temporary, "market-quotes.json"), meta: path.join(temporary, "market-quotes-meta.json"), scores: path.join(temporary, "intraday-core-snapshots-v1.json")};
fs.writeFileSync(files.quotes, JSON.stringify({version: 2, items: []}));
fs.writeFileSync(files.meta, JSON.stringify({version: 2}));
fs.writeFileSync(files.scores, JSON.stringify({schema_version: 1, snapshots: []}));

assert.equal(bridge.publish(payload, files).status, "ARTIFACTS_WRITTEN");
const firstBytes = Object.fromEntries(Object.entries(files).map(([name, file]) => [name, fs.readFileSync(file, "utf8")]));
assert.equal(bridge.publish(payload, files).status, "ALREADY_PUBLISHED_IDENTICAL");
assert.deepEqual(Object.fromEntries(Object.entries(files).map(([name, file]) => [name, fs.readFileSync(file, "utf8")])), firstBytes,
  "an identical late delivery must be a byte-for-byte no-op");
const scoreArtifact = JSON.parse(fs.readFileSync(files.scores));
assert.equal(scoreArtifact.snapshots.length, 1, "same slot must dedupe");
assert.equal(scoreArtifact.snapshots[0].source.trigger_source, "RAILWAY_PRIMARY");
assert.equal(JSON.parse(fs.readFileSync(files.quotes)).radar_refresh.trigger_source, "RAILWAY_PRIMARY");
assert.equal(JSON.parse(fs.readFileSync(files.meta)).live_completeness, "5/5");

const conflicting = structuredClone(payload);
conflicting.quotes["0050"].price = 100.5;
assert.throws(() => bridge.publish(conflicting, files), /fingerprint_mismatch|same_slot_conflicting/);
console.log("RAILWAY ARTIFACT PUBLICATION P0: 5/5 PASS");
