'use strict';
const assert=require('assert/strict'),fs=require('fs'),cp=require('child_process');
const html=fs.readFileSync('index.html','utf8'),project=require('./helpers/final_refresh_projection.cjs');
project(html);console.log('PASS full original HTML/financial functions preserved after exact research-only additions');
for(const mutation of[
 html.replace('data-lc4-research-open>00631L','data-lc4-research-open>錯誤'),
 html.replace('function switchTab(', 'function changedSwitchTab('),
 html.replace('LIVE','ALTERED_LIVE')
])assert.throws(()=>project(mutation),'unrelated modification must fail the full HTML seal');
console.log('PASS strict negative financial/navigation/entry seal checks');
const old=cp.execFileSync('git',['show','2de99f950d87b3f4befb4d507019dbe423320107:index.html'],{maxBuffer:8000000}).toString();
const inline=s=>[...s.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(x=>x[1]).filter(Boolean);
assert.deepEqual(inline(html),inline(old));console.log('PASS every existing inline script byte-identical');
for(const name of['lc4-research.js','lc4-research.css'])assert(fs.existsSync(name));
const script=fs.readFileSync('lc4-research.js','utf8');for(const api of['localStorage','indexedDB','sessionStorage','HSLeverage'])assert(!script.includes(api));
console.log('PASS research module has no financial storage API');
