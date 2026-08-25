"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const html = fs.readFileSync("index.html", "utf8");
const start = html.indexOf("function formatHomeMonthDay");
const end = html.indexOf("function formatHeaderMarketAsOf", start);
assert.ok(start > 0 && end > start, "freshness helpers must remain isolated and testable");
const context = {};
vm.createContext(context);
vm.runInContext(html.slice(start, end), context);

const today = "2026-08-25";
const partial = context.hsLiveSnapshotFreshness(
  { trading_date: today, slot: "11:30" },
  { trading_date: today, success_count: 2, missed_slots: ["09:30"], failed_slots: ["10:30"] },
  today
);
assert.equal(partial.label, "最新成功 今日 11:30｜已缺 2 個時段");
assert.equal(partial.isLkg, false);

const lkg = context.hsLiveSnapshotFreshness(
  { trading_date: "2026-08-24", slot: "13:30" },
  { trading_date: today, success_count: 0, missed_slots: ["09:30", "13:30"], failed_slots: ["10:30", "11:30", "12:30"] },
  today
);
assert.equal(lkg.label, "最近成功 8/24 13:30｜今日盤中資料尚未成功");
assert.equal(lkg.isLkg, true);
assert.equal(
  context.hsLiveCloseComparisonLabel({ previous_close_trading_date: "2026-08-21" }, { trading_date: "2026-08-24" }, today),
  "vs 8/21 正式收盤"
);
assert.equal(
  context.hsLiveCloseComparisonLabel({}, { trading_date: today }, today),
  "vs 昨日正式收盤"
);
console.log("PASS HS LIVE fresh-today, partial-day and prior-day LKG presentation contracts");
