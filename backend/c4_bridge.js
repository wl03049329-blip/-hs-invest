#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const publisher = require("../scripts/build_intraday_core_snapshots.js");

function fail(message) { throw new Error(`SHADOW_C4_BRIDGE ${message}`); }
function atomicWrite(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, "utf8");
  fs.renameSync(temporary, file);
}
async function historiesFor(input) {
  if (input.histories) return input.histories;
  const cacheRoot = path.resolve(String(input.history_cache_dir || ""));
  if (!cacheRoot || path.basename(cacheRoot) !== "history-cache" || !fs.existsSync(cacheRoot)) fail("history_cache_dir_unavailable");
  const file = path.join(cacheRoot, `history-${input.trading_date}.json`);
  try {
    const cached = JSON.parse(fs.readFileSync(file, "utf8"));
    if (publisher.SYMBOLS.every(symbol => Array.isArray(cached[symbol]) && cached[symbol].length >= 252)) return cached;
  } catch {}
  const histories = Object.fromEntries(await Promise.all(publisher.SYMBOLS.map(async symbol => [symbol, await publisher.loadHistory(symbol, input.trading_date)])));
  if (!publisher.SYMBOLS.every(symbol => Array.isArray(histories[symbol]) && histories[symbol].length >= 252)) fail("history_incomplete");
  atomicWrite(file, histories);
  return histories;
}
async function scoreRequest(input) {
  const { trading_date: tradingDate, slot, calculated_at: calculatedAt } = input;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(tradingDate || "")) || !publisher.validIntradaySlot(slot)) fail("invalid_request");
  if (!publisher.SYMBOLS.every(symbol => input.quotes?.[symbol])) fail("required_quotes_incomplete");
  const key = `${tradingDate}_${slot.replace(":", "")}`;
  const quotes = { intraday_quote_snapshots: { [key]: { status: "SUCCESS", captured_at: input.captured_at || calculatedAt, items: input.quotes } } };
  const histories = await historiesFor(input);
  const result = publisher.buildSnapshot({ quotes, histories, existing: { schema_version: 1, snapshots: [] }, tradingDate, slot, calculatedAt });
  if (result.snapshot.score_version !== publisher.SCORE_VERSION) fail("score_version_mismatch");
  return { status: "SUCCESS", score_version: publisher.SCORE_VERSION, input_fingerprint: result.snapshot.source.input_fingerprint, snapshot: result.snapshot };
}
async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const output = await scoreRequest(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

module.exports = { scoreRequest };
if (require.main === module) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
