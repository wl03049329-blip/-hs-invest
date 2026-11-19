'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const R=require('../lradar-core');
test('calendar month/year returns retain the actual preceding close and price-only basis',()=>{
 const rows=[['2023-02-28',50],['2023-12-29',60],['2024-02-29',80],['2024-03-29',100]];
 const p=R.periodReturns(rows);
 assert.equal(p.month.date,'2024-02-29');assert.equal(p.m1.date,'2024-02-29');
 assert.equal(p.m1.change,25);assert.equal(p.year.date,'2023-12-29');
 assert.equal(p.y1.requested,'2023-03-29');assert.equal(p.y1.date,'2023-02-28');
 assert.equal(R.monthsBack('2024-02-29',12),'2023-02-28');
 assert.equal(R.periodReturns([rows.at(-1)]).m1,null);
 assert.deepEqual(R.periodReturns([]),{});
});
test('selected chart interval never invents a comparison close',()=>{
 assert.equal(R.rangeReturn([]),null);assert.equal(R.rangeReturn([['2026-11-18',26.84]]),null);
 assert.deepEqual(R.rangeReturn([['2026-11-17',26.86],['2026-11-18',26.84]]),
  {start:'2026-11-17',end:'2026-11-18',change:100*(26.84/26.86-1)});
});
test('period UI uses only the existing verified continuous archive; no full-history fetch or threshold change',()=>{
 const ui=fs.readFileSync('lc4-research.js','utf8');
 assert.match(ui,/HSLRadar\.archiveSummary/);assert.match(ui,/HSLRadar\.verifyIndex/);
 assert.match(ui,/HSLRadar\.archiveURL/);
 assert.ok(ui.includes("dataset.href='https://data.gov.tw/dataset/11549'"));
 assert.ok(ui.includes("license.href='https://data.gov.tw/license'"));
 const summary=R.archiveSummary([],240);
 assert.equal(summary.speed,null);assert.equal(summary.depth,null);assert.equal(summary.level,null);
 assert.deepEqual(summary.returns,[null,null,null,null]);assert.deepEqual(summary.performance,{});
 assert.equal(R.thresholdVersion,'P80_P95_CLOSE_FIXED_20201231_V1');
});
