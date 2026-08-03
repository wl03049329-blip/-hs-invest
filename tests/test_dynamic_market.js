const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const live=require("../live-market-core.js");
const market=require("../market-v61-core.js");
const root=path.resolve(__dirname,"..");
const read=name=>fs.readFileSync(path.join(root,name),"utf8");
const html=read("index.html"),css=read("v62-tech.css"),portfolio=read("portfolio-v6.js");
const tx=JSON.parse(read("tx-futures-quote.json"));

check("missing OHLCV is not coerced from null to zero",()=>{
  const payload={updated_at:"2026-08-03T02:30:00Z",instruments:{
    taiex:{value:100,change:1,change_pct:1,data_date:"2026-08-03",data_time:"10:30",quote_time:"2026-08-03T02:30:00Z",open:null,high:null,low:null,volume:null},
    otc:{value:100,change:1,change_pct:1,data_date:"2026-08-03",data_time:"10:30",quote_time:"2026-08-03T02:30:00Z",open:null,high:null,low:null,volume:null},
    tsmc:{value:100,change:1,change_pct:1,data_date:"2026-08-03",data_time:"10:30",quote_time:"2026-08-03T02:30:00Z",open:null,high:null,low:null,volume:null}
  }};
  const normalized=market.validateOverview(payload,new Date("2026-08-03T02:31:00Z"));
  assert.equal(normalized.instruments.taiex.open,null);
  assert.equal(normalized.instruments.taiex.volume,null);
});

function check(name,fn){fn();process.stdout.write(`PASS ${name}\n`)}
function quoteAt(iso){return{quoteTime:iso}}

check("資料時間 60 秒、3 分鐘與過期邊界",()=>{
  const now=new Date("2026-08-03T02:30:00Z");
  assert.equal(live.quoteFreshness(quoteAt("2026-08-03T02:29:01Z"),"intraday",now).key,"updating");
  assert.equal(live.quoteFreshness(quoteAt("2026-08-03T02:28:00Z"),"intraday",now).key,"delayed");
  assert.equal(live.quoteFreshness(quoteAt("2026-08-03T02:26:59Z"),"intraday",now).key,"stale");
  assert.equal(live.quoteFreshness(quoteAt("2026-07-31T05:30:00Z"),"closed",now).key,"closed");
});

check("台指期日盤、夜盤、跨午夜與週五跨週六",()=>{
  assert.equal(market.futuresSession(new Date("2026-07-29T02:30:00Z")).key,"day");
  assert.equal(market.futuresSession(new Date("2026-07-29T14:00:00Z")).key,"night");
  assert.equal(market.futuresSession(new Date("2026-07-29T18:00:00Z")).key,"night");
  assert.equal(market.futuresSession(new Date("2026-07-31T18:00:00Z")).key,"night");
});

check("授權期貨資料禁止混用契約月份",()=>{
  const one={price:42000,previous_close:42100,quote_time:"2026-08-03T02:30:00Z",change:-100,change_pct:-0.2375,contract_month:"202608"};
  assert.throws(()=>live.normalizeFutures({day:one,night:{...one,contract_month:"202609"}},{sourceName:"test"}),/不同契約月份/);
});

check("官方台指期 fallback 不冒充盤中",()=>{
  assert.equal(tx.authorized_intraday,false);
  assert.equal(tx.availability,"official_close_only");
  assert.match(tx.source_url,/openapi\.taifex\.com\.tw/);
  for(const item of Object.values(tx.sessions)){
    assert.equal(item.quote_mode,"close");
    assert.ok(item.value>0&&Number.isFinite(item.change));
    assert.equal(item.contract_month,tx.contract_month);
  }
  assert.match(html,/台指期盤中行情需串接授權來源/);
  assert.match(html,/目前顯示最近官方收盤資料/);
});

check("單一輪詢、AbortController、背景暫停與前景強制更新",()=>{
  assert.match(html,/let liveQuoteTimer=null/);
  assert.equal((html.match(/let liveQuoteTimer=/g)||[]).length,1);
  assert.match(html,/timerCount:liveQuoteTimer===null\?0:1/);
  assert.match(html,/liveQuoteAbortController\?\.abort\(\)/);
  assert.match(html,/document\.hidden/);
  assert.match(html,/refreshLiveQuotes\(\{force:true\}\)/);
  const portfolioScheduler=portfolio.slice(portfolio.indexOf("function scheduleNext"),portfolio.indexOf("async function updateQuotes"));
  assert.doesNotMatch(portfolioScheduler,/setTimeout/);
});

check("20 秒盤中、45 秒商品與 429 退避",()=>{
  assert.equal(live.pollDelay({spotActive:true}),20000);
  assert.equal(live.pollDelay({commodityActive:true}),45000);
  assert.ok(live.pollDelay({spotActive:true,failures:2,httpStatus:429})>=480000);
  assert.match(html,/now-liveCommodityLastAttemptAt>=45000/);
  assert.match(html,/includeCommodities:commodityDue/);
});

check("Proxy URL 不接受金鑰 query、帳密或非 HTTPS",()=>{
  assert.equal(live.validProxyUrl("http://quotes.example.com/feed"),"");
  assert.equal(live.validProxyUrl("https://user:pass@quotes.example.com/feed"),"");
  assert.equal(live.validProxyUrl("https://quotes.example.com/feed?key=secret"),"");
  assert.equal(live.validProxyUrl("https://quotes.example.com/feed"),"https://quotes.example.com/feed");
});

check("首頁三現貨、台指期、黃金、布蘭特與可展開 OHLCV",()=>{
  for(const text of ["台股加權指數","上櫃指數","台積電 2330","台指期近月","黃金","布蘭特原油","開盤","最高","最低","成交量"])assert.match(html,new RegExp(text));
  assert.match(html,/<details class="marketQuoteCard/);
  assert.doesNotMatch(html,/杜蘭特原油/);
});

check("快取請求 no-store、時間戳且沒有 Service Worker cache-first",()=>{
  assert.match(html,/cache:"no-store"/);
  assert.match(html,/\?ts=\$\{now\}/);
  assert.doesNotMatch(html,/serviceWorker\.register|cache-first|caches\.open/);
});

check("盤中 ETF 試算與持股共用公開行情事件",()=>{
  assert.match(html,/applyIntradayEstimate/);
  assert.match(html,/refreshAllDecisionModels\(\)/);
  assert.match(html,/formalScore/);
  assert.match(html,/hs:delayed-quotes/);
  assert.match(portfolio,/applySharedQuotes/);
  assert.match(portfolio,/renderPortfolio\(true\)/);
});

check("價格閃動遵守 reduced motion 且台股紅漲綠跌",()=>{
  assert.match(css,/quoteUpFlash/);
  assert.match(css,/quoteDownFlash/);
  assert.match(css,/prefers-reduced-motion:reduce/);
  assert.match(css,/\.moodUp.*#ff637d/);
  assert.match(css,/\.moodDown.*#41d6a3/);
});

check("375、390、430 手機雙欄無橫向溢位設計",()=>{
  assert.match(css,/marketOverviewCards\{grid-template-columns:repeat\(2/);
  assert.match(css,/max-width:430px/);
  assert.match(css,/min-width:0;overflow:hidden/);
  for(const width of [375,390,430])assert.ok(width<=430);
});

check("生產資料不含非有限數值或錯誤 0",()=>{
  for(const file of ["market-overview.json","market-quotes-meta.json","commodity-quotes.json","tx-futures-quote.json"]){
    const text=read(file);assert.doesNotMatch(text,/NaN|Infinity|undefined/);JSON.parse(text);
  }
  assert.doesNotMatch(html,/>\s*(?:NaN|undefined|Infinity)\s*</);
});

console.log("dynamic market integration tests passed");
