"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const engine = require("../scripts/build_c4_historical_outcomes.js");

const ROOT = path.resolve(__dirname, "..");
const hashFile = file => crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, file))).digest("hex");

// Core statistics: zero is not positive; odd/even median and interpolated quartiles are deterministic.
let stats = engine.statistics([{forward_5d:.10}, {forward_5d:0}, {forward_5d:-.05}], 5);
assert.equal(stats.sample_count, 3); assert.equal(stats.positive_rate, 1 / 3);
assert.equal(stats.median_return, 0); assert.equal(stats.best_return, .10); assert.equal(stats.worst_return, -.05);
assert.equal(stats.p25, -.025); assert.equal(stats.p75, .05);
stats = engine.statistics([{forward_5d:1}, {forward_5d:3}, {forward_5d:2}, {forward_5d:4}], 5);
assert.equal(stats.median_return, 2.5);

// Level and DD52 boundaries reuse the production decision-layer source of truth.
assert.equal(engine.stageFor(39).stage, "GENERAL");
assert.equal(engine.stageFor(40).stage, "PULLBACK_WATCH");
assert.equal(engine.stageFor(49).stage, "PULLBACK_WATCH");
assert.equal(engine.stageFor(50).stage, "SMALL_ADD");
assert.equal(engine.stageFor(65).stage, "FORMAL_SCALE_IN");
assert.equal(engine.stageFor(70).stage, "DEEP_PULLBACK_ADD");
assert.equal(engine.stageFor(80).stage, "RARE_OPPORTUNITY");
assert.equal(engine.stageFor(90).stage, "EXTREME_REFERENCE");
for (const [value, id] of [[0,"DD52_0_TO_NEG5"],[-5,"DD52_NEG5_TO_NEG10"],[-10,"DD52_NEG10_TO_NEG15"],[-15,"DD52_NEG15_TO_NEG20"],[-20,"DD52_NEG20_TO_NEG25"],[-25,"DD52_NEG25_TO_NEG30"],[-30,"DD52_NEG30_OR_DEEPER"]]) assert.equal(engine.dd52Band(value).id, id);

const sample = (date, score, extra = {}) => ({etf:"X", date, event_type:"LEVEL_DAILY",
  level:engine.stageFor(score).stage, level_label:engine.stageFor(score).label, display_score:score,
  raw_total:score+.25, dd52:-10, weekly_j:30, crash:-2, dd52_band:"DD52_NEG10_TO_NEG15",
  adjusted_close:100, mature_5d:true, forward_5d:.01, mature_20d:true, forward_20d:.02,
  mature_40d:true, forward_40d:.03, mature_60d:true, forward_60d:.04, ...extra});
let samples = [sample("2026-01-01",38),sample("2026-01-02",42),sample("2026-01-03",45),sample("2026-01-04",48),sample("2026-01-05",51)];
let events = engine.entryEvents(samples);
assert.deepEqual(events.map(row=>[row.date,row.from_level,row.to_level]),[
  ["2026-01-02","GENERAL","PULLBACK_WATCH"],["2026-01-05","PULLBACK_WATCH","SMALL_ADD"]]);

// A multi-level jump creates one final-level event while recording every crossed threshold.
samples = [sample("2026-02-01",48), sample("2026-02-02",67)];
events = engine.entryEvents(samples);
assert.equal(events.length,1); assert.equal(events[0].to_level,"FORMAL_SCALE_IN");
assert.deepEqual(events[0].crossed_thresholds,[50,65]);

// NON_OVERLAP_60D is condition-specific and keeps ENTRY_ALL separately.
const dates = Array.from({length:130},(_,index)=>`D${String(index).padStart(3,"0")}`);
const eventAt = index => ({...sample(dates[index],42),date:dates[index],to_level:"PULLBACK_WATCH"});
const allEvents=[eventAt(0),eventAt(30),eventAt(60),eventAt(119),eventAt(120)];
assert.deepEqual(engine.nonOverlap60(allEvents,dates).map(row=>row.date),[dates[0],dates[60],dates[120]]);

// Trading-session horizons and independent maturity guards.
const priceRows=Array.from({length:65},(_,index)=>({date:`D${String(index).padStart(3,"0")}`,close:100+index}));
let outcome=engine.outcomeFields(60,priceRows); assert.equal(outcome.mature_5d,false);
outcome=engine.outcomeFields(45,priceRows); assert.equal(outcome.mature_20d,false); assert.equal(outcome.mature_5d,true);
outcome=engine.outcomeFields(25,priceRows); assert.equal(outcome.mature_40d,false); assert.equal(outcome.mature_20d,true);
outcome=engine.outcomeFields(5,priceRows); assert.equal(outcome.mature_60d,false); assert.equal(outcome.mature_40d,true);
outcome=engine.outcomeFields(4,priceRows); assert.equal(outcome.mature_60d,true); assert.equal(outcome.forward_60d,164/104-1);

// Full adjusted/restored convention is applied to the outcome price series.
const adjusted=engine.adjustedPrices({source_version:"FINMIND_AS_OF_ADJUSTED_OHLC_V1",provider:"fixture",symbol:"0050",
  price:[{date:"2026-01-01",open:100,max:100,min:100,close:100,Trading_Volume:1},{date:"2026-01-02",open:90,max:90,min:90,close:90,Trading_Volume:1}],
  dividend:[{date:"2026-01-02",before_price:100,reference_price:90,type:"除息"}],split:[]},"0050");
assert.equal(adjusted[0].close,90); assert.equal(adjusted[1].close,90);

// Threshold and DD52 aggregates preserve daily overlapping samples and do not discard outliers.
samples=[sample("2026-03-01",39),sample("2026-03-02",40),sample("2026-03-03",50,{dd52_band:"DD52_NEG20_TO_NEG25"}),sample("2026-03-04",90,{forward_5d:5})];
const summary=engine.summaryBody(samples,engine.entryEvents(samples),engine.nonOverlap60(engine.entryEvents(samples),samples.map(row=>row.date)));
assert.equal(summary.threshold_samples.SCORE_40_PLUS.total_records,3);
assert.equal(summary.threshold_samples.SCORE_50_PLUS.total_records,2);
assert.equal(summary.threshold_samples.SCORE_90_PLUS.total_records,1);
assert.equal(summary.threshold_samples.SCORE_90_PLUS.horizons["5d"].best_return,5);
assert.equal(summary.dd52_bands.DD52_NEG20_TO_NEG25.total_records,1);

// Real Phase 6.5B sources: integrity, hashes, per-ETF separation, outcomes and manual return checks.
const protectedFiles=["index.html","formal-black-gold.css","finalized-core-score-snapshots-v1.json",
  "forward-action-policy-v1.json","forward-shadow-v1.json","intraday-core-snapshots-v1.json",
  "final-core-production.js","hs-decision-layer-v1.js","leverage-v1-core.js"]
  .filter(file=>fs.existsSync(path.join(ROOT,file)));
const protectedBefore=Object.fromEntries(protectedFiles.map(file=>[file,hashFile(file)]));
const built=engine.buildAll({generatedAt:"2026-09-19T00:00:00.000Z",generationCommit:"TEST_COMMIT"});
assert.deepEqual([...built.artifacts.keys()],engine.SYMBOLS);
assert.equal(built.index.etfs.find(row=>row.etf==="009815").status,"HOLD");
assert.equal(built.index.etfs.find(row=>row.etf==="009815").reason,"WAIT_NATIVE_NO_RESEARCH_HISTORY");

for(const symbol of engine.SYMBOLS){
  const research=JSON.parse(fs.readFileSync(path.join(ROOT,"research","c4_historical",`${symbol}.json`),"utf8"));
  const source=JSON.parse(fs.readFileSync(path.join(ROOT,"research","c4_historical","source",`${symbol}.json`),"utf8"));
  const result=built.artifacts.get(symbol),rows=result.raw.daily_samples,entries=result.raw.level_entry_all;
  assert.equal(rows.length,research.metadata.record_count);
  assert.equal(result.summary.metadata.source_research_hash,research.artifact_sha256);
  assert.equal(result.summary.metadata.price_source_hash,engine.sha(source));
  assert.equal(result.summary.metadata.transaction_costs,"EXCLUDED");
  assert.equal(result.summary.metadata.horizon_unit,"TRADING_SESSION");
  assert.ok(entries.length>0); assert.ok(result.summary.counts.non_overlap_events<=entries.length);
  const adjustedRows=engine.adjustedPrices(source,symbol),byDate=new Map(adjustedRows.map((row,index)=>[row.date,index]));
  for(const entry of entries.filter(row=>row.mature_20d).slice(0,2)){
    const index=byDate.get(entry.date);
    assert.ok(Math.abs(entry.forward_5d-(adjustedRows[index+5].close/adjustedRows[index].close-1))<1e-12);
    assert.ok(Math.abs(entry.forward_20d-(adjustedRows[index+20].close/adjustedRows[index].close-1))<1e-12);
  }
  // Selection is condition-only: outcomes never alter level, band, or event membership.
  const changed=rows.map(row=>({...row,forward_5d:finiteOrZero(row.forward_5d)+99}));
  assert.deepEqual(engine.entryEvents(changed).map(row=>[row.date,row.to_level]),engine.entryEvents(rows).map(row=>[row.date,row.to_level]));
}
function finiteOrZero(value){return Number.isFinite(value)?value:0}

// Source hash mismatch and version mismatch fail closed.
const research0050=JSON.parse(fs.readFileSync(path.join(ROOT,"research","c4_historical","0050.json"),"utf8"));
const source0050=JSON.parse(fs.readFileSync(path.join(ROOT,"research","c4_historical","source","0050.json"),"utf8"));
assert.throws(()=>engine.validateInputs("0050",research0050,{...source0050,provider:"tampered"}),/SOURCE_HASH_MISMATCH/);
const wrongVersion=JSON.parse(JSON.stringify(research0050));wrongVersion.metadata.weekly_j_version="WEEKLY_J_TW_TRADING_WEEK_V2";
assert.throws(()=>engine.validateInputs("0050",wrongVersion,source0050),/VERSION_MISMATCH/);

// Deterministic content hashes exclude generated_at; full artifact hashes retain it for audit.
const again=engine.buildAll({generatedAt:"2027-01-01T00:00:00.000Z",generationCommit:"TEST_COMMIT"});
for(const symbol of engine.SYMBOLS){
  assert.equal(built.artifacts.get(symbol).raw.metadata.content_sha256,again.artifacts.get(symbol).raw.metadata.content_sha256);
  assert.equal(built.artifacts.get(symbol).summary.metadata.content_sha256,again.artifacts.get(symbol).summary.metadata.content_sha256);
  assert.notEqual(built.artifacts.get(symbol).raw.artifact_sha256,again.artifacts.get(symbol).raw.artifact_sha256);
}

assert.deepEqual(Object.fromEntries(protectedFiles.map(file=>[file,hashFile(file)])),protectedBefore);
assert.doesNotMatch(fs.readFileSync(path.join(ROOT,"index.html"),"utf8"),/c4_outcomes|RESEARCH_HISTORICAL_OUTCOME_V1/);
assert.doesNotMatch(fs.readFileSync(path.join(ROOT,"formal-black-gold.css"),"utf8"),/c4_outcomes|Historical Outcome/);

// Generated artifacts are self-verifying and keep raw/summary separate.
for(const file of ["index.json",...engine.SYMBOLS.flatMap(symbol=>[`raw/${symbol}.json`,`summary/${symbol}.json`])]){
  const artifactPath=path.join(ROOT,"research","c4_outcomes",file);
  if(!fs.existsSync(artifactPath))continue;
  const artifact=JSON.parse(fs.readFileSync(artifactPath,"utf8")),unsigned={...artifact};delete unsigned.artifact_sha256;
  assert.equal(artifact.artifact_sha256,engine.sha(unsigned),`${file} artifact hash`);
  const metadata={...artifact.metadata};delete metadata.generated_at;delete metadata.content_sha256;
  const body={...artifact};delete body.metadata;delete body.artifact_sha256;
  assert.equal(artifact.metadata.content_sha256,engine.sha({metadata,...body}),`${file} deterministic content hash`);
}
console.log("PASS Phase 7A Historical Outcome Research Engine: forward horizons, entry/daily/non-overlap, integrity, determinism and production isolation");
