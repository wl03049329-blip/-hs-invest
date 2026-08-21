#!/usr/bin/env node
"use strict";
const crypto=require("node:crypto"),fs=require("node:fs"),path=require("node:path");
const REQUIRED=["0050","00662","00830","00935"];
const sha=value=>crypto.createHash("sha256").update(value).digest("hex");
function fail(code){throw Error(`SNAPSHOT_INVALID:${code}`)}
function validate(directory,expectedDate){
  const dataPath=path.join(directory,"historical-adjusted.json"),manifestPath=path.join(directory,"manifest.json"); if(!fs.existsSync(dataPath)||!fs.existsSync(manifestPath))fail("FILES_MISSING");
  const bytes=fs.readFileSync(dataPath),data=JSON.parse(bytes),manifest=JSON.parse(fs.readFileSync(manifestPath)); const date=expectedDate||manifest.trading_date;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||manifest.trading_date!==date||data.metadata?.trading_date!==date)fail("TRADING_DATE");
  if(manifest.dataset_sha256!==sha(bytes))fail("DATASET_HASH");
  if(!manifest.producer_sha256||!/^[0-9a-f]{64}$/.test(manifest.producer_sha256)||!manifest.producer_commit_sha||!/^[0-9a-f]{40}$/.test(manifest.producer_commit_sha)||!manifest.producer_schema_version||!manifest.adjustment_algorithm_version||!manifest.repair_manifest_version||!manifest.repair_manifest)fail("PROVENANCE");
  for(const ticker of REQUIRED){const rows=data.items?.[ticker]?.rows;if(!Array.isArray(rows)||!rows.length)fail(`ETF_MISSING:${ticker}`);if(rows.at(-1).date!==date)fail(`CUTOFF:${ticker}`);for(const row of rows){if(row.date>date)fail(`FUTURE_ROW:${ticker}`);const e=1e-5,zeroOpen=row.open===0&&data.metadata?.source_open_zero_policy==="PRESERVE_SOURCE_NUMERIC_OPEN_ZERO_V1";if(![row.open,row.high,row.low,row.close].every(Number.isFinite)||row.high+e<Math.max(row.open,row.close)||(!zeroOpen&&row.low-e>Math.min(row.open,row.close))||row.close<=0)fail(`OHLC:${ticker}`);}}
  if(manifest.no_lookahead_validation?.result!=="PASS"||manifest.data_quality_status!=="PASS")fail("NO_LOOKAHEAD"); return {ok:true,trading_date:date,dataset_sha256:manifest.dataset_sha256,manifest_sha256:sha(fs.readFileSync(manifestPath))};
}
function cli(){const args=process.argv.slice(2),at=f=>{const i=args.indexOf(f);return i<0?null:args[i+1]},directory=at("--snapshot-dir"),date=at("--trading-date");if(!directory)throw Error("USAGE: --snapshot-dir <dir> [--trading-date <T>]");console.log(JSON.stringify(validate(directory,date)));}
if(require.main===module)cli(); module.exports={validate,sha};
