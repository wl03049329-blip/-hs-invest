#!/usr/bin/env node
"use strict";

// Phase 7A research-only historical outcome engine. Never imported by production.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {execFileSync} = require("node:child_process");
const buy = require("../buy-point-core.js");
const decision = require("../hs-decision-layer-v1.js");
const historyBuilder = require("./build_c4_research_history.js");

const ROOT = path.resolve(__dirname, "..");
const HISTORY_DIR = path.join(ROOT, "research", "c4_historical");
const OUTPUT_DIR = path.join(ROOT, "research", "c4_outcomes");
const SYMBOLS = Object.freeze(["0050", "00662", "00830", "00935"]);
const EXCLUDED = Object.freeze(["009815", "00631L"]);
const HORIZONS = Object.freeze([5, 20, 40, 60]);
const STATUS = "RESEARCH_HISTORICAL_OUTCOME_V1";
const WEEKLY_J_VERSION = "WEEKLY_J_PRODUCTION_LEGACY_V1";
const FORMULA_VERSION = historyBuilder.FORMULA_VERSION;
const THRESHOLDS = Object.freeze([...decision.NEXT_THRESHOLDS]);
const DD52_BANDS = Object.freeze([
  {id: "DD52_0_TO_NEG5", label: "0% ～ -5%", upper: 0, lower: -5},
  {id: "DD52_NEG5_TO_NEG10", label: "-5% ～ -10%", upper: -5, lower: -10},
  {id: "DD52_NEG10_TO_NEG15", label: "-10% ～ -15%", upper: -10, lower: -15},
  {id: "DD52_NEG15_TO_NEG20", label: "-15% ～ -20%", upper: -15, lower: -20},
  {id: "DD52_NEG20_TO_NEG25", label: "-20% ～ -25%", upper: -20, lower: -25},
  {id: "DD52_NEG25_TO_NEG30", label: "-25% ～ -30%", upper: -25, lower: -30},
  {id: "DD52_NEG30_OR_DEEPER", label: "<= -30%", upper: -30, lower: -Infinity}
]);

const finite = value => typeof value === "number" && Number.isFinite(value);
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === "object" ?
  Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const canonical = value => JSON.stringify(stable(value));
const sha = value => crypto.createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : canonical(value)).digest("hex");
const codeHash = file => sha(fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n"));

function stageFor(score) {
  return decision.STAGES.find(stage => score >= stage.min) || null;
}

function dd52Band(value) {
  if (!finite(value) || value > 0) return null;
  return DD52_BANDS.find(band => value <= band.upper && value > band.lower) || null;
}

function quantile(sorted, probability) {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position), upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function sampleClass(count) {
  return count < 10 ? "VERY_SMALL" : count < 30 ? "SMALL" : "NORMAL";
}

function statistics(records, horizon) {
  const key = `forward_${horizon}d`;
  const values = records.map(record => record[key]).filter(finite).sort((a, b) => a - b);
  const count = values.length;
  return {
    sample_count: count,
    mean_return: count ? values.reduce((sum, value) => sum + value, 0) / count : null,
    median_return: quantile(values, .5),
    positive_rate: count ? values.filter(value => value > 0).length / count : null,
    best_return: count ? values.at(-1) : null,
    worst_return: count ? values[0] : null,
    p25: quantile(values, .25), p75: quantile(values, .75),
    sample_class: sampleClass(count), small_sample: count < 10
  };
}

function aggregate(records) {
  return Object.fromEntries(HORIZONS.map(horizon => [`${horizon}d`, statistics(records, horizon)]));
}

function validateInputs(symbol, research, source) {
  if (!SYMBOLS.includes(symbol)) throw Error(`OUTCOME_SYMBOL_NOT_ALLOWED:${symbol}`);
  const metadata = research?.metadata, records = research?.records;
  if (metadata?.data_status !== historyBuilder.STATUS || metadata?.weekly_j_version !== WEEKLY_J_VERSION ||
      metadata?.strategy_id !== FORMULA_VERSION || metadata?.formula_version !== FORMULA_VERSION) {
    throw Error(`OUTCOME_RESEARCH_VERSION_MISMATCH:${symbol}`);
  }
  if (!Array.isArray(records) || records.length !== metadata.record_count || metadata.records_sha256 !== sha(records) ||
      research.artifact_sha256 !== sha({metadata, records}) || metadata.sample_start !== records[0]?.date ||
      metadata.sample_end !== records.at(-1)?.date) throw Error(`OUTCOME_RESEARCH_INTEGRITY_FAILED:${symbol}`);
  if (metadata.parity_status !== "CHECKED" || !metadata.parity?.overlap_dates || metadata.parity?.mismatches?.length) {
    throw Error(`OUTCOME_RESEARCH_PARITY_FAILED:${symbol}`);
  }
  const sourceHash = sha(source);
  if (source?.symbol !== symbol || source?.source_version !== historyBuilder.SOURCE_VERSION ||
      sourceHash !== metadata?.provenance?.source_ohlc_sha256) throw Error(`OUTCOME_PRICE_SOURCE_HASH_MISMATCH:${symbol}`);
  let previous = "";
  for (const row of records) {
    const stage = stageFor(row.display_score);
    if (row.etf !== symbol || row.data_status !== historyBuilder.STATUS || row.weekly_j_version !== WEEKLY_J_VERSION ||
        row.strategy_id !== FORMULA_VERSION || row.formula_version !== FORMULA_VERSION || !validDate(row.date) ||
        row.date <= previous || !finite(row.display_score) || !finite(row.raw_total) || !finite(row.dd52_raw) ||
        !finite(row.weekly_j_raw) || !finite(row.crash_raw) || !stage || row.level !== stage.label) {
      throw Error(`OUTCOME_RESEARCH_ROW_INVALID:${symbol}:${row?.date || "UNKNOWN"}`);
    }
    previous = row.date;
  }
  return sourceHash;
}

function adjustedPrices(source, symbol) {
  const prices = historyBuilder.sourceRows(source, symbol);
  const events = [
    ...source.dividend.filter(row => validDate(row.date)).map(row => ({...row, kind: "distribution"})),
    ...source.split.filter(row => validDate(row.date)).map(row => ({...row, kind: "split"}))
  ];
  const rows = buy.adjustPriceHistory(prices, events).rows;
  if (!rows.length || rows.some(row => !validDate(row.date) || !finite(row.close) || row.close <= 0)) {
    throw Error(`OUTCOME_ADJUSTED_PRICE_INVALID:${symbol}`);
  }
  return rows;
}

function outcomeFields(index, priceRows) {
  const output = {};
  for (const horizon of HORIZONS) {
    const target = priceRows[index + horizon], mature = Boolean(target);
    output[`mature_${horizon}d`] = mature;
    output[`target_date_${horizon}d`] = target?.date || null;
    output[`forward_${horizon}d`] = mature ? target.close / priceRows[index].close - 1 : null;
  }
  return output;
}

function dailySamples(symbol, records, priceRows) {
  const priceIndex = new Map(priceRows.map((row, index) => [row.date, index]));
  return records.map(row => {
    const index = priceIndex.get(row.date), band = dd52Band(row.dd52_raw), stage = stageFor(row.display_score);
    if (!Number.isInteger(index) || !band || !stage) throw Error(`OUTCOME_PRICE_DATE_MISSING:${symbol}:${row.date}`);
    return {
      etf: symbol, date: row.date, event_type: "LEVEL_DAILY", level: stage.stage, level_label: stage.label,
      display_score: row.display_score, raw_total: row.raw_total, dd52: row.dd52_raw,
      weekly_j: row.weekly_j_raw, crash: row.crash_raw, dd52_band: band.id,
      adjusted_close: priceRows[index].close, ...outcomeFields(index, priceRows)
    };
  });
}

function entryEvents(samples) {
  const events = [];
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1], current = samples[index];
    const from = decision.STAGES.find(stage => stage.stage === previous.level);
    const to = decision.STAGES.find(stage => stage.stage === current.level);
    if (!from || !to || to.min <= from.min) continue;
    events.push({...current, event_type: "LEVEL_ENTRY_UP", from_level: from.stage, from_level_label: from.label,
      to_level: to.stage, to_level_label: to.label,
      crossed_thresholds: THRESHOLDS.filter(threshold => previous.display_score < threshold && current.display_score >= threshold)});
  }
  return events;
}

function nonOverlap60(events, sampleDates) {
  const indexByDate = new Map(sampleDates.map((date, index) => [date, index]));
  const lastAccepted = new Map(), output = [];
  for (const event of events) {
    const index = indexByDate.get(event.date), previous = lastAccepted.get(event.to_level);
    if (previous !== undefined && index - previous < 60) continue;
    output.push({...event, overlap_mode: "NON_OVERLAP_60D"});
    lastAccepted.set(event.to_level, index);
  }
  return output;
}

function groupedSummary(samples, selector, definitions) {
  return Object.fromEntries(definitions.map(definition => {
    const rows = samples.filter(row => selector(row, definition));
    return [definition.id, {...definition, total_records: rows.length, horizons: aggregate(rows)}];
  }));
}

function summaryBody(samples, events, nonOverlap) {
  const levels = [...decision.STAGES].reverse().map(stage => ({id: stage.stage, label: stage.label, min_score: stage.min}));
  const thresholds = THRESHOLDS.map(value => ({id: `SCORE_${value}_PLUS`, label: `${value}+`, threshold: value}));
  const bands = DD52_BANDS.map(({lower, upper, ...rest}) => rest);
  return {
    level_daily: groupedSummary(samples, (row, item) => row.level === item.id, levels),
    level_entry_all: groupedSummary(events, (row, item) => row.to_level === item.id, levels),
    level_entry_non_overlap_60d: groupedSummary(nonOverlap, (row, item) => row.to_level === item.id, levels),
    threshold_samples: groupedSummary(samples, (row, item) => row.display_score >= item.threshold, thresholds),
    dd52_bands: groupedSummary(samples, (row, item) => row.dd52_band === item.id, bands)
  };
}

function metadataFor(symbol, research, sourceHash, adjusted, generatedAt, generationCommit) {
  return {
    schema_version: 1, data_status: STATUS, etf: symbol, strategy_id: FORMULA_VERSION,
    formula_version: FORMULA_VERSION, weekly_j_version: WEEKLY_J_VERSION,
    source_research_artifact: `research/c4_historical/${symbol}.json`,
    source_research_hash: research.artifact_sha256,
    price_source_artifact: `research/c4_historical/source/${symbol}.json`,
    price_source_hash: sourceHash, adjusted_price_sha256: sha(adjusted),
    builder_sha256: codeHash(__filename), generation_commit: generationCommit, generated_at: generatedAt,
    sample_start: research.metadata.sample_start, sample_end: research.metadata.sample_end,
    transaction_costs: "EXCLUDED", forward_definition: "adjusted_close[t+N] / adjusted_close[t] - 1",
    horizon_unit: "TRADING_SESSION", condition_timing: "DAY_T_FINALIZED_CLOSE",
    overlap_policy: {level_daily: "ALLOW_OVERLAP", level_entry_all: "ENTRY_ALL", level_entry_non_overlap_60d: "NON_OVERLAP_60D"},
    no_look_ahead: true, outlier_policy: "PRESERVE_ALL"
  };
}

function signedArtifact(metadata, body) {
  const contentMetadata = {...metadata};
  delete contentMetadata.generated_at;
  const content_sha256 = sha({metadata: contentMetadata, ...body});
  const unsigned = {metadata: {...metadata, content_sha256}, ...body};
  return {...unsigned, artifact_sha256: sha(unsigned)};
}

function buildOne(symbol, research, source, options = {}) {
  const generatedAt = options.generatedAt || new Date().toISOString();
  const generationCommit = options.generationCommit || "UNKNOWN";
  const sourceHash = validateInputs(symbol, research, source);
  const adjusted = adjustedPrices(source, symbol), samples = dailySamples(symbol, research.records, adjusted);
  const events = entryEvents(samples), nonOverlap = nonOverlap60(events, samples.map(row => row.date));
  const metadata = metadataFor(symbol, research, sourceHash, adjusted, generatedAt, generationCommit);
  const raw = signedArtifact(metadata, {daily_samples: samples,
    level_entry_all: events.map(event => ({...event, overlap_mode: "ENTRY_ALL"})),
    level_entry_non_overlap_60d: nonOverlap});
  const summary = signedArtifact(metadata, {summary: summaryBody(samples, events, nonOverlap),
    counts: {research_rows: samples.length, entry_events: events.length,
      non_overlap_events: nonOverlap.length,
      mature_5d: samples.filter(row => row.mature_5d).length,
      mature_20d: samples.filter(row => row.mature_20d).length,
      mature_40d: samples.filter(row => row.mature_40d).length,
      mature_60d: samples.filter(row => row.mature_60d).length}});
  return {raw, summary};
}

function buildAll(options = {}) {
  const generatedAt = options.generatedAt || new Date().toISOString();
  const generationCommit = options.generationCommit || execFileSync("git", ["rev-parse", "HEAD"], {cwd: ROOT, encoding: "utf8"}).trim();
  const artifacts = new Map(), indexEntries = [];
  for (const symbol of SYMBOLS) {
    try {
      const research = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, `${symbol}.json`), "utf8"));
      const source = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, "source", `${symbol}.json`), "utf8"));
      const built = buildOne(symbol, research, source, {generatedAt, generationCommit});
      artifacts.set(symbol, built);
      indexEntries.push({etf: symbol, status: "READY", sample_start: built.summary.metadata.sample_start,
        sample_end: built.summary.metadata.sample_end, research_rows: built.summary.counts.research_rows,
        entry_events: built.summary.counts.entry_events, non_overlap_events: built.summary.counts.non_overlap_events,
        raw_artifact: `raw/${symbol}.json`, raw_sha256: built.raw.artifact_sha256,
        summary_artifact: `summary/${symbol}.json`, summary_sha256: built.summary.artifact_sha256});
    } catch (error) {
      indexEntries.push({etf: symbol, status: "HOLD", reason: String(error?.message || "OUTCOME_UNKNOWN_FAILURE").split(":").slice(0, 2).join(":")});
    }
  }
  indexEntries.push({etf: "009815", status: "HOLD", reason: "WAIT_NATIVE_NO_RESEARCH_HISTORY"});
  if (indexEntries.some(item => SYMBOLS.includes(item.etf) && item.status !== "READY")) {
    const failed = indexEntries.filter(item => item.status !== "READY");
    throw Error(`OUTCOME_BUILD_HOLD:${failed.map(item => `${item.etf}:${item.reason}`).join(",")}`);
  }
  const indexMetadata = {schema_version: 1, data_status: STATUS, strategy_id: FORMULA_VERSION,
    weekly_j_version: WEEKLY_J_VERSION, generated_at: generatedAt, generation_commit: generationCommit,
    builder_sha256: codeHash(__filename), transaction_costs: "EXCLUDED", pooled_etfs: false};
  return {artifacts, index: signedArtifact(indexMetadata, {etfs: indexEntries})};
}

function writeArtifact(file, value, regenerate) {
  const bytes = `${canonical(value)}\n`;
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file, "utf8") === bytes) return "UNCHANGED";
    if (!regenerate) throw Error(`OUTCOME_EXPLICIT_REGENERATION_REQUIRED:${path.basename(file)}`);
  }
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, bytes, {flag: "wx"});
  fs.renameSync(temporary, file);
  return "WRITTEN";
}

function main() {
  const args = process.argv.slice(2), regenerate = args.includes("--regenerate");
  const outputIndex = args.indexOf("--output-dir");
  const outputDir = outputIndex >= 0 ? path.resolve(args[outputIndex + 1]) : OUTPUT_DIR;
  const generatedAtIndex = args.indexOf("--generated-at");
  const generatedAt = generatedAtIndex >= 0 ? args[generatedAtIndex + 1] : new Date().toISOString();
  if (!Number.isFinite(Date.parse(generatedAt))) throw Error("OUTCOME_GENERATED_AT_INVALID");
  const built = buildAll({generatedAt});
  for (const [symbol, files] of built.artifacts) {
    writeArtifact(path.join(outputDir, "raw", `${symbol}.json`), files.raw, regenerate);
    writeArtifact(path.join(outputDir, "summary", `${symbol}.json`), files.summary, regenerate);
    console.log(JSON.stringify({status: "OUTCOME_READY", etf: symbol, ...files.summary.counts,
      raw_sha256: files.raw.artifact_sha256, summary_sha256: files.summary.artifact_sha256}));
  }
  writeArtifact(path.join(outputDir, "index.json"), built.index, regenerate);
  console.log(JSON.stringify({status: "OUTCOME_INDEX_READY", etfs: built.index.etfs}));
}

module.exports = {SYMBOLS, EXCLUDED, HORIZONS, STATUS, WEEKLY_J_VERSION, FORMULA_VERSION, THRESHOLDS,
  DD52_BANDS, stable, canonical, sha, stageFor, dd52Band, quantile, statistics, aggregate,
  validateInputs, adjustedPrices, outcomeFields, dailySamples, entryEvents, nonOverlap60,
  summaryBody, metadataFor, signedArtifact, buildOne, buildAll, writeArtifact};

if (require.main === module) {
  try { main(); } catch (error) { console.error(String(error?.message || "OUTCOME_BUILD_FAILED")); process.exitCode = 1; }
}
