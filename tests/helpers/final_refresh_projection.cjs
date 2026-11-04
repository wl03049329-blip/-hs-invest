'use strict';
// Pin the entire reviewed public-data-only refresh; preserve the full prior HTML
// seal, including every financial, LIVE/FINAL, C4 and other-tab function.
const assert=require('assert/strict'),cp=require('child_process'),crypto=require('crypto');
module.exports=function(source){
 const tag='<script defer src="portfolio-v3/asset-summary.js"></script>\n';assert.equal(source.split(tag).length-1,1);source=source.replace(tag,'');
 const prior=cp.execFileSync('git',['show','6b7a0c5:index.html'],{maxBuffer:8e6}).toString();
 const a=source.indexOf('// HS_FINAL_SOURCE_REFRESH_V1_BEGIN'),b=source.indexOf('// HS_FINAL_SOURCE_REFRESH_V1_END',a)+'// HS_FINAL_SOURCE_REFRESH_V1_END'.length;
 assert(a>0&&b>a);const block=source.slice(a,b);
 assert.equal(crypto.createHash('sha256').update(block).digest('hex'),'f2f362063e7cf71037d218da7c60865546bf90aaa6c9749955d497cc1a250555');
 const old=prior.slice(prior.indexOf('async function loadFinalizedCoreScoreHistory(){'),prior.indexOf('function stableResearchValue(')).trimEnd();
 const normalized=source.slice(0,a)+old+source.slice(b);
 assert.equal(normalized,prior,'UNRELATED_HTML_OR_FINANCIAL_FUNCTION_CHANGED');return normalized;
};
