#!/usr/bin/env node
"use strict";

/*
 * Canonical intraday Core Score publisher.
 *
 * market-quotes.json deliberately remains the raw official market-data cache.
 * This script is the sole production publisher of scored intraday snapshots.
 * It imports the same approved Core modules used by production instead of
 * duplicating the 30 / 55 / 15 model in another language.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const buy = require("../buy-point-core.js");
const intraday = require("../intraday-buy-point-core.js");
const core = require("../final-core-production.js");

const ROOT = path.resolve(__dirname, "..");
const QUOTES_FILE = path.join(ROOT, "market-quotes.json");
const OUTPUT_FILE = path.join(ROOT, "intraday-core-snapshots-v1.json");
const SYMBOLS = Object.freeze(["0050", "00662", "00757", "00830", "00935"]);
const SLOTS = new Set(["09:30", "10:30", "11:30", "12:30", "13:30"]);
const SCHEMA_VERSION = 1;
const SLOT_CONTRACT = "HS_LIVE_INTRADAY_SLOT_V4";
const FINMIND_URL = "https://api.finmindtrade.com/api/v4/data";
const SCORE_VERSION = core.LONG_TERM_CORE_SCORE_VERSION;

function integrity(message) { throw new Error(`INTRADAY_CORE_INTEGRITY ${message}`); }
function operational(message) { throw new Error(`INTRADAY_CORE_OPERATIONAL ${message}`); }

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function iso(value) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? String(value) : ""; }
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeAtomic(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value)}\n`, "utf8");
  fs.renameSync(temp, file);
}
function parseArgs(argv) {
  const values = {};
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) continue;
    values[key.slice(2)] = argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[++index] : true;
  }
  return values;
}
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function rawFingerprint(raw, tradingDate, slot) {
  if (!raw || raw.status !== "SUCCESS") return "";
  const items = Object.fromEntries(SYMBOLS.map(symbol => {
    const row = raw.items?.[symbol] || {};
    return [symbol, Object.fromEntries(["price", "open", "high", "low", "volume", "date", "quote_time"].map(key => [key, row[key] ?? null]))];
  }));
  return crypto.createHash("sha256").update(stable({ trading_date: tradingDate, slot, items })).digest("hex");
}
function validateLedger(existing) {
  if (!existing || existing.schema_version !== SCHEMA_VERSION || !Array.isArray(existing.snapshots)) integrity("malformed_canonical_artifact");
  const keys = new Set();
  for (const snapshot of existing.snapshots) {
    if (snapshot.contract && snapshot.contract !== SLOT_CONTRACT) integrity("wrong_slot_contract");
    const key = `${snapshot?.trading_date || ""}|${snapshot?.slot || ""}`;
    if (!iso(snapshot?.trading_date) || !SLOTS.has(snapshot?.slot) || snapshot?.status !== "SUCCESS" || keys.has(key)) integrity("malformed_or_duplicate_snapshot");
    keys.add(key);
    if (snapshot.score_version && snapshot.score_version !== SCORE_VERSION) integrity("wrong_score_version");
    for (const symbol of SYMBOLS) {
      const item = snapshot?.items?.[symbol];
      if (!item || item.status !== "SUCCESS" || item.score_version !== SCORE_VERSION || !Number.isFinite(finite(item.score))) integrity(`invalid_item_${symbol}`);
      if (String(item.market_as_of || "").slice(0, 10) !== snapshot.trading_date) integrity(`trading_date_contamination_${symbol}`);
    }
  }
}
function quoteAsOf(quote) { return intraday.quoteAsOf({ date: quote?.date, quoteTime: quote?.quote_time ?? quote?.quoteTime }); }
function toQuote(row) {
  return {
    price: finite(row?.price), date: iso(row?.date), quoteTime: String(row?.quote_time || ""),
    open: finite(row?.open), high: finite(row?.high), low: finite(row?.low), volume: finite(row?.volume)
  };
}
function cleanRows(rows, cutoff) {
  return (Array.isArray(rows) ? rows : []).map(row => ({
    date: iso(row?.date), open: finite(row?.open), max: finite(row?.max ?? row?.high),
    min: finite(row?.min ?? row?.low), close: finite(row?.close),
    Trading_Volume: finite(row?.Trading_Volume ?? row?.volume)
  })).filter(row => row.date && row.date <= cutoff && row.open > 0 && row.max > 0 && row.min > 0 && row.close > 0 && row.max >= row.min)
    .sort((a, b) => a.date.localeCompare(b.date));
}
function componentState(key, raw) {
  if (!Number.isFinite(raw)) return "unavailable";
  if (key === "weekly_j") return raw < 0 ? "strong" : raw < 20 ? "positive" : raw < 50 ? "neutral" : "weak";
  if (key === "dd52") return raw <= -20 ? "strong" : raw <= -10 ? "positive" : raw <= -5 ? "neutral" : "weak";
  return raw <= -10 ? "strong" : raw <= -5 ? "positive" : raw < 0 ? "neutral" : "weak";
}
function scoreRows(ticker, officialRows, quote, slot, calculatedAt) {
  const provisional = intraday.buildProvisionalRows(officialRows, quote, officialRows.at(-1)?.date);
  if (!provisional) return null;
  const features = buy.buildWeeklyFeatures(provisional.rows, "equity");
  const feature = features.at(-1);
  const last252 = provisional.rows.slice(-252);
  const high52 = Math.max(...last252.map(row => finite(row.max ?? row.close)).filter(Number.isFinite));
  const dd52 = Number.isFinite(high52) && high52 > 0 ? (quote.price / high52 - 1) * 100 : null;
  const decision = core.buildDecision({
    ticker, j: feature?.j, k: feature?.k, d: feature?.d, dd52, rows: provisional.rows,
    weeklyBias: feature?.bias40w, marketAsOf: provisional.asOf
  }, null, core.LONG_TERM_CORE_SCORE_VERSION);
  if (!feature || !Number.isFinite(decision.coreScore) || decision.dataStatus === "FAIL_CLOSED") return null;
  return {
    symbol: ticker, trading_date: quote.date, slot, market_as_of: provisional.asOf,
    calculated_at: calculatedAt, price: quote.price, score: decision.coreScore, display_score: decision.coreScoreDisplay,
    tier: decision.label, stage: decision.stage, cta: decision.cta, score_version: decision.coreScoreVersion, status: "SUCCESS", freshness: "FRESH",
    components: {
      weekly_j: { value: feature.j, state: componentState("weekly_j", feature.j) },
      dd52: { value: dd52, state: componentState("dd52", dd52) },
      crash: { value: decision.coreFactors?.crash?.raw ?? null, state: componentState("crash", decision.coreFactors?.crash?.raw) }
    },
    core_factors: decision.coreFactors, data_as_of: provisional.asOf,
    weekly_j: feature.j, dd52: dd52
  };
}
function scorePreviousClose(ticker, rows, tradingDate) {
  const closeRows = rows.filter(row => row.date < tradingDate);
  const latest = closeRows.at(-1);
  if (!latest || closeRows.length < 252) return null;
  const features = buy.buildWeeklyFeatures(closeRows, "equity");
  const feature = features.at(-1), last252 = closeRows.slice(-252);
  const high52 = Math.max(...last252.map(row => finite(row.max ?? row.close)).filter(Number.isFinite));
  const dd52 = Number.isFinite(high52) && high52 > 0 ? (latest.close / high52 - 1) * 100 : null;
  const decision = core.buildDecision({ ticker, j: feature?.j, k: feature?.k, d: feature?.d, dd52, rows: closeRows, marketAsOf: `${latest.date}T13:30:00+08:00` }, null, core.LONG_TERM_CORE_SCORE_VERSION);
  return Number.isFinite(decision.coreScore) ? { symbol: ticker, score: decision.coreScore, trading_date: latest.date, market_as_of: `${latest.date}T13:30:00+08:00` } : null;
}
function latestEarlierSuccess(snapshots, tradingDate, slot, symbol) {
  const snapshot = [...snapshots].filter(row => row?.status === "SUCCESS" && row.trading_date === tradingDate && row.slot < slot)
    .sort((a, b) => b.slot.localeCompare(a.slot))[0];
  const item = snapshot?.items?.[symbol];
  return item ? { ...item, slot: snapshot.slot } : null;
}
function attachBaselines(item, previousClose, previousIntraday) {
  const previousCloseScore = finite(previousClose?.score);
  const priorScore = finite(previousIntraday?.score);
  return {
    ...item,
    previous_close_score: previousCloseScore,
    previous_close_trading_date: previousClose?.trading_date || null,
    previous_close_rank: Number.isFinite(previousClose?.rank) ? previousClose.rank : null,
    rank_delta_vs_previous_close: Number.isFinite(previousClose?.rank) && Number.isFinite(item.rank) ? previousClose.rank - item.rank : null,
    delta_vs_previous_close: previousCloseScore === null ? null : item.score - previousCloseScore,
    previous_successful_intraday_slot: previousIntraday?.slot || null,
    previous_successful_intraday_score: priorScore,
    previous_successful_intraday_rank: Number.isFinite(previousIntraday?.rank) ? previousIntraday.rank : null,
    delta_vs_previous_successful_intraday: priorScore === null ? null : item.score - priorScore,
    rank_delta_vs_previous_successful_intraday: Number.isFinite(previousIntraday?.rank) && Number.isFinite(item.rank) ? previousIntraday.rank - item.rank : null
  };
}
function buildSnapshot({ quotes, histories, existing, tradingDate, slot, calculatedAt }) {
  if (!SLOTS.has(slot)) integrity(`unsupported_slot_${slot}`);
  validateLedger(existing);
  const raw = quotes?.intraday_quote_snapshots?.[`${tradingDate}_${slot.replace(":", "")}`];
  if (!raw || raw.status !== "SUCCESS") operational("validated_raw_intraday_quote_snapshot_unavailable");
  const inputFingerprint = rawFingerprint(raw, tradingDate, slot);
  const existingSnapshot = existing.snapshots.find(snapshot => snapshot.trading_date === tradingDate && snapshot.slot === slot && snapshot.status === "SUCCESS");
  if (existingSnapshot) {
    const existingFingerprint = String(existingSnapshot?.source?.input_fingerprint || "");
    if (existingFingerprint && existingFingerprint !== inputFingerprint) integrity("same_slot_conflicting_payload");
    return { snapshot: existingSnapshot, published: false, reason: "already_published_identical" };
  }
  const current = {}, previousClose = {};
  for (const symbol of SYMBOLS) {
    const quote = toQuote(raw.items?.[symbol]);
    if (!quote.date || quote.date !== tradingDate || !quoteAsOf(quote)) operational(`required_raw_quote_invalid_${symbol}`);
    if (![quote.price, quote.open, quote.high, quote.low].every(value => Number.isFinite(value) && value > 0) || quote.high < quote.low || quote.price < quote.low * .999 || quote.price > quote.high * 1.001) {
      operational(`FAIL_CLOSED_required_quote_OHLC_invalid_${symbol}`);
    }
    const officialRows = cleanRows(histories[symbol] || [], tradingDate);
    const scored = scoreRows(symbol, officialRows, quote, slot, calculatedAt);
    if (!scored) operational(`FAIL_CLOSED_core_input_unavailable_${symbol}`);
    const close = scorePreviousClose(symbol, officialRows, tradingDate);
    if (!close) operational(`FAIL_CLOSED_previous_close_unavailable_${symbol}`);
    if (scored.score_version !== SCORE_VERSION || !Number.isFinite(scored.score) || scored.score < 0 || scored.score > 100) integrity(`invalid_score_output_${symbol}`);
    current[symbol] = scored;
    previousClose[symbol] = close;
  }
  const rankRows = object => Object.values(object).sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol)).forEach((item, index) => { item.rank = index + 1; });
  rankRows(current); rankRows(previousClose);
  const items = Object.fromEntries(SYMBOLS.map(symbol => [symbol, attachBaselines(current[symbol], previousClose[symbol], latestEarlierSuccess(existing.snapshots, tradingDate, slot, symbol))]));
  const marketAsOf = Object.values(items).map(item => item.market_as_of).sort().at(-1);
  const snapshot = {
    schema_version: SCHEMA_VERSION,
    contract: SLOT_CONTRACT,
    snapshot_type: "INTRADAY_CORE",
    status: "SUCCESS",
    trading_date: tradingDate,
    slot,
    captured_at: raw.captured_at || calculatedAt,
    market_as_of: marketAsOf,
    calculated_at: calculatedAt,
    score_version: SCORE_VERSION,
    source_completeness: "5/5",
    source: { provider: "TWSE_MIS", required_symbols: "5/5", input_fingerprint: inputFingerprint },
    freshness: { status: "FRESH", trading_date: tradingDate, market_as_of: marketAsOf },
    items,
  };
  return { snapshot, published: true, reason: "published" };
}
async function fetchDataset(dataset, ticker, startDate) {
  const url = new URL(FINMIND_URL);
  url.searchParams.set("dataset", dataset); url.searchParams.set("data_id", ticker); url.searchParams.set("start_date", startDate);
  const response = await fetch(url, { headers: process.env.FINMIND_TOKEN ? { Authorization: `Bearer ${process.env.FINMIND_TOKEN}` } : {} });
  if (!response.ok) operational(`${ticker}_${dataset}_HTTP_${response.status}`);
  const payload = await response.json();
  if (Number(payload?.status) !== 200 || !Array.isArray(payload.data)) operational(`${ticker}_${dataset}_invalid_response`);
  return payload.data;
}
async function loadHistory(ticker, tradingDate) {
  const year = Number(tradingDate.slice(0, 4)) - 3;
  const startDate = `${year}-01-01`;
  const [prices, dividends, splits] = await Promise.all([
    fetchDataset("TaiwanStockPrice", ticker, startDate),
    fetchDataset("TaiwanStockDividendResult", ticker, startDate),
    fetchDataset("TaiwanStockSplitPrice", ticker, startDate)
  ]);
  return buy.adjustPriceHistory(cleanRows(prices, tradingDate), [
    ...dividends.filter(row => iso(row?.date) && row.date <= tradingDate).map(row => ({ ...row, kind: "distribution" })),
    ...splits.filter(row => iso(row?.date) && row.date <= tradingDate).map(row => ({ ...row, kind: "split" }))
  ]).rows;
}
async function main() {
  const args = parseArgs(process.argv);
  const quotesFile = args.quotes ? path.resolve(args.quotes) : QUOTES_FILE;
  const outputFile = args.output ? path.resolve(args.output) : OUTPUT_FILE;
  const quotes = readJson(quotesFile, {});
  const refresh = quotes.radar_refresh;
  const tradingDate = String(args["trading-date"] || refresh?.trading_date || "");
  const slot = String(args.slot || refresh?.slot || "");
  if (!iso(tradingDate) || !SLOTS.has(slot) || refresh?.verified !== true || refresh?.status !== "success") throw new Error("a verified raw radar refresh is required");
  const existing = readJson(outputFile, { schema_version: SCHEMA_VERSION, snapshots: [] });
  validateLedger(existing);
  const snapshotKey = `${tradingDate}_${slot.replace(":", "")}`;
  const raw = quotes?.intraday_quote_snapshots?.[snapshotKey];
  const existingSnapshot = existing.snapshots.find(snapshot => snapshot.trading_date === tradingDate && snapshot.slot === slot && snapshot.status === "SUCCESS");
  if (existingSnapshot) {
    const currentFingerprint = rawFingerprint(raw, tradingDate, slot);
    const existingFingerprint = String(existingSnapshot?.source?.input_fingerprint || "");
    if (existingFingerprint && currentFingerprint && existingFingerprint !== currentFingerprint) integrity("same_slot_conflicting_payload");
    console.log(`INTRADAY_CORE_SNAPSHOT ${snapshotKey} already_published_identical`);
    return;
  }
  const histories = Object.fromEntries(await Promise.all(SYMBOLS.map(async symbol => [symbol, await loadHistory(symbol, tradingDate)])));
  const result = buildSnapshot({ quotes, histories, existing, tradingDate, slot, calculatedAt: new Date().toISOString() });
  if (result.published) {
    const snapshots = [...(existing.snapshots || []), result.snapshot].sort((a, b) => `${a.trading_date} ${a.slot}`.localeCompare(`${b.trading_date} ${b.slot}`)).slice(-500);
    writeAtomic(outputFile, { schema_version: SCHEMA_VERSION, artifact: "intraday-core-snapshots-v1", generated_at: result.snapshot.calculated_at, snapshots });
  }
  console.log(`INTRADAY_CORE_SNAPSHOT ${snapshotKey} ${result.reason}`);
}

module.exports = { SYMBOLS, SCORE_VERSION, SLOT_CONTRACT, cleanRows, scoreRows, scorePreviousClose, attachBaselines, rawFingerprint, validateLedger, buildSnapshot };
if (require.main === module) main().catch(error => { console.error(`INTRADAY_CORE_SNAPSHOT_FAILED ${error.message}`); process.exitCode = 1; });
