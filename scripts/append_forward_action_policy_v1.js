#!/usr/bin/env node
"use strict";

/*
 * FORWARD_ACTION_POLICY_V1 research-sidecar ledger.
 * This module has no production imports or writes. Callers supply frozen
 * as-of inputs; the CLI only appends an already-built record to a chosen JSONL.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const finalCore = require("../backtest/long-term/final-core-score-v1.js");

const RESEARCH_VERSION = "FORWARD_ACTION_POLICY_V1";
const CORE_VERSION = finalCore.VERSION;
const SIGNAL_TIMING = "CLOSE_SIGNAL_13:30_ASIA_TAIPEI";
const TIERS = Object.freeze([65, 70, 80, 90]);
const LEDGERS = Object.freeze({
  CANDIDATE: Object.freeze({allocations:[.15,.15,.20,.20], reserve:.30}),
  BASELINE: Object.freeze({allocations:[.20,.20,.20,.20], reserve:.20})
});
const RECORD_TYPES = new Set(["DAILY_SIGNAL", "EXECUTION_REFERENCE", "EPISODE_CLOSE", "EVALUATION", "CORRECTION"]);

function isFiniteScore(value){ return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100; }
function isDate(value){ return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")); }
function stable(value){
  if(Array.isArray(value)) return value.map(stable);
  if(value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key,stable(value[key])]));
  return value;
}
function canonicalJson(value){ return JSON.stringify(stable(value)); }
function sha256(value){ return crypto.createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex"); }
function withoutHashes(record){ const {previous_record_hash,current_record_hash,...business} = record; return business; }
function recordHash(record){ return sha256({...withoutHashes(record),previous_record_hash:record.previous_record_hash || null}); }
function readLedger(ledgerPath){
  if(!fs.existsSync(ledgerPath)) return [];
  return fs.readFileSync(ledgerPath,"utf8").split(/\r?\n/).filter(Boolean).map((line,index) => {
    try { return JSON.parse(line); } catch { throw Error(`LEDGER_INVALID_JSON:${index + 1}`); }
  });
}
function verifyChain(records){
  let previous = null;
  for(const [index,record] of records.entries()){
    if(!RECORD_TYPES.has(record.record_type)) throw Error(`LEDGER_RECORD_TYPE_INVALID:${index + 1}`);
    if(record.previous_record_hash !== previous) throw Error(`LEDGER_PREVIOUS_HASH_MISMATCH:${index + 1}`);
    if(record.current_record_hash !== recordHash(record)) throw Error(`LEDGER_HASH_MISMATCH:${index + 1}`);
    previous = record.current_record_hash;
  }
  return previous;
}
function appendRecord(ledgerPath,draft){
  const records = readLedger(ledgerPath), tail = verifyChain(records);
  if(!RECORD_TYPES.has(draft.record_type)) throw Error("RECORD_TYPE_INVALID");
  if(typeof draft.record_id !== "string" || !draft.record_id) throw Error("RECORD_ID_REQUIRED");
  const existing = records.find(record => record.record_id === draft.record_id);
  if(existing){
    if(canonicalJson(withoutHashes(existing)) === canonicalJson(withoutHashes(draft))) return {status:"NOOP_IDENTICAL",record:existing};
    throw Error(`RECORD_ID_CONFLICT:${draft.record_id}`);
  }
  const record = {...draft,previous_record_hash:tail,current_record_hash:null};
  record.current_record_hash = recordHash(record);
  fs.mkdirSync(path.dirname(ledgerPath),{recursive:true});
  fs.appendFileSync(ledgerPath,`${canonicalJson(record)}\n`,"utf8");
  return {status:"APPENDED",record};
}
function episodeId(etf,highDate){
  if(!etf || !isDate(highDate)) throw Error("EPISODE_ID_INPUT_INVALID");
  return `FAPV1:EPISODE:${etf}:${highDate}`;
}
function dailySignalId(etf,date){ return `FAPV1:DAILY_SIGNAL:${etf}:${date}:${CORE_VERSION}:SHARED`; }
function executionReferenceId(etf,signalDate,executionDate){ return `FAPV1:EXECUTION_REFERENCE:${etf}:${signalDate}:${executionDate}:ADJUSTED_OPEN`; }
function episodeCloseId(etf,id){ return `FAPV1:EPISODE_CLOSE:${etf}:${id}`; }
function evaluationId(etf,id,policy){ return `FAPV1:EVALUATION:${etf}:${id}:${policy}`; }
function replayTierState(records,etf,currentEpisodeId,ledgerName){
  const fired = new Set();
  for(const record of records){
    if(record.record_type !== "DAILY_SIGNAL" || record.etf !== etf || record.episode?.episode_id !== currentEpisodeId) continue;
    const tier = record.virtual_ledgers?.[ledgerName]?.newly_crossed_tier;
    if(Number.isInteger(tier) && tier >= 1 && tier <= TIERS.length) fired.add(tier);
  }
  return fired;
}
function nextDecision(coreScore,fired,ledger){
  if(!isFiniteScore(coreScore)) return {newly_crossed_tier:null,virtual_allocation:0,cumulative_allocation:0,remaining_cash:1,action_status:"NO_ACTION_CORE_UNAVAILABLE"};
  const tierIndex = TIERS.findIndex((threshold,index) => coreScore >= threshold && !fired.has(index + 1));
  const allocation = tierIndex < 0 ? 0 : ledger.allocations[tierIndex];
  const cumulative = [...fired].reduce((sum,tier) => sum + ledger.allocations[tier - 1],0) + allocation;
  return {newly_crossed_tier:tierIndex < 0 ? null : tierIndex + 1,virtual_allocation:allocation,cumulative_allocation:cumulative,remaining_cash:1-cumulative,action_status:tierIndex < 0 ? "NO_NEW_TIER" : "VIRTUAL_ACTION"};
}
function buildDailySignal(input,existingRecords=[]){
  const {etf,trading_date,appended_at,source_date,data_quality="PASS",mapping_version="FROZEN_PRODUCTION_FACTOR_MAPPING_V1",source={},dataset={}} = input;
  if(!etf || !isDate(trading_date) || !appended_at || !isDate(source_date)) throw Error("DAILY_SIGNAL_IDENTITY_INVALID");
  const factors = input.factors || {}, weeklyJ = factors.weekly_j || {}, dd52 = factors.dd52 || {}, crash = factors.crash || {};
  const canonical=input.canonical_snapshot||{};
  const canonicalValid=typeof canonical.data_branch_commit==="string" && /^[0-9a-f]{40}$/.test(canonical.data_branch_commit) && canonical.snapshot_date===trading_date && typeof canonical.snapshot_path==="string" && /^research\/forward-action-policy-data\/snapshots\/\d{4}-\d{2}-\d{2}\/$/.test(canonical.snapshot_path) && [canonical.dataset_sha256,canonical.manifest_sha256,canonical.producer_sha256].every(value=>typeof value==="string"&&/^[0-9a-f]{64}$/.test(value));
  const valid = canonicalValid && source_date === trading_date && data_quality === "PASS" && isFiniteScore(weeklyJ.mapped_component) && isFiniteScore(dd52.mapped_component) && isFiniteScore(crash.mapped_component);
  const internalCore = valid ? finalCore.calculateFinalCoreScoreV1(weeklyJ.mapped_component,dd52.mapped_component,crash.mapped_component) : null;
  const highDate = input.episode?.asof_52w_high_date;
  const id = episodeId(etf,highDate);
  const candidateState = replayTierState(existingRecords,etf,id,"candidate");
  const baselineState = replayTierState(existingRecords,etf,id,"baseline");
  const candidate = nextDecision(internalCore,candidateState,LEDGERS.CANDIDATE);
  const baseline = nextDecision(internalCore,baselineState,LEDGERS.BASELINE);
  const contribution = (score,weight) => isFiniteScore(score) ? score * weight / 100 : null;
  const provenance = {
    source_date,
    adjusted_ohlc_snapshot_revision: dataset.adjusted_ohlc_snapshot_revision || dataset.revision || null,
    adjusted_ohlc_snapshot_hash: dataset.adjusted_ohlc_snapshot_hash || source.adjusted_ohlc_snapshot_hash || source.source_snapshot_hash || null
  };
  return {
    record_id:dailySignalId(etf,trading_date),record_type:"DAILY_SIGNAL",research_version:RESEARCH_VERSION,core_version:CORE_VERSION,mapping_version,
    etf,trading_date,appended_at,signal_timing:SIGNAL_TIMING,source:{...source,source_date},dataset,canonical_snapshot:canonical,provenance,
    factors:{weekly_j:{...weeklyJ,weighted_contribution:contribution(weeklyJ.mapped_component,30)},dd52:{...dd52,weighted_contribution:contribution(dd52.mapped_component,55)},crash:{...crash,weighted_contribution:contribution(crash.mapped_component,15)},adjusted_ohlc:input.adjusted_ohlc || null},
    core:{internal_score:internalCore,display_score:finalCore.displayFinalCoreScoreV1(internalCore),core_valid:internalCore !== null,validity:internalCore === null ? "NO_ACTION_CORE_UNAVAILABLE" : "AVAILABLE"},
    episode:{episode_id:id,status:"PROVISIONAL",asof_52w_high_date:highDate,new_asof_52w_high:Boolean(input.episode?.new_asof_52w_high),prior_tier_state:{candidate:[...candidateState].sort(),baseline:[...baselineState].sort()}},
    virtual_ledgers:{candidate,baseline}
  };
}
function buildExecutionReference(input){
  const {etf,signal_record_id,signal_date,execution_date,adjusted_open,appended_at,source={}} = input;
  if(!etf || !signal_record_id || !isDate(signal_date) || !isDate(execution_date) || execution_date <= signal_date || !(typeof adjusted_open === "number" && Number.isFinite(adjusted_open) && adjusted_open > 0) || !appended_at) throw Error("EXECUTION_REFERENCE_INVALID");
  return {record_id:executionReferenceId(etf,signal_date,execution_date),record_type:"EXECUTION_REFERENCE",research_version:RESEARCH_VERSION,etf,signal_record_id,signal_date,execution_date,adjusted_open,appended_at,source};
}
function buildEpisodeClose(input,existingRecords=[]){
  const {etf,episode_id,closed_on,appended_at,reason="NEW_52W_HIGH",source={}} = input;
  if(!etf || !episode_id || !isDate(closed_on) || !appended_at) throw Error("EPISODE_CLOSE_INVALID");
  const signals = existingRecords.filter(record => record.record_type === "DAILY_SIGNAL" && record.etf === etf && record.episode?.episode_id === episode_id);
  if(!signals.length) throw Error("EPISODE_CLOSE_NO_SIGNALS");
  const tierDates = Object.fromEntries(["candidate","baseline"].map(name => [name,Object.fromEntries(TIERS.map((_,index) => {
    const record = signals.find(signal => signal.virtual_ledgers?.[name]?.newly_crossed_tier === index + 1);
    return [`tier_${index + 1}`,record?.trading_date || null];
  }))]));
  const tier4Date = tierDates.candidate.tier_4;
  const tier1Date = tierDates.candidate.tier_1;
  const elapsedDays = tier1Date && tier4Date ? Math.round((Date.parse(`${tier4Date}T00:00:00Z`) - Date.parse(`${tier1Date}T00:00:00Z`)) / 86400000) : null;
  return {record_id:episodeCloseId(etf,episode_id),record_type:"EPISODE_CLOSE",research_version:RESEARCH_VERSION,etf,episode_id,closed_on,appended_at,reason,source,
    first_tier_dates:tierDates,classification:tier4Date ? (elapsedDays >= 21 ? "DELAYED_EXTREME" : "FAST_OR_NORMAL_ESCALATION") : "NO_90",days_tier_1_to_tier_4:elapsedDays};
}
function buildEvaluation(input){
  const {etf,episode_id,policy,appended_at} = input;
  if(!etf || !episode_id || !["CANDIDATE","BASELINE"].includes(policy) || !appended_at) throw Error("EVALUATION_INVALID");
  return {record_id:evaluationId(etf,episode_id,policy),record_type:"EVALUATION",research_version:RESEARCH_VERSION,etf,episode_id,policy,appended_at,
    inputs:input.inputs || {},metrics:input.metrics || {},provenance:input.provenance || {}};
}
function buildCorrection(input){
  if(!input.original_record_id || !input.reason || !input.corrected_at) throw Error("CORRECTION_INVALID");
  const payloadHash = sha256({original_record_id:input.original_record_id,previous_value:input.previous_value,corrected_value:input.corrected_value,reason:input.reason,provenance:input.provenance});
  return {record_id:`FAPV1:CORRECTION:${input.original_record_id}:${payloadHash}`,record_type:"CORRECTION",research_version:RESEARCH_VERSION,correction_id:`FAPV1:CORRECTION:${input.original_record_id}:${payloadHash}`,correction_payload_hash:payloadHash,...input};
}
function cli(){
  const args = process.argv.slice(2); if(!args.length) return;
  const value = flag => { const i=args.indexOf(flag); return i < 0 ? null : args[i+1]; };
  const ledgerPath=value("--ledger"),recordPath=value("--input"),dailyInputPath=value("--daily-input");
  if(!ledgerPath || (!recordPath && !dailyInputPath) || (recordPath && dailyInputPath)) throw Error("USAGE: --ledger <jsonl> (--input <record.json> | --daily-input <asof-feature-input.json>)");
  const draft = dailyInputPath
    ? buildDailySignal(JSON.parse(fs.readFileSync(dailyInputPath,"utf8")),readLedger(ledgerPath))
    : JSON.parse(fs.readFileSync(recordPath,"utf8"));
  process.stdout.write(`${JSON.stringify(appendRecord(ledgerPath,draft))}\n`);
}
if(require.main === module) cli();
module.exports={RESEARCH_VERSION,CORE_VERSION,SIGNAL_TIMING,TIERS,LEDGERS,canonicalJson,sha256,recordHash,readLedger,verifyChain,appendRecord,episodeId,dailySignalId,executionReferenceId,episodeCloseId,evaluationId,replayTierState,buildDailySignal,buildExecutionReference,buildEpisodeClose,buildEvaluation,buildCorrection};
