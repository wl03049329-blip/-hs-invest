'use strict';
// Strip only the exact reviewed V4.0 presentation slices; the entire remaining
// HTML, all embedded engines, and the previous historical projections stay sealed.
const assert=require('node:assert/strict'),cp=require('node:child_process'),crypto=require('node:crypto');
const slices=[["  <section id=\"signals\"","    <div class=\"sectionHead radarDetailHeading\">","7f8dd9ffad51192a287a65ffc519b6c89759b92581a9fc068e5d4c3417622566"],["<link rel=\"stylesheet\" href=\"radar-history.css","<script src=\"","615a7e146b4164d40aa5775fa63f9880b7ef886d26b39170601852261bd02e5b"],["function longOverviewCardHtml(","function radarSingleStrategyHtml(","bcdfa4dc67415efacd7086201b1f4d0cfee89781d54f28815afb0900bf2569cd"],["function radarWhyScoreHtml(","const RADAR_TREND_PHASE4_PERIODS","a846d6e569838882deca4a0ad3d52bd0e68ddbdd3270154a3ff27353ce75e5e0"],["function detailAdvancedHtml(","function syncRadarV4(","ead11e3e4e530834f4a47e79106747481fb1d0e9b0712b9ff2ff06df5e4c32e2"],["function switchRadarOverviewView(","function syncRadarDetailStickyNav(","93df06e468a2c48ce8eb0ee3f5fc33a526bab2f9aab1df45a2aa5d00037ac7f4"],["function mountRadarHistoryChart(","function formatYi(","c2e63eae3653cc42ee6258a7ee8072dfafa26099407b2f92938d342a0bc966d3"],["function watchUnavailableState(","function watchScoreForDisplay(","67bc9bcbf3fb4e1219a507aac4768c12f54870c7433fafe073e395b97659b0bb"],["function watchDiagnosticCard(","function diagnosticCheckLabel(","b66bb3b8aa746c1a7fda8b0f798611d2cba91527ce79faa6613ab27e6210f490"],["$(\"#watchAdHocForm\").addEventListener","$(\"#resetEtfBtn\").addEventListener","8d901d70d3c0c06e2ce52d569f5fa96f6ef9b1c2e2709dfd8f6a7902bc048eb1"]];
const baseline='fc292ce84a2bfe71c87c2fea8cf9a6289533410b';
module.exports=function(source){
 const old=cp.execFileSync('git',['show',baseline+':index.html'],{maxBuffer:8e6}).toString();
 const block=(s,a,b)=>{const i=s.indexOf(a),j=s.indexOf(b,i+a.length);assert(i>=0&&j>i,a);return s.slice(i,j);};
 for(const [a,b,pin] of slices){
  const reviewed=block(source,a,b);
  assert.equal(crypto.createHash('sha256').update(reviewed).digest('hex'),pin,'UNREVIEWED_LUXURY_RADAR_SLICE: '+a);
  source=source.replace(reviewed,()=>block(old,a,b));
 }
 assert.equal(crypto.createHash('sha256').update(source).digest('hex'),crypto.createHash('sha256').update(old).digest('hex'),'UNRELATED_HTML_OR_ENGINE_CHANGE');
 return old;
};
