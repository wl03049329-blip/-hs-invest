"use strict";
const {execFileSync} = require("node:child_process");
const marketSource = "https://openapi.twse.com.tw/v1/exchangeReport/FMTQIK";
const dateOK = d => typeof d === "string" && /^20\d\d-\d\d-\d\d$/.test(d) &&
  Number.isFinite(Date.parse(d)) && new Date(d).toISOString().slice(0,10) === d;
const cronSlots = Object.freeze({"20 10 * * 1-5":"18:20","20 12 * * 1-5":"20:20",
  "53 13 * * 1-5":"watchdog","17 0 * * 2-6":"morning"});
function scheduleContext(now, input, createdAt) {
  const actual = +now, created = Date.parse(createdAt), slot = cronSlots[input] || input;
  if (!Number.isFinite(actual) || !Number.isFinite(created) || created > actual ||
      !["18:20","20:20","manual","watchdog","morning"].includes(slot)) throw Error("SCHEDULE_CONTEXT_INVALID");
  const tpe = ms => new Date(ms+8*3600000).toISOString();
  let nominal = null;
  if (slot !== "manual") {
    const minute = {"18:20":620,"20:20":740,watchdog:833,morning:17}[slot];
    const first = new Date(created);first.setUTCHours(0,0,0,0);
    for (let n=0;n<8;n++) {
      const day = +first-n*86400000, candidate = day+minute*60000, weekday = new Date(day).getUTCDay();
      if (candidate<=created && (slot==="morning" ? weekday>=2&&weekday<=6 : weekday>=1&&weekday<=5)) {nominal=candidate;break;}
    }
    if (nominal===null) throw Error("SCHEDULE_OCCURRENCE_UNKNOWN");
  }
  const anchor = nominal===null ? created : nominal;
  return {slot,cron:Object.keys(cronSlots).find(k=>cronSlots[k]===slot)||null,runCreatedAt:new Date(created).toISOString(),executedAt:new Date(actual).toISOString(),
    executionTaipeiDate:tpe(actual).slice(0,10),nominalScheduledAt:nominal===null?null:new Date(nominal).toISOString(),
    nominalTimeBasis:nominal===null?"MANUAL_RUN_CREATED_AT":"LATEST_CRON_OCCURRENCE_INFERRED_NOT_PROVIDER_TRIGGER_TIME",
    triggerTaipeiDate:tpe(created).slice(0,10),targetDate:tpe(anchor-(slot==="morning"?86400000:0)).slice(0,10),
    creationDelayMs:nominal===null?null:created-nominal,executionQueueMs:actual-created};
}
const incidentMarker = "<!-- hs-twse-close-capture-v1 -->";
const incidentKeys = report => [...new Set(report?.incidents?.map(i=>i.date+":"+i.code)||[])].sort();
// Persist independent capture/watchdog scopes together: alternating jobs must
// not repeatedly replace each other's alert, or close an unresolved failure.
async function notify({github,context,core,report}) {
  if (!report || typeof report.scope!=="string" || typeof report.healthy!=="boolean" ||
      !Array.isArray(report.incidents) || report.incidents.some(i=>!dateOK(i.date)||typeof i.code!=="string") ||
      !report.healthy&&!report.incidents.length || report.healthy&&report.incidents.length) throw Error("INCIDENT_REPORT_INVALID");
  await core.summary.addCodeBlock(JSON.stringify(report,null,2),"json").write();
  const issues=await github.paginate(github.rest.issues.listForRepo,{...context.repo,state:"open",per_page:100});
  const prior=issues.find(i=>!i.pull_request&&i.user?.login==="github-actions[bot]"&&i.body?.startsWith(incidentMarker+"\n"));
  let old={};if(prior){try{old=JSON.parse(prior.body.slice(incidentMarker.length+1)).reports;if(!old||Array.isArray(old))throw Error();}catch{throw Error("INCIDENT_STATE_UNREADABLE");}}
  const next={...old};if(report.healthy)delete next[report.scope];else next[report.scope]=report;
  const keys=reports=>[...new Set(Object.values(reports).flatMap(incidentKeys))].sort();
  const before=keys(old),after=keys(next),novel=after.some(k=>!before.includes(k));
  // Context timestamps/Run IDs do not make a new incident. No issue mutation
  // at all for repeated active reasons; a new trading date remains a new key.
  if(JSON.stringify(incidentKeys(old[report.scope]))===JSON.stringify(incidentKeys(report))) {core.notice(report.healthy?"No active capture incident.":"Known FAIL_CLOSED capture incident; issue unchanged.");return report.healthy?"healthy":"duplicate";}
  if(!after.length){if(prior)await github.rest.issues.update({...context.repo,issue_number:prior.number,state:"closed"});return "recovered";}
  const body=incidentMarker+"\n"+JSON.stringify({reports:next},null,2);
  if(prior)await github.rest.issues.update({...context.repo,issue_number:prior.number,body});
  else await github.rest.issues.create({...context.repo,title:"TWSE close capture requires attention (not C4 publication)",body});
  if(!report.healthy)core.notice("Capture remains FAIL_CLOSED; see persistent incident issue.");
  return novel?"new":"changed";
}
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
  const at=new Date(),now = new Date(+at+8*3600000).toISOString().slice(0,10);
  const timing=scheduleContext(at,process.env.HS_CAPTURE_SLOT||"watchdog",process.env.HS_RUN_CREATED_AT);
  const start = process.env.HS_CAPTURE_START;
  const r = await fetch(marketSource,{redirect:"error",signal:AbortSignal.timeout(15000)});
  if (!r.ok) throw Error("MARKET_SESSION_HTTP_" + r.status);
  const rows = await r.json();
  const days = sessions(rows, start, now).filter(d=>d<=timing.targetDate);
  // Current-month feed cannot certify a missed previous-month last session.
  if (!days.length || !rows.some(row => row.Date.slice(0,5) ===
      String(Number(now.slice(0,4))-1911)+now.slice(5,7)))
    throw Error("MARKET_SESSION_COVERAGE_UNKNOWN");
  const prefix = "twse-close-" + process.env.GITHUB_REF_NAME.replaceAll("/","-") + "-";
  const pages = JSON.parse(execFileSync("gh",["api","--paginate","--slurp",
    `repos/${process.env.GITHUB_REPOSITORY}/actions/artifacts?per_page=100`],{encoding:"utf8",maxBuffer:24e6}));
  const receipts = pages.flatMap(page => page.artifacts).filter(a => !a.expired).map(a => a.name);
  const missing = missingReceipts(days, receipts, prefix);
  const report={scope:"watchdog",healthy:!missing.length,timing,source:marketSource,
    calendarCoverage:"OBSERVED_SESSIONS_ONLY_NOT_A_HOLIDAY_CERTIFICATE",observedSessions:days,
    incidents:missing.map(date=>({date,code:"MISSED_CAPTURE_RECEIPT"}))};
  if(process.env.HS_AUDIT_REPORT)require("node:fs").writeFileSync(process.env.HS_AUDIT_REPORT,JSON.stringify(report,null,2)+"\n",{flag:"wx"});
  if (missing.length) throw Object.assign(Error("MISSED_CAPTURE_RECEIPTS " + missing.join(",")),{reported:true});
  console.log("Receipts present for observed sessions",days.length,
    "; absent market sessions and previous-month coverage are not certified.");
}
if (require.main === module) {
  if(process.argv[2]==="--context")console.log(JSON.stringify(scheduleContext(new Date(),process.argv[3],process.argv[4])));
  else main().catch(e=>{
    if(!e.reported&&process.env.HS_AUDIT_REPORT){const now=new Date(),timing=scheduleContext(now,process.env.HS_CAPTURE_SLOT||"watchdog",process.env.HS_RUN_CREATED_AT);
      require("node:fs").writeFileSync(process.env.HS_AUDIT_REPORT,JSON.stringify({scope:"watchdog",healthy:false,timing,incidents:[{date:timing.targetDate,code:e.message}]},null,2)+"\n",{flag:"wx"});}
    console.error(e.message);process.exitCode=1;
  });
}
module.exports = {sessions,missingReceipts,scheduleContext,notify,incidentKeys,cronSlots};
