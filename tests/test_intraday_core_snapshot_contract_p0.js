const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const publisher = require("../scripts/build_intraday_core_snapshots.js");
const core = require("../final-core-production.js");

const symbols = [...publisher.SYMBOLS];
function rows(seed) {
  const result = [];
  let index = 0;
  for (let date = new Date("2025-06-02T00:00:00Z"); date <= new Date("2026-08-20T00:00:00Z"); date.setUTCDate(date.getUTCDate() + 1)) {
    if ([0, 6].includes(date.getUTCDay())) continue;
    const close = seed * (.84 + index * .00065 + Math.sin(index / 8) * .018);
    result.push({ date: date.toISOString().slice(0, 10), open: close * .996, max: close * 1.012, min: close * .988, close, Trading_Volume: 1_000_000 + index });
    index += 1;
  }
  return result;
}
const histories = Object.fromEntries(symbols.map((symbol, index) => [symbol, rows(90 + index * 3)]));
function rawSlot(slot, priceOffset = 0) {
  return {
    status: "SUCCESS", items: Object.fromEntries(symbols.map((symbol, index) => [symbol, {
      price: 100 + index + priceOffset, open: 99 + index, high: Math.max(102 + index, 101 + index + priceOffset),
      low: Math.min(98 + index, 99 + index + priceOffset), volume: 1_200_000, date: "2026-08-21", quote_time: `${slot}:00`
    }]))
  };
}
function quotes(slots) { return { intraday_quote_snapshots: Object.fromEntries(Object.entries(slots).map(([slot, raw]) => [`2026-08-21_${slot.replace(":", "")}`, raw])) }; }
function build(slot, slots, existing = { schema_version: 1, snapshots: [] }) {
  return publisher.buildSnapshot({ quotes: quotes(slots), histories, existing, tradingDate: "2026-08-21", slot, calculatedAt: `2026-08-21T${slot}:30+08:00` });
}

const first = build("09:30", { "09:30": rawSlot("09:30") });
assert.equal(first.published, true);
for (const item of Object.values(first.snapshot.items)) {
  assert.equal(item.previous_successful_intraday_score, null);
  assert.equal(item.delta_vs_previous_successful_intraday, null);
  assert.ok(Number.isFinite(item.previous_close_score));
  assert.ok(Number.isFinite(item.delta_vs_previous_close));
}
console.log("A PASS: 09:30 persists the previous finalized close baseline only");

const example0930 = publisher.attachBaselines({ symbol: "0050", score: 48, rank: 1 }, { symbol: "0050", score: 45, rank: 1, trading_date: "2026-08-20" }, null);
const example1130 = publisher.attachBaselines({ symbol: "0050", score: 53, rank: 1 }, { symbol: "0050", score: 45, rank: 1, trading_date: "2026-08-20" }, { symbol: "0050", slot: "09:30", score: 48, rank: 1 });
assert.deepEqual([example0930.delta_vs_previous_close, example0930.previous_successful_intraday_score], [3, null]);
assert.deepEqual([example1130.delta_vs_previous_close, example1130.previous_successful_intraday_slot, example1130.delta_vs_previous_successful_intraday], [8, "09:30", 5]);
console.log("A2 PASS: close 45 → 09:30 48; failed 10:30 → 11:30 53 baseline contract");

const second = build("10:30", { "10:30": rawSlot("10:30", -2) }, { schema_version: 1, snapshots: [first.snapshot] });
for (const item of Object.values(second.snapshot.items)) {
  const prior = first.snapshot.items[item.symbol];
  assert.equal(item.previous_successful_intraday_slot, "09:30");
  assert.equal(item.previous_successful_intraday_score, prior.score);
  assert.equal(item.delta_vs_previous_successful_intraday, item.score - prior.score);
  assert.equal(item.delta_vs_previous_close, item.score - item.previous_close_score);
}
console.log("B PASS: 10:30 keeps both previous-close and previous-successful-slot deltas");

const third = build("11:30", { "11:30": rawSlot("11:30", -4) }, { schema_version: 1, snapshots: [first.snapshot] });
for (const item of Object.values(third.snapshot.items)) {
  const prior = first.snapshot.items[item.symbol];
  assert.equal(item.previous_successful_intraday_slot, "09:30");
  assert.equal(item.previous_successful_intraday_score, prior.score);
  assert.equal(item.delta_vs_previous_successful_intraday, item.score - prior.score);
}
assert.equal(third.snapshot.items["0050"].previous_successful_intraday_slot, "09:30");
console.log("C PASS: missing 10:30 creates no fake record; 11:30 uses 09:30");

const rerun = build("09:30", { "09:30": rawSlot("09:30", 9) }, { schema_version: 1, snapshots: [first.snapshot] });
assert.equal(rerun.published, false);
assert.equal(rerun.snapshot, first.snapshot);
console.log("D PASS: identity symbol/date/slot is append-once and idempotent");

const incomplete = rawSlot("12:30");
delete incomplete.items["0050"].high;
assert.throws(() => build("12:30", { "12:30": incomplete }, { schema_version: 1, snapshots: [first.snapshot] }), /FAIL_CLOSED/);
console.log("E PASS: missing required Core input fails closed without publication");

assert.deepEqual(core.LONG_TERM_CORE_SCORE_VERSION, "FINAL_CORE_WEIGHT_V1");
assert.deepEqual(core.buildFinal({ ticker: "0050", j: null, dd52: -10, rows: [] }).coreScore, null);
const factors = first.snapshot.items["0050"].core_factors;
assert.deepEqual(Object.fromEntries(Object.entries(factors).map(([key, value]) => [key, value.weight])), { weeklyJ: 30, dd52: 55, crash: 15 });
console.log("F PASS: canonical artifact uses frozen 30/55/15 and FAIL_CLOSED");

const html = fs.readFileSync(path.resolve(__dirname, "..", "index.html"), "utf8");
const consumer = html.slice(html.indexOf("function applyHomeDelayedQuotes"), html.indexOf("function scoreTone"));
assert.match(html, /intraday-core-snapshots-v1\.json/);
assert.match(consumer, /const snapshotForRender=canonicalSnapshot\|\|liveCanonicalCoreSnapshot/);
assert.match(consumer, /applyCanonicalCoreSnapshot\(snapshotForRender\)/);
assert.doesNotMatch(consumer, /buildIntradayRadarBatch\(quotes,verifiedRefresh\)/);
assert.match(html, /authorizedFresh&&!LONG_RADAR_SCORED_CODES\.has\(x\.id\)/);
console.log("G PASS: homepage consumes canonical artifact; proxy cannot publish radar Core");
