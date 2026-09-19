"use strict";

const assert=require("node:assert/strict"),fs=require("node:fs"),vm=require("node:vm");
const html=fs.readFileSync("index.html","utf8");

function slice(startMarker,endMarker){
  const start=html.indexOf(startMarker),end=html.indexOf(endMarker,start);
  assert.ok(start>=0&&end>start,`${startMarker} must be extractable`);
  return html.slice(start,end);
}

(async()=>{
  const loaderSource=slice("function parseCanonicalCoreSnapshots","function currentCanonicalCoreSnapshot");
  const valid={schema_version:1,snapshot_type:"INTRADAY_CORE",status:"SUCCESS",trading_date:"2026-09-18",slot:"09:05",items:{"00830":{status:"SUCCESS",display_score:49,market_as_of:"2026-09-18T09:05:00+08:00"}}};
  const loaderSandbox={Date,window:{HSLiveDiagnostics:{sanitizeError:error=>String(error?.message||error)}}};
  vm.createContext(loaderSandbox);vm.runInContext(loaderSource,loaderSandbox);

  loaderSandbox.fetchNoStore=async()=>({snapshots:[valid]});
  let result=await loaderSandbox.loadArchivedIntradayCoreSnapshots({aborted:false});
  assert.equal(result.status,"SUCCESS");assert.equal(result.snapshots.length,1);assert.equal(result.trading_date,"2026-09-18");

  loaderSandbox.fetchNoStore=async()=>({snapshots:[]});
  result=await loaderSandbox.loadArchivedIntradayCoreSnapshots({aborted:false});
  assert.equal(result.status,"EMPTY");assert.deepEqual(Array.from(result.snapshots),[]);

  loaderSandbox.fetchNoStore=async()=>{throw new Error("network unavailable")};
  result=await loaderSandbox.loadArchivedIntradayCoreSnapshots({aborted:false});
  assert.equal(result.status,"REQUEST_ERROR");assert.equal(result.snapshots,null);

  loaderSandbox.fetchNoStore=async()=>{throw new SyntaxError("malformed json")};
  result=await loaderSandbox.loadArchivedIntradayCoreSnapshots({aborted:false});
  assert.equal(result.status,"PARSE_ERROR");assert.equal(result.snapshots,null);

  loaderSandbox.fetchNoStore=async()=>{throw new Error("cancelled")};
  result=await loaderSandbox.loadArchivedIntradayCoreSnapshots({aborted:true});
  assert.equal(result.status,"CANCELLED");assert.equal(result.snapshots,null);
  console.log("A PASS: archive load distinguishes success-empty, request, parse and cancellation outcomes");

  const applySource=slice("function applyLiveCoreState","async function loadCanonicalCoreLedger");
  const preserved=[valid],events=[];
  const applySandbox={
    Date,
    liveRequestCoordinator:{canApply:()=>true,applied:()=>{}},
    liveCoreSourceState:{},liveCanonicalCoreSnapshots:[],archivedIntradayCoreSnapshots:preserved,
    archivedIntradayCoreState:{status:"SUCCESS",trading_date:"2026-09-18",last_success_at:"2026-09-18T13:31:00+08:00",last_attempt_at:"2026-09-18T13:31:00+08:00",error:null},
    taipeiToday:()=>"2026-09-18",liveDiagnosticRecord:(event,patch)=>events.push({event,patch}),
    window:{HSLiveDiagnostics:{latestSnapshotTime:()=>null,archiveSummary:snapshots=>({total:snapshots.length,today:snapshots.length,archive_date:"2026-09-18",latest_today_snapshot_time:"2026-09-18T09:05:00+08:00"}),diagnosticMarketState:value=>value,classifyRenderState:()=>"API_UNAVAILABLE",diagnosticRenderState:({baseState})=>baseState}},
  };
  vm.createContext(applySandbox);vm.runInContext(applySource,applySandbox);
  const state={source:"railway",status:"UNAVAILABLE",reason:"API_UNAVAILABLE",market_state:"UNAVAILABLE",diagnostics:{freshness_check:"REJECTED"}};
  assert.equal(applySandbox.applyLiveCoreState(1,{state,liveSnapshots:[],archivedResult:{status:"REQUEST_ERROR",snapshots:null,loaded_at:"2026-09-18T13:32:00+08:00",error:"HTTP 503"}}),true);
  assert.equal(applySandbox.archivedIntradayCoreSnapshots.length,1);
  assert.equal(applySandbox.archivedIntradayCoreState.last_success_at,"2026-09-18T13:31:00+08:00");
  assert.equal(applySandbox.archivedIntradayCoreState.status,"REQUEST_ERROR");
  assert.equal(events.at(-1).patch.store_archived_snapshot_count,1);
  assert.equal(events.at(-1).patch.archive_error,"HTTP 503");
  console.log("B PASS: one archive request failure preserves the last validated trajectory and its success time");

  applySandbox.liveRequestCoordinator={canApply:()=>false,applied:()=>{throw new Error("must not apply")}};
  applySandbox.applyLiveCoreState(0,{state,liveSnapshots:[],archivedResult:{status:"EMPTY",snapshots:[],loaded_at:"2026-09-18T13:33:00+08:00",error:null}});
  assert.equal(applySandbox.archivedIntradayCoreSnapshots.length,1);
  console.log("C PASS: stale responses cannot overwrite a newer validated archive state");

  assert.match(html,/if\(nextArchived\.status==="CANCELLED"\)return liveCanonicalCoreSnapshots\[0\]\|\|null/);
  assert.doesNotMatch(applySource,/archivedIntradayCoreSnapshots\s*=\s*\[\]/);
  console.log("D PASS: cancellation is non-destructive and archived data is never promoted to LIVE");
})().catch(error=>{console.error(error);process.exitCode=1});
