"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const {receipt,capture,captureWindow,archiveReceipt,appendClose,windowCoverage,receiptIncidents,archivePlan,recoverNovember20} = require("../scripts/audit_twse_close_capture.cjs");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const {sessions,missingReceipts,scheduleContext,notify,publicationReport} = require("../scripts/audit_twse_close_watchdog.cjs");
const date = "2026-11-16";
const now = () => new Date("2026-11-16T10:20:00Z");
const raw = close => Buffer.from(JSON.stringify([{Date:"1151116",Code:"0050",
  OpeningPrice:"10",HighestPrice:"12",LowestPrice:"9",ClosingPrice:close,TradeVolume:"123"}]));
const openRaw = (date="1151116",close="27.95",change="-3.9700") => Buffer.from(JSON.stringify([
  {Date:date,Code:"00631L",ClosingPrice:close,Change:change,TradeVolume:"678825245"}]));
const market = Buffer.from(JSON.stringify([{Date:"1151116",TradeVolume:"1100000"}]));

test("00631L requires a dated confirmed session and handles a bounded next-morning retry", () => {
  assert.equal(archiveReceipt(openRaw("1151113"),market,now(),false).status,"DEFERRED_SOURCE_DATE");
  assert.equal(archiveReceipt(openRaw(),market,new Date("2026-11-17T00:17:00Z"),false).status,"DEFERRED_WINDOW");
  assert.equal(archiveReceipt(openRaw(),market,new Date("2026-11-17T00:17:00Z"),true).record.trading_date,date);
  assert.equal(archiveReceipt(openRaw(),market,new Date("2026-11-17T10:20:00Z"),false).status,"DEFERRED_SESSION");
  const {record} = archiveReceipt(openRaw(),market,now(),false);
  assert.equal(record.close_twd,"27.95");
  assert.equal(record.comparison_twd,"31.92");
  assert.match(record.response_sha256,/^[a-f0-9]{64}$/);
  assert.equal(archiveReceipt(openRaw("1151116","27.95","X"),market,now(),false).record.comparison_twd,null);
});
test("licensed CSV independently confirms the close and previous price basis", () => {
  const stock = Buffer.from('日期,證券代號,證券名稱,成交股數,成交金額,開盤價,最高價,最低價,收盤價,漲跌價差,成交筆數\n"1151116","00631L","元大,台灣50","678825245","1","31.25","31.37","27.95","27.95","-3.9700","1"\n');
  const daily = Buffer.from('日期,成交股數,成交金額,成交筆數,發行量加權股價指數,漲跌點數\n"1151116","1000","1","1","1","1"\n');
  const options = {csv:true,marketCsv:true,manual:true};
  const {record} = archiveReceipt(stock,daily,new Date("2026-11-16T16:15:00Z"),true,false,options);
  assert.equal(record.trading_date,"2026-11-16");
  assert.equal(record.close_twd,"27.95");
  assert.equal(record.comparison_twd,"31.92");
  assert.ok(record.source.endsWith("response=open_data"));
  assert.throws(() => archiveReceipt(Buffer.from("bad header"),daily,now(),false,false,options),/OPEN_CSV_HEADER/);
});
test("00631L replays are idempotent; corrections never replace original bytes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),"hs-00631l-test-"));
  try {
    const {record} = archiveReceipt(openRaw(),market,now(),false);
    const {name,status} = appendClose(dir,record);
    assert.equal(status,"APPENDED");
    const original = fs.readFileSync(path.join(dir,name),"utf8");
    assert.equal(appendClose(dir,{...record,response_sha256:"f".repeat(64)}).status,"DUPLICATE");
    assert.throws(() => appendClose(dir,{...record,close_twd:"28.00"}),/REVISION/);
    assert.equal(fs.readFileSync(path.join(dir,name),"utf8"),original);
  } finally { fs.unlinkSync(path.join(dir,date+".json")); fs.rmdirSync(dir); }
});
test("window eligibility rejects missing days and unverified action basis", () => {
  const first = "2026-11-13", days = [first,date];
  const {record} = archiveReceipt(openRaw(),market,now(),false);
  assert.deepEqual(windowCoverage([record],days,first,date,true),{status:"MISSING_SESSIONS",missing:[first]});
  const complete = [{...record,trading_date:first,close_twd:"31.92"},record];
  assert.equal(windowCoverage(complete,days,first,date,false).status,"PRICE_BASIS_UNVERIFIED");
  assert.equal(windowCoverage(complete,days,first,date,true).status,"COMPLETE");
});

test("watchdog uses actual completed sessions, never weekday guesses", () => {
  const entries = [{Date:"1151113",TradeVolume:"100"},{Date:"1151116",TradeVolume:"200"}];
  assert.deepEqual(sessions(entries,"2026-11-13","2026-11-17"),["2026-11-13","2026-11-16"]);
  assert.throws(() => sessions([...entries,entries[0]],"2026-11-13","2026-11-17"),/DUPLICATE/);
  assert.throws(() => sessions(entries,"2026-11-13","2026-11-15"),/ROW_INVALID/);
});

test("Taipei slots accept bounded delays but reject the next slot or next date", () => {
  const created = "2026-11-16T10:20:00Z";
  assert.equal(captureWindow(new Date("2026-11-16T10:47:00Z"),"18:20",created),date);
  assert.equal(captureWindow(new Date("2026-11-16T12:26:00Z"),"20:20","2026-11-16T12:20:00Z"),date);
  assert.throws(() => captureWindow(new Date("2026-11-16T12:20:00Z"),"18:20",created),/WINDOW_MISSED/);
  assert.throws(() => captureWindow(new Date("2026-11-17T10:25:00Z"),"18:20",created),/WINDOW_MISSED/);
});

test("on-time and 10/30/60-minute creation or runner delays retain the correct slot date",()=>{
  for(const [slot,hour] of [["18:20",10],["20:20",12]])for(const minutes of [0,10,30,60]){
    const nominal=Date.parse(`2026-11-20T${hour}:20:00Z`),late=new Date(nominal+minutes*60000);
    assert.equal(captureWindow(late,slot,late.toISOString()),"2026-11-20");
    assert.equal(captureWindow(late,slot,new Date(nominal).toISOString()),"2026-11-20");
    const c=scheduleContext(late,slot,late.toISOString());
    assert.equal(c.creationDelayMs,minutes*60000);assert.equal(c.executionQueueMs,0);
  }
});

test("recorded runs 35/36/37 identify the prior target without pretending the trigger time is known",()=>{
  for(const [cron,created,started,slot]of [
    ["20 10 * * 1-5","2026-11-20T18:37:41Z","2026-11-20T18:37:48Z","18:20"],
    ["20 12 * * 1-5","2026-11-20T20:27:14Z","2026-11-20T20:27:21Z","20:20"],
    ["53 13 * * 1-5","2026-11-20T21:34:15Z","2026-11-20T21:34:20Z","watchdog"]]){
    const c=scheduleContext(new Date(started),cron,created);
    assert.equal(c.targetDate,"2026-11-20");assert.equal(c.runCreatedTaipeiDate,"2026-11-21");
    assert.equal(c.executionTaipeiDate,"2026-11-21");assert.equal(c.slot,slot);
    assert.match(c.nominalTimeBasis,/INFERRED_NOT_PROVIDER_TRIGGER/);assert.ok(c.executionQueueMs<10000);
    if(slot!=="watchdog")assert.throws(()=>captureWindow(new Date(started),slot,created),/WINDOW_MISSED/);
  }
  assert.equal(scheduleContext(new Date("2026-11-21T00:30:00Z"),"17 0 * * 2-6","2026-11-21T00:20:00Z").targetDate,"2026-11-20");
});

test("expired windows, future clocks, weekends and unconfirmed holiday data never become clean",async()=>{
  assert.throws(()=>captureWindow(new Date("2026-11-20T16:05:00Z"),"20:20","2026-11-20T16:00:00Z"),/WINDOW_MISSED/);
  assert.throws(()=>scheduleContext(now(),"18:20","2026-11-17T10:20:00Z"),/CONTEXT_INVALID/);
  assert.throws(()=>captureWindow(new Date("2026-11-21T10:20:00Z"),"manual","2026-11-21T10:20:00Z"),/WEEKEND/);
  // A prior dated snapshot during a weekday holiday is not proof of a new
  // session, nor does an absent session authorize fabricated OHLCV.
  await assert.rejects(capture("2026-02-17",null,{now:()=>new Date("2026-02-17T12:20:00Z"),get:async()=>new Response(raw("10"))}),/SESSION_DATE_MISMATCH/);
});

function incidentHarness(){
  let issue=null,creates=0,updates=0;const notices=[];
  const github={paginate:async()=>issue&&issue.state!=="closed"?[structuredClone(issue)]:[],rest:{issues:{listForRepo(){},
    create:async p=>{creates++;issue={...p,number:1,state:"open",user:{login:"github-actions[bot]"}};},
    update:async p=>{updates++;issue={...issue,...p};}}}};
  const core={notice:s=>notices.push(s),summary:{addCodeBlock:()=>({write:async()=>{}})}};
  const context={repo:{owner:"TEST_ONLY",repo:"ISOLATED"}},run=report=>notify({github,context,core,report});
  return {run,state:()=>({issue,creates,updates,notices})};
}
const failure=(scope,date,code)=>({scope,healthy:false,incidents:[{date,code}]});
test("same reason has no second issue update/red alert; different date or reason alerts",async()=>{
  const h=incidentHarness(),scope="capture:2026-11-20",r=failure(scope,"2026-11-20","CAPTURE_WINDOW_MISSED");
  assert.equal(await h.run(r),"new");assert.equal(await h.run({...r,timing:{differentRun:true}}),"duplicate");
  assert.equal(h.state().creates,1);assert.equal(h.state().updates,0);
  assert.equal(await h.run(failure(scope,"2026-11-20","OPENAPI_HTTP_503")),"new");
  assert.equal(await h.run(failure("capture:2026-11-23","2026-11-23","OPENAPI_HTTP_503")),"new");
  assert.equal(h.state().updates,2);
});
test("capture/watchdog interleaving does not flip alerts; recovery closes only after all scopes recover",async()=>{
  const h=incidentHarness(),capture=failure("capture:2026-11-20","2026-11-20","CAPTURE_WINDOW_MISSED"),
    watchdog=failure("watchdog","2026-11-19","MISSED_CAPTURE_RECEIPT");
  await h.run(capture);await h.run(watchdog);const before=h.state().updates;
  assert.equal(await h.run(capture),"duplicate");assert.equal(await h.run(watchdog),"duplicate");assert.equal(h.state().updates,before);
  await h.run({...capture,healthy:true,incidents:[]});assert.equal(h.state().issue.state,"open");
  assert.equal(await h.run({...watchdog,healthy:true,incidents:[]}),"recovered");assert.equal(h.state().issue.state,"closed");
  assert.equal(await h.run({...watchdog,healthy:true,incidents:[]}),"healthy");
});
test("missing-report or notification permission errors must fail closed",async()=>{
  const h=incidentHarness();await assert.rejects(h.run({scope:"watchdog",healthy:false,incidents:[]}),/REPORT_INVALID/);
  const bad={rest:{issues:{listForRepo(){}}},paginate:async()=>{throw Error("TEST_PERMISSION_DENIED");}};
  await assert.rejects(notify({github:bad,context:{repo:{}},core:{summary:{addCodeBlock:()=>({write:async()=>{}})}},report:failure("watchdog","2026-11-20","MISSING")}),/PERMISSION_DENIED/);
});
test("a verified quote without its clean artifact cannot resolve a publication alert",()=>{
  const good={scope:"capture:2026-11-20",healthy:true,timing:{targetDate:"2026-11-20"},incidents:[]};
  assert.equal(publicationReport(good,"success"),good);
  for(const outcome of["failure","skipped",undefined]){
    const blocked=publicationReport(good,outcome);assert.equal(blocked.healthy,false);
    assert.equal(blocked.incidents[0].code,"CLEAN_RECEIPT_ARTIFACT_UNAVAILABLE");
  }
});

test("workflow uses scheduled context, retains strict errors and immutable artifacts, and does not publish FINAL",()=>{
  const w=fs.readFileSync(".github/workflows/audit-twse-close-capture.yml","utf8");
  assert.ok(!w.includes("day=$(TZ=Asia/Taipei date +%F)"));
  for(const s of ["--context", "HS_RUN_CREATED_AT", "HS_AUDIT_REPORT", "steps.audit.outcome == 'success'", "retention-days: 30", "timezone: 'Etc/UTC'"])assert.ok(w.includes(s),s);
  assert.ok(!w.includes("finalize_core_score_history"));assert.ok(!w.includes("FINMIND_TOKEN"));
  const block=w.replace(/\r\n/g,"\n").split("  archive-00631l:\n")[1];
  for(const s of ["github.ref == 'refs/heads/main'","HS_00631L_OPEN_CLOSE_ARCHIVE_ENABLED","refs/heads/data/00631l-open-close",
    "git cat-file -e","git push origin", "--expected-only","--00631l-health",'target "$expected"'])assert.ok(block.includes(s),s);
  assert.ok(!block.includes("--force")&&!block.includes("TZ=Asia/Taipei date +%H"));
});

test("archive append plan blocks gaps/corrections and supports two staggered feeds plus pinned recovery",()=>{
  const days=["2026-11-19","2026-11-20","2026-11-23","2026-11-24"],p=["24.57","21.24","22.50","27.00"];
  const rows=days.map((trading_date,i)=>({trading_date,close_twd:p[i],comparison_twd:p[i-1],observed_sessions:days.slice(0,i+1)}));
  assert.deepEqual(archivePlan([rows[0]],[rows[3],rows[1],rows[2]],days[3]),rows.slice(1));
  assert.deepEqual(archivePlan(rows,[rows[3],rows[2]],days[3]),[]);
  assert.deepEqual(archivePlan(rows.slice(0,2),[rows[3],rows[2]],days[2]),[rows[2]]);
  assert.throws(()=>archivePlan([rows[0]],rows.slice(2),days[3]),/GAP/);
  assert.throws(()=>archivePlan(rows,[{...rows[3],close_twd:"27.01"}],days[3]),/REVISION/);
  assert.throws(()=>archivePlan(rows.slice(0,3),[],days[3]),/UNAVAILABLE/);
  assert.throws(()=>recoverNovember20(Buffer.from("{}"),market,now(),rows[0],rows[2]),/EVIDENCE_MISSING/);
});

test("watchdog flags both skipped and failed capture, but accepts the second clean slot", () => {
  const prefix = "twse-close-main-", days = ["2026-11-13",date,"2026-11-17"];
  assert.deepEqual(missingReceipts(days,[prefix+days[0]+"-ok-18-20",prefix+days[1]],prefix),[date,days[2]]);
  assert.deepEqual(missingReceipts(days,[prefix+days[0]+"-ok-18-20",prefix+date+"-ok-20-20"],prefix),[days[2]]);
});

test("receipt has no raw prices and changes are flagged only for affected symbols", () => {
  const first = receipt(raw("10"),date,null,now());
  const duplicate = receipt(raw("10"),date,first,now());
  const revised = receipt(raw("11"),date,first,now());
  assert.equal(first.symbols["0050"].corporateActions,"UNKNOWN");
  assert.equal(first.symbols["0050"].scoreEligible,false);
  assert.equal(first.rawRetained,false);
  assert.equal(first.symbols["0050"].close,undefined);
  assert.equal(duplicate.responseChanged,false);
  assert.equal(revised.responseChanged,true);
  assert.equal(revised.symbols["0050"].revised,true);
  assert.equal(revised.symbols["00757"].revised,false);
  assert.deepEqual(receiptIncidents(first).map(x=>x.code),["SYMBOL_MISSING_SYMBOL:00757","SYMBOL_MISSING_SYMBOL:00830","SYMBOL_MISSING_SYMBOL:00935"]);
  assert.ok(receiptIncidents(revised).some(x=>x.code==="SOURCE_REVISION:0050"));
  assert.throws(() => receipt(raw("10"),date,{...first,date:"2026-11-13"},now()),/PREVIOUS_RECEIPT_INVALID/);
});

test("5xx retry is bounded but rate limits and stale sessions fail closed", async () => {
  let calls=0;
  await capture(date,null,{now,pause:async()=>{},get:async()=>{
    calls++;
    return calls===1 ? new Response(null,{status:503}) : new Response(raw("10"));
  }});
  assert.equal(calls,2);
  calls=0;
  await assert.rejects(capture(date,null,{now,get:async()=>{calls++;return new Response(null,{status:429});}}),/HTTP_429/);
  assert.equal(calls,1);
  await assert.rejects(capture("2026-11-17",null,{
    now:()=>new Date("2026-11-17T10:20:00Z"),get:async()=>new Response(raw("10"))
  }),e=>e.message==="OPENAPI_SESSION_DATE_MISMATCH"&&e.sourceDates.join()==="1151116");
});
