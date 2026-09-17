"use strict";

const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const diagnostics=require("../frontend-live-diagnostics.js"),adapter=require("../hs-live-source-adapter.js");
const root=path.resolve(__dirname,".."),html=fs.readFileSync(path.join(root,"index.html"),"utf8"),buildInfo=fs.readFileSync(path.join(root,"build-info.json"),"utf8");
const symbols=["0050","00662","00757","00830","00935"],date="2026-09-17",scoreVersion="FINAL_CORE_WEIGHT_V1";
function payload(time="09:15:30"){
  const tickers=Object.fromEntries(symbols.map((symbol,index)=>[symbol,{score:40+index,display_score:40+index,delta_vs_official:0,quote_as_of:`${date}T${time}+08:00`,freshness:"FRESH",quote_source:"MIS_Z",status:"AVAILABLE"}]));
  tickers["009815"]={score:null,display_score:null,delta_vs_official:null,quote_as_of:null,freshness:"WAIT_NATIVE",quote_source:null,status:"WAIT_NATIVE"};
  return{status:"AVAILABLE",market_state:"OPEN",trading_date:date,as_of:`${date}T${time}+08:00`,calculated_at:`${date}T${time}+08:00`,completeness:"5/5",c4_version:scoreVersion,tickers};
}

const live=adapter.railwayToCanonical(payload(),{targetDate:date,scoreVersion,symbols,now:new Date(`${date}T09:16:00+08:00`)});
assert.equal(live.status,"AVAILABLE");assert.equal(live.snapshots.length,1);
let coordinator=diagnostics.createRequestCoordinator(),first=coordinator.begin();
assert.equal(coordinator.canApply(first,live.snapshots,live.status),true);coordinator.applied(first,live.snapshots);
assert.equal(diagnostics.classifyRenderState({marketState:"OPEN",sourceStatus:"AVAILABLE",liveSnapshotCount:1,selectedSnapshotTime:diagnostics.latestSnapshotTime(live.snapshots),freshnessCheck:"ACCEPTED"}),"LIVE_ACTIVE");
console.log("TEST 1 PASS: API live snapshot updates monotonic state and renders LIVE_ACTIVE");

coordinator=diagnostics.createRequestCoordinator();const oldRequest=coordinator.begin(),newRequest=coordinator.begin();
const newer=adapter.railwayToCanonical(payload("09:20:00"),{targetDate:date,scoreVersion,symbols,now:new Date(`${date}T09:20:10+08:00`)});
assert.equal(coordinator.canApply(newRequest,newer.snapshots,"AVAILABLE"),true);coordinator.applied(newRequest,newer.snapshots);
assert.equal(coordinator.canApply(oldRequest,live.snapshots,"AVAILABLE"),false);
console.log("TEST 2 PASS: late older request cannot overwrite newer live state");

assert.notEqual(diagnostics.classifyRenderState({marketState:"OPEN",sourceStatus:"AVAILABLE",liveSnapshotCount:1,selectedSnapshotTime:diagnostics.latestSnapshotTime(live.snapshots),freshnessCheck:"ACCEPTED"}),"BACKEND_NO_SNAPSHOT");
console.log("TEST 3 PASS: accepted live snapshot cannot render not-started");

assert.equal(diagnostics.classifyRenderState({marketState:"OPEN",pending:true,sourceStatus:"AVAILABLE",liveSnapshotCount:1,selectedSnapshotTime:null}),"FRONTEND_STATE_PENDING");
assert.equal(diagnostics.messageFor("FRONTEND_STATE_PENDING"),"盤中資料同步中");
console.log("TEST 4 PASS: pending source selection has an explicit synchronization state");

assert.match(html,/<meta name="hs-live-source" content="railway"/);assert.match(html,/selectedSource\(\)==="railway"/);
assert.doesNotMatch(html,/loadRailway[\s\S]{0,700}latestCanonicalCoreSnapshot/);
console.log("TEST 5 PASS: Railway remains the sole OPEN live source without sticky artifact fallback");

assert.equal(diagnostics.classifyRenderState({marketState:"CLOSED",sourceStatus:"UNAVAILABLE",liveSnapshotCount:0}),"MARKET_CLOSED");
assert.match(html,/archivedIntradayCoreSnapshots/);assert.match(html,/homeC4PreviousSessionSummary/);
console.log("TEST 6 PASS: MARKET_CLOSED preserves archived intraday presentation");

assert.match(html,/visibilitychange[\s\S]*refreshLiveQuotes\(\{force:true\}\)/);
console.log("TEST 7 PASS: foreground recovery immediately refreshes live API");

assert.match(html,/addEventListener\("online"[\s\S]*refreshLiveQuotes\(\{force:true\}\)/);
console.log("TEST 8 PASS: network recovery immediately refreshes live API");

assert.match(html,/fetch\(url,\{cache:"no-store"/);assert.doesNotMatch(html,/serviceWorker\.register|caches\.open|cache-first/i);
console.log("TEST 9 PASS: live requests bypass HTTP cache and no service worker intercept exists");

assert.match(html,/hs-app-build-sha/);assert.match(html,/hs-frontend-bundle-version/);assert.match(html,/backend_build_sha:"NOT_EXPOSED"/);assert.match(html,/debugLive/);assert.match(html,/LIVE DIAGNOSTICS/);
console.log("TEST 10 PASS: diagnostic mode exposes build and source evidence");

const telemetry=diagnostics.createTelemetry({clock:()=>new Date("2026-09-17T01:15:00Z")});
let event=telemetry.record("state",{api_live_snapshot_count:1,store_live_snapshot_count:0}).current;
assert.equal(event.anomaly,"FRONTEND_STATE_NOT_UPDATED");
event=telemetry.record("state",{store_live_snapshot_count:1,selected_snapshot_time:null}).current;
assert.equal(event.anomaly,"SOURCE_SELECTION_FAILED");
assert.doesNotMatch(diagnostics.sanitizeError("token=secret https://example.test/key"),/secret|example\.test/);
console.log("ANOMALY PASS: state gaps and sanitized errors are diagnosable without secrets");

assert.equal(diagnostics.normalizeBuildSha("{{ site.github.build_revision }}"),"LOCAL");
assert.equal(diagnostics.normalizeBuildSha("ABCDEF0123456789ABCDEF0123456789ABCDEF01"),"abcdef0123456789abcdef0123456789abcdef01");
assert.doesNotMatch(html,/\{\{|site\.github|github\.sha/);
assert.match(buildInfo,/site\.github\.build_revision/);
console.log("BUILD SHA PASS: runtime metadata resolves exact SHA and raw template text cannot leak into the page");

const archives=[];
for(let index=0;index<53;index+=1) archives.push({trading_date:date,status:"SUCCESS",market_as_of:`${date}T09:${String(index%60).padStart(2,"0")}:00+08:00`});
for(let index=0;index<57;index+=1) archives.push({trading_date:"2026-09-16",status:"SUCCESS",market_as_of:`2026-09-16T09:${String(index%60).padStart(2,"0")}:00+08:00`});
const archive=diagnostics.archiveSummary(archives,date);
assert.equal(archive.total,110);assert.equal(archive.today,53);assert.equal(archive.archive_date,date);
assert.equal(diagnostics.diagnosticMarketState("CLOSED"),"MARKET_CLOSED");
assert.equal(diagnostics.diagnosticRenderState({marketState:"CLOSED",liveSnapshotCount:0,archivedTodaySnapshotCount:archive.today,baseState:"MARKET_CLOSED"}),"FINAL_WITH_ARCHIVED_INTRADAY");
const nextDay=diagnostics.archiveSummary(archives,"2026-09-18");
assert.equal(nextDay.total,110);assert.equal(nextDay.today,0);
assert.equal(diagnostics.diagnosticRenderState({marketState:"CLOSED",liveSnapshotCount:0,archivedTodaySnapshotCount:nextDay.today,baseState:"MARKET_CLOSED"}),"FINAL_ONLY_MARKET_CLOSED");
assert.doesNotMatch(diagnostics.archiveSummary.toString(),/2026-09-17|\b53\b/);
console.log("ARCHIVE PASS: MARKET_CLOSED remains market state while render state and dynamic today/total counts stay distinct");
