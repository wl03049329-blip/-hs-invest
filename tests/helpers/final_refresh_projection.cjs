'use strict';
// Pin the entire reviewed public-data-only refresh; preserve the full prior HTML
// seal, including every financial, LIVE/FINAL, C4 and other-tab function.
const assert=require('assert/strict'),cp=require('child_process'),crypto=require('crypto');
module.exports=function(source){
 source=require('./home_sentiment_projection.cjs')(source);
 if(source.includes('portfolio-v3/experience360.js'))for(const literal of['<link rel="stylesheet" href="portfolio-v3/experience360.css">\n','<script defer src="portfolio-v3/experience360.js"></script>\n']){assert.equal(source.split(literal).length-1,1);source=source.replace(literal,'');}
 // Radar V2 replaces only the visible leverage presentation, not its inline
 // renderer or ANY market/financial function. Normalize exact reviewed literals.
 if(source.includes('<script defer src="lc4-radar-core.js"></script>')){
  for(const literal of ['<script defer src="lc4-radar-core.js"></script>\n','<link rel="stylesheet" href="lc4-radar-v2.css">\n']){assert.equal(source.split(literal).length-1,1);source=source.replace(literal,'');}
  const pairs=[
   ['00631L 正二雷達</h2><span class="hsLeverageIsolation">急跌機會與歷史統計｜不納入 C4 排名</span></div><small>描述性研究 · 非買進訊號</small>','00631L 槓桿戰術雷達</h2><span class="hsLeverageIsolation">獨立策略｜不納入 C4 排名</span></div><small>獨立戰術觀察 · 嚴控風險</small>'],
   ['<div id="homeLeverageCard" hidden aria-hidden="true">','<div id="homeLeverageCard">'],
   ['    <div id="lc4-radar-v2" class="lc4v2" aria-live="polite"><p>正在核驗研究資料…</p></div>\n',''],
   ['data-lc4-research-open>00631L 查看完整研究 › <small>樣本、方法與風險限制</small>','data-lc4-research-open>00631L 研究雷達 › <small>歷史風險觀察，非買進訊號</small>']
  ];for(const[a,b]of pairs){assert.equal(source.split(a).length-1,1,'EXACT_RADAR_V2_PRESENTATION_REQUIRED');source=source.replace(a,b);}
 }
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
