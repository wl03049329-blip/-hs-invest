"use strict";
const fs = require("node:fs");
const {createHash} = require("node:crypto");
const {URL, readCloseSnapshot} = require("./c4_openapi_close_candidate.cjs");
const {sessions} = require("./audit_twse_close_watchdog.cjs");
const path = require("node:path");
const SCHEMA = "HS_TWSE_CLOSE_CAPTURE_V1";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const taipei = now => new Date(+now + 8*3600000).toISOString();

function captureWindow(now, slot, createdAt) {
  const clock = taipei(now), date = clock.slice(0,10), time = clock.slice(11,16);
  const windows = {"18:20":["18:20","20:20"],"20:20":["20:20","21:53"],manual:["18:20","21:53"]};
  if (!Object.hasOwn(windows,slot) || time < windows[slot][0] || time >= windows[slot][1] ||
      !createdAt || taipei(new Date(createdAt)).slice(0,10) !== date)
    throw Error("CAPTURE_WINDOW_MISSED");
  if ([0,6].includes(new Date(date).getUTCDay())) throw Error("WEEKEND_CAPTURE_NOT_EXPECTED");
  return date;
}

function receipt(raw, date, previous, now = new Date()) {
  if (date > taipei(now).slice(0,10)) throw Error("FUTURE_SESSION");
  const snapshot = readCloseSnapshot(raw, date);
  if (previous && (previous.schema !== SCHEMA || previous.date !== date ||
      previous.source !== URL || !/^[a-f0-9]{64}$/.test(previous.sha256 ?? "") ||
      Object.keys(snapshot.symbols).some(s => !/^[a-f0-9]{64}$/.test(previous.symbols?.[s]?.digest ?? ""))))
    throw Error("PREVIOUS_RECEIPT_INVALID");
  const symbols = {};
  for (const [symbol, row] of Object.entries(snapshot.symbols)) {
    const digest = sha(JSON.stringify(row));
    symbols[symbol] = {status: row.status, digest,
      revised: previous ? previous.symbols[symbol].digest !== digest : null,
      corporateActions: "UNKNOWN", scoreEligible: false};
  }
  return {schema: SCHEMA, date, source: URL, sha256: snapshot.sha256, collectedAt: now.toISOString(),
    sourceAttribution: "TWSE", licenseReference: "https://data.gov.tw/dataset/11549",
    responseChanged: previous ? previous.sha256 !== snapshot.sha256 : null,
    rawRetained: false, symbols};
}

async function capture(date, previous, {get = fetch, pause = ms => new Promise(r => setTimeout(r,ms)), now = () => new Date()} = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await get(URL, {redirect:"error", signal: AbortSignal.timeout(15000)});
      if (!response.ok) throw Object.assign(Error("OPENAPI_HTTP_" + response.status), {retry:response.status >= 500});
      return receipt(Buffer.from(await response.arrayBuffer()), date, previous, now());
    } catch (e) {
      // Do not retry rate limits, a prior session, invalid schema or revisions.
      if (attempt === 2 || !(e.retry || e.name === "TimeoutError" || e instanceof TypeError)) throw e;
      await pause(1000 * (attempt + 1));
    }
  }
}

async function main() {
  const [out, previousPath, expectedDate] = process.argv.slice(2);
  if (!out) throw Error("OUTPUT_REQUIRED");
  const {HS_CAPTURE_SLOT:slot, HS_RUN_CREATED_AT:createdAt} = process.env;
  const date = captureWindow(new Date(),slot,createdAt);
  if (date !== expectedDate) throw Error("CAPTURE_LOOKUP_DATE_MISMATCH");
  const previous = previousPath && fs.existsSync(previousPath) ? JSON.parse(fs.readFileSync(previousPath,"utf8")) : null;
  const r = await capture(date, previous);
  captureWindow(new Date(),slot,createdAt);
  r.slot = slot;
  fs.writeFileSync(out, JSON.stringify(r,null,2) + "\n", {flag:"wx"});
  console.log(date + " TWSE receipt; no score publication authorized");
  if (Object.values(r.symbols).some(s => s.revised || s.status !== "CANDIDATE_OHLCV"))
    throw Error("SYMBOL_UNAVAILABLE_OR_REVISION_REVIEW_REQUIRED");
}
const ARCHIVE_SCHEMA = "HS_00631L_OPEN_CLOSE_V1";
const DATASET = "https://data.gov.tw/dataset/11549";
const LICENSE = "https://data.gov.tw/license";
const MARKET_SESSIONS = "https://openapi.twse.com.tw/v1/exchangeReport/FMTQIK";
const price = s => typeof s === "string" && /^\d{1,7}\.\d{2}$/.test(s) && cents(s) > 0;
const cents = s => Number(s.replace(".", ""));
function archiveReceipt(raw, marketRaw, now, morning, probe = false) {
  const today = taipei(now).slice(0,10);
  const time = taipei(now).slice(11,16);
  if (!probe && (morning ? time < "08:00" || time >= "12:00" : time < "18:20"))
    return {status:"DEFERRED_WINDOW"};
  const eligible = sessions(JSON.parse(marketRaw), "2000-01-01", today)
    .filter(date => !morning || date < today);
  const rows = JSON.parse(raw);
  if (!Array.isArray(rows) || !rows.length || !/^\d{7}$/.test(rows[0]?.Date) ||
      rows.some(r => r?.Date !== rows[0].Date))
    throw Error("ARCHIVE_SNAPSHOT_SCHEMA_OR_MIXED_DATE");
  const toRoc = date => String(Number(date.slice(0,4))-1911)+date.slice(5).replace("-","");
  const date = probe ? eligible.find(d => toRoc(d) === rows[0].Date) : eligible.at(-1);
  if (!date || !probe && !morning && date !== today ||
      (morning || probe) && (Date.parse(today)-Date.parse(date))/86400000 > 4)
    return {status:"DEFERRED_SESSION"};
  if (rows[0].Date !== toRoc(date))
    return {status:"DEFERRED_SOURCE_DATE",expected:date};
  const hits = rows.filter(r => r.Code === "00631L"), row = hits[0];
  if (hits.length !== 1 || !price(row.ClosingPrice) || !/^\d+$/.test(row.TradeVolume) ||
      Number(row.TradeVolume) <= 0)
    throw Error("ARCHIVE_CLOSE_UNVERIFIED");
  // An ordinary signed change is evidence of the venue's comparison basis,
  // not on its own proof that a historical window is complete or split-safe.
  const match = /^([+-]?)(\d{1,7})\.(\d{2})0{0,2}$/.exec(row.Change ?? "");
  const delta = match ? (match[1] === "-" ? -1 : 1) * Number(match[2]+match[3]) : null;
  const reference = delta === null ? null : cents(row.ClosingPrice)-delta;
  const record = {schema:ARCHIVE_SCHEMA, symbol:"00631L", trading_date:date,
    close_twd:row.ClosingPrice, comparison_twd:reference > 0 ? (reference/100).toFixed(2) : null,
    captured_at:now.toISOString(), price_basis:"TWSE_RAW_CLOSE",
    source:URL, source_attribution:"臺灣證券交易所", dataset:DATASET, license:LICENSE,
    response_sha256:sha(raw), session_source:MARKET_SESSIONS, session_sha256:sha(marketRaw),
    session_dataset:"https://data.gov.tw/dataset/11672",
    observed_sessions:eligible.filter(d => d <= date)};
  return {status:"VERIFIED",record};
}
function appendClose(dir, record) {
  if (record.schema !== ARCHIVE_SCHEMA || record.symbol !== "00631L" ||
      !/^20\d\d-\d\d-\d\d$/.test(record.trading_date) || !price(record.close_twd) ||
      record.source !== URL || record.license !== LICENSE || record.dataset !== DATASET ||
      !/^[a-f0-9]{64}$/.test(record.response_sha256)) throw Error("ARCHIVE_RECORD_INVALID");
  const name = record.trading_date+".json", file = path.join(dir,name);
  const days = fs.readdirSync(dir).filter(s => /^20\d\d-\d\d-\d\d\.json$/.test(s)).sort();
  if (fs.existsSync(file)) {
    const old = JSON.parse(fs.readFileSync(file,"utf8"));
    if (old.close_twd !== record.close_twd || old.comparison_twd !== record.comparison_twd ||
        old.trading_date !== record.trading_date || old.schema !== ARCHIVE_SCHEMA)
      throw Error("ARCHIVE_REVISION_REVIEW_REQUIRED");
    return {status:"DUPLICATE", name};
  }
  if (days.at(-1) >= name) throw Error("ARCHIVE_OUT_OF_ORDER");
  fs.writeFileSync(file,JSON.stringify(record,null,2)+"\n",{flag:"wx"});
  return {status:"APPENDED", name};
}
// A consumer must separately supply a verified calendar and company-action
// coverage. Never turn an archive gap into a shorter lookback.
function windowCoverage(records, verifiedSessions, first, last, actionsVerified) {
  const days = verifiedSessions.filter(d => first <= d && d <= last);
  if (days[0] !== first || days.at(-1) !== last || days.join() !== [...new Set(days)].sort().join())
    return {status:"CALENDAR_UNKNOWN"};
  const byDay = new Map(records.map(row => [row.trading_date,row]));
  const missing = days.filter(d => !byDay.has(d));
  if (missing.length) return {status:"MISSING_SESSIONS",missing};
  if (!actionsVerified || days.slice(1).some((d,i) => byDay.get(d).comparison_twd !== byDay.get(days[i]).close_twd))
    return {status:"PRICE_BASIS_UNVERIFIED"};
  return {status:"COMPLETE",days:days.length};
}
async function fetchArchive(out, mode) {
  const load = async url => {
    const r = await fetch(url,{redirect:"error",signal:AbortSignal.timeout(15000)});
    if ([429,500,502,503,504].includes(r.status)) return null;
    if (!r.ok) throw Error("ARCHIVE_HTTP_"+r.status);
    const body = Buffer.from(await r.arrayBuffer());
    if (body.length > 4_000_000) throw Error("ARCHIVE_RESPONSE_TOO_BIG");
    return body;
  };
  let raw, marketRaw;
  try { [marketRaw,raw] = await Promise.all([load(MARKET_SESSIONS),load(URL)]); }
  catch (err) {
    if (err.name === "TimeoutError" || err instanceof TypeError) return {status:"DEFERRED_NETWORK"};
    throw err;
  }
  if (!raw || !marketRaw) return {status:"DEFERRED_UPSTREAM"};
  const result = archiveReceipt(raw,marketRaw,new Date(),mode === "morning",mode === "probe");
  if (result.record) {
    // The market OpenAPI may roll at month end. A matching, independently
    // verified official session interval can bridge that boundary, not a price guess.
    if (process.env.HS_00631L_CROSS_MONTH_CALENDAR === "1") {
      const read = name => JSON.parse(fs.readFileSync(path.join(__dirname,"..","data","radar-history",name),"utf8"));
      const r = result.record, calendar = read("twse/0050.json"), status = read("status-v1.json"),
        inc = calendar.incremental_verification, dates = inc?.sessions;
      if (calendar.verified === true && status.symbols?.["0050"]?.archive_sha256 === calendar.content_sha256 &&
          /^[a-f0-9]{64}$/.test(calendar.content_sha256) && inc?.calendar_evidence?.length &&
          Array.isArray(dates) && dates.join() === [...new Set(dates)].sort().join()) {
        const i = dates.indexOf(r.trading_date), prev = dates[i-1];
        if (i>0 && /^20\d\d-\d\d-\d\d$/.test(prev) && prev.slice(0,7)!==r.trading_date.slice(0,7))
          r.cross_month_session = {previous:prev, source:"HS_VERIFIED_TWSE_SESSION_INTERVAL", sha256:calendar.content_sha256};
      }
    }
    return {...appendClose(out,result.record),date:result.record.trading_date};
  }
  return result;
}
if (require.main === module) (process.argv[2] === "--00631l-archive"
  ? fetchArchive(process.argv[3],process.argv[4]).then(result => {
    console.log(JSON.stringify(result));
    if (result.status === "APPENDED" && process.env.GITHUB_OUTPUT)
      fs.appendFileSync(process.env.GITHUB_OUTPUT,"file="+result.name+"\n");
  }) : main()).catch(e => {
  console.error("::error::TWSE close receipt not clean: " + e.message);
  process.exitCode = 1;
});
module.exports = {receipt,capture,captureWindow,archiveReceipt,appendClose,windowCoverage};
