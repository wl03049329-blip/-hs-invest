"use strict";
// Offline reconstruction only. No network, exporter, deployment, trading or
// financial storage. A correct checksum is NOT a data redistribution licence.
const fs=require("node:fs"),path=require("node:path"),zlib=require("node:zlib");
const {execFileSync}=require("node:child_process"),crypto=require("node:crypto");
const R=require("../lradar-core");
const ROOT=path.resolve(__dirname,"..");
const sha=raw=>crypto.createHash("sha256").update(raw).digest("hex");
const fail=(condition,reason)=>{if(!condition)throw Error(reason);};
const minor=n=>{
  fail(Number.isFinite(n)&&n>0&&Math.abs(n*100-Math.round(n*100))<1e-8,"NOT_CENT_PRICE");
  return Math.round(n*100);
};
const SPLIT={effective:"2026-03-31",lastBefore:"2026-03-24",factor:22,
  notice:"https://api.yuantafunds.com/ECImage/ECBackstage/file/2026-03-30/3bdfb16432cf4c8c8cd10a30808802b4.pdf"};
const LATE=[
  ["2026-11-06","301f2a12"],["2026-11-09","0d9831ef"],["2026-11-10","2655fce1"],
  ["2026-11-11","56c9a25c"],["2026-11-12","91f2fe61"],["2026-11-13","ef5b2e74"],
  ["2026-11-16","dce192a9"],["2026-11-17","f9441183"],["2026-11-18","ce946dd2"],
  ["2026-11-19","b802ace1a1314e098363b6d22c98f97d7e8f2ab1"]
];
function adjustedClose(raw,date){
  fail(R.monthsBack(date,0)===date&&Number.isFinite(raw)&&raw>0,"INVALID_RAW_CLOSE");
  fail(!(SPLIT.lastBefore<date&&date<SPLIT.effective),"SUSPENSION_HAS_NO_CLOSE");
  return date<SPLIT.effective?raw/SPLIT.factor:raw;
}
function roc(value){
  const m=/^(\d{3})\/(\d\d)\/(\d\d)$/.exec(value);
  fail(m,"INVALID_OFFICIAL_DAY");
  return (+m[1]+1911)+"-"+m[2]+"-"+m[3];
}
function verifyRows(rows){
  fail(Array.isArray(rows)&&rows.length>0,"NO_ROWS");
  for(let i=0;i<rows.length;i++){
    const [date,value]=rows[i];
    fail(rows[i].length===2&&/^20\d\d-\d\d-\d\d$/.test(date)&&
      Number.isFinite(Date.parse(date))&&new Date(date).toISOString().slice(0,10)===date&&
      (!i||rows[i-1][0]<date)&&Number.isFinite(value)&&value>0,"INVALID_OR_DUPLICATE_CLOSE");
  }
}
function audit(root=ROOT,git=(ref)=>execFileSync("git",["show",ref+":market-quotes.json"],{cwd:root,maxBuffer:12_000_000})){
  const read=name=>JSON.parse(fs.readFileSync(path.join(root,name),"utf8"));
  const seed=read("data/lc4-research/seed.json"),pointer=read("data/lc4-research/latest.json");
  const compressed=fs.readFileSync(path.join(root,"data/lc4-research/seed-sources.json.gz"));
  fail(sha(compressed)===seed.sources_sha256,"SOURCE_ARCHIVE_HASH");
  const sources=JSON.parse(zlib.gunzipSync(compressed));
  fail(/^snapshots\/[a-zA-Z0-9_.-]+\.json$/.test(pointer.path),"POINTER_PATH");
  const bytes=fs.readFileSync(path.join(root,"data/lc4-research",pointer.path));
  fail(bytes.length===pointer.bytes&&sha(bytes)===pointer.sha256,"RESEARCH_BUNDLE_HASH");
  const bundle=JSON.parse(bytes),rows=bundle.history.histories["00631L"].map(r=>[r.date,r.close]);
  verifyRows(rows);
  fail(bundle.asof===pointer.asof&&rows.at(-1)[0]===pointer.asof,"HISTORY_END_MISMATCH");
  const by=new Map(rows),official=new Set(),calendar=new Set(),rawBefore=[];
  let months=0;
  for(const [name,source]of Object.entries(sources)){
    if(/^twse-0050-\d{6}\.json$/.test(name))
      source.payload.data.forEach(r=>calendar.add(roc(r[0])));
    if(!/^twse-00631L-\d{6}\.json$/.test(name))continue;
    const p=source.payload;
    fail(p.stat==="OK"&&p.fields[0]==="日期"&&p.fields[6]==="收盤價"&&p.title.includes("00631L")&&
      /^https:\/\/www\.twse\.com\.tw\/exchangeReport\/STOCK_DAY\?/.test(source.receipt.url)&&
      /^[a-f0-9]{64}$/.test(source.receipt.sha256),"SOURCE_SCHEMA");
    months++;
    for(const r of p.data){
      const date=roc(r[0]),raw=Number(r[6].replaceAll(",",""));
      fail(!official.has(date),"DUPLICATE_SOURCE_DAY");official.add(date);
      fail(by.has(date)&&by.get(date)===adjustedClose(raw,date),"ADJUSTED_CLOSE_DIFF:"+date);
      if(date===SPLIT.lastBefore||date===SPLIT.effective)rawBefore.push({date,raw,adjusted:by.get(date)});
    }
  }
  const fm=sources["finmind-TaiwanStockPrice-00631L.json"].payload.data;
  const fmDifferences=fm.filter(r=>by.get(r.date)!==adjustedClose(r.close,r.date)).map(r=>r.date);
  const reviewedSplit=sources["finmind-TaiwanStockSplitPrice-00631L.json"].payload.data;
  fail(reviewedSplit.length===1&&reviewedSplit[0].date===SPLIT.effective&&
    bundle.history.review.split_factor===22&&bundle.history.review.split_effective===SPLIT.effective,"SPLIT_CONFLICT");
  // Compare the union of two archived instruments, not weekdays guessed from
  // today's calendar; this is overlap evidence, not full market certification.
  const historicalSessions=[...new Set([...calendar,...official])].filter(d=>d>=rows[0][0]&&d<=rows.at(-2)[0]&&
    !(SPLIT.lastBefore<d&&d<SPLIT.effective)).sort();
  const missingHistorical=historicalSessions.filter(d=>!by.has(d));
  const lateEvidence=[];
  for(const [date,ref]of LATE){
    const raw=git(ref),q=JSON.parse(raw);
    const matches=q.items.filter(r=>r.code==="00631L"&&r.date===date&&r.market==="TWSE"&&r.quote_mode==="close");
    fail(matches.length===1&&q.official_source_dates.TWSE===date&&q.source_dates.TWSE===date&&
      ["official_closing_data","official_closing_data_daily_report"].includes(q.source_status.TWSE),"LATE_OFFICIAL_CLOSE_UNVERIFIED:"+date);
    const value=matches[0].price;
    // Existing HS previous_close is IEEE-754 subtraction (e.g. 26.299999999999997).
    // Reconcile integer cents, never round an actual one-tick discrepancy away.
    fail(date>rows.at(-1)[0]&&minor(matches[0].previous_close)===minor(rows.at(-1)[1]),"LATE_REFERENCE_CONFLICT:"+date);
    minor(value);
    rows.push([date,value]);
    lateEvidence.push({date,ref,sha256:sha(raw),source:q.sources.TWSE_close,public_reuse:"UNCONFIRMED"});
  }
  verifyRows(rows);
  const summary=R.summary({rows,thresholds:R.limits},240);
  return {schema:"HS_00631L_OFFLINE_HISTORY_AUDIT_V1",publication_authorized:false,
    status:"HOLD_SOURCE_REUSE_AND_COMPLETE_ACTION_COVERAGE",raw_redistribution_authorized:false,
    history:{start:rows[0][0],end:rows.at(-1)[0],rows:rows.length,bundle_sha256:pointer.sha256,sources_sha256:seed.sources_sha256},
    official_archive:{months,matched_closes:official.size,missing_overlap_dates:missingHistorical,
      caveat:"Two-instrument overlap is not proof of complete official market calendar coverage."},
    vendor_differences:{close_dates:fmDifferences,count:fmDifferences.length,selection:"ARCHIVED_OFFICIAL_CLOSE_NOT_VENDOR"},
    split:{...SPLIT,anchors:rawBefore,already_adjusted:true,reapply:false},
    incremental:lateEvidence,threshold_version:R.thresholdVersion,price_return_only:true,
    metrics:summary};
}
if(require.main===module) console.log(JSON.stringify(audit(),(key,value)=>key==="rows"&&Array.isArray(value)?undefined:value,2));
module.exports={audit,adjustedClose,verifyRows,SPLIT};
