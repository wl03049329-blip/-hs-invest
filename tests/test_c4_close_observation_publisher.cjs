"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {extend,dates}=require("../scripts/update_c4_close_observations.cjs");
const production=require("../final-core-production");
const published=require("../data/c4-close-observations-v1.json");
const artifact={...published,sessions:published.sessions.filter(s=>s.date<="2026-11-16")};
const weights=[30,55,15], names=["weeklyJ","dd52","crash"];
const calendar={stat:"ok",queryYear:2026,total:1,fields:["日期","名稱","說明"],data:[["2026-01-01","元旦","放假"]]};
const body={stat:"OK",date:"20261117",tables:[{fields:["證券代號","開盤價","最高價","最低價","收盤價","成交股數"],
 data:["0050","00757","00830","00935"].map(s=>[s,"100","102","99","101","1,000"])}]};
const asOf=new Date("2026-11-17T10:20:00Z");
const fetchBytes=async url=>Buffer.from(JSON.stringify(url.includes("holidaySchedule")?calendar:body));
const decide=async()=>({coreScoreVersion:artifact.score_version,coreScore:50,source_close:101,
 label:production.labelFor(50).label,coreFactors:Object.fromEntries(names.map((k,i)=>[k,{raw:20,score:50,weight:weights[i],contribution:weights[i]/2}]))});
test("Taipei cutoff and idempotence; official close only; no 00662 or FINAL",async()=>{
 assert.equal(dates(new Date("2026-11-17T05:00:00Z")).cutoff,"2026-11-16");
 assert.equal((await extend(artifact,new Date("2026-11-17T05:00:00Z"),{fetchBytes,decide})).added.length,0);
 const r=await extend(artifact,asOf,{fetchBytes,decide});
 assert.deepEqual(r.added.map(x=>x.date),["2026-11-17"]);
 assert.deepEqual(r.result.sessions.slice(0,-1),artifact.sessions);
 assert.equal(r.result.official_final,false);
 assert.equal(r.added[0].symbols["00662"],undefined);
 assert.equal((await extend(r.result,asOf,{fetchBytes,decide})).added.length,0);
});
test("wrong year or scoring source close cannot publish",async()=>{
 const wrong=async()=>Buffer.from(JSON.stringify({...calendar,queryYear:2027}));
 await assert.rejects(extend(artifact,asOf,{fetchBytes:wrong,decide}),/CALENDAR_UNVERIFIED/);
 await assert.rejects(extend(artifact,asOf,{fetchBytes,decide:async()=>({...await decide(),source_close:99})}),/SCORE_CLOSE_UNVERIFIED/);
});
