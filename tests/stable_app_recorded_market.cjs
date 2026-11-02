'use strict';
// TEST_ONLY HTTP-server fixture. Never imported by product or deployed HTML.
// Exact published Git blobs, not fabricated prices. No live-market certification.
const cp=require('child_process'),crypto=require('crypto'),path=require('path'),assert=require('assert/strict');
const commit='87dfa2d',pins={
 'market-quotes.json':'af748552b24a89fd0c8efd6ea2e6a1d2425fbbcf7c189d2e6c2e09aee1adbdb9',
 'data/radar-history/status-v1.json':'015283fe1361f17dbdc1884bb5452283b62a493ce53244d0e69d3bd563d1196c',
 'finalized-core-score-snapshots-v1.json':'371d8eeb346d06a84ff2f9dd9296f0d694fb5b96c0b657bb7bdce38a2df47391'
};
const recorded=new Map(Object.entries(pins).map(([name,pin])=>{const bytes=cp.execFileSync('git',['show',commit+':'+name],{cwd:path.resolve(__dirname,'..'),maxBuffer:10000000});assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),pin);return[name,bytes];}));
module.exports=Object.freeze({read:name=>recorded.get(name),evidence:Object.freeze({commit,as_of:'2026-11-01T10:00:00Z',pins,classification:'RECORDED_READ_ONLY_FIXTURE_NOT_LIVE'})});
