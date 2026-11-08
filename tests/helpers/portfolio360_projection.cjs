// Strip ONLY the reviewed V3.6 reader/UI wiring; keep all original safety seals.
const assert=require('assert/strict');module.exports=s=>{
 if(s.includes('refreshVisiblePortfolio')){
  const visibility=` const refresh=()=>host.document.querySelector('[data-tab-section="portfolio"].tabHidden')?Promise.resolve():refreshVisiblePortfolio();
 host.addEventListener('hs:portfolio-visible',()=>void refresh());
`;
  assert.equal(s.split(visibility).length-1,1,'EXACT_PORTFOLIO_VISIBILITY_WIRING');
  assert.equal(s.split(' async function refreshVisiblePortfolio(){').length-1,1);
  s=s.replace(visibility,'').replace(' async function refreshVisiblePortfolio(){',' async function refresh(){');
 }
 for(const line of[
 ' const estimateQuotes=V.closeQuotes(cache,status,now);for(const[k,q]of estimateQuotes){const verified=window.HSPersonalV3HistoryBasis.apply(q,histories.get(k),status,A.actions,now),split=A.actions.find(a=>a.symbol===k&&a.effective&&verified.previous_session_date<a.effective&&q.date>=a.effective);estimateQuotes.set(k,{...verified,estimate_split_ratio:split?.ratio||1});}\n',
 ' const currentEstimate=host.HSPortfolio360.estimate({holdings:projected,quotes:estimateQuotes,session:priceSession,positionValue:HSPortfolioCapitalBuildPlanCore.localPositionValue});\n',
 ' const experience360=host.HSPortfolio360.mount({scope,read,loadStrategy,colors:uiColors,money,percent,fp});\n'
 ]){assert.equal(s.split(line).length-1,1,'EXACT_V360_WIRING');s=s.replace(line,'');}for(const[a,b]of[['...v,daily_estimate:currentEstimate,snapshot:','...v,snapshot:'],['assetSummary.update(v);experience360.update(v);','assetSummary.update(v);'],['assetSummary.invalidate();experience360.invalidate();','assetSummary.invalidate();']]){assert.equal(s.split(a).length-1,1);s=s.replace(a,b);}return s;};
