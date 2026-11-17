"use strict";
const fs = require("node:fs");
const {createHash} = require("node:crypto");
const {URL, readCloseSnapshot} = require("./c4_openapi_close_candidate.cjs");
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
if (require.main === module) main().catch(e => {
  console.error("::error::TWSE close receipt not clean: " + e.message);
  process.exitCode = 1;
});
module.exports = {receipt,capture,captureWindow};
