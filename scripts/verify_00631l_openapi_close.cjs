"use strict";
// Read-only check against the existing HS dated official market quote.
// Missing dated OpenAPI rows are never reconstructed or published.
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const { readCloseSnapshot, URL } = require("./c4_openapi_close_candidate.cjs");
function verify(raw, cache) {
  const q = cache.items?.filter(r => r.code === "00631L" && r.market === "TWSE" && r.quote_mode === "close");
  if (q?.length !== 1 || cache.official_source_dates?.TWSE !== q[0].date ||
      cache.source_dates?.TWSE !== q[0].date || ![URL,"https://www.twse.com.tw/exchangeReport/MI_INDEX"].includes(cache.sources?.TWSE_close) ||
      !["official_closing_data_daily_report", "official_closing_data"].includes(cache.source_status?.TWSE))
    throw Error("HS_OFFICIAL_CLOSE_UNAVAILABLE");
  const { date, sha256, source, symbols } = readCloseSnapshot(raw, q[0].date, ["00631L"]);
  const bar = symbols["00631L"];
  if (bar.status !== "CANDIDATE_OHLCV" || q[0].price !== bar.close) throw Error("00631L_OFFICIAL_CLOSE_CONFLICT");
  return { date, source, sha256, bar };
}
async function probe() {
  const rev = process.argv[2];
  if (rev !== undefined && !/^[a-f0-9]{7,40}$/.test(rev)) throw Error("ARCHIVE_COMMIT_INVALID");
  const cache = rev ? execFileSync("git", ["show", rev + ":market-quotes.json"], { maxBuffer: 16_000_000 }) :
    fs.readFileSync("market-quotes.json", "utf8");
  const response = await fetch(URL, { signal: AbortSignal.timeout(15000), redirect: "error" });
  if (!response.ok) throw Error("OPENAPI_HTTP_" + response.status);
  const raw = await response.text();
  if (raw.length > 4_000_000) throw Error("OPENAPI_BODY_TOO_LARGE");
  console.log(JSON.stringify(verify(raw, JSON.parse(cache))));
}
if (require.main === module) probe().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { verify };
