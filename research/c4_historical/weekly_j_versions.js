"use strict";

// Research-only, explicit reproductions of the production weeklyKdj arithmetic.
// The legacy key intentionally preserves the UTC runner's Taipei-Monday-as-Sunday behavior.
const LEGACY = "WEEKLY_J_PRODUCTION_LEGACY_V1";
const TW = "WEEKLY_J_TW_TRADING_WEEK_V2";
const DAY = 86400000;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const finite = value => value === null || value === undefined || value === "" ? null :
  Number.isFinite(Number(value)) ? Number(value) : null;

function calendarMs(date) {
  if (!datePattern.test(String(date))) return null;
  const [year, month, day] = date.split("-").map(Number);
  const ms = Date.UTC(year, month - 1, day);
  return new Date(ms).toISOString().slice(0, 10) === date ? ms : null;
}

function weekKey(date, version) {
  const day = calendarMs(date);
  if (day === null) return null;
  if (version !== LEGACY && version !== TW) throw Error(`UNKNOWN_WEEKLY_J_VERSION:${version}`);
  // Production parsed Taipei midnight (+08:00), then used the UTC host's local
  // getDay/setDate. This is the same Monday anchor, expressed entirely in UTC.
  const pivot = version === LEGACY ? day - 8 * 3600000 : day;
  const weekday = new Date(pivot).getUTCDay() || 7;
  return new Date(pivot - (weekday - 1) * DAY).toISOString().slice(0, 10);
}

function calculateWeeklyJ(rows, version) {
  if (version !== LEGACY && version !== TW) throw Error(`UNKNOWN_WEEKLY_J_VERSION:${version}`);
  const weeks = new Map();
  for (const row of rows || []) {
    const date = String(row?.date || "");
    const key = weekKey(date, version);
    const close = finite(row?.close);
    const high = finite(row?.max ?? row?.close);
    const low = finite(row?.min ?? row?.close);
    const open = finite(row?.open);
    const volume = finite(row?.Trading_Volume ?? row?.trading_volume ?? row?.volume);
    if (!key || close === null || high === null || low === null) continue;
    if (!weeks.has(key)) weeks.set(key, {date, open: open ?? close, close, high, low, volume: null});
    const week = weeks.get(key);
    week.date = date;
    week.close = close;
    week.high = Math.max(week.high, high);
    week.low = Math.min(week.low, low);
    if (volume !== null) week.volume = (week.volume ?? 0) + volume;
  }
  let k = 50, d = 50, previousJ = 50, previousK = 50, previousD = 50;
  const values = [...weeks.values()].sort((a, b) => a.date.localeCompare(b.date));
  const output = [];
  for (let index = 0; index < values.length; index++) {
    const window = values.slice(Math.max(0, index - 8), index + 1);
    const high = Math.max(...window.map(item => item.high));
    const low = Math.min(...window.map(item => item.low));
    const rsv = high === low ? 50 : (values[index].close - low) / (high - low) * 100;
    k = 2 / 3 * k + 1 / 3 * rsv;
    d = 2 / 3 * d + 1 / 3 * k;
    const j = 3 * k - 2 * d;
    output.push({...values[index], k, d, j, previousJ, previousK, previousD, weekly_j_version: version});
    previousJ = j; previousK = k; previousD = d;
  }
  return output;
}

module.exports = {LEGACY, TW, weekKey, calculateWeeklyJ};
