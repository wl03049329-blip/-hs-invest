"use strict";

const assert = require("node:assert/strict");
const bridge = require("../backend/c4_bridge.js");
const production = require("../scripts/build_intraday_core_snapshots.js");

const tradingDate = "2026-09-07", slot = "10:17", calculatedAt = "2026-09-07T10:17:30+08:00";
function history(seed) {
  const rows = [];
  for (let cursor = new Date("2025-05-01T00:00:00Z"), index = 0; cursor < new Date(`${tradingDate}T00:00:00Z`); cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    if ([0, 6].includes(cursor.getUTCDay())) continue;
    const close = seed * (.8 + index * .0008 + Math.sin(index / 11) * .015);
    rows.push({ date: cursor.toISOString().slice(0, 10), open: close * .995, max: close * 1.012, min: close * .988, close, Trading_Volume: 1_000_000 + index });
    index += 1;
  }
  return rows;
}
const histories = Object.fromEntries(production.SYMBOLS.map((symbol, index) => [symbol, history(80 + index * 5)]));
const quotes = Object.fromEntries(production.SYMBOLS.map((symbol, index) => [symbol, {
  price: 100 + index, open: 99 + index, high: 102 + index, low: 98 + index,
  volume: 1_200_000, date: tradingDate, quote_time: "10:16:30",
}]));
const key = `${tradingDate}_${slot.replace(":", "")}`;
const direct = production.buildSnapshot({
  quotes: { intraday_quote_snapshots: { [key]: { status: "SUCCESS", captured_at: calculatedAt, items: quotes } } },
  histories, existing: { schema_version: 1, snapshots: [] }, tradingDate, slot, calculatedAt,
});

(async () => {
  const viaBridge = await bridge.scoreRequest({ trading_date: tradingDate, slot, calculated_at: calculatedAt, captured_at: calculatedAt, quotes, histories });
  assert.equal(viaBridge.input_fingerprint, direct.snapshot.source.input_fingerprint);
  assert.equal(viaBridge.score_version, production.SCORE_VERSION);
  for (const symbol of production.SYMBOLS) {
    assert.equal(viaBridge.snapshot.items[symbol].score, direct.snapshot.items[symbol].score);
    assert.equal(viaBridge.snapshot.items[symbol].display_score, direct.snapshot.items[symbol].display_score);
  }
  assert.ok(!Object.hasOwn(viaBridge.snapshot.items, "00631L"));
  assert.ok(!Object.hasOwn(viaBridge.snapshot.items, "009815"));
  console.log("L PASS: same fingerprint produces exact raw Frozen C4 parity through the bridge");
})().catch(error => { console.error(error); process.exitCode = 1; });
