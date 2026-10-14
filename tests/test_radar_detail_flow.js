"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),vm=require("node:vm"),path=require("node:path");
const root=path.resolve(__dirname,".."),html=fs.readFileSync(path.join(root,"index.html"),"utf8"),css=fs.readFileSync(path.join(root,"radar-history.css"),"utf8");
const start=html.indexOf("function buildRadarV2Card("),end=html.indexOf("function switchRadarDetailView",start);
const pieces={radarDetailCoreStatusHtml:'<section>official-score</section>',radarScoreTrendHtml:'<section data-radar-history>chart</section>',radarMarketPositionHtml:'<section>market</section>',radarDecisionSummaryHtml:'<section>decision</section>',radarWhyScoreHtml:'<section>breakdown</section>',detailAdvancedHtml:'<section>advanced</section>',longTermDrawdownTableHtml:'<table>verified-drawdown</table>'};
const context={esc:String,fmt:String,rankBadgeHtml:()=>'',radarDecisionLayerFor:()=>({}),finalDecisionBadgeLabel:()=>"正式",uiMetricStatus:()=>"existing status"};
for(const [name,value] of Object.entries(pieces))context[name]=()=>value;
vm.createContext(context);vm.runInContext(html.slice(start,end),context);
for(const id of ["0050","00662","00757","00830","00935","009815"]){
  const result=context.buildRadarV2Card({x:{id,name:id,signal:{className:""},fromHigh:null},mode:"long_term_core",decision:{},score:id==="009815"?null:27});
  assert.match(result,/^<article /,`${id}: focused card must not depend on native disclosure layout`);
  assert.doesNotMatch(result,/<summary|<details/,`${id}: no hidden native summary may reserve the card's first row`);
  assert.match(result,/<div class="signalCardDetails"><div class="detailTabs"/,`${id}: tabs are first in the card body`);
  assert.match(result,/<div data-detail-panel="drawdown" hidden>/);
  assert.ok(result.indexOf('data-detail-panel="score"')<result.indexOf('data-detail-panel="drawdown"'));
  for(const piece of Object.values(pieces))assert.ok(result.includes(piece),`${id}: existing information and chart retained`);
  assert.ok(result.endsWith('</article>'));
}
const flow=(css.match(/[^{}]*\.radarFlowCard[^{}]*\{[^}]*\}/g)||[]).join('\n');
assert.match(flow,/\.radarFlowCard>\.signalCardDetails\{[^}]*padding:14px/);
assert.match(flow,/\.radarFlowCard>\.signalCardDetails>\.detailTabs\{[^}]*position:static/);
assert.match(flow,/\.radarFlowCard>\.signalCardDetails>\.detailTabs\{[^}]*margin:0 0 14px/);
assert.doesNotMatch(flow,/translate|margin[^;}:]*:-|overflow:hidden/);
assert.match(html,/radar-history\.css\?v=20261014-selected-labels-v1/);
console.log('PASS six ETF natural-flow cards, both panels, retained chart/data helpers, versioned layout CSS');
