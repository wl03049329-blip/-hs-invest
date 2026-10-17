'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync('index.html','utf8');
const start=html.indexOf('function radarDisplayItems()'),end=html.indexOf('function historyPositionText',start);
assert.ok(start>0);
const actual=JSON.parse(fs.readFileSync('finalized-core-score-snapshots-v1.json'));
const targetDate=actual.snapshots.filter(s=>s.finalized&&s.snapshot_type==='FINALIZED_CLOSE').map(s=>s.date).sort().at(-1);
const resolver=require('../canonical-score-resolver.js');
const symbols=new Set(['0050','00662','00757','00830','00935']);
const snapshot=resolver.resolveFinalOnly({finalizedArtifact:actual,targetDate,scoreVersion:'FINAL_CORE_WEIGHT_V1',symbols});
const canonicalStart=html.indexOf('function canonicalCoreItem('),canonicalEnd=html.indexOf('function canonicalScoreProductionInvariant(',canonicalStart);
const context={all:[],LONG_RADAR_CODES:new Set([...symbols,'009815']),DEFAULT_WATCHLIST:[],META:{},
  taipeiToday:()=>targetDate,currentCanonicalCoreSnapshot:()=>snapshot,
  canonicalScoreProductionInvariant:()=>true,radarList:()=>[...symbols,'009815'].map(id=>({id})),strategyModeFor:()=> 'long_term_core',LONG_TERM_CORE_SCORE_VERSION:'FINAL_CORE_WEIGHT_V1'};
vm.createContext(context);vm.runInContext(html.slice(canonicalStart,canonicalEnd)+html.slice(start,end)+';this.display=radarDisplayItems;',context);
const rows=context.display();assert.equal(rows.length,6);assert.equal(context.all.length,0);
for(const symbol of symbols){const row=rows.find(r=>r.id===symbol);assert.equal(row.price,null);assert.equal(row.changePct,null);assert.equal(row.officialRows.length,0);assert.equal(row.scoreMode,'finalized_eod');
  const official=actual.snapshots.find(s=>s.date===targetDate).rows.find(r=>r.symbol===symbol);
  assert.equal(row.strategyDecisions.long_term_core.coreScore,official.final_core_score);
  assert.equal(row.intraday.canonical.market_as_of,official.data_as_of);
}
assert.equal(rows.find(r=>r.id==='009815').score,null);
assert.equal(context.activeRadarItems().length,6);
context.strategyModeFor=()=> 'user_selected';assert.equal(context.activeRadarItems().length,0,'official display records must not impersonate universal/swing models');
const original={id:'0050',price:100};context.all=[original];assert.equal(context.display().find(r=>r.id==='0050'),original);
context.canonicalScoreProductionInvariant=()=>false;assert.ok(context.display().filter(r=>r.id!=='0050').every(r=>r.score===null));
const body=html.slice(html.indexOf('async function load(){'),html.indexOf('$("#token").value='));
assert.ok(body.indexOf('renderCards();')<body.indexOf('ids.map(one)'),'radar renders without waiting for price requests');
assert.ok(body.indexOf('renderTop();')<body.indexOf('ids.map(one)'),'home C4 must render validated official sources before price requests, too');
assert.doesNotMatch(html.slice(start,end),/applyAssetModel|refreshDecisionModel|recordForward|\.push\(x\).*all|localStorage\.setItem/);
assert.match(body,/if\(!all.length\)\{\s*renderTop\(\);renderCards\(\);renderWatchDiagnostics\(\);/,'empty price results rerender independent C4 and price diagnostics');
assert.match(body,/歷史行情暫不可用/,'unavailable historical prices remain explicitly unavailable');
assert.match(body,/await Promise\.all\(\[loadFinalizedCoreScoreHistory\(\),loadResearchC4History\(\)\]\)/,'shared request ordering is unchanged');
assert.match(html,/const longs=all\.filter\(x=>longIds\.has\(x\.id\)\)/,'home renderer does not consume radar-only records');
console.log('PASS real FINALIZED survives price failure in radar and home, WAIT_NATIVE stays null, price-derived records remain separate');
