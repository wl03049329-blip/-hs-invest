"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const core = require("../portfolio-core.js");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const ui = fs.readFileSync(path.join(root, "portfolio-v6.js"), "utf8");
const payload = {
  updated_at: "2026-09-24T05:30:00Z",
  official_last_checked_at: "2026-09-24T10:30:00Z",
  official_source_dates: {TWSE: "2026-09-23", TPEx: "2026-09-24"},
  items: [
    {code: "006208", name: "富邦台50", price: 255.7, previous_close: 254.7, date: "2026-09-22", market: "TWSE", quote_mode: "close", quote_time: "收盤"},
    {code: "009815", name: "大華美國MAG7+", price: 11.93, previous_close: 12.03, date: "2026-09-24", market: "TPEx", quote_mode: "close", quote_time: "收盤"}
  ]
};
const parserStart = html.indexOf("function parsePublicQuoteCache(payload){");
const parserEnd = html.indexOf("function parseCanonicalCoreSnapshots", parserStart);
const parser = vm.createContext({Map});
vm.runInContext(`${html.slice(parserStart, parserEnd)};this.parse=parsePublicQuoteCache`, parser);
const shared = parser.parse(payload);
assert.equal(shared.get("006208").officialMarketDate, "2026-09-23");
assert.equal(shared.get("009815").officialMarketDate, "2026-09-24");
assert.equal(core.parseCachedQuotes(payload).get("006208").officialMarketDate, "2026-09-23");

const holding = core.validateHolding({code: "006208", shares: 1000, averageCost: 256, name: "富邦台50"});
const calculate = quotes => core.calculatePortfolio([holding], quotes, {now: Date.parse("2026-09-24T06:00:00Z")});
const old = calculate(shared);
assert.equal(old.rows[0].quoteStatus, "current"); // Existing five-day monetary contract is unchanged.
assert.equal(old.rows[0].marketValue, 255700);
assert.equal(old.rows[0].totalPnl, -300);
const start = ui.indexOf("  function portfolioFreshnessLabel() {");
const end = ui.indexOf("  function taipeiToday() {", start);
assert.ok(start > 0 && end > start);
const view = vm.createContext({computed: old, effectiveHoldings: () => [holding]});
vm.runInContext(`${ui.slice(start, end)};this.lagged=quoteSessionLagged;this.label=quoteSessionLabel;this.summary=portfolioFreshnessLabel`, view);
assert.equal(view.lagged(old.rows[0]), true);
assert.equal(view.label(old.rows[0]), "最後有效收盤｜2026-09-22");
assert.match(view.summary(), /1 檔沿用最後有效收盤/);

const freshPayload = structuredClone(payload);
freshPayload.items[0].date = "2026-09-23";
freshPayload.items[0].price = 257;
freshPayload.items[0].previous_close = 255.7;
const fresh = calculate(parser.parse(freshPayload));
view.computed = fresh;
assert.equal(view.lagged(fresh.rows[0]), false);
assert.equal(view.summary(), "持股行情：1 檔最新");
assert.equal(fresh.rows[0].marketValue, 257000);
assert.equal(fresh.rows[0].totalPnl, 1000);
assert.equal(parser.parse({...payload, items: [{code: "09999Z", price: 0, previous_close: 1}]}).size, 0);
console.log("PASS official-day quote labels, unchanged valuation, 006208 recovery, 09999Z no fake quote");
