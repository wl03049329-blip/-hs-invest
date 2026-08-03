const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const root=path.resolve(__dirname,"..");
const read=name=>fs.readFileSync(path.join(root,name),"utf8");
const html=read("index.html"),css=read("v62-tech.css"),portfolio=read("portfolio-v6.js"),strategy=require("../strategy-mode-core.js"),commodity=require("../commodity-quotes-core.js"),live=require("../live-market-core.js");

assert.deepEqual(strategy.LONG_TERM_WEIGHTS,{weeklyKdj:35,weeklyBias:25,drawdown:20,marketFear:10,valuation:10});
assert(strategy.weeklyKdjFactor(-1,10,12)>=94);
assert(strategy.weeklyKdjFactor(9,15,18)>strategy.weeklyKdjFactor(19,25,28));
assert(strategy.weeklyKdjFactor(19,25,28)>strategy.weeklyKdjFactor(25,30,32));

for(const code of ["0050","00830","00662","009815","00935"])assert.match(html,new RegExp(`id:\"${code}\"[^\\n]+strategyMode:\"long_term_core\"`));
assert.match(html,/swingIds=new Set\(\["00631L","00733","006201"\]\)/);
assert.doesNotMatch(html,/swingIds=new Set\([^\n]*00935/);
assert.match(html,/週乖離（約13週均線）/);
assert.match(html,/longTermDrawdownTableHtml/);
for(const level of [5,10,15,20,25,30])assert.match(html,new RegExp(`levels=\\[5,10,15,20,25,30\\]`));
assert.match(html,/臺灣科技主題 ETF｜產業集中、波動較高/);

const market=html.indexOf('id="homeMarketOverview"'),sentiment=html.indexOf('id="homeSentiment"'),radar=html.indexOf('id="homeEtfBrief"'),summary=html.indexOf('class="panel marketPanel"');
assert(market<sentiment&&sentiment<radar&&radar<summary);
for(const token of ["homeMarginKpiGrid","融資餘額","單日增減","推估維持率","20日均／區間","展開融資風險明細"])assert.match(portfolio,new RegExp(token));
assert.match(css,/homeMarginKpiGrid\{display:grid;grid-template-columns:repeat\(4/);
assert.match(css,/homeMarginKpiGrid\{grid-template-columns:repeat\(2/);

const oneGood={updated_at:"2026-08-03T02:30:00Z",items:{gold:{key:"gold",value:4100,previous_close:4090,change:10,change_pct:.2445,data_time:"2026-08-03T02:29:30Z",source_date:"2026-08-03",quote_mode:"delayed"},brent:{key:"brent",value:0}},source_status:{gold:"ok",brent:"error"}};
const parsed=commodity.validate(oneGood);assert(parsed.items.gold);assert.equal(parsed.items.brent,undefined);
const auth=live.normalizeAuthorizedPayload({items:{gold:{price:4100,previous_close:4090,quote_time:"2026-08-03T02:29:30Z"}},futures:{day:{price:42000,previous_close:42100,quote_time:"2026-08-03T02:29:30Z",contract_month:"202608"},night:{price:41900,previous_close:42100,quote_time:"2026-08-03T02:29:30Z",contract_month:"202609"}}});
assert(auth.items.gold);assert.equal(auth.futures,null);assert.match(auth.sourceErrors.futures,/不同契約月份/);
assert.match(html,/cache:"no-store"/);assert.match(html,/Cache-Control":"no-cache/);assert.match(html,/timeoutMs=12000/);assert.match(html,/來源受限/);assert.match(html,/最後成功/);
assert.doesNotMatch(html,/serviceWorker\.register|cache-first|caches\.open/);

for(const file of ["assets/hs-etf-radar-mark.svg","assets/hs-etf-radar-logo.svg","assets/icon-192-v2.png","assets/icon-512-v2.png","assets/apple-touch-icon-v2.png"])assert(fs.statSync(path.join(root,file)).size>500,file);
assert.match(read("assets/hs-etf-radar-mark.svg"),/幾何HS字首結合雷達掃描、K線與行情脈衝/);
assert.match(css,/max-width:430px/);assert.doesNotMatch(`${html}\n${css}`,/>\s*(?:NaN|undefined|Infinity)\s*</);
console.log("PASS buy radar homepage, margin KPIs, independent quotes and brand redesign");
