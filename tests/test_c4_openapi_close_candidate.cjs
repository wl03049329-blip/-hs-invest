"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {readCloseSnapshot} = require("../scripts/c4_openapi_close_candidate.cjs");
const row = (Code, extra = {}) => ({Date:"1151116", Code, OpeningPrice:"101.20",
  HighestPrice:"101.45", LowestPrice:"96.45", ClosingPrice:"96.45", TradeVolume:"357525464", ...extra});
const read = (rows, date = "2026-11-16") => readCloseSnapshot(Buffer.from(JSON.stringify(rows)), date);

test("dated close snapshot preserves OHLCV and exposes candidate status only", () => {
  const result = read(["0050","00757","00830","00935"].map(s => row(s)));
  assert.equal(result.date, "2026-11-16");
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(result.symbols["0050"], {status:"CANDIDATE_OHLCV",
    open:101.2, high:101.45, low:96.45, close:96.45, shares:357525464});
});

test("previous session and mixed-day snapshots cannot be used for today's close", () => {
  assert.throws(() => read([row("0050")], "2026-11-17"), /SESSION_DATE_MISMATCH/);
  assert.throws(() => read([row("0050"), row("00757", {Date:"1151117"})]), /SESSION_DATE_MISMATCH/);
  assert.throws(() => read([row("0050")], "2026-02-30"), /EXPECTED_DATE_INVALID/);
});

test("one missing, duplicate or invalid symbol does not remove a valid peer", () => {
  const {symbols} = read([row("0050"), row("00757"), row("00757"), row("00935", {TradeVolume:"0"})]);
  assert.equal(symbols["0050"].status, "CANDIDATE_OHLCV");
  assert.equal(symbols["00757"].status, "DUPLICATE_SYMBOL");
  assert.equal(symbols["00830"].status, "MISSING_SYMBOL");
  assert.equal(symbols["00935"].status, "OHLCV_UNVERIFIED");
});
