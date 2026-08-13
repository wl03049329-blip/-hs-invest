const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const root=path.resolve(__dirname,"..");
const read=name=>fs.readFileSync(path.join(root,name),"utf8");
const html=read("index.html"),css=read("v62-tech.css"),portfolio=read("portfolio-v6.js"),workflow=read(".github/workflows/update-market-quotes.yml"),strategy=require("../strategy-mode-core.js");

assert.doesNotMatch(html,/id="homeMarketOverview"|id="marketOverviewCards"/);
assert.doesNotMatch(html,/scheduleLiveQuotePoll|liveQuoteTimer/);
assert(html.indexOf('id="homeSentiment"')<html.indexOf('id="homeEtfBrief"')&&html.indexOf('id="homeEtfBrief"')<html.indexOf('class="panel marketPanel"')&&html.indexOf('class="panel marketPanel"')<html.indexOf('id="homeSwingBrief"'));
assert.match(html,/scheduleLongRankRefresh/);
assert.match(html,/market-quotes-meta\.json\?ts=/);
assert.doesNotMatch(html,/fetchNoStore\(`(?:market-overview|commodity-quotes|tx-futures-quote)\.json/);

for(const id of ["homeMarginBalanceCard","homeMaintenanceCard","homeCnnCard","homeForeignFuturesCard","homeTmfRatioCard"])assert.match(html,new RegExp(`id="${id}"`));
assert.match(portfolio,/微台多空比＝推估多單÷推估空單/);
assert.match(css,/homeSentimentWide\{grid-column:1\/-1\}/);

for(const code of ["0050","00830","00662","009815","00935"])assert.match(html,new RegExp(`id:"${code}"[^\n]+strategyMode:"long_term_core"`));
assert.match(html,/sort\(longRankComparator\)/);
assert.match(html,/longRankComparator[\s\S]*scoreB[\s\S]*a\.j[\s\S]*a\.fromHigh[\s\S]*localeCompare/);
assert.match(html,/第\$\{index\+1\}名/);
assert.match(html,/rankDelta>0\?`↑\$\{rankDelta\}`:rankDelta<0\?`↓/);
assert.match(html,/LONG_RANK_STORAGE_KEY/);
for(const field of ["current_score","current_rank","snapshotTime","marketAsOf"])assert.match(html,new RegExp(field));
assert.match(css,/@keyframes rankUp/);
assert.match(css,/@media\(prefers-reduced-motion:reduce\)/);

const provisional=strategy.longTermDecision({j:8,k:15,d:18,weeklyBias:-9,fromHigh:null,valuation:null,marketFear:null,stopConfirmation:25});
assert(Number.isFinite(provisional.score));
assert.equal(provisional.coverage,60);
assert.equal(provisional.scoreStatus,"provisional");
assert.equal(strategy.longTermDecision({j:null,weeklyBias:-9,fromHigh:-20}).score,null);
assert.equal(strategy.longTermDecision({j:8,weeklyBias:null,fromHigh:null}).score,null);
assert.match(html,/mode==="long_term_core"\?null:x\.score/);
assert.deepEqual(strategy.SWING_WEIGHTS,{stopConfirmation:30,trendStrength:25,technicalLow:15,momentum:10,historicalStats:10,valuationBackground:5,marketLiquidity:5});
assert.deepEqual(strategy.LONG_TERM_WEIGHTS,{weeklyKdj:45,drawdown:20,weeklyBias:15,marketFear:15,valuation:5});

assert.match(workflow,/cron: "25 0 \* \* 1-5"/);assert.match(workflow,/run_intraday_radar_session\.py/);
assert.match(html,/minute>=30&&minute<=49/);
assert.match(html,/setTimeout\(async\(\)=>/);
assert.match(html,/60000/);
assert.match(html,/visibilitychange[\s\S]*refreshLiveQuotes\(\{force:true\}\)[\s\S]*scheduleLongRankRefresh/);

assert.match(css,/@media\(max-width:430px\)/);
assert.doesNotMatch(`${html}\n${css}`,/>\s*(?:NaN|undefined|Infinity)\s*</);
console.log("PASS focused homepage sentiment, long-term ranking and scheduled refresh tests");
