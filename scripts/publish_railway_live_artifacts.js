#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const corePublisher = require("./build_intraday_core_snapshots.js");

const ROOT = path.resolve(__dirname, "..");
const QUOTES = path.join(ROOT, "market-quotes.json");
const META = path.join(ROOT, "market-quotes-meta.json");
const SCORES = path.join(ROOT, "intraday-core-snapshots-v1.json");
const SOURCES = new Set(["MIS_Z", "MIS_PZ", "FUGLE_LAST_TRADE"]);
const ENVELOPE_VERSION = "HS_LIVE_ARTIFACT_DISPATCH_V1";

function fail(reason) { throw new Error(`RAILWAY_ARTIFACT_INTEGRITY ${reason}`); }
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function atomicWrite(file, value, compact = false) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, compact ? 0 : 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
}
function finitePositive(value) { const number = Number(value); return Number.isFinite(number) && number > 0 ? number : null; }
function eventPayload(file) {
  const event = readJson(file, null);
  const envelope = event?.client_payload;
  if (!envelope || envelope.version !== ENVELOPE_VERSION || !envelope.payload || typeof envelope.payload !== "object" || Array.isArray(envelope.payload)) fail("invalid_event_envelope");
  const payload = envelope.payload;
  if (!payload || payload.trigger_source !== "RAILWAY_PRIMARY") fail("invalid_event_payload");
  return payload;
}
function validatePayload(payload) {
  const { trading_date: tradingDate, slot, quotes, snapshot } = payload;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(tradingDate || "")) || !corePublisher.validIntradaySlot(slot)) fail("invalid_identity");
  if (payload.completeness !== "5/5" || payload.score_version !== corePublisher.SCORE_VERSION) fail("invalid_contract");
  if (!snapshot || snapshot.status !== "SUCCESS" || snapshot.trading_date !== tradingDate || snapshot.slot !== slot || snapshot.score_version !== corePublisher.SCORE_VERSION) fail("snapshot_mismatch");
  const quoteKeys = Object.keys(quotes || {}).sort();
  if (JSON.stringify(quoteKeys) !== JSON.stringify([...corePublisher.SYMBOLS].sort())) fail("required_quotes_incomplete");
  for (const symbol of corePublisher.SYMBOLS) {
    const quote = quotes[symbol];
    const item = snapshot.items?.[symbol];
    if (quote?.code !== symbol || quote?.date !== tradingDate || !/^\d{2}:\d{2}:\d{2}$/.test(String(quote?.quote_time || ""))) fail(`invalid_quote_${symbol}`);
    if (![quote.price, quote.open, quote.high, quote.low].every(value => finitePositive(value) !== null) || Number(quote.high) < Number(quote.low)) fail(`invalid_ohlc_${symbol}`);
    if (!SOURCES.has(payload.quote_sources?.[symbol]) || quote.quote_source !== payload.quote_sources[symbol]) fail(`invalid_source_${symbol}`);
    if (!item || item.status !== "SUCCESS" || item.score_version !== corePublisher.SCORE_VERSION || !Number.isFinite(Number(item.score))) fail(`invalid_score_${symbol}`);
  }
  const raw = { status: "SUCCESS", items: quotes };
  const fingerprint = corePublisher.rawFingerprint(raw, tradingDate, slot);
  if (!fingerprint || fingerprint !== payload.input_fingerprint || fingerprint !== snapshot.source?.input_fingerprint) fail("fingerprint_mismatch");
  return payload;
}
function comparableRaw(row) {
  return JSON.stringify({ market_date: row.market_date, slot: row.slot, status: row.status, items: row.items });
}
function publish(payload, files = { quotes: QUOTES, meta: META, scores: SCORES }) {
  validatePayload(payload);
  const quotesArtifact = readJson(files.quotes, {});
  const scoreArtifact = readJson(files.scores, { schema_version: 1, snapshots: [] });
  corePublisher.validateLedger(scoreArtifact);
  const key = `${payload.trading_date}_${payload.slot.replace(":", "")}`;
  const raw = {
    contract: corePublisher.SLOT_CONTRACT,
    market_date: payload.trading_date,
    slot: payload.slot,
    status: "SUCCESS",
    captured_at: payload.captured_at,
    calculated_at: payload.snapshot.calculated_at,
    market_as_of: payload.snapshot.market_as_of,
    items: payload.quotes,
    non_blocking_status: { "009815": "WAIT_NATIVE" },
    trigger_source: "RAILWAY_PRIMARY",
    quote_sources: payload.quote_sources,
  };
  const rawSnapshots = { ...(quotesArtifact.intraday_quote_snapshots || {}) };
  if (rawSnapshots[key] && comparableRaw(rawSnapshots[key]) !== comparableRaw(raw)) fail("same_slot_conflicting_raw_payload");
  const existingScore = (scoreArtifact.snapshots || []).find(row => row.trading_date === payload.trading_date && row.slot === payload.slot && row.status === "SUCCESS");
  if (existingScore && existingScore.source?.input_fingerprint !== payload.input_fingerprint) fail("same_slot_conflicting_score_payload");
  if (existingScore) return { status: "ALREADY_PUBLISHED_IDENTICAL", key };
  rawSnapshots[key] = rawSnapshots[key] || raw;
  const canonicalSnapshot = {
    ...payload.snapshot,
    source: { ...payload.snapshot.source, trigger_source: "RAILWAY_PRIMARY", quote_sources: payload.quote_sources },
  };
  const snapshots = [...(scoreArtifact.snapshots || []), canonicalSnapshot]
    .sort((a, b) => `${a.trading_date} ${a.market_as_of || a.slot}`.localeCompare(`${b.trading_date} ${b.market_as_of || b.slot}`)).slice(-500);

  const itemMap = Object.fromEntries((quotesArtifact.items || []).map(row => [row.code, row]));
  for (const symbol of corePublisher.SYMBOLS) itemMap[symbol] = { ...itemMap[symbol], ...payload.quotes[symbol], quote_mode: "delayed" };
  const refresh = {
    verified: true, status: "success", trading_date: payload.trading_date, slot: payload.slot,
    captured_at: payload.captured_at, verified_at: payload.snapshot.calculated_at,
    market_as_of: payload.snapshot.market_as_of, completeness: "5/5",
    trigger_source: "RAILWAY_PRIMARY", quote_sources: payload.quote_sources,
  };
  const previousSuccesses = Object.values(rawSnapshots).filter(row => row?.status === "SUCCESS")
    .sort((a, b) => `${a.market_date} ${a.slot}`.localeCompare(`${b.market_date} ${b.slot}`));
  const previous = previousSuccesses.length > 1 ? previousSuccesses.at(-2) : null;
  const nextQuotes = {
    ...quotesArtifact,
    version: Math.max(2, Number(quotesArtifact.version || 0)),
    updated_at: payload.snapshot.calculated_at,
    items: Object.values(itemMap).sort((a, b) => String(a.code).localeCompare(String(b.code))),
    source_status: { ...(quotesArtifact.source_status || {}), RAILWAY_PRIMARY: "ok" },
    radar_refresh: refresh,
    radar_refresh_attempt: refresh,
    intraday_quote_snapshots: rawSnapshots,
    intraday_snapshot_meta: {
      current_market_date: payload.trading_date, current_slot: payload.slot,
      previous_successful_slot: previous?.slot || null, last_successful_snapshot: key,
      snapshot_calculated_at: payload.snapshot.calculated_at, trigger_source: "RAILWAY_PRIMARY",
    },
  };
  const nextMeta = {
    ...readJson(files.meta, {}),
    version: nextQuotes.version, updated_at: nextQuotes.updated_at,
    source_dates: nextQuotes.source_dates, source_status: nextQuotes.source_status,
    item_count: nextQuotes.items.length, radar_refresh: refresh, radar_refresh_attempt: refresh,
    intraday_completeness: nextQuotes.intraday_completeness,
    intraday_snapshot_meta: nextQuotes.intraday_snapshot_meta,
    intraday_quote_snapshots: rawSnapshots,
    primary_trigger_source: "RAILWAY_PRIMARY",
    last_primary_tick_at: payload.snapshot.calculated_at,
    last_successful_live_snapshot_at: payload.snapshot.calculated_at,
    latest_trading_date: payload.trading_date,
    live_completeness: "5/5",
    required_symbols_status: Object.fromEntries(corePublisher.SYMBOLS.map(symbol => [symbol, "AVAILABLE"])),
    publication_status: "ARTIFACTS_WRITTEN",
    // The artifact commit is created after these files are written.  Keep the
    // field explicit and null rather than mislabelling the workflow source SHA.
    artifact_commit_sha: null,
  };
  atomicWrite(files.quotes, nextQuotes, true);
  atomicWrite(files.meta, nextMeta);
  atomicWrite(files.scores, { ...scoreArtifact, schema_version: 1, artifact: "intraday-core-snapshots-v1", generated_at: payload.snapshot.calculated_at, snapshots });
  return { status: "ARTIFACTS_WRITTEN", key };
}

function main() {
  const eventIndex = process.argv.indexOf("--event");
  if (eventIndex < 0 || !process.argv[eventIndex + 1]) fail("event_file_required");
  const result = publish(eventPayload(path.resolve(process.argv[eventIndex + 1])));
  console.log(`RAILWAY_ARTIFACT_PUBLICATION ${result.key} ${result.status}`);
}

module.exports = { ENVELOPE_VERSION, eventPayload, validatePayload, publish };
if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
