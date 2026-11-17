"use strict";
const {execFileSync} = require("node:child_process");
const marketSource = "https://openapi.twse.com.tw/v1/exchangeReport/FMTQIK";
const dateOK = d => typeof d === "string" && /^20\d\d-\d\d-\d\d$/.test(d) &&
  Number.isFinite(Date.parse(d)) && new Date(d).toISOString().slice(0,10) === d;
function sessions(rows, since, now) {
  if (!dateOK(since) || !dateOK(now) || since > now || !Array.isArray(rows) || !rows.length)
    throw Error("MARKET_SESSION_COVERAGE_UNKNOWN");
  const dates = rows.map(row => {
    const m = /^(\d{3})(\d\d)(\d\d)$/.exec(row?.Date);
    const date = m && `${1911 + Number(m[1])}-${m[2]}-${m[3]}`;
    if (!dateOK(date) || date > now || !/^\d+$/.test(row.TradeVolume) || Number(row.TradeVolume) <= 0)
      throw Error("MARKET_SESSION_ROW_INVALID");
    return date;
  }).sort();
  if (new Set(dates).size !== dates.length) throw Error("MARKET_SESSION_DUPLICATE");
  return dates.filter(day => day >= since);
}
function missingReceipts(days, names, prefix) {
  const known = new Set(names);
  return days.filter(day => !["18-20","20-20","manual"].some(slot => known.has(prefix+day+"-ok-"+slot)));
}
async function main() {
  const now = new Date(Date.now()+8*3600000).toISOString().slice(0,10);
  const start = process.env.HS_CAPTURE_START;
  const r = await fetch(marketSource,{redirect:"error",signal:AbortSignal.timeout(15000)});
  if (!r.ok) throw Error("MARKET_SESSION_HTTP_" + r.status);
  const rows = await r.json();
  const days = sessions(rows, start, now);
  // Current-month feed cannot certify a missed previous-month last session.
  if (!days.length || !rows.some(row => row.Date.slice(0,5) ===
      String(Number(now.slice(0,4))-1911)+now.slice(5,7)))
    throw Error("MARKET_SESSION_COVERAGE_UNKNOWN");
  const prefix = "twse-close-" + process.env.GITHUB_REF_NAME.replaceAll("/","-") + "-";
  const pages = JSON.parse(execFileSync("gh",["api","--paginate","--slurp",
    `repos/${process.env.GITHUB_REPOSITORY}/actions/artifacts?per_page=100`],{encoding:"utf8",maxBuffer:24e6}));
  const receipts = pages.flatMap(page => page.artifacts).filter(a => !a.expired).map(a => a.name);
  const missing = missingReceipts(days, receipts, prefix);
  if (missing.length) throw Error("MISSED_CAPTURE_RECEIPTS " + missing.join(","));
  console.log("Receipts present for observed sessions",days.length,
    "; absent market sessions and previous-month coverage are not certified.");
}
if (require.main === module) main().catch(e=>{console.error("::error::"+e.message);process.exitCode=1;});
module.exports = {sessions,missingReceipts};
