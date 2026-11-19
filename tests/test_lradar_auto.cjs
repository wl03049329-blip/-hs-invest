'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),L=require('../lradar-local');
test('open-page daily refresh uses the research store, not the Taipei time string',async()=>{
 const vm=require('node:vm'),source=fs.readFileSync('lc4-research.js','utf8');
 const refresh=source.slice(source.indexOf('   function refreshDaily(){'),source.indexOf('   draw();refreshDaily();'));
 assert.ok(refresh.startsWith('   function refreshDaily(){'));
 const sandbox={Date,Intl,Promise,calls:0,draws:0};
 vm.createContext(sandbox);
 vm.runInContext(`let flight=null,lastCheck=0,records=[],fresh=false,personal={enabled:true},personalError='';
 const next=[{trading_date:'2026-11-19'}];
 const local={sync:async r=>{calls++;if(r!==records)throw Error('WRONG_RECORDS');return {enabled:true,updated:true};}};
 const HSLRadar={archiveURL:'TEST_ONLY',verifyIndex:x=>x.records};
 const json=async()=>({value:{records:next,schema_version:1,expected_completed_bar:'2026-11-19',next_expected_trading_day:'2026-11-20'}});
 const localError=e=>e.message,draw=()=>{draws++;};
 ${refresh}
 globalThis.run=async()=>{refreshDaily();await flight;return {calls,draws,personalError,updated:personal.updated};};`,sandbox);
 const result=await sandbox.run();assert.equal(result.calls,1);assert.equal(result.draws,1);assert.equal(result.personalError,'');assert.equal(result.updated,true);
});
test('auto loader rejects partial, corrupt, zero-price and unverified history without changing financial contracts',async()=>{
 await assert.rejects(L.fromProvider('{}'),/AUTO_RESPONSE_INVALID/);
 await assert.rejects(L.fromProvider('not json'),/AUTO_RESPONSE_INVALID/);
 await assert.rejects(L.fromProvider('{"status":402,"msg":"quota"}'),/AUTO_HTTP_402/);
 const data=Array.from({length:2935},()=>({stock_id:'00631L',date:'2026-11-19',close:1,Trading_Volume:0}));
 await assert.rejects(L.fromProvider(JSON.stringify({status:200,data})),/AUTO_ROW_INVALID/);
 assert.match(L.DIRECT_URL,/^https:\/\/api\.finmindtrade\.com\/api\/v4\/data\?/);
 const code=fs.readFileSync('lradar-local.js','utf8');
 for(const s of ['credentials:\'omit\'','redirect:\'error\'','Retry-After','navigator.locks.request','AUTO_ORIGIN_NOT_ENABLED'])assert.ok(code.includes(s));
 assert.ok(!/Authorization|FINMIND_TOKEN|FUGLE_API_KEY|method:'POST'/.test(code));
});
test('real direct response matches the exact existing 2935-row price basis',{skip:!process.env.HS_DIRECT_RESPONSE},async()=>{
 const text=fs.readFileSync(process.env.HS_DIRECT_RESPONSE,'utf8'),value=await L.fromProvider(text),old=JSON.parse(fs.readFileSync(process.env.HS_PRIVATE_INPUT,'utf8'));
 assert.deepEqual(value.base.rows,old.base.rows);assert.equal(value.base.rows.length,2935);
 assert.equal(value.base.schema,'HS_00631L_PERSONAL_DIRECT_V1');await L.verify(value);
 const revision=JSON.parse(text);revision.data[0].close+=1;await assert.rejects(L.fromProvider(JSON.stringify(revision)),/AUTO_HISTORY_REVISED/);
 const double=JSON.parse(text);double.data.forEach(r=>{if(r.date<'2026-03-31')r.close/=22;});await assert.rejects(L.fromProvider(JSON.stringify(double)),/AUTO_HISTORY_REVISED/);
 const backup=structuredClone(value);backup.base.rows[0][1]*=22;await assert.rejects(L.verify(backup),/HASH/);
});
