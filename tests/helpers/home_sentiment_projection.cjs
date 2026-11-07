'use strict';
// Project only the exact reviewed home markup/rendering changes. In particular
// marketSentimentPresentation, CNN validation, detailed UI and all trading/
// portfolio code remain under the original byte-for-byte assertions.
const assert=require('assert/strict'),cp=require('child_process'),crypto=require('crypto');
module.exports=function(source){
 if(!source.includes('data-sentiment-layout="five"'))return source;
 const baseline=cp.execFileSync('git',['show','6a45c0285716713e8698cee712c535d0dfd8b05c:index.html'],{maxBuffer:8e6}).toString();
 const range=(s,start,end)=>{
  const a=s.indexOf(start),b=s.indexOf(end,a+start.length);
  assert(a>=0&&b>a,start);
  return s.slice(a,b);
 };
 if(source.includes('src="home-tmf-core.js"')){
  const previous=cp.execFileSync('git',['show','7dbfefcea827c1c8dc6fdbcb6e97339c100a3481:index.html'],{maxBuffer:8e6}).toString();
  for(const [start,end,pin] of [
   ['  <section id="homeSentiment"','  </section>','628a26461d490f9bfc87d228281a1d1505c75b7c2dd389981dd0bf23d64acfd0'],
   ['<script src="official-margin-balance.js','<script src="cnn-gauge.js','843ea5f3e643f44c22150c161fd2b3d3d4e34c759c2f42bef6ec8d50331087cb'],
   ['function renderHomeSentimentCards(','function marketSentimentPresentation(','b709a8b50942689d6f26097b9bc9617e2d1ce0bc1afa3fbebf7125f4aa1b0af6'],
   ['function renderMarketSentimentSummary(','function combinedSentimentConclusion(','97bf595cc0b05c9ba250d0d72cbc79b4a5a54435afc886ef31b26cbf8ce61b95'],
  ]){
   const block=range(source,start,end);
   assert.equal(crypto.createHash('sha256').update(block).digest('hex'),pin,'UNREVIEWED_V391_DISPLAY_CHANGE: '+start);
   source=source.replace(block,range(previous,start,end));
  }
  assert.equal(source,previous,'UNRELATED_V391_HTML_OR_FINANCIAL_FUNCTION_CHANGED');
 }
 if(source.includes('id="homeTaiexCard"')){
  const previous=cp.execFileSync('git',['show','90b08d1e97d8e1c0c01be24e4ea3d27c3088576f:index.html'],{maxBuffer:8e6}).toString();
  for(const [start,end,pin] of [
   ['  <section id="homeSentiment"','  </section>','2f722adfbbfe52915109fa70bc300c28381ec06fecda68fc7b31cc78a33ee2b1'],
   ['<script src="official-margin-balance.js','<script src="cnn-gauge.js','dd373150009d4390e294522c94f2d4c90d5e6b0e07eacc9c8618e9144537f432'],
   ['function renderMarketSentimentSummary(','function combinedSentimentConclusion(','5b7fc5b7a95a8989ad888965d243e99ece035b9af1e9354a6155815ea921f4fb'],
  ]){
   const block=range(source,start,end);
   assert.equal(crypto.createHash('sha256').update(block).digest('hex'),pin,'UNREVIEWED_V390_DISPLAY_CHANGE: '+start);
   source=source.replace(block,range(previous,start,end));
  }
  assert.equal(source,previous,'UNRELATED_V390_HTML_OR_FINANCIAL_FUNCTION_CHANGED');
 }
 if(source.includes('class="homeMarginExternalLinks"')){
  const start='      <div class="homeSentimentCard homeMarginCardShell">';
  const end='      <button id="homeMaintenanceCard"';
  const block=range(source,start,end);
  assert.equal(crypto.createHash('sha256').update(block).digest('hex'),
   '5429785ab3a687cb719cfa5c00663d2e57be18827131b6bee9cc72000c0bf973','UNREVIEWED_MARGIN_EXTERNAL_LINKS_MARKUP');
  const prior=cp.execFileSync('git',['show','ffa2ef8ae972b118b0ffddd7101dc556a7b0433e:index.html'],{maxBuffer:8e6}).toString();
  source=source.replace(block,range(prior,'      <button id="homeMarginBalanceCard"',end));
 }
 if(source.includes("data-home-foreign-change")){
  const v380=cp.execFileSync('git',['show','9b9d1609f8581f64b8c7e5484dd4c45a096ffac5:index.html'],{maxBuffer:8e6}).toString();
  for(const [start,end,pin] of [
   ["  <section id=\"homeSentiment\"","  </section>","80ccadf35df3a8759f590b46625477fc63632ae7965561b71517ea3ea0882c5a"],
   ["let homeFuturesChangeAvailable=","function positionCard(","39d11a694a317f50304798918bb274e47484087007265da96bf1263273653b16"],
   ["function renderHomeSentimentCards(","function marketSentimentPresentation(","5bdd53b57f443f03b5324fccf3b0709b4d10973bbb57199ad609fb24a26af759"],
   ["function renderHomeSentimentDetails(","function combinedSentimentConclusion(","62a25f43805f75aabb447433c2eeeed30023e225ba5108eaacb35c7ba947741e"],
  ]){
   const block=range(source,start,end);
   assert.equal(crypto.createHash('sha256').update(block).digest('hex'),pin,'UNREVIEWED_V381_DISPLAY_CHANGE: '+start);
   const baselineStart=start==="let homeFuturesChangeAvailable="?"async function loadFuturesPosition(":start;
   source=source.replace(block,range(v380,baselineStart,end));
  }
  const fallback='      renderTop();renderCards();renderWatchDiagnostics();\n      // The existing futures snapshot is independent of ETF price availability.\n      void loadFuturesPosition();\n';
  assert(source.includes(fallback),'UNREVIEWED_V381_FUTURES_FALLBACK');
  source=source.replace(fallback,'      renderTop();renderCards();renderWatchDiagnostics();\n');
  assert.equal(source,v380,'UNRELATED_V381_HTML_OR_FINANCIAL_FUNCTION_CHANGED');
 }
 // Phase 4A: verify each reviewed UI-only slice, then require the entire
 // V3.7 page to match before applying the prior historical projection.
 if(source.includes('id="officialMarginObservation"')){
  const v370=cp.execFileSync('git',['show','73a684a1afea66299b3ff90a32f866a2427f0b63:index.html'],{maxBuffer:8e6}).toString();
  for(const [start,end,pin] of [
    ["  <section id=\"homeSentiment\"","  </section>","474ab706e10b515f9f984d4536d4b0b121efba5d596040fa78988d1ff8f7c5ae"],
    ["      <button class=\"chipSegment\" type=\"button\" role=\"tab\" aria-selected=\"false\" data-chip-tab=\"margin\"","      <button class=\"chipSegment\" type=\"button\" role=\"tab\" aria-selected=\"false\" data-chip-tab=\"institutions\"","6d084df261f0840c616aaea90af7858b058265479f9a957276d9c42194f3804c"],
    ["    <div class=\"chipPanel\" data-chip-panel=\"margin\" hidden>","    <div class=\"chipPanel\" data-chip-panel=\"institutions\" hidden>","d25bea163340da3b148a2406980dfedbff4b41307ad6bdcb9b42dc60540fd19d"],
    ["<script src=\"margin-risk-core.js\"></script>","<script src=\"cnn-gauge.js","1a8d2dc0a50854a9cffd81c1f6d6a8204449c7971a62549c25756ee84ebdd83f"],
    ["function renderHomeSentimentCards(","function marketSentimentPresentation(","1f71a9f4cd5844b6d07a0e48c0e297bcdd24c4cf5f076d21e46378ef45ed4481"],
    ["function renderMarketSentimentSummary(","function combinedSentimentConclusion(","2563c12534cd6fda1ab32c7c9e901dff17fd4436958edfe527cf1013ea0e992f"],
    ["function switchChipTab(","async function loadMarketEvents(","f7dd26b814bafd0253e6a7a9f741da7dacb710866fa22030a1172b0064179d39"],
    ["$(\"#homeCnnCard\").addEventListener","$(\"#cnnFearGreedContent\").addEventListener","10819ffd94f96f338394e433b91da1f583c617012bce0e6b74a84770be2a8409"],
  ]){
   const block=range(source,start,end);
   assert.equal(crypto.createHash('sha256').update(block).digest('hex'),pin,'UNREVIEWED_OFFICIAL_MARGIN_UI_CHANGE: '+start);
   source=source.replace(block,range(v370,start,end));
  }
  assert.equal(source,v370,'UNRELATED_V380_HTML_OR_FINANCIAL_FUNCTION_CHANGED');
 }
 for(const [start,end,pin] of [
  ["  <section id=\"homeSentiment\"","  </section>","2513c08a51548f6908e37c7cbe3c587b0867435b72be6f438ad795466d67450b"],
  ["function setHomeSentimentCard(","function cnnGaugePresentation(","f0a02c3bb06c95c102dd1681029ef9781539a4d1138cf7550853212e54b01eed"],
  ["function renderCnnPresentationViews(","function renderHomeCnnGauge(","a8f19bb4fd69683ee5a2d2f35fc1cd43755d8110f771caaa76b42042f815457b"],
  ["function renderHomeCnnGauge(","function renderCnnDashboard(","28747de940305e0393f2cb1a5f315a1663c49ef042f360e0e87148f430625136"],
  ["function renderHomeSentimentCards(","function marketSentimentPresentation(","c14d02b1e963335c9676965347454019262d4a1f1fd673c22c37232ce05d17ed"],
  ["function renderMarketSentimentSummary(","function combinedSentimentConclusion(","f439843056e9ec36a957bee21aa017c11405904c73b3dc2ec74551dec77bcb9e"],
  ["$(\"#homeCnnCard\").addEventListener","$(\"#cnnFearGreedContent\").addEventListener","2e95e92936ace6d92bd2adbaa335570089c86a23d93d4cb820e2c1c51d470eef"],
  ["<script src=\"portfolio-etf-catalog.js","<script defer src=\"portfolio-v3/display-ui.js","49393d04233b543472073c7e27465378b78b208d2854af12bf6dd69934eb76e6"],
 ]){
  const block=range(source,start,end);
  assert.equal(crypto.createHash('sha256').update(block).digest('hex'),pin,'UNREVIEWED_HOME_SENTIMENT_CHANGE: '+start);
  source=source.replace(block,range(baseline,start,end));
 }
 assert.equal(source,baseline,'UNRELATED_HTML_OR_FINANCIAL_FUNCTION_CHANGED');
 return source;
};
