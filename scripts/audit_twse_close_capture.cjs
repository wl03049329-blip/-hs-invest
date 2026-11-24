"use strict";
const fs = require("node:fs");
const {createHash} = require("node:crypto");
const {URL, readCloseSnapshot} = require("./c4_openapi_close_candidate.cjs");
const {sessions,scheduleContext} = require("./audit_twse_close_watchdog.cjs");
const path = require("node:path");
const SCHEMA = "HS_TWSE_CLOSE_CAPTURE_V1";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const taipei = now => new Date(+now + 8*3600000).toISOString();

function captureWindow(now, slot, createdAt) {
  const context=scheduleContext(now,slot,createdAt);
  slot=context.slot;
  const clock = taipei(now), date = context.targetDate, time = clock.slice(11,16);
  const windows = {"18:20":["18:20","20:20"],"20:20":["20:20","21:53"],manual:["18:20","21:53"]};
  if (!Object.hasOwn(windows,slot) || time < windows[slot][0] || time >= windows[slot][1] ||
      clock.slice(0,10) !== date)
    throw Object.assign(Error("CAPTURE_WINDOW_MISSED"),{timing:context});
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
      const raw=Buffer.from(await response.arrayBuffer());
      try { return receipt(raw,date,previous,now()); }
      catch(e) {
        // Diagnostic dates only, never an alternative acceptance path or prices.
        try { const rows=JSON.parse(raw);e.sourceDates=Array.isArray(rows)?[...new Set(rows.map(r=>r?.Date).filter(d=>typeof d==="string"&&/^\d{7}$/.test(d)))].slice(0,8):null; } catch { e.sourceDates=null; }
        throw e;
      }
    } catch (e) {
      // Do not retry rate limits, a prior session, invalid schema or revisions.
      if (attempt === 2 || !(e.retry || e.name === "TimeoutError" || e instanceof TypeError)) throw e;
      await pause(1000 * (attempt + 1));
    }
  }
}
function receiptIncidents(r) {
  return Object.entries(r.symbols).filter(([,s])=>s.revised||s.status!=="CANDIDATE_OHLCV")
    .map(([symbol,s])=>({date:r.date,code:s.revised?"SOURCE_REVISION:"+symbol:"SYMBOL_"+s.status+":"+symbol}));
}

async function main() {
  const [out, previousPath, expectedDate] = process.argv.slice(2);
  if (!out) throw Error("OUTPUT_REQUIRED");
  const {HS_CAPTURE_SLOT:slot, HS_RUN_CREATED_AT:createdAt} = process.env;
  const timing=scheduleContext(new Date(),slot,createdAt);
  const date = captureWindow(new Date(),slot,createdAt);
  if (date !== expectedDate) throw Error("CAPTURE_LOOKUP_DATE_MISMATCH");
  const previous = previousPath && fs.existsSync(previousPath) ? JSON.parse(fs.readFileSync(previousPath,"utf8")) : null;
  const r = await capture(date, previous);
  captureWindow(new Date(),slot,createdAt);
  r.slot = slot;
  r.timing=timing;
  fs.writeFileSync(out, JSON.stringify(r,null,2) + "\n", {flag:"wx"});
  console.log(date + " TWSE receipt; no score publication authorized");
  const incidents=receiptIncidents(r);
  if (incidents.length) throw Object.assign(Error("SYMBOL_UNAVAILABLE_OR_REVISION_REVIEW_REQUIRED"),{incidents});
}
const ARCHIVE_SCHEMA = "HS_00631L_OPEN_CLOSE_V1";
const DATASET = "https://data.gov.tw/dataset/11549";
const LICENSE = "https://data.gov.tw/license";
const MARKET_SESSIONS = "https://openapi.twse.com.tw/v1/exchangeReport/FMTQIK";
const OPEN_CSV = "https://www.twse.com.tw/exchangeReport/STOCK_DAY_ALL?response=open_data";
const MARKET_CSV = "https://www.twse.com.tw/exchangeReport/FMTQIK?response=open_data";
// Immutable, attributed mirror of the licensed STOCK_DAY_ALL OpenAPI response.
// Only the 11/20 snapshot is accepted; raw historical website reports are not
// copied into the public data branch.
const RECOVERY_URL = "https://raw.githubusercontent.com/88jiayu/tw-chip-open-data/afdb5e75b17d239d05b7b8603ccc2acb6dcd8004/data/official/price_twse/2026-11-20.json";
const RECOVERY_SHA = "ea9576685baf3d0ef96042fb56f4f192249f617d9825e0d1749acb7390a8d66f";
// Only the two CSV resources explicitly listed in the government data catalog.
function csvRows(raw, market) {
  const header=market?"日期,成交股數,成交金額,成交筆數,發行量加權股價指數,漲跌點數":
    "日期,證券代號,證券名稱,成交股數,成交金額,開盤價,最高價,最低價,收盤價,漲跌價差,成交筆數";
  const [first,...lines]=raw.toString("utf8").replace(/^\uFEFF/,"").trimEnd().split(/\r?\n/);
  if(first!==header||!lines.length)throw Error("ARCHIVE_OPEN_CSV_HEADER");
  return lines.map(line=>{
    if(!/^"(?:[^"]|"")*"(?:,"(?:[^"]|"")*")*$/.test(line)) throw Error("ARCHIVE_OPEN_CSV_ROW");
    const f=[...line.matchAll(/"((?:[^"]|"")*)"/g)].map(m=>m[1].replaceAll('""','"'));
    if(f.length!==(market?6:11)) throw Error("ARCHIVE_OPEN_CSV_COLUMNS");
    return market?{Date:f[0],TradeVolume:f[1]}:{Date:f[0],Code:f[1],TradeVolume:f[3],ClosingPrice:f[8],Change:f[9]};
  });
}
const price = s => typeof s === "string" && /^\d{1,7}\.\d{2}$/.test(s) && cents(s) > 0;
const cents = s => Number(s.replace(".", ""));
function archiveReceipt(raw, marketRaw, now, morning, probe = false, options = {}) {
  const today = taipei(now).slice(0,10);
  const time = taipei(now).slice(11,16);
  if (!probe && (morning ? (!options.manual && time < "08:00") || time >= "12:00" : time < "18:20"))
    return {status:"DEFERRED_WINDOW"};
  const eligible = sessions(options.marketCsv?csvRows(marketRaw,true):JSON.parse(marketRaw), "2000-01-01", today)
    .filter(date => !morning || date < today);
  const rows = options.csv?csvRows(raw,false):JSON.parse(raw);
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
    source:options.csv?OPEN_CSV:URL, source_attribution:"臺灣證券交易所", dataset:DATASET, license:LICENSE,
    response_sha256:sha(raw), session_source:options.marketCsv?MARKET_CSV:MARKET_SESSIONS, session_sha256:sha(marketRaw),
    session_dataset:"https://data.gov.tw/dataset/11672",
    observed_sessions:eligible.filter(d => d <= date)};
  return {status:"VERIFIED",record};
}
function recoverNovember20(raw, marketRaw, now, prior, next) {
  if (sha(raw)!==RECOVERY_SHA || prior.trading_date!=="2026-11-19" ||
      next?.trading_date!=="2026-11-23" || next.observed_sessions.at(-2)!=="2026-11-20")
    throw Error("ARCHIVE_RECOVERY_EVIDENCE_MISSING");
  const j=JSON.parse(raw), p=j.rows?.["00631L"], day="2026-11-20";
  // Price and comparison independently matched the official STOCK_DAY report
  // and FinMind (21.24 close, -3.33); the next open-source reference must agree.
  if(j.trade_date!==day||j.source!=="twse_openapi_stock_day_all"||j.license_url!==LICENSE||
      j.license!=="open"||p?.[3]!=="21.24"||p[4]!==1300766332||
      prior.close_twd!=="24.57"||next.comparison_twd!==p[3])
    throw Error("ARCHIVE_RECOVERY_CONFLICT");
  const observed=sessions(csvRows(marketRaw,true),"2026-11-01",taipei(now).slice(0,10)).filter(d=>d<=day);
  if(observed.at(-1)!==day||observed.at(-2)!==prior.trading_date)throw Error("ARCHIVE_RECOVERY_SESSION_GAP");
  return {...next,trading_date:day,close_twd:p[3],comparison_twd:prior.close_twd,captured_at:now.toISOString(),
    source:URL,response_sha256:RECOVERY_SHA,session_sha256:sha(marketRaw),observed_sessions:observed,
    recovery_snapshot:RECOVERY_URL};
}
function archivePlan(existing, candidates, target) {
  const records=[...existing], result=[];
  for(const r of [...candidates].sort((a,b)=>a.trading_date.localeCompare(b.trading_date))){
    if(r.trading_date>target)continue;
    const old=records.find(p=>p.trading_date===r.trading_date);
    if(old){
      if(old.close_twd!==r.close_twd||old.comparison_twd!==r.comparison_twd)throw Error("ARCHIVE_REVISION_REVIEW_REQUIRED");
      continue;
    }
    const prior=records.at(-1);
    if(prior&&(r.trading_date<=prior.trading_date||r.comparison_twd!==prior.close_twd||
        (r.observed_sessions.at(-2)!==prior.trading_date&&r.cross_month_session?.previous!==prior.trading_date)))
      throw Error("ARCHIVE_EXTENSION_GAP_OR_PRICE");
    records.push(r);result.push(r);
  }
  if(records.at(-1)?.trading_date!==target)throw Error("ARCHIVE_EXPECTED_SESSION_UNAVAILABLE:"+target);
  return result;
}
function appendClose(dir, record) {
  if (record.schema !== ARCHIVE_SCHEMA || record.symbol !== "00631L" ||
      !/^20\d\d-\d\d-\d\d$/.test(record.trading_date) || !price(record.close_twd) ||
      ![URL,OPEN_CSV].includes(record.source) || record.license !== LICENSE || record.dataset !== DATASET ||
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
async function fetchArchive(out, mode, target) {
  const load = async url => {
    const r = await fetch(url,{redirect:"error",signal:AbortSignal.timeout(15000)});
    if ([429,500,502,503,504].includes(r.status)) return null;
    if (!r.ok) throw Error("ARCHIVE_HTTP_"+r.status);
    const body = Buffer.from(await r.arrayBuffer());
    if (body.length > 4_000_000) throw Error("ARCHIVE_RESPONSE_TOO_BIG");
    return body;
  };
  let raw, marketRaw;
  try { [marketRaw,raw] = await Promise.all([load(MARKET_CSV),load(OPEN_CSV)]); }
  catch (err) {
    if (err.name === "TimeoutError" || err instanceof TypeError) return {status:"DEFERRED_NETWORK"};
    throw err;
  }
  if (!raw || !marketRaw) return {status:"DEFERRED_UPSTREAM"};
  const now=new Date(), morning=mode==="morning"||mode==="manual-morning";
  if(mode==="target"){
    if(!validTarget(target)||target>taipei(now).slice(0,10))throw Error("ARCHIVE_TARGET_INVALID");
    if(+now<Date.parse(target+"T18:20:00+08:00"))return {status:"DEFERRED_WINDOW",expected:target};
    const read=name=>JSON.parse(fs.readFileSync(path.join(out,name),"utf8"));
    const existing=fs.readdirSync(out).filter(n=>/^20\d\d-\d\d-\d\d\.json$/.test(n)).sort().map(read);
    // Both independently dated official representations can roll at different
    // times. Read only a bounded pair; also compare duplicates for revisions.
    const primary=archiveReceipt(raw,marketRaw,now,false,true,{csv:true,marketCsv:true}).record;
    const alternate=await load(URL);
    const secondary=alternate&&archiveReceipt(alternate,marketRaw,now,false,true,{marketCsv:true}).record;
    const candidates=[primary,secondary].filter(Boolean);
    const prior=existing.at(-1);
    if(prior?.trading_date==="2026-11-19"&&target>="2026-11-23"){
      const next=candidates.find(r=>r.trading_date==="2026-11-23");
      // After the OpenAPI rotates, this narrow recovery cannot be performed
      // from an unrelated newer price. Fail rather than create a partial gap.
      const mirror=await load(RECOVERY_URL);
      if(!mirror)throw Error("ARCHIVE_RECOVERY_MIRROR_UNAVAILABLE");
      candidates.push(recoverNovember20(mirror,marketRaw,now,prior,next));
    }
    for(const r of candidates) annotateCrossMonth(r);
    const newFiles=archivePlan(existing,candidates,target).map(r=>appendClose(out,r).name);
    return {status:newFiles.length?"APPENDED":"DUPLICATE",date:target,newFiles};
  }
  const result = archiveReceipt(raw,marketRaw,now,morning,mode === "probe",
    {csv:true,marketCsv:true,manual:mode==="manual-morning"});
  if (result.record) {
    const r=result.record, newFiles=[];
    // On a new archive only, the independently dated official JSON can supply
    // the immediately preceding close while the CSV has already rolled forward.
    if (!fs.readdirSync(out).some(n=>/^20\d\d-\d\d-\d\d\.json$/.test(n))) {
      let previousRaw;
      try{previousRaw=await load(URL);}catch(e){console.warn("OPTIONAL_PRIOR_SOURCE_UNAVAILABLE",e.message);}
      if(previousRaw){
        const p=archiveReceipt(previousRaw,marketRaw,now,morning,true,{marketCsv:true}).record;
        if(p&&r.observed_sessions.at(-2)===p.trading_date&&r.comparison_twd===p.close_twd)
          newFiles.push(appendClose(out,p).name);
      }
    }
    // The market OpenAPI may roll at month end. A matching, independently
    // verified official session interval can bridge that boundary, not a price guess.
    annotateCrossMonth(r);
    const saved=appendClose(out,r);
    if(saved.status==="APPENDED")newFiles.push(saved.name);
    return {...saved,date:r.trading_date,newFiles};
  }
  return result;
}
function annotateCrossMonth(r) {
    if (process.env.HS_00631L_CROSS_MONTH_CALENDAR === "1") {
      const read = name => JSON.parse(fs.readFileSync(path.join(__dirname,"..","data","radar-history",name),"utf8"));
      const calendar = read("twse/0050.json"), status = read("status-v1.json"),
        inc = calendar.incremental_verification, dates = inc?.sessions;
      if (calendar.verified === true && status.symbols?.["0050"]?.archive_sha256 === calendar.content_sha256 &&
          /^[a-f0-9]{64}$/.test(calendar.content_sha256) && inc?.calendar_evidence?.length &&
          Array.isArray(dates) && dates.join() === [...new Set(dates)].sort().join()) {
        const i = dates.indexOf(r.trading_date), prev = dates[i-1];
        if (i>0 && /^20\d\d-\d\d-\d\d$/.test(prev) && prev.slice(0,7)!==r.trading_date.slice(0,7))
          r.cross_month_session = {previous:prev, source:"HS_VERIFIED_TWSE_SESSION_INTERVAL", sha256:calendar.content_sha256};
      }
    }
}
const validTarget=d=>typeof d==="string"&&/^20\d\d-\d\d-\d\d$/.test(d)&&
  Number.isFinite(Date.parse(d))&&new Date(d).toISOString().slice(0,10)===d;
async function archiveHealth(target) {
  if(!validTarget(target))throw Error("ARCHIVE_TARGET_INVALID");
  const R=require("../lradar-core.js"),now=new Date();
  if(+now<Date.parse(target+"T18:20:00+08:00")) {
    console.log(JSON.stringify({status:"WAIT_00631L_CLOSE_WINDOW",expected:target}));return;
  }
  for(let attempt=0;attempt<3;attempt++){
    try {
      const response=await fetch(R.archiveURL+"?audit="+Date.now(),{redirect:"error",signal:AbortSignal.timeout(15000)});
      if(!response.ok)throw Error("ARCHIVE_PUBLIC_HTTP_"+response.status);
      const records=R.verifyIndex(await response.json(),taipei(now).slice(0,10),Date.now());
      const first=records.findIndex(r=>r.trading_date==="2026-11-19"), chain=records.slice(first);
      if(first<0||chain.at(-1)?.trading_date!==target||chain.slice(1).some((r,i)=>
        r.comparison_twd!==chain[i].close_twd||(r.observed_sessions.at(-2)!==chain[i].trading_date&&r.cross_month_session?.previous!==chain[i].trading_date)))
        throw Error("ARCHIVE_PUBLIC_GAP_OR_STALE:"+target);
      console.log(JSON.stringify({status:"CURRENT",symbol:"00631L",date:target,close:chain.at(-1).close_twd}));return;
    }catch(e){if(attempt===2)throw e;await new Promise(r=>setTimeout(r,2000));}
  }
}
if (require.main === module) (process.argv[2] === "--00631l-health" ? archiveHealth(process.argv[3]) :
  process.argv[2] === "--00631l-archive"
  ? fetchArchive(process.argv[3],process.argv[4],process.argv[5]).then(result => {
    console.log(JSON.stringify(result));
    if (result.status === "APPENDED" && process.env.HS_00631L_FILE_LIST)
      fs.writeFileSync(process.env.HS_00631L_FILE_LIST,result.newFiles.join("\n")+"\n",{flag:"wx"});
  }) : main().then(()=>{
    if(process.env.HS_AUDIT_REPORT){const timing=scheduleContext(new Date(),process.env.HS_CAPTURE_SLOT,process.env.HS_RUN_CREATED_AT);
      fs.writeFileSync(process.env.HS_AUDIT_REPORT,JSON.stringify({scope:"capture:"+timing.targetDate,healthy:true,timing,incidents:[]},null,2)+"\n",{flag:"wx"});}
  })).catch(e => {
  if(process.env.HS_AUDIT_REPORT){const timing=e.timing||scheduleContext(new Date(),process.env.HS_CAPTURE_SLOT,process.env.HS_RUN_CREATED_AT);
    fs.writeFileSync(process.env.HS_AUDIT_REPORT,JSON.stringify({scope:"capture:"+timing.targetDate,healthy:false,timing,sourceDates:e.sourceDates??null,incidents:e.incidents||[{date:timing.targetDate,code:e.message}]},null,2)+"\n",{flag:"wx"});}
  console.error("TWSE close receipt not clean: " + e.message);
  process.exitCode = 1;
});
module.exports = {receipt,capture,captureWindow,archiveReceipt,appendClose,windowCoverage,csvRows,receiptIncidents,archivePlan,recoverNovember20};
