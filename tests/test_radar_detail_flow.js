"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),vm=require("node:vm"),path=require("node:path");
const root=path.resolve(__dirname,".."),html=fs.readFileSync(path.join(root,"index.html"),"utf8"),css=fs.readFileSync(path.join(root,"radar-history.css"),"utf8");
const start=html.indexOf("const radarMobileV4="),end=html.indexOf("function syncRadarV4",start),builder=html.indexOf("function buildRadarV2Card(");
const chart='<section data-radar-history>chart</section>';
const pieces={radarDetailCoreStatusHtml:'<section>official-score</section>',radarScoreTrendHtml:chart+'<section>trend</section>',radarMarketPositionHtml:'<section>market</section>',radarDecisionSummaryHtml:'<section>decision</section>',radarWhyScoreHtml:'<section>breakdown</section>',detailAdvancedHtml:'<section>advanced</section>',longTermDrawdownTableHtml:'<table>verified-drawdown</table>'};
const archive=require("../finalized-core-score-snapshots-v1.json"), core=require("../radar-history-core"), production=require("../final-core-production");
const context={window:{HSRadarHistory:core,HSFinalCoreProduction:production,HSRadarHistoryView:{html:()=>chart}},finalizedCoreScoreHistoryArtifact:archive,isCompletedTradingDate:()=>true,radarOfficialFactorPair:()=>({}),radarMarketPhase5State:()=>({}),radarTrendPhase4PriceRows:()=>[],radarOutcomePhase7BState:()=>({}),currentDualTrackCoreView:()=>({}),taipeiToday:()=>"2026-11-18",radarExplainSummary:()=>"資料不足",finalSourceRefreshIssue:false,formatC4Score:v=>v.toFixed(1),formatC4Signed:String,esc:String,fmt:String,rankBadgeHtml:()=>'',radarDecisionLayerFor:()=>({}),finalDecisionBadgeLabel:()=>"正式",uiMetricStatus:()=>"existing status",radarDisplayItems:()=>[]};
for(const [name,value] of Object.entries(pieces))context[name]=()=>value;
vm.createContext(context);vm.runInContext(html.slice(start,end)+html.slice(builder,html.indexOf("function switchRadarDetailView",builder)),context);
for(const id of ["0050","00662","00757","00830","00935","009815"]){
  const result=context.buildRadarV2Card({x:{id,name:id,signal:{className:""},fromHigh:null},mode:"long_term_core",decision:{},score:id==="009815"?null:27});
  assert.match(result,/^<article /,`${id}: focused card must not depend on native disclosure layout`);
  assert.match(result,/class="signalCardDetails".*class="radarV4Toolbar"/);
  assert.match(result,/<div data-radar-v4-pane="deep" hidden>/);
  assert.equal((result.slice(0,result.indexOf('data-radar-v4-pane="deep"')).match(/class="radarV4Card"/g)||[]).length,2);
  for(const [name,piece] of Object.entries(pieces))assert.ok(result.includes(name==="radarScoreTrendHtml"?piece.slice(chart.length):piece),`${id}: existing information and chart retained`);
  assert.equal(result.split(chart).length,2);
  assert.ok(result.endsWith('</article>'));
}
const flow=(css.match(/[^{}]*\.radarFlowCard[^{}]*\{[^}]*\}/g)||[]).join('\n');
assert.match(flow,/\.radarFlowCard>\.signalCardDetails\{[^}]*padding:14px/);
assert.match(css,/\.radarV4Toolbar\{position:sticky/);
assert.doesNotMatch(flow,/translate|margin[^;}:]*:-|overflow:hidden/);
assert.match(html,/radar-history\.css\?v=20261014-selected-labels-v1/);
console.log('PASS six ETF natural-flow cards, both panels, retained chart/data helpers, versioned layout CSS');
