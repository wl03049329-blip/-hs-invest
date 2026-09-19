#!/usr/bin/env node
"use strict";

// Explicit, research-only reconstruction. Never imported by production jobs.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {execFileSync} = require("node:child_process");
const buy = require("../buy-point-core.js");
const core = require("../final-core-production.js");
const decisionLayer = require("../hs-decision-layer-v1.js");
const weeklyVersions = require("../research/c4_historical/weekly_j_versions.js");

const ROOT = path.resolve(__dirname, "..");
const RESEARCH_DIR = path.join(ROOT, "research", "c4_historical");
const SYMBOLS = Object.freeze(["0050", "00662", "00830", "00935", "009815"]);
const STATUS = "RESEARCH_HISTORICAL";
const SOURCE_VERSION = "FINMIND_AS_OF_ADJUSTED_OHLC_V1";
const FORMULA_VERSION = core.LONG_TERM_CORE_SCORE_VERSION;
const SCORE_LEVEL_VERSION = decisionLayer.SCORE_LEVEL_VERSION;
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const canonical = value => JSON.stringify(stable(value));
const sha = value => crypto.createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : canonical(value)).digest("hex");
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
const finite = value => typeof value === "number" && Number.isFinite(value);
const codeHash = file => sha(fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n"));
const builderHash = () => codeHash(__filename);
const weeklyHelperHash = () => codeHash(path.join(ROOT, "research", "c4_historical", "weekly_j_versions.js"));

function normalizePrice(rows, start, end) {
  return (Array.isArray(rows) ? rows : []).map(row => ({
    date: String(row.date || ""), open: Number(row.open), max: Number(row.max ?? row.high),
    min: Number(row.min ?? row.low), close: Number(row.close),
    Trading_Volume: Number(row.Trading_Volume ?? row.volume)
  })).filter(row => validDate(row.date) && row.date >= start && row.date <= end &&
    row.open > 0 && row.max > 0 && row.min > 0 && row.close > 0 && row.max >= row.min
  ).sort((a, b) => a.date.localeCompare(b.date));
}

function sourceRows(source, symbol) {
  if (source?.symbol !== symbol || source?.source_version !== SOURCE_VERSION ||
      !Array.isArray(source.price) || !Array.isArray(source.dividend) || !Array.isArray(source.split)) {
    throw Error(`RESEARCH_SOURCE_INVALID:${symbol}`);
  }
  const prices = normalizePrice(source.price, "0000-01-01", "9999-12-31");
  if ((!prices.length && symbol !== "009815") || new Set(prices.map(row => row.date)).size !== prices.length) throw Error(`RESEARCH_PRICE_DATES_INVALID:${symbol}`);
  return prices;
}

function decisionFromAdjusted(symbol, date, rows, weeklyJVersion = weeklyVersions.LEGACY) {
  // Input selection mirrors the official EOD publisher; all factor/scoring math
  // stays in the shared production helpers below.
  const weekly = weeklyVersions.calculateWeeklyJ(rows, weeklyJVersion).at(-1);
  const high = Math.max(...rows.slice(-252).map(row => row.max));
  const dd52 = high > 0 ? (rows.at(-1).close / high - 1) * 100 : null;
  return {...core.buildFinal({ticker: symbol, j: weekly?.j, k: weekly?.k, d: weekly?.d,
    dd52, rows, marketAsOf: `${date}T13:30:00+08:00`}), source_close: rows.at(-1).close};
}

function reconstruct(symbol, source, generatedAt, generationCommit, comparison = null) {
  if (!SYMBOLS.includes(symbol)) throw Error(`RESEARCH_SYMBOL_NOT_ALLOWED:${symbol}`);
  const prices = sourceRows(source, symbol);
  const sourceHash = sha(source);
  const records = [];
  for (let i = 0; i < prices.length; i += 1) {
    const date = prices[i].date;
    const start = `${Number(date.slice(0, 4)) - 3}-01-01`;
    const raw = prices.slice(0, i + 1).filter(row => row.date >= start);
    // Mirrors the official publisher's as-of corporate-action convention.
    const events = [
      ...source.dividend.filter(row => validDate(row.date) && row.date <= date).map(row => ({...row, kind: "distribution"})),
      ...source.split.filter(row => validDate(row.date) && row.date <= date).map(row => ({...row, kind: "split"}))
    ];
    const adjusted = buy.adjustPriceHistory(raw, events).rows;
    if (adjusted.length < 252 || adjusted.at(-1)?.date !== date) continue;
    const decision = decisionFromAdjusted(symbol, date, adjusted);
    if (decision.coreScoreVersion !== FORMULA_VERSION || decision.scoreStatus !== "complete") continue;
    const factors = decision.coreFactors;
    if (![factors.weeklyJ, factors.dd52, factors.crash].every(f => finite(f.raw) && finite(f.score) && finite(f.contribution))) continue;
    const display = decision.coreScoreDisplay;
    const level = decisionLayer.STAGES.find(stage => display >= stage.min)?.label;
    if (!level || !finite(display) || !finite(decision.coreScore)) throw Error(`RESEARCH_FORMULA_INVALID:${symbol}:${date}`);
    records.push({
      date, etf: symbol, strategy_id: FORMULA_VERSION, data_status: STATUS,
      weekly_j_version: weeklyVersions.LEGACY,
      close: decision.source_close,
      weekly_j_raw: factors.weeklyJ.raw, weekly_j_score: factors.weeklyJ.score,
      weekly_j_contribution: factors.weeklyJ.contribution,
      dd52_raw: factors.dd52.raw, dd52_score: factors.dd52.score,
      dd52_contribution: factors.dd52.contribution,
      crash_raw: factors.crash.raw, crash_score: factors.crash.score,
      crash_contribution: factors.crash.contribution,
      raw_total: decision.coreScore, display_score: display, level,
      score_level_version: SCORE_LEVEL_VERSION,
      source_version: SOURCE_VERSION, formula_version: FORMULA_VERSION, generated_at: generatedAt,
      provenance: {source_ohlc_sha256: sourceHash}
    });
    if (comparison) {
      const tw = decisionFromAdjusted(symbol, date, adjusted, weeklyVersions.TW);
      if (tw.scoreStatus !== "complete") throw Error(`RESEARCH_TW_FACTOR_UNAVAILABLE:${symbol}:${date}`);
      const twDisplay = tw.coreScoreDisplay;
      comparison.push({date, legacy_j: factors.weeklyJ.raw, tw_j: tw.coreFactors.weeklyJ.raw,
        legacy_display_score: display, tw_display_score: twDisplay,
        legacy_level: level, tw_level: decisionLayer.STAGES.find(stage => twDisplay >= stage.min)?.label});
    }
  }
  return records;
}

function checkParity(symbol, records, finalized) {
  const byDate = new Map(records.map(record => [record.date, record]));
  const differences = [];
  let overlap = 0;
  for (const snapshot of finalized?.snapshots || []) {
    if (snapshot.snapshot_type !== "FINALIZED_CLOSE" || snapshot.finalized !== true) continue;
    const research = byDate.get(snapshot.date);
    if (!research) continue;
    const production = snapshot.rows?.find(row => row.symbol === symbol);
    if (!production || !finite(production.final_core_score)) continue;
    overlap += 1;
    const productionLevel = decisionLayer.STAGES.find(stage => Math.floor(production.final_core_score) >= stage.min)?.label;
    for (const [field, actual, expected] of [
      ["weekly_j_raw", research.weekly_j_raw, production.factors?.weekly_j?.raw],
      ["weekly_j_score", research.weekly_j_score, production.factors?.weekly_j?.score],
      ["weekly_j_contribution", research.weekly_j_contribution, production.factors?.weekly_j?.contribution],
      ["dd52_raw", research.dd52_raw, production.factors?.dd52?.raw],
      ["dd52_score", research.dd52_score, production.factors?.dd52?.score],
      ["dd52_contribution", research.dd52_contribution, production.factors?.dd52?.contribution],
      ["crash_raw", research.crash_raw, production.factors?.crash?.raw],
      ["crash_score", research.crash_score, production.factors?.crash?.score],
      ["crash_contribution", research.crash_contribution, production.factors?.crash?.contribution],
      ["raw_total", research.raw_total, production.final_core_score],
      ["display_score", research.display_score, Math.floor(production.final_core_score)],
      ["level", research.level, productionLevel],
      ["production_tier", core.labelFor(research.raw_total)?.label, production.tier]
    ]) {
      const match = typeof expected === "string" ? actual === expected :
        finite(expected) && finite(actual) &&
        (field === "display_score" || field.endsWith("_score") ? actual === expected : Math.abs(actual - expected) <= 1e-10);
      if (!match) {
        differences.push({date: snapshot.date, etf: symbol, field, production_value: expected ?? null,
          research_value: actual ?? null, difference: finite(expected) && finite(actual) ? actual - expected : null});
      }
    }
  }
  return {overlap_dates: overlap, matching_dates: overlap - new Set(differences.map(item => item.date)).size, mismatches: differences};
}

function artifact(symbol, source, records, parity, generatedAt, generationCommit) {
  const metadata = {
    schema_version: 1, etf: symbol, strategy_id: FORMULA_VERSION, data_status: STATUS,
    score_level_version: SCORE_LEVEL_VERSION,
    weekly_j_version: weeklyVersions.LEGACY,
    source_version: SOURCE_VERSION, formula_version: FORMULA_VERSION, generated_at: generatedAt,
    provenance: {
      source_ohlc_artifact: `research/c4_historical/source/${symbol}.json`,
      source_ohlc_sha256: sha(source), model_version: FORMULA_VERSION,
      formula_version: FORMULA_VERSION, weekly_j_version: weeklyVersions.LEGACY,
      generation_commit: generationCommit, builder_sha256: builderHash(),
      weekly_j_helper_sha256: weeklyHelperHash()
    },
    sample_start: records[0]?.date ?? null, sample_end: records.at(-1)?.date ?? null,
    record_count: records.length, records_sha256: sha(records),
    parity_status: parity.overlap_dates ? "CHECKED" : "NO_FINALIZED_OVERLAP",
    parity
  };
  const unsigned = {metadata, records};
  return {...unsigned, artifact_sha256: sha(unsigned)};
}

function comparisonSummary(symbol, rows, source, generatedAt, generationCommit) {
  const diffs = rows.map(row => Math.abs(row.legacy_j - row.tw_j));
  return {etf: symbol, data_status: "RESEARCH_WEEKLY_J_TW_V2_COMPARISON",
    score_level_version: SCORE_LEVEL_VERSION,
    legacy_weekly_j_version: weeklyVersions.LEGACY, tw_weekly_j_version: weeklyVersions.TW,
    source_ohlc_sha256: sha(source), strategy_id: FORMULA_VERSION, generated_at: generatedAt,
    generation_commit: generationCommit, builder_sha256: builderHash(),
    weekly_j_helper_sha256: weeklyHelperHash(), sample_start: rows[0]?.date ?? null,
    sample_end: rows.at(-1)?.date ?? null, record_count: rows.length,
    weekly_j_differing_days: diffs.filter(value => value > 1e-10).length,
    weekly_j_mean_absolute_difference: diffs.length ? diffs.reduce((a, b) => a + b, 0) / diffs.length : null,
    weekly_j_max_absolute_difference: diffs.length ? Math.max(...diffs) : null,
    display_score_differing_days: rows.filter(row => row.legacy_display_score !== row.tw_display_score).length,
    level_differing_days: rows.filter(row => row.legacy_level !== row.tw_level).length};
}

async function fetchDataset(dataset, symbol, start, end) {
  const url = new URL("https://api.finmindtrade.com/api/v4/data");
  for (const [key, value] of Object.entries({dataset, data_id: symbol, start_date: start, end_date: end})) url.searchParams.set(key, value);
  const headers = process.env.FINMIND_TOKEN ? {Authorization: `Bearer ${process.env.FINMIND_TOKEN}`} : {};
  const response = await fetch(url, {headers, signal: AbortSignal.timeout(30000)});
  const payload = await response.json();
  if (!response.ok || Number(payload.status) !== 200 || !Array.isArray(payload.data)) throw Error(`RESEARCH_SOURCE_FETCH_FAILED:${symbol}:${dataset}:${response.status}`);
  return payload.data;
}

async function fetchSource(symbol, end) {
  const start = "2000-01-01";
  const [price, dividend, split] = await Promise.all([
    fetchDataset("TaiwanStockPrice", symbol, start, end),
    fetchDataset("TaiwanStockDividendResult", symbol, start, end),
    fetchDataset("TaiwanStockSplitPrice", symbol, start, end)
  ]);
  return {source_version: SOURCE_VERSION, provider: "FinMind", symbol, requested_start: start, requested_end: end, fetched_at: new Date().toISOString(), price, dividend, split};
}

function writeResearch(file, value, regenerate) {
  const bytes = `${canonical(value)}\n`;
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file, "utf8") === bytes) return "UNCHANGED";
    if (!regenerate) throw Error(`RESEARCH_EXPLICIT_REGENERATION_REQUIRED:${path.basename(file)}`);
  }
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, bytes, {flag: "wx"});
  fs.renameSync(temporary, file);
  return "WRITTEN";
}

async function main() {
  const args = process.argv.slice(2);
  const fetchNew = args.includes("--fetch");
  const regenerate = args.includes("--regenerate");
  const endIndex = args.indexOf("--end");
  const end = endIndex >= 0 ? args[endIndex + 1] : "";
  if (fetchNew && !validDate(end)) throw Error("RESEARCH_EXPLICIT_END_DATE_REQUIRED");
  const generationCommit = execFileSync("git", ["rev-parse", "HEAD"], {cwd: ROOT, encoding: "utf8"}).trim();
  const finalized = JSON.parse(fs.readFileSync(path.join(ROOT, "finalized-core-score-snapshots-v1.json"), "utf8"));
  const sources = new Map();
  for (const symbol of SYMBOLS) {
    const file = path.join(RESEARCH_DIR, "source", `${symbol}.json`);
    sources.set(symbol, fetchNew ? await fetchSource(symbol, end) : JSON.parse(fs.readFileSync(file, "utf8")));
  }
  const outputs = new Map();
  const comparisons = [];
  const parityFailures = [];
  const missingOverlap = [];
  for (const symbol of SYMBOLS) {
    const source = sources.get(symbol);
    const generatedAt = source.fetched_at;
    if (!Number.isFinite(Date.parse(generatedAt))) throw Error(`RESEARCH_SOURCE_FETCH_TIME_INVALID:${symbol}`);
    const comparisonRows = [];
    const records = reconstruct(symbol, source, generatedAt, generationCommit, comparisonRows);
    const parity = checkParity(symbol, records, finalized);
    console.log(JSON.stringify({status: "RESEARCH_PREFLIGHT", etf: symbol, source_start: source.price[0]?.date || null,
      source_end: source.price.at(-1)?.date || null, research_start: records[0]?.date || null,
      research_end: records.at(-1)?.date || null, count: records.length, overlap_dates: parity.overlap_dates,
      mismatch_count: parity.mismatches.length}));
    if (parity.mismatches.length) parityFailures.push(...parity.mismatches);
    if (records.length && !parity.overlap_dates) missingOverlap.push(symbol);
    outputs.set(symbol, artifact(symbol, source, records, parity, generatedAt, generationCommit));
    comparisons.push(comparisonSummary(symbol, comparisonRows, source, generatedAt, generationCommit));
  }
  if (parityFailures.length || missingOverlap.length) {
    console.error(JSON.stringify({status: "RESEARCH_PARITY_FAILED", mismatch_count: parityFailures.length,
      missing_overlap: missingOverlap,
      by_etf_field: parityFailures.reduce((out, item) => {const key = `${item.etf}:${item.field}`; out[key] = (out[key] || 0) + 1; return out}, {}),
      examples: [...new Map(parityFailures.map(item => [`${item.etf}:${item.field}`, item])).values()]}));
    process.exitCode = 1;
    return; // No research artifact or source write on parity failure.
  }
  for (const symbol of SYMBOLS) {
    const sourceFile = path.join(RESEARCH_DIR, "source", `${symbol}.json`);
    const resultFile = path.join(RESEARCH_DIR, `${symbol}.json`);
    writeResearch(sourceFile, sources.get(symbol), regenerate);
    writeResearch(resultFile, outputs.get(symbol), regenerate);
    const result = outputs.get(symbol);
    console.log(JSON.stringify({etf: symbol, start: result.metadata.sample_start, end: result.metadata.sample_end, count: result.metadata.record_count, parity: result.metadata.parity}));
  }
  const comparison = {schema_version: 1, data_status: "RESEARCH_WEEKLY_J_TW_V2_COMPARISON",
    score_level_version: SCORE_LEVEL_VERSION,
    legacy_weekly_j_version: weeklyVersions.LEGACY, tw_weekly_j_version: weeklyVersions.TW,
    etfs: comparisons};
  writeResearch(path.join(RESEARCH_DIR, "weekly_j_comparison.json"),
    {...comparison, content_sha256: sha(comparison)}, regenerate);
}

module.exports = {SYMBOLS, STATUS, SOURCE_VERSION, FORMULA_VERSION, SCORE_LEVEL_VERSION, sha, normalizePrice, sourceRows,
  decisionFromAdjusted, reconstruct, checkParity, artifact, comparisonSummary, writeResearch};
if (require.main === module) main().catch(error => {console.error(error.message); process.exitCode = 1});
