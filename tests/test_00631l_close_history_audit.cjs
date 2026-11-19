"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const R=require("../lradar-core"),A=require("../scripts/audit_00631l_close_history.cjs");
test("raw split adjustment is date-scoped and the suspension never supplies bars",()=>{
  assert.equal(A.adjustedClose(443.15,"2026-03-24"),443.15/22);
  assert.equal(A.adjustedClose(19.26,"2026-03-31"),19.26);
  assert.throws(()=>A.adjustedClose(20,"2026-03-25"),/SUSPENSION/);
  assert.throws(()=>A.verifyRows([["2026-03-31",19.26],["2026-03-31",19.26]]),/DUPLICATE/);
});
test("calendar month and year comparisons use the preceding valid session",()=>{
  const rows=[["2023-02-27",40],["2023-02-28",50],["2023-12-29",60],["2024-02-29",80],["2024-03-28",90],["2024-03-29",100]];
  const r=R.periodReturns(rows);
  assert.equal(r.month.date,"2024-02-29");
  assert.equal(r.m1.date,"2024-02-29");
  assert.equal(r.y1.requested,"2023-03-29");assert.equal(r.y1.date,"2023-02-28");
  assert.equal(r.year.date,"2023-12-29");
  assert.equal(r.m1.change,25);
  assert.equal(R.monthsBack("2024-02-29",12),"2023-02-28");
  assert.equal(R.periodReturns([rows.at(-1)]).m1,null);
});
test("range return is the same close-to-close basis and no imaginary first point",()=>{
  assert.equal(R.rangeReturn([]),null);assert.equal(R.rangeReturn([["2026-11-18",26.84]]),null);
  assert.deepEqual(R.rangeReturn([["2026-11-17",26.86],["2026-11-18",26.84]]),
    {start:"2026-11-17",end:"2026-11-18",change:100*(26.84/26.86-1)});
});
test("all real archived closes reconcile once; audit cannot authorize publication",()=>{
  const a=A.audit();
  assert.equal(a.history.start,"2014-10-31");assert.equal(a.history.end,"2026-11-19");
  assert.equal(a.official_archive.matched_closes,2924);
  assert.equal(a.history.rows,2935);assert.deepEqual(a.official_archive.missing_overlap_dates,[]);
  assert.equal(a.publication_authorized,false);assert.equal(a.split.reapply,false);
  assert.equal(a.metrics.close,24.57);assert.equal(a.metrics.recent[5],100*(24.57/30.99-1));
  assert.equal(a.metrics.performance.month.date,"2026-10-30");
  assert.equal(a.metrics.performance.year.date,"2025-12-31");
});
