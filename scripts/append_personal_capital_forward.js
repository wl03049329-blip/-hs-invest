#!/usr/bin/env node
"use strict";

/*
 * PERSONAL_CAPITAL_FORWARD_V1 is a manual, prospective-only research ledger.
 * The producer accepts already-produced Personal Capital input + policy state;
 * it must never calculate a score, portfolio value, target, or capital action.
 */
const crypto=require("node:crypto");
const fs=require("node:fs");
const path=require("node:path");

const VERSION="PERSONAL_CAPITAL_FORWARD_V1";
const INPUT_VERSION="PERSONAL_CAPITAL_INPUT_V1";
const POLICY_VERSION="PERSONAL_CAPITAL_POLICY_V1";
const MODE="FORMAL_ONLY";
const ELIGIBLE_SYMBOLS=Object.freeze(["0050","00662","00830","00935","009815"]);
const EXCLUDED_SYMBOLS=Object.freeze(["00631L","006201","00733","00757"]);
const DATE_RE=/^\d{4}-\d{2}-\d{2}$/;
const OUTCOME_FIELD_RE=/(?:return|outcome|win|loss|mae|mfe)/i;
function stable(value){if(Array.isArray(value))return value.map(stable);if(value&&typeof value==="object")return Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])]));return value;}
function canonicalJson(value){return JSON.stringify(stable(value));}
function sha256(value){return crypto.createHash("sha256").update(typeof value==="string"?value:canonicalJson(value)).digest("hex");}
function withoutHashes(record){const {previousHash,recordHash,...rest}=record;return rest;}
function recordHash(record){return sha256({...withoutHashes(record),previousHash:record.previousHash||null});}
function validDate(value){return DATE_RE.test(String(value||""));}
function unique(values){return[...new Set(values.filter(Boolean))];}
function assertTimestamp(value,label){if(!value||!Number.isFinite(Date.parse(value)))throw Error(`${label}_INVALID`);}
function defaultLedger(forwardStartAt){return{version:VERSION,forwardStartAt,observationMode:MODE,records:[]};}
function readLedger(ledgerPath){
  if(!fs.existsSync(ledgerPath))throw Error("LEDGER_MISSING");
  let ledger;try{ledger=JSON.parse(fs.readFileSync(ledgerPath,"utf8"));}catch{throw Error("LEDGER_INVALID_JSON");}
  if(!ledger||ledger.version!==VERSION||ledger.observationMode!==MODE||!Array.isArray(ledger.records)||!ledger.forwardStartAt)throw Error("LEDGER_SCHEMA_INVALID");
  assertTimestamp(ledger.forwardStartAt,"LEDGER_FORWARD_START_AT");return ledger;
}
function verifyChain(records){
  let prior=null;
  for(const [index,record] of records.entries()){
    if(record?.version!==VERSION||record?.previousHash!==prior||record?.recordHash!==recordHash(record))throw Error(`LEDGER_CHAIN_INVALID:${index+1}`);
    prior=record.recordHash;
  }
  return prior;
}
function containsOutcomeFields(value){
  if(Array.isArray(value))return value.some(containsOutcomeFields);
  if(value&&typeof value==="object")return Object.entries(value).some(([key,item])=>OUTCOME_FIELD_RE.test(key)||containsOutcomeFields(item));
  return false;
}
function naturalKey(record){return`${record.tradingDate}:${record.symbol}:${record.market?.decisionMode||record.asOf?.decisionMode||"FORMAL"}:${record.asOf?.radarDate||""}`;}
function observationId({tradingDate,symbol,radarDate}){return`PCFV1:${tradingDate}:${symbol}:FORMAL:${radarDate}`;}
function buildRecord(draft,forwardStartAt){
  const normalized=draft?.normalizedInput,policy=draft?.policyResult;
  if(!normalized||normalized.version!==INPUT_VERSION||!policy||policy.version!==POLICY_VERSION)throw Error("CANONICAL_STATE_REQUIRED");
  const symbol=String(normalized.symbol||"").trim().toUpperCase();
  if(!ELIGIBLE_SYMBOLS.includes(symbol))throw Error("SYMBOL_OUT_OF_SCOPE");
  const decisionMode=String(normalized.asOf?.decisionMode||normalized.radar?.decisionMode||"");
  if(decisionMode!=="FORMAL")return{status:"SKIPPED_INTRADAY",symbol};
  const observedAt=String(draft.observedAt||"");assertTimestamp(observedAt,"OBSERVED_AT");
  const canonicalAsOfAt=String(normalized.asOf?.canonicalAsOfAt||normalized.asOf?.observedAt||"");
  if(!canonicalAsOfAt)throw Error("CANONICAL_ASOF_TIMESTAMP_REQUIRED");
  assertTimestamp(canonicalAsOfAt,"CANONICAL_ASOF_TIMESTAMP");
  if(Date.parse(canonicalAsOfAt)<Date.parse(forwardStartAt)||Date.parse(observedAt)<Date.parse(forwardStartAt))throw Error("OBSERVATION_BEFORE_FORWARD_START");
  const tradingDate=String(draft.tradingDate||normalized.asOf?.radarDate||"");
  const ready=normalized.eligibility==="READY"&&policy.status==="READY";
  if(!validDate(tradingDate)||ready&&tradingDate!==normalized.asOf?.radarDate)throw Error("TRADING_DATE_INVALID");
  const reasons=unique([...(Array.isArray(normalized.reasons)?normalized.reasons:[]),...(Array.isArray(policy.rationaleCodes)?policy.rationaleCodes:[])]);
  const base={version:VERSION,observationId:observationId({tradingDate,symbol,radarDate:normalized.asOf.radarDate}),observedAt,tradingDate,symbol,inputVersion:INPUT_VERSION,policyVersion:POLICY_VERSION,eligibility:ready?"READY":"DATA_UNAVAILABLE",rationaleCodes:reasons,asOf:{portfolioDate:normalized.asOf?.portfolioDate||"",radarDate:normalized.asOf?.radarDate||"",decisionMode:"FORMAL",canonicalAsOfAt},freshness:{portfolio:normalized.freshness?.portfolio||"MISSING",radar:normalized.freshness?.radar||"MISSING",sourceConflict:Boolean(normalized.freshness?.sourceConflict)},status:ready?"READY":"DATA_UNAVAILABLE"};
  if(ready){
    if(!policy.allocation||!policy.market||!policy.action)throw Error("POLICY_STATE_INCOMPLETE");
    return{...base,allocation:{actualWeightPct:policy.allocation.actualWeightPct,targetAllocationPct:policy.allocation.targetAllocationPct,gapPct:policy.allocation.gapPct,state:policy.allocation.state},market:{score:policy.market.score,stage:policy.market.stage||null,scoreBucket:policy.market.scoreBucket,decisionMode:"FORMAL"},action:policy.action};
  }
  return base;
}
function atomicWrite(ledgerPath,ledger){
  const directory=path.dirname(ledgerPath),temporary=path.join(directory,`.${path.basename(ledgerPath)}.${process.pid}.${Date.now()}.tmp`);
  fs.mkdirSync(directory,{recursive:true});
  try{fs.writeFileSync(temporary,`${canonicalJson(ledger)}\n`,"utf8");fs.renameSync(temporary,ledgerPath);}finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
}
function appendObservations(ledgerPath,payload){
  const ledger=readLedger(ledgerPath),tail=verifyChain(ledger.records),drafts=Array.isArray(payload?.observations)?payload.observations:[];
  if(!drafts.length)throw Error("OBSERVATIONS_REQUIRED");
  if(containsOutcomeFields(payload))throw Error("OUTCOME_FIELDS_FORBIDDEN");
  const results=[],nextRecords=[...ledger.records];let nextHash=tail;
  for(const supplied of drafts){
    const recordResult=buildRecord({...supplied,observedAt:supplied.observedAt||payload.observedAt,tradingDate:supplied.tradingDate||payload.tradingDate},ledger.forwardStartAt);
    if(recordResult.status==="SKIPPED_INTRADAY"){results.push(recordResult);continue;}
    const candidate=recordResult,key=naturalKey(candidate),existing=nextRecords.find(row=>naturalKey(row)===key);
    if(existing){if(canonicalJson(withoutHashes(existing))===canonicalJson(withoutHashes(candidate)))results.push({status:"NOOP_IDENTICAL",record:existing});else throw Error(`OBSERVATION_CONFLICT:${key}`);continue;}
    const record={...candidate,previousHash:nextHash,recordHash:null};record.recordHash=recordHash(record);nextHash=record.recordHash;nextRecords.push(record);results.push({status:"APPENDED",record});
  }
  if(results.some(result=>result.status==="APPENDED"))atomicWrite(ledgerPath,{...ledger,records:nextRecords});
  return{results,appended:results.filter(result=>result.status==="APPENDED").length,skipped:results.filter(result=>result.status==="SKIPPED_INTRADAY").length};
}
function cli(){const args=process.argv.slice(2),value=flag=>{const i=args.indexOf(flag);return i<0?null:args[i+1];},ledgerPath=value("--ledger"),inputPath=value("--input");if(!ledgerPath||!inputPath)throw Error("USAGE: --ledger <personal-capital-forward-observations-v1.json> --input <canonical-state.json>");process.stdout.write(`${JSON.stringify(appendObservations(ledgerPath,JSON.parse(fs.readFileSync(inputPath,"utf8"))))}\n`);}
if(require.main===module)cli();
module.exports={VERSION,INPUT_VERSION,POLICY_VERSION,MODE,ELIGIBLE_SYMBOLS,EXCLUDED_SYMBOLS,canonicalJson,sha256,recordHash,defaultLedger,readLedger,verifyChain,buildRecord,appendObservations,observationId,naturalKey,atomicWrite};
