"use strict";
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const core = require("../home-taiex-core");
const file = path.resolve(__dirname, "../home-taiex.json");
const fail = reason => { throw new Error(reason); };

function parseReport(bytes, month) {
  const raw = JSON.parse(bytes);
  const fields = ["日期", "成交股數", "成交金額", "成交筆數", "發行量加權股價指數", "漲跌點數"];
  if (raw.stat !== "OK" || raw.date !== month.replace("-", "") + "01" ||
      JSON.stringify(raw.fields) !== JSON.stringify(fields) || !Array.isArray(raw.data) || !raw.data.length) fail("INVALID_TWSE_REPORT");
  const cents = value => {
    if (typeof value !== "string" || !/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)\.\d{2}$/.test(value)) fail("INVALID_POINT_FORMAT");
    const n = Number(value.replace(/[,.]/g, ""));
    if (!Number.isSafeInteger(n)) fail("INVALID_POINT_RANGE");
    return n;
  };
  let previous = "";
  return raw.data.map(row => {
    if (!Array.isArray(row) || row.length !== fields.length || typeof row[0] !== "string") fail("INVALID_TWSE_ROW");
    const parts = /^(\d{3})\/(\d{2})\/(\d{2})$/.exec(row[0]);
    const date = parts && `${Number(parts[1]) + 1911}-${parts[2]}-${parts[3]}`;
    if (!core.day(date) || !date.startsWith(month + "-") || date <= previous) fail("INVALID_TWSE_DATE_ORDER");
    previous = date;
    const close = cents(row[4]), change = cents(row[5]);
    if (close <= 0) fail("INVALID_TWSE_CLOSE");
    return { date, close, change };
  });
}

function buildSnapshot(reports, retrievedAt, updatedAt = retrievedAt) {
  const rows = reports.flatMap(({month, bytes}) => parseReport(bytes, month)).sort((a,b) => a.date.localeCompare(b.date));
  if (rows.length < 2 || new Set(rows.map(r => r.date)).size !== rows.length) fail("MISSING_DISTINCT_BASELINE");
  const [previous, current] = rows.slice(-2);
  if (current.close - previous.close !== current.change) fail("OFFICIAL_PREVIOUS_CLOSE_MISMATCH");
  const used = new Set([previous.date.slice(0,7), current.date.slice(0,7)]);
  const snapshot = {
    schema: core.schema, indicator: "TAIEX", source: core.source, validation: "VERIFIED",
    trade_date: current.date, previous_trade_date: previous.date,
    close_cents: current.close, previous_close_cents: previous.close, change_cents: current.change,
    retrieved_at: retrievedAt, updated_at: updatedAt,
    evidence: reports.filter(r => used.has(r.month)).map(({month, bytes}) => ({
      url: core.reportUrl(month), sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    })),
  };
  if (!core.valid(snapshot, Date.parse(updatedAt))) fail("INVALID_SNAPSHOT");
  return snapshot;
}
async function run() {
  const now = new Date(Date.now() + 8 * 3600000);
  const currentMonth = now.toISOString().slice(0,7);
  const previousMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth()-1, 1)).toISOString().slice(0,7);
  async function get(month) {
    const response = await fetch(core.reportUrl(month), {signal: AbortSignal.timeout(15000), redirect: "error"});
    if (!response.ok) fail("TWSE_HTTP_" + response.status);
    return {month, bytes: Buffer.from(await response.arrayBuffer())};
  }
  const reports = [await get(currentMonth)];
  if (parseReport(reports[0].bytes, currentMonth).length < 2) reports.unshift(await get(previousMonth));
  const snapshot = buildSnapshot(reports, new Date().toISOString());
  const old = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
  if (old && !core.valid(old)) fail("INVALID_EXISTING_CACHE");
  if (old?.trade_date === snapshot.trade_date &&
      ["previous_trade_date","close_cents","previous_close_cents","change_cents"].some(k => old[k] !== snapshot[k])) fail("TWSE_SAME_DAY_REVISION_REQUIRES_REVIEW");
  if (old && old.trade_date > snapshot.trade_date) fail("TWSE_OLDER_THAN_LAST_VERIFIED");
  if (core.select(old, snapshot) !== snapshot) {
    console.log("UNCHANGED: " + old.trade_date + " remains the last verified close");
    return;
  }
  if (process.argv.includes("--check")) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }
  const temporary = file + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(snapshot, null, 2) + "\n", {flag:"wx"});
  fs.renameSync(temporary, file);
  console.log("UPDATED: " + snapshot.trade_date);
}
module.exports = {parseReport, buildSnapshot, run};
if (require.main === module) run().catch(error => { console.error(error.message); process.exitCode = 1; });
