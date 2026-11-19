'use strict';
// Explicit, offline, same-owner export. Never a workflow or Pages input.
const fs=require('node:fs'),path=require('node:path'),z=require('node:zlib'),{createHash}=require('node:crypto');
const A=require('./audit_00631l_close_history.cjs');
const root=path.resolve(__dirname,'..'),hash=b=>createHash('sha256').update(b).digest('hex');
function build(recentPath){
 const audit=A.audit(),seed=require('../data/lc4-research/seed.json'),pointer=require('../data/lc4-research/latest.json');
 const gz=fs.readFileSync(path.join(root,'data/lc4-research/seed-sources.json.gz'));
 if(hash(gz)!==seed.sources_sha256)throw Error('SOURCE_HASH');
 const sources=JSON.parse(z.gunzipSync(gz)),fm=sources['finmind-TaiwanStockPrice-00631L.json'];
 const bundle=JSON.parse(fs.readFileSync(path.join(root,'data/lc4-research',pointer.path))),known=new Map(bundle.history.histories['00631L'].map(r=>[r.date,r.close]));
 const raw=fs.readFileSync(recentPath),recent=JSON.parse(raw);
 if(fm.payload.status!==200||recent.status!==200||!Array.isArray(recent.data)||recent.data.length!==11||hash(raw)!=='2b6a85111a0f4bd19237f3d58aab0688c95a57a20a6faf2cd4bc9e9d87a9b609')throw Error('RECENT_RECEIPT');
 const rows=[...fm.payload.data,...recent.data].map(r=>{
  if(r.stock_id!=='00631L'||!Number.isFinite(r.close)||r.close<=0||r.Trading_Volume<=0)throw Error('SOURCE_ROW');
  const price=A.adjustedClose(r.close,r.date);if(known.has(r.date)&&known.get(r.date)!==price)throw Error('ARCHIVE_CONFLICT');
  return [r.date,price];
 });
 A.verifyRows(rows);if(rows.length!==2935||rows.at(-1)[0]!=='2026-11-19'||audit.vendor_differences.count!==0||audit.official_archive.missing_overlap_dates.length)throw Error('HISTORY_PARITY');
 for(const e of audit.incremental){
  const q=JSON.parse(require('node:child_process').execFileSync('git',['show',e.ref+':market-quotes.json'],{cwd:root,maxBuffer:12_000_000}));
  if(q.items.find(r=>r.code==='00631L'&&r.date===e.date)?.price!==new Map(rows).get(e.date))throw Error('RECENT_OFFICIAL_PARITY');
 }
 const base={schema:'HS_00631L_PERSONAL_BASE_V1',symbol:'00631L',scope:'PERSONAL_NONCOMMERCIAL_ONLY',
  price_basis:'SPLIT22_20260331_CLOSE_NO_DIVIDEND',listing_date:'2014-10-31',asof:'2026-11-19',
  split:{date:'2026-03-31',factor:22,applied_once:true},
  sources:[{provider:'FinMind',dataset:'TaiwanStockPrice',sha256:fm.receipt.sha256,from:'2014-10-31',to:'2026-11-04'},
   {provider:'FinMind',dataset:'TaiwanStockPrice',sha256:hash(raw),from:'2026-11-05',to:'2026-11-19'}],rows};
 return {schema:'HS_00631L_PERSONAL_BACKUP_V1',base,extension:[]};
}
if(require.main===module){
 const [recent,out]=process.argv.slice(2);if(!recent||!out)throw Error('EXPLICIT_PRIVATE_INPUT_AND_OUTPUT_REQUIRED');
 const dest=path.resolve(out);if(dest===root||dest.startsWith(root+path.sep)||!dest.endsWith('.lradar-private.json'))throw Error('PRIVATE_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY');
 const result=build(recent);fs.writeFileSync(dest,JSON.stringify(result),{flag:'wx'});
 console.log(JSON.stringify({rows:result.base.rows.length,asof:result.base.asof,base_sha256:hash(JSON.stringify(result.base)),personal_only:true,public_export:false}));
}
module.exports={build};
