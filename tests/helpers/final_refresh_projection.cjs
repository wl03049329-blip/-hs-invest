'use strict';
// Pin the entire reviewed public-data-only refresh; preserve the full prior HTML
// seal, including every financial, LIVE/FINAL, C4 and other-tab function.
const assert=require('assert/strict'),cp=require('child_process'),crypto=require('crypto');
module.exports=function(source){
 // Stage4 adds exactly two code assets and two descriptive-research launchers.
 // Strip only these reviewed literals; the complete original HTML/function
 // seal below still rejects ANY other change, including financial code.
 if(source.includes('<script defer src="lc4-research.js"></script>')){
  for(const literal of [
   '<link rel="stylesheet" href="lc4-research.css">\n',
   '<script defer src="lc4-research.js"></script>\n',
   '    <button type="button" class="lc4r-entry" data-lc4-research-open>00631L 研究雷達 › <small>歷史風險觀察，非買進訊號</small></button>\n',
   '    <button type="button" class="lc4r-entry" data-lc4-research-open>00631L 研究雷達 ›</button>\n'
  ]){assert.equal(source.split(literal).length-1,1,'EXACT_RESEARCH_ADDITION_REQUIRED');source=source.replace(literal,'');}
 }
 const tag='<script defer src="portfolio-v3/asset-summary.js"></script>\n';assert.equal(source.split(tag).length-1,1);source=source.replace(tag,'');
 const prior=cp.execFileSync('git',['show','6b7a0c5:index.html'],{maxBuffer:8e6}).toString();
 const a=source.indexOf('// HS_FINAL_SOURCE_REFRESH_V1_BEGIN'),b=source.indexOf('// HS_FINAL_SOURCE_REFRESH_V1_END',a)+'// HS_FINAL_SOURCE_REFRESH_V1_END'.length;
 assert(a>0&&b>a);const block=source.slice(a,b);
 assert.equal(crypto.createHash('sha256').update(block).digest('hex'),'f2f362063e7cf71037d218da7c60865546bf90aaa6c9749955d497cc1a250555');
 const old=prior.slice(prior.indexOf('async function loadFinalizedCoreScoreHistory(){'),prior.indexOf('function stableResearchValue(')).trimEnd();
 const normalized=source.slice(0,a)+old+source.slice(b);
 assert.equal(normalized,prior,'UNRELATED_HTML_OR_FINANCIAL_FUNCTION_CHANGED');return normalized;
};
