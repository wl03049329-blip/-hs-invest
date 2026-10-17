"use strict";
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync('index.html','utf8'),resolver=require('../canonical-score-resolver'),decision=require('../hs-decision-layer-v1');
const symbols=['0050','00662','00757','00830','00935'],artifact=JSON.parse(fs.readFileSync('finalized-core-score-snapshots-v1.json'));
const extract=(a,b)=>html.slice(html.indexOf(a),html.indexOf(b,html.indexOf(a)));
const context={window:{HSDecisionLayerV1:decision},LONG_RADAR_SCORED_CODES:new Set(symbols),LONG_TERM_CORE_SCORE_VERSION:artifact.core_score_version,homepageFinalDecision:()=>null,hsTodayFactorAdapter:f=>f};
vm.createContext(context);
vm.runInContext(extract('function finalDecisionPresentation','function finalDecisionBadgeLabel')+extract('function decisionCenterOfficialRows','function selectDecisionCenterHighest'),context);
const options={finalizedArtifact:artifact,targetDate:'2026-10-17',scoreVersion:artifact.core_score_version,symbols,now:new Date('2026-10-17T11:00:00+08:00'),tradingDayStatus:'HOLIDAY'};
const view=resolver.buildDualTrackView(options),rows=context.decisionCenterOfficialRows(view,[]);
context.homepageFinalDecision=()=>({label:'TEST_STALE_PRICE_DERIVED_LABEL'});
assert.equal(context.decisionCenterOfficialRows(view,symbols.map(id=>({id})))[0].tier,rows[0].tier,'current official interpretation must win over a stale price-derived model');
context.homepageFinalDecision=()=>null;
assert.equal(rows.length,5);for(const row of rows){assert.equal(row.score,view.items[row.symbol].official.score);assert.equal(row.date,'2026-10-16');assert.equal(row.tier,decision.interpret({symbol:row.symbol,score:view.items[row.symbol].official.display_score,sourceStatus:'SUCCESS',asOf:row.asOf}).decision_label_zh)}
for(const mutated of [{...artifact,core_score_version:'INVALID'}, {...artifact,snapshots:artifact.snapshots.map(s=>({...s,rows:s.rows.filter(r=>r.symbol!=='0050')}))},{...artifact,snapshots:[]}])assert.equal(context.decisionCenterOfficialRows(resolver.buildDualTrackView({...options,finalizedArtifact:mutated}),[]).length,0);
assert.equal(context.decisionCenterOfficialRows({items:{'0050':{official:{status:'FINALIZED',score:null}}}},[]).length,0);
// Exercise the actual asynchronous initializer with every price request rejected.
(async()=>{const calls=[],elements={message:{},reload:{querySelector:()=>({}),setAttribute(){},removeAttribute(){}}},noop=async()=>{};
 const c={$:s=>elements[s.slice(1)],syncWatchlistState(){},renderWatchlist(){},loadFinalizedCoreScoreHistory:noop,loadResearchC4History:noop,loadResearchC4Outcomes:noop,loadCorporateActionTables:noop,loadEtfValuation:noop,loadLeverageOfficialStatus:noop,renderCards:()=>calls.push('cards'),renderTop:()=>calls.push('official'),renderWatchDiagnostics:()=>calls.push('diagnostic'),rebuildWatchDiagnostics(){},ids:symbols,one:async()=>{throw new Error('TEST_CORS_BLOCKED')},all:[],esc:String};
 vm.createContext(c);vm.runInContext(extract('async function load(){','$("#token").value='),c);await c.load();assert.equal(c.all.length,0);assert.equal(elements.reload.disabled,false);assert.ok(calls.filter(v=>v==='official').length>=3);assert.match(elements.message.textContent,/歷史行情暫不可用/);assert.match(elements.message.textContent,/無有效快照時維持資料不足/);
 assert.doesNotMatch(extract('function decisionCenterOfficialRows','function selectDecisionCenterHighest'),/buildFinal|calculate|\.setItem|fetch\(/);
 console.log('PASS C4 price-source independence: actual FINALIZED raw scores/tier/date; rejected version/incomplete/missing/null; real initializer completion without any price item');
})().catch(e=>{console.error(e);process.exitCode=1});
