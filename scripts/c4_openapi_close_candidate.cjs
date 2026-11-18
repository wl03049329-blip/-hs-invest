"use strict";

// Read-only candidate adapter. Not a scoring source or a publication gate.
const crypto = require("node:crypto");
const URL = "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL";
const SYMBOLS = Object.freeze(["0050", "00757", "00830", "00935"]);
const numeric = s => typeof s === "string" && /^\d+(?:\.\d+)?$/.test(s) ? Number(s) : NaN;

function readCloseSnapshot(raw, expectedDate, requested = SYMBOLS) {
  if (typeof expectedDate !== "string" || !/^20\d\d-\d\d-\d\d$/.test(expectedDate) ||
      !Number.isFinite(Date.parse(expectedDate)) || new Date(expectedDate).toISOString().slice(0, 10) !== expectedDate)
    throw Error("OPENAPI_EXPECTED_DATE_INVALID");
  const rows = JSON.parse(raw);
  if (!Array.isArray(rows) || !rows.length) throw Error("OPENAPI_SCHEMA_INVALID");
  const roc = String(Number(expectedDate.slice(0, 4)) - 1911) + expectedDate.slice(5).replace("-", "");
  if (rows.some(row => row?.Date !== roc)) throw Error("OPENAPI_SESSION_DATE_MISMATCH");
  if (!Array.isArray(requested) || !requested.length || requested.some(s => typeof s !== "string" || !/^[0-9A-Z]{4,10}$/.test(s)) ||
      new Set(requested).size !== requested.length) throw Error("OPENAPI_SYMBOLS_INVALID");
  const symbols = {};
  for (const symbol of requested) {
    const matches = rows.filter(row => row.Code === symbol);
    if (matches.length !== 1) {
      symbols[symbol] = {status: matches.length ? "DUPLICATE_SYMBOL" : "MISSING_SYMBOL"};
      continue;
    }
    const r = matches[0];
    const [open, high, low, close, shares] = [
      r.OpeningPrice, r.HighestPrice, r.LowestPrice, r.ClosingPrice, r.TradeVolume
    ].map(numeric);
    if (![open, high, low, close, shares].every(x => Number.isFinite(x) && x > 0) ||
        high < Math.max(open, close) || low > Math.min(open, close) || !Number.isSafeInteger(shares)) {
      symbols[symbol] = {status: "OHLCV_UNVERIFIED"};
      continue;
    }
    symbols[symbol] = {status: "CANDIDATE_OHLCV", open, high, low, close, shares};
  }
  return {date: expectedDate, source: URL, sha256: crypto.createHash("sha256").update(raw).digest("hex"), symbols};
}

module.exports = {readCloseSnapshot, URL};
