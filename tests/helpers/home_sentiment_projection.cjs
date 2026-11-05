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
