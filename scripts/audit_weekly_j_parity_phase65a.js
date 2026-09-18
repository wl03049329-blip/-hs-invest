#!/usr/bin/env node
"use strict";

// Audit-only replay. Does not import any production publisher or write C4 history.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const buy = require("../buy-point-core.js");
const core = require("../final-core-production.js");

const ROOT = path.resolve(__dirname, "..");
const OUTPUT = path.join(ROOT, "research", "audits", "weekly_j_parity");
const CASES = Object.freeze([["0050", "2026-09-18"], ["00662", "2026-09-17"], ["00830", "2026-09-18"]]);
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));

function withTimezone(timezone, fn) {
  const before = process.env.TZ;
  process.env.TZ = timezone;
  try { return fn(); }
  finally { if (before === undefined) delete process.env.TZ; else process.env.TZ = before; }
}

function weekKey(date) {
  // Mirrors buy-point-core.weeklyKdj byte-for-byte in its date handling.
  const parsed = new Date(`${date}T00:00:00+08:00`);
  const weekday = parsed.getDay() || 7;
  const monday = new Date(parsed);
  monday.setDate(parsed.getDate() - weekday + 1);
  return monday.toISOString().slice(0, 10);
}

function weeklyTrace(rows, timezone) {
  return withTimezone(timezone, () => {
    const weeks = new Map();
    const assignments = [];
    for (const row of rows) {
      const date = String(row.date || "");
      const close = Number(row.close), high = Number(row.max ?? row.close), low = Number(row.min ?? row.close);
      if (!validDate(date) || ![close, high, low].every(Number.isFinite)) continue;
      const key = weekKey(date);
      assignments.push({date, week_key: key});
      if (!weeks.has(key)) weeks.set(key, {date, week_key: key, week_start: date, week_end: date,
        open: Number.isFinite(Number(row.open)) ? Number(row.open) : close,
        close, high, low, volume: null, source_daily_dates: []});
      const week = weeks.get(key);
      week.date = date; week.week_end = date; week.close = close;
      week.high = Math.max(week.high, high); week.low = Math.min(week.low, low);
      week.source_daily_dates.push(date);
      const volume = Number(row.Trading_Volume ?? row.trading_volume ?? row.volume);
      if (Number.isFinite(volume)) week.volume = (week.volume ?? 0) + volume;
    }
    const bars = [...weeks.values()].sort((a, b) => a.date.localeCompare(b.date));
    let k = 50, d = 50;
    const trace = bars.map((bar, index) => {
      const window = bars.slice(Math.max(0, index - 8), index + 1);
      const high = Math.max(...window.map(item => item.high));
      const low = Math.min(...window.map(item => item.low));
      const rsv = high === low ? 50 : (bar.close - low) / (high - low) * 100;
      const previousK = k, previousD = d;
      k = 2 / 3 * k + 1 / 3 * rsv;
      d = 2 / 3 * d + 1 / 3 * k;
      return {week_key: bar.week_key, week_start: bar.week_start, week_end: bar.week_end,
        source_daily_dates: bar.source_daily_dates, rolling_rsv_inputs: {
          week_keys: window.map(item => item.week_key), high, low, close: bar.close},
        rsv, previous_k: previousK, previous_d: previousD, k, d, j: 3 * k - 2 * d};
    });
    const helper = buy.weeklyKdj(rows);
    if (helper.length !== trace.length || trace.some((item, i) =>
      Math.abs(item.k - helper[i].k) > 1e-12 || Math.abs(item.d - helper[i].d) > 1e-12 || Math.abs(item.j - helper[i].j) > 1e-12)) {
      throw Error(`AUDIT_TRACE_HELPER_MISMATCH:${timezone}`);
    }
    return {timezone, weekly_bars: bars, rsv_k_d_j_trace: trace, daily_week_assignments: assignments,
      initialization: {k: 50, d: 50, first_rsv_week: trace[0]?.week_end || null, first_j_week: trace[0]?.week_end || null},
      terminal: trace.at(-1) || null};
  });
}

function firstBoundaryDifference(a, b) {
  if (a.daily_week_assignments.length !== b.daily_week_assignments.length) throw Error("AUDIT_DAILY_RANGE_CONFLICT");
  for (let i = 1; i < a.daily_week_assignments.length; i += 1) {
    const startA = a.daily_week_assignments[i].week_key !== a.daily_week_assignments[i - 1].week_key;
    const startB = b.daily_week_assignments[i].week_key !== b.daily_week_assignments[i - 1].week_key;
    if (startA !== startB) return {date: a.daily_week_assignments[i].date,
      taipei_new_week: startA, utc_new_week: startB,
      taipei_week_key: a.daily_week_assignments[i].week_key,
      utc_week_key: b.daily_week_assignments[i].week_key};
  }
  return null;
}

function clean(rows, cutoff) {
  return (Array.isArray(rows) ? rows : []).map(row => ({date: validDate(row.date) ? row.date : "",
    open: Number(row.open), max: Number(row.max ?? row.high), min: Number(row.min ?? row.low),
    close: Number(row.close), Trading_Volume: Number(row.Trading_Volume ?? row.volume)}))
    .filter(row => row.date && row.date <= cutoff && row.open > 0 && row.max > 0 &&
      row.min > 0 && row.close > 0 && row.max >= row.min)
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchDataset(dataset, symbol, start) {
  const url = new URL("https://api.finmindtrade.com/api/v4/data");
  for (const [key, value] of Object.entries({dataset, data_id: symbol, start_date: start})) url.searchParams.set(key, value);
  const response = await fetch(url, {
    headers: process.env.FINMIND_TOKEN ? {Authorization: `Bearer ${process.env.FINMIND_TOKEN}`} : {},
    signal: AbortSignal.timeout(30000)
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  const parsed = JSON.parse(bytes.toString("utf8"));
  if (!response.ok || Number(parsed.status) !== 200 || !Array.isArray(parsed.data)) throw Error(`AUDIT_SOURCE_UNAVAILABLE:${symbol}:${dataset}:${response.status}`);
  return {rows: parsed.data, response_sha256: sha(bytes)};
}

function makeAudit(symbol, targetDate, productionSnapshot, source, fetchedAt) {
  const production = productionSnapshot?.rows?.find(row => row.symbol === symbol);
  if (productionSnapshot?.snapshot_type !== "FINALIZED_CLOSE" || productionSnapshot.finalized !== true ||
      productionSnapshot.date !== targetDate || !Number.isFinite(production?.factors?.weekly_j?.raw)) throw Error("AUDIT_FINALIZED_INPUT_INVALID");
  const raw = clean(source.price.rows, targetDate);
  const corporateActions = [
    ...source.dividend.rows.filter(row => validDate(row.date) && row.date <= targetDate).map(row => ({...row, kind: "distribution"})),
    ...source.split.rows.filter(row => validDate(row.date) && row.date <= targetDate).map(row => ({...row, kind: "split"}))
  ];
  const adjusted = buy.adjustPriceHistory(raw, corporateActions);
  if (adjusted.rows.length < 252 || adjusted.rows.at(-1)?.date !== targetDate) throw Error("AUDIT_AS_OF_HISTORY_NOT_READY");
  const taipei = weeklyTrace(adjusted.rows, "Asia/Taipei");
  const utc = weeklyTrace(adjusted.rows, "UTC");
  const first = firstBoundaryDifference(taipei, utc);
  const decisions = Object.fromEntries([["Asia/Taipei", taipei], ["UTC", utc]].map(([timezone, trace]) => {
    const terminal = trace.terminal;
    const high = Math.max(...adjusted.rows.slice(-252).map(row => row.max));
    const dd52 = (adjusted.rows.at(-1).close / high - 1) * 100;
    const value = core.buildFinal({ticker: symbol, j: terminal.j, k: terminal.k, d: terminal.d,
      dd52, rows: adjusted.rows, marketAsOf: `${targetDate}T13:30:00+08:00`});
    return [timezone, {weekly_j_raw: terminal.j, raw_total: value.coreScore, display_score: value.coreScoreDisplay}];
  }));
  const exact = (a, b) => Math.abs(a - b) < 1e-10;
  const matched = exact(decisions.UTC.weekly_j_raw, production.factors.weekly_j.raw) &&
    exact(decisions.UTC.raw_total, production.final_core_score);
  if (!first || !matched || exact(decisions["Asia/Taipei"].weekly_j_raw, production.factors.weekly_j.raw)) {
    throw Error(`AUDIT_ROOT_CAUSE_NOT_REPRODUCED:${symbol}:${targetDate}`);
  }
  const targetWeek = trace => trace.weekly_bars.at(-1);
  return {
    data_status: "PARITY_AUDIT", case_id: `${symbol}_${targetDate}`, etf: symbol, target_date: targetDate,
    target_weekday_taipei: withTimezone("Asia/Taipei", () => new Date(`${targetDate}T00:00:00+08:00`).getDay()),
    fetched_at: fetchedAt,
    production: {source: productionSnapshot.source, source_historical_helper: "scripts/finalize_core_score_history.js:decisionAtClose -> buy.weeklyKdj",
      historical_price_response_sha256: "NOT_STORED", corporate_action_response_sha256: "NOT_STORED",
      point_in_time_daily_ohlc: "NOT_STORED", point_in_time_adjusted_ohlc: "NOT_STORED",
      weekly_bars: "NOT_STORED", rsv_k_d_trace: "NOT_STORED",
      weekly_j_raw: production.factors.weekly_j.raw, raw_total: production.final_core_score,
      display_score: Math.floor(production.final_core_score), data_as_of: production.data_as_of},
    research: {source: "FinMind current response, exact official request shape (no end_date)",
      source_response_sha256: {price: source.price.response_sha256, dividend: source.dividend.response_sha256,
        split: source.split.response_sha256}, daily_input_range: {start: raw[0]?.date, end: raw.at(-1)?.date, count: raw.length},
      raw_daily_ohlc: raw, adjusted_daily_ohlc: adjusted.rows,
      corporate_actions: adjusted.events, corporate_action_input_counts: {
        dividend: source.dividend.rows.filter(row => validDate(row.date) && row.date <= targetDate).length,
        split: source.split.rows.filter(row => validDate(row.date) && row.date <= targetDate).length},
      taipei_trace: taipei, utc_replay_trace: utc, values: decisions,
      target_week: {taipei: targetWeek(taipei), utc_replay: targetWeek(utc)}},
    first_divergence_stage: "WEEKLY_GROUPING_BOUNDARY",
    first_boundary_difference: first,
    root_cause: "buy.weeklyKdj constructs Asia/Taipei midnight but uses local getDay/setDate; UTC runner and Taipei-local reconstruction group Mondays differently",
    confidence: "HIGH",
    unverifiable_fields: ["Production point-in-time raw/adjusted OHLC", "Production weekly bar/RSV/K/D trace",
      "Production FinMind price/dividend/split raw responses or hashes"],
    as_of_safety: {latest_source_date: adjusted.rows.at(-1).date, future_daily_rows_used: false,
      future_corporate_actions_used: false, target_week_dates_taipei: targetWeek(taipei).source_daily_dates,
      target_week_dates_utc_replay: targetWeek(utc).source_daily_dates}
  };
}

async function main() {
  const finalized = JSON.parse(fs.readFileSync(path.join(ROOT, "finalized-core-score-snapshots-v1.json"), "utf8"));
  const fetchedAt = new Date().toISOString();
  const audits = [];
  for (const [symbol, targetDate] of CASES) {
    const start = `${Number(targetDate.slice(0, 4)) - 3}-01-01`;
    const [price, dividend, split] = await Promise.all([
      fetchDataset("TaiwanStockPrice", symbol, start),
      fetchDataset("TaiwanStockDividendResult", symbol, start),
      fetchDataset("TaiwanStockSplitPrice", symbol, start)
    ]);
    const audit = makeAudit(symbol, targetDate, finalized.snapshots.find(row => row.date === targetDate),
      {price, dividend, split}, fetchedAt);
    audits.push(audit);
  }
  // No output until all three cases reproduce. Audit path cannot resolve into production artifacts.
  fs.mkdirSync(OUTPUT, {recursive: true});
  for (const audit of audits) {
    fs.writeFileSync(path.join(OUTPUT, `${audit.case_id}.json`), `${JSON.stringify(audit, null, 2)}\n`, {flag: "wx"});
    console.log(JSON.stringify({case: audit.case_id, production_j: audit.production.weekly_j_raw,
      taipei_j: audit.research.values["Asia/Taipei"].weekly_j_raw,
      utc_j: audit.research.values.UTC.weekly_j_raw,
      first_boundary: audit.first_boundary_difference,
      target_week: audit.research.target_week}));
  }
}

module.exports = {CASES, withTimezone, weekKey, weeklyTrace, firstBoundaryDifference, clean, makeAudit};
if (require.main === module) main().catch(error => {console.error(error.message); process.exitCode = 1});
