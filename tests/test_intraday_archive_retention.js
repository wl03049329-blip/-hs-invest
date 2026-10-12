"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const core=require("../scripts/build_intraday_core_snapshots.js");
const publisher=require("../scripts/publish_railway_live_artifacts.js");
const archive=JSON.parse(fs.readFileSync("intraday-core-snapshots-v1.json","utf8"));
core.validateLedger(archive);
assert.ok(archive.snapshots.length>0&&archive.snapshots.length<=500);
const keys=archive.snapshots.map(s=>s.trading_date+" "+(s.market_as_of||s.slot));
assert.deepEqual(keys,[...keys].sort(),"rolling artifact is chronologically ordered");
const productionBytes=fs.readFileSync("intraday-core-snapshots-v1.json");
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"hs-archive-contract-"));
try{
  const files={quotes:path.join(tmp,"quotes.json"),meta:path.join(tmp,"meta.json"),scores:path.join(tmp,"scores.json")};
  fs.writeFileSync(files.quotes,JSON.stringify({version:2,items:[]}));
  fs.writeFileSync(files.meta,"{}");
  const last=archive.snapshots.at(-1);
  const next=new Date(last.trading_date+"T00:00:00Z");next.setUTCDate(next.getUTCDate()+1);
  const day=next.toISOString().slice(0,10),slot="09:05",stamp=day+"T09:05:00+08:00";
  const quotes=Object.fromEntries(core.SYMBOLS.map(code=>[code,{code,name:code,date:day,quote_time:"09:05:00",
    price:100,previous_close:99,open:99,high:101,low:98,volume:1000,market:"TWSE",quote_source:"MIS_Z"}]));
  const fingerprint=core.rawFingerprint({status:"SUCCESS",items:quotes},day,slot);
  const snapshot={schema_version:1,contract:core.SLOT_CONTRACT,snapshot_type:"INTRADAY_CORE",status:"SUCCESS",
    trading_date:day,slot,market_as_of:stamp,calculated_at:stamp,score_version:core.SCORE_VERSION,
    source_completeness:"5/5",source:{input_fingerprint:fingerprint},
    items:Object.fromEntries(core.SYMBOLS.map(s=>[s,{status:"SUCCESS",score:24.25,display_score:24,
      score_version:core.SCORE_VERSION,market_as_of:stamp,freshness:"FRESH"}]))};
  const payload={schema_version:1,trigger_source:"RAILWAY_PRIMARY",run_id:stamp,trading_date:day,slot,captured_at:stamp,
    completeness:"5/5",score_version:core.SCORE_VERSION,input_fingerprint:fingerprint,quotes,snapshot,
    quote_sources:Object.fromEntries(core.SYMBOLS.map(s=>[s,"MIS_Z"])),quote_timestamps:Object.fromEntries(core.SYMBOLS.map(s=>[s,stamp]))};
  // Exercise production publication in temporary files. Never replace the real archive.
  fs.writeFileSync(files.scores,JSON.stringify(archive));
  publisher.publish(payload,files);
  const result=JSON.parse(fs.readFileSync(files.scores));
  core.validateLedger(result);
  assert.equal(result.snapshots.length,Math.min(500,archive.snapshots.length+1));
  assert.deepEqual(result.snapshots.slice(0,-1),archive.snapshots.slice(-(result.snapshots.length-1)),
    "retained snapshots preserve every raw score, timestamp and provenance byte value");
  assert.equal(result.snapshots.at(-1).items["0050"].score,24.25);
  const after=Object.fromEntries(Object.entries(files).map(([k,v])=>[k,fs.readFileSync(v)]));
  assert.equal(publisher.publish(payload,files).status,"ALREADY_PUBLISHED_IDENTICAL");
  for(const [k,v] of Object.entries(files))assert.deepEqual(fs.readFileSync(v),after[k],"idempotent "+k);
  const bad=structuredClone(payload);bad.quotes["0050"].price=102;
  assert.throws(()=>publisher.publish(bad,files),/fingerprint_mismatch/);
  for(const [k,v] of Object.entries(files))assert.deepEqual(fs.readFileSync(v),after[k],"invalid write rejected "+k);
  assert.deepEqual(fs.readFileSync("intraday-core-snapshots-v1.json"),productionBytes);
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
console.log("PASS rolling archive: cap/order/5-of-5 integrity/raw provenance/idempotency/fail-closed; no production history writes");
